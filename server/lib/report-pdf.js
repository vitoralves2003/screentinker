'use strict';

/*
 * The report as a document — the thing that gets emailed to the advertiser who paid for the slot.
 *
 * WHAT THIS COPIES from the competitor's reports, and what it does not:
 *
 *   Copied: the grid. Screens (or files) down the side, hours across the top, with row and column
 *   totals and the busiest cell shaded. It fits one page whatever the volume, and it is the one
 *   part of their output that reads like a document rather than a screenshot.
 *
 *   NOT copied: their per-screen report, which prints one line per play and runs to fifteen pages
 *   for a single day. Only its last two pages — the aggregates — are worth anything. The
 *   line-by-line detail belongs in the CSV, which is a click away and which nobody has to scroll
 *   past to reach a total.
 *
 *   Copied and then fixed: the verification code. Theirs is stamped "Informações válidas até"
 *   two minutes after generation, which empties the idea — a receipt that expires while you read
 *   it proves nothing. Ours resolves to a page that keeps working, so the customer can check the
 *   numbers themselves whenever they like. See lib/report-verify.js.
 *
 * PDFKit rather than headless Chrome: this renders tables and a header, which is what PDFKit is
 * for, and Chromium is 300 MB of image and 100-300 MB of RAM per instance on a VPS already
 * running eleven containers. The built-in fonts are WinAnsi, which covers every accent in
 * Portuguese.
 */

const PDFDocument = require('pdfkit');
const fs = require('node:fs');
const path = require('node:path');

const LOGO = path.join(__dirname, '..', '..', 'frontend', 'assets', 'loop-player-logo.png');

const MARGIN = 40;
const INK = '#111827';
const MUTED = '#6B7280';
const RULE = '#D1D5DB';
const ACCENT = '#16A34A';

/*
 * The kinds a play can be, in Portuguese.
 *
 * The document is read by a customer, not by an operator, and "file" or "clock" in a column headed
 * "Tipo" reads as an untranslated string that escaped — which is exactly what it would be. An
 * unknown kind prints itself rather than a blank, so a widget type added later is legible while
 * nobody has got round to naming it.
 */
const KIND = {
  file: 'Arquivo',
  widget: 'Widget',
  clock: 'Relógio',
  news: 'Notícias',
  weather: 'Previsão do tempo',
  football: 'Futebol',
  lottery: 'Loteria',
};
const kindLabel = (k) => KIND[k] || k;

const fmtInt = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

function hms(sec) {
  const n = Number(sec) || 0;
  if (!n) return '0s';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  if (h) return `${h}h ${m}min`;
  if (m) return `${m}min ${n % 60}s`;
  return `${n}s`;
}

function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = String(d).split('-');
  return `${day}/${m}/${y}`;
}

/* ---------------------------------------------------------------- page furniture */

function header(doc, { tenant, kind, subject }) {
  const top = doc.y;
  try {
    doc.image(LOGO, MARGIN, top, { height: 26 });
  } catch {
    // A missing or unreadable logo must not fail the report somebody is waiting for.
    doc.fontSize(14).fillColor(ACCENT).text('Loop Player', MARGIN, top);
  }

  const x = MARGIN + 150;
  doc.fontSize(9).fillColor(MUTED).text(kind, x, top, { width: 340 });
  doc.fontSize(14).fillColor(INK).text(subject, x, doc.y, { width: 340 });
  if (tenant) doc.fontSize(9).fillColor(MUTED).text(tenant, x, doc.y + 1, { width: 340 });

  doc.moveDown(1.2);
  rule(doc);
}

function rule(doc) {
  const y = doc.y + 4;
  doc.strokeColor(RULE).lineWidth(0.7).moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y).stroke();
  doc.y = y + 10;
}

function sectionTitle(doc, text) {
  if (doc.y > doc.page.height - 120) doc.addPage();
  doc.fontSize(11).fillColor(INK).font('Helvetica-Bold').text(text, MARGIN, doc.y);
  doc.font('Helvetica').moveDown(0.4);
}

/*
 * The facts block. Two columns: what the report measured on the left, and what the report IS on
 * the right — code, when it was made, and where to check it.
 */
function factsBlock(doc, left, right) {
  const startY = doc.y;
  const colW = (doc.page.width - MARGIN * 2) / 2 - 10;

  const draw = (items, x) => {
    let y = startY;
    for (const [label, value] of items) {
      doc.fontSize(8.5).fillColor(MUTED).text(label, x, y, { width: colW, continued: false });
      y = doc.y;
      doc.fontSize(11).fillColor(INK).text(String(value), x, y, { width: colW });
      y = doc.y + 4;
    }
    return y;
  };

  const a = draw(left, MARGIN);
  const b = draw(right, MARGIN + colW + 20);
  doc.y = Math.max(a, b) + 4;
  rule(doc);
}

/* ---------------------------------------------------------------- the grid */

/*
 * Rows down the side, columns across the top, on as many pages as it takes.
 *
 * Columns are sized to what is left after the label, and a grid of 24 hours on A4 portrait leaves
 * about 17pt each — enough for three digits, which is all a cell ever holds at this granularity.
 * A wider grid than the page can hold is not shrunk to illegibility: the caller has already been
 * told to drop it (see lib/report-matrix.js), so anything arriving here fits.
 */
function grid(doc, matrix, { rowLabel }) {
  if (!matrix || matrix.kind === 'none' || !matrix.total) return;

  const usable = doc.page.width - MARGIN * 2;
  const labelW = Math.min(150, usable * 0.28);
  const totalW = 34;
  const cellW = (usable - labelW - totalW) / matrix.columns.length;
  const rowH = 15;

  const headerRow = () => {
    let x = MARGIN;
    doc.fontSize(7.5).fillColor(MUTED).font('Helvetica-Bold');
    doc.text(rowLabel, x + 2, doc.y + 4, { width: labelW - 4 });
    const y = doc.y - 9;
    x += labelW;
    for (const c of matrix.columns) {
      doc.text(c, x, y, { width: cellW, align: 'center' });
      x += cellW;
    }
    doc.text('Total', x, y, { width: totalW, align: 'center' });
    doc.font('Helvetica');
    doc.y = y + rowH;
    doc.strokeColor(RULE).lineWidth(0.7).moveTo(MARGIN, doc.y - 2).lineTo(doc.page.width - MARGIN, doc.y - 2).stroke();
  };

  headerRow();

  const drawRow = (label, cells, total, bold) => {
    if (doc.y > doc.page.height - 60) {
      doc.addPage();
      headerRow();
    }
    const y = doc.y;
    let x = MARGIN;

    doc.fontSize(7.5).fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(label, x + 2, y + 4, { width: labelW - 6, ellipsis: true, height: rowH });
    x += labelW;

    for (const v of cells) {
      if (v && matrix.peak) {
        /*
         * Shaded relative to the busiest cell — the competitor's report does this and it is the
         * fastest way to find the hour that matters without reading every number. Kept pale
         * enough that the figure on top stays black.
         */
        const a = 0.12 + 0.35 * (v / matrix.peak);
        doc.rect(x, y, cellW, rowH).fillColor(ACCENT).fillOpacity(a).fill().fillOpacity(1);
      }
      doc.fillColor(INK).text(v ? String(v) : '', x, y + 4, { width: cellW, align: 'center' });
      x += cellW;
    }

    doc.font('Helvetica-Bold').text(String(total), x, y + 4, { width: totalW, align: 'center' }).font('Helvetica');
    doc.y = y + rowH;
  };

  for (const r of matrix.rows) {
    drawRow(r.name === null ? `outros ${r.count}` : r.name, r.cells, r.total, false);
  }

  doc.strokeColor(RULE).moveTo(MARGIN, doc.y).lineTo(doc.page.width - MARGIN, doc.y).stroke();
  doc.y += 2;
  drawRow('Total', matrix.col_totals, matrix.total, true);
  doc.moveDown(1);
}

/* ---------------------------------------------------------------- ranked tables */

function rankTable(doc, columns, rows, empty) {
  if (!rows.length) {
    doc.fontSize(9).fillColor(MUTED).text(empty, MARGIN, doc.y);
    doc.moveDown(0.8);
    return;
  }

  const usable = doc.page.width - MARGIN * 2;
  const numW = 70;
  const nameW = usable - numW * (columns.length - 1);
  const widths = columns.map((c, i) => (i === 0 ? nameW : numW));
  const rowH = 14;

  const head = () => {
    let x = MARGIN;
    const y = doc.y;
    doc.fontSize(8).fillColor(MUTED).font('Helvetica-Bold');
    columns.forEach((c, i) => {
      doc.text(c.label, x, y, { width: widths[i], align: i ? 'right' : 'left' });
      x += widths[i];
    });
    doc.font('Helvetica');
    doc.y = y + 12;
    doc.strokeColor(RULE).lineWidth(0.7).moveTo(MARGIN, doc.y - 2).lineTo(doc.page.width - MARGIN, doc.y - 2).stroke();
  };

  head();

  for (const r of rows) {
    if (doc.y > doc.page.height - 60) { doc.addPage(); head(); }
    const y = doc.y;
    let x = MARGIN;
    doc.fontSize(9).fillColor(INK);
    columns.forEach((c, i) => {
      doc.text(String(c.get(r)), x, y, { width: widths[i], align: i ? 'right' : 'left', ellipsis: true, height: rowH });
      x += widths[i];
    });
    doc.y = y + rowH;
  }
  doc.moveDown(0.8);
}

/* ---------------------------------------------------------------- footers */

/*
 * Page numbers and the timezone note, stamped on every page AFTER the body is laid out.
 *
 * Written last on purpose: the total page count is not knowable while the body is still being
 * written, and a footer that says "1 / 1" on a fifteen-page document is exactly the kind of small
 * lie that makes a reader doubt the numbers above it.
 */
function stampFooters(doc, note) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const y = doc.page.height - 28;
    doc.fontSize(7.5).fillColor(MUTED);
    doc.text(note, MARGIN, y, { width: doc.page.width - MARGIN * 2 - 60, lineBreak: false, ellipsis: true });
    doc.text(`${i + 1} / ${range.count}`, doc.page.width - MARGIN - 60, y, { width: 60, align: 'right' });
  }
}

/* ---------------------------------------------------------------- documents */

function newDoc() {
  // bufferPages, so the footers can be stamped once the page count is known.
  return new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true, info: { Producer: 'Loop Player' } });
}

function verifyFacts({ code, url, generatedAt }) {
  const when = new Date(generatedAt * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const facts = [['Código', code], ['Gerado em', when]];
  // No "valid until". A receipt that expires while the customer is reading it proves nothing, and
  // the verification page keeps working for as long as the history behind it does.
  if (url) facts.push(['Confira em', url]);
  return facts;
}

function screenPdf(data, meta) {
  const doc = newDoc();
  header(doc, { tenant: meta.tenant, kind: 'Relatório de exibições — tela', subject: data.device.name });

  factsBlock(doc, [
    ['Total de exibições', fmtInt(data.totals.plays)],
    ['Tempo no ar', hms(data.totals.seconds)],
    ['Arquivos distintos', fmtInt(data.totals.distinct_files)],
    ['Widgets distintos', fmtInt(data.totals.distinct_widgets)],
  ], [
    ['Período', `${fmtDate(data.window.start)} a ${fmtDate(data.window.end)}`],
    ...verifyFacts(meta),
  ]);

  sectionTitle(doc, data.matrix.kind === 'hour' ? 'Exibições por hora' : 'Exibições por dia');
  grid(doc, data.matrix, { rowLabel: 'Item' });

  sectionTitle(doc, 'O que exibiu');
  rankTable(doc, [
    { label: 'Item', get: (r) => r.name },
    { label: 'Exibições', get: (r) => fmtInt(r.plays) },
    { label: 'Tempo', get: (r) => hms(r.seconds) },
  ], data.by_item, 'Nada neste período.');

  sectionTitle(doc, 'Por tipo');
  rankTable(doc, [
    { label: 'Tipo', get: (r) => kindLabel(r.kind) },
    { label: 'Exibições', get: (r) => fmtInt(r.plays) },
    { label: '%', get: (r) => `${r.pct}%` },
  ], data.by_kind, 'Nada neste período.');

  stampFooters(doc, `Horários na hora da tela (${data.timezone}). Histórico mantido por 90 dias.`);
  doc.end();
  return doc;
}

function filePdf(data, meta) {
  const doc = newDoc();
  header(doc, { tenant: meta.tenant, kind: 'Relatório de exibições — arquivo', subject: data.file.filename });

  /*
   * The two kinds of number are labelled with their own period, not only grouped under a heading.
   * A screenshot of the web version showed "Telas: 1" above a table listing two — both correct
   * (one is where the file is today, the other where it played), and a heading was not enough to
   * stop it reading as a contradiction.
   */
  factsBlock(doc, [
    ['Exibições no período', fmtInt(data.totals.plays)],
    ['Dias no ar', fmtInt(data.totals.days_on_air)],
    ['Tempo no ar', hms(data.totals.seconds)],
    ['Telas em que exibiu no período', fmtInt(data.by_screen.length)],
  ], [
    ['Período', `${fmtDate(data.window.start)} a ${fmtDate(data.window.end)}`],
    ['Listas em que está hoje', fmtInt(data.reach.playlist_count)],
    ['Telas que exibem hoje', fmtInt(data.reach.screen_count)],
    ...verifyFacts(meta),
  ]);

  sectionTitle(doc, data.matrix.kind === 'hour' ? 'Exibições por tela e hora' : 'Exibições por tela e dia');
  grid(doc, data.matrix, { rowLabel: 'Tela' });

  sectionTitle(doc, 'Por tela');
  rankTable(doc, [
    { label: 'Tela', get: (r) => r.name },
    { label: 'Exibições', get: (r) => fmtInt(r.plays) },
    { label: 'Tempo', get: (r) => hms(r.seconds) },
  ], data.by_screen, 'Nada neste período.');

  sectionTitle(doc, 'Por lista');
  rankTable(doc, [
    { label: 'Lista', get: (r) => r.name || 'lista não registrada' },
    { label: 'Exibições', get: (r) => fmtInt(r.plays) },
    { label: 'Tempo', get: (r) => hms(r.seconds) },
  ], data.by_list, 'Nada neste período.');

  stampFooters(doc, 'Horários na hora de cada tela. Histórico mantido por 90 dias.');
  doc.end();
  return doc;
}

function playlistPdf(data, meta) {
  const doc = newDoc();
  header(doc, { tenant: meta.tenant, kind: 'Relatório de exibições — lista', subject: data.playlist.name });

  factsBlock(doc, [
    ['Exibições no período', fmtInt(data.totals.plays)],
    ['Tempo no ar', hms(data.totals.seconds)],
    ['Itens que exibiram', fmtInt(data.totals.distinct_items)],
  ], [
    ['Período', `${fmtDate(data.window.start)} a ${fmtDate(data.window.end)}`],
    ['Telas que rodam hoje', fmtInt(data.reach.screen_count)],
    ['Itens na lista', fmtInt(data.reach.item_count)],
    ...verifyFacts(meta),
  ]);

  sectionTitle(doc, data.matrix.kind === 'hour' ? 'Exibições por tela e hora' : 'Exibições por tela e dia');
  grid(doc, data.matrix, { rowLabel: 'Tela' });

  sectionTitle(doc, 'O que veiculou');
  rankTable(doc, [
    { label: 'Item', get: (r) => r.name },
    { label: 'Exibições', get: (r) => fmtInt(r.plays) },
    { label: 'Tempo', get: (r) => hms(r.seconds) },
  ], data.by_item, 'Nada neste período.');

  sectionTitle(doc, 'Por tela');
  rankTable(doc, [
    { label: 'Tela', get: (r) => r.name },
    { label: 'Exibições', get: (r) => fmtInt(r.plays) },
    { label: 'Tempo', get: (r) => hms(r.seconds) },
  ], data.by_screen, 'Nada neste período.');

  stampFooters(doc, 'Horários na hora de cada tela. Histórico mantido por 90 dias.');
  doc.end();
  return doc;
}

module.exports = { screenPdf, filePdf, playlistPdf, hms, fmtDate };
