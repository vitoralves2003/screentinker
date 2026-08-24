'use strict';

/*
 * The report as a document — the thing that gets sent to the advertiser who paid for the slot.
 *
 * LANDSCAPE, and that is a measurement, not a preference. The first version was portrait: 515pt of
 * usable width, 144 for the row label and 34 for the totals column, leaving 337 for thirty day
 * columns — 11.2pt each. Three digits at 7.5pt need 12.5pt, so every number over 99 broke onto two
 * lines and a correct grid printed as gibberish. Landscape gives 762pt, and the granularity ladder
 * in lib/report-matrix.js caps the count at what the COLUMN LABELS need — sixteen days, thirteen
 * weeks — which leaves 35pt a cell where "10 ago" measures 22.9.
 *
 * WHAT THIS COPIES from the competitor's reports, and what it does not:
 *
 *   Copied: the grid, with row and column totals, a tinted total column and the busiest cells
 *   shaded. It is the one part of their output that reads like a document rather than a screenshot.
 *
 *   NOT copied: their per-screen report, which prints one line per play and runs to fifteen pages
 *   for a single day; and their grid, which covers "the last 7 days" while the totals above it
 *   cover the whole period, so the two do not add up and nothing on the page says why. Ours covers
 *   exactly the period in the heading.
 *
 *   Copied and then fixed: the verification code. Theirs expires four minutes after generation,
 *   which empties the idea. Ours resolves to a page that keeps working — see lib/report-verify.js.
 *
 * PDFKit rather than headless Chrome: this draws tables and a header, which is what PDFKit is for,
 * and Chromium is 300 MB of image and 100-300 MB of RAM per instance on a VPS already running
 * eleven containers. The built-in fonts are WinAnsi, which covers every accent in Portuguese.
 */

const PDFDocument = require('pdfkit');
const path = require('node:path');

/*
 * The BLACK wordmark, not the one the app uses.
 *
 * The app's logo is drawn for a dark interface: its "Player" is rgb(254,254,254), which on a white
 * page is white ink on white paper. It printed as a green "Loop" followed by nothing. This asset is
 * the black variant, cropped to its own ink — the source is a 2000x1414 canvas holding a 1595x380
 * wordmark, and placed uncropped at "height: 26" the letters would have rendered about 7pt tall.
 */
const LOGO = path.join(__dirname, '..', '..', 'frontend', 'assets', 'loop-player-logo-print.png');

const MARGIN = 40;
const INK = '#111827';
const MUTED = '#6B7280';
const RULE = '#D1D5DB';
const ACCENT = '#16A34A';
const TINT = '#F3F4F6';

/*
 * The kinds a play can be, in Portuguese.
 *
 * The document is read by a customer, not by an operator, and "file" or "clock" in a column headed
 * "Tipo" reads as an untranslated string that escaped — which is what it would be. An unknown kind
 * prints itself rather than a blank, so a widget type added later is legible while nobody has got
 * round to naming it.
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

const GRID_TITLE = {
  hour: 'Exibições por hora',
  day: 'Exibições por dia',
  week: 'Exibições por semana',
  month: 'Exibições por mês',
};

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

function newDoc() {
  // bufferPages, so the footers can be stamped once the page count is known.
  return new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: MARGIN,
    bufferPages: true,
    info: { Producer: 'Loop Player' },
  });
}

const usableWidth = (doc) => doc.page.width - MARGIN * 2;

function rule(doc) {
  const y = doc.y + 4;
  doc.strokeColor(RULE).lineWidth(0.7).moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y).stroke();
  doc.y = y + 10;
}

/*
 * The header, with the subject sized to fit.
 *
 * A file name can be ninety characters. Left at one size it wrapped to three lines and pushed the
 * tenant name and the rule below it down the page; capped at two lines and shrunk to fit, it stays
 * a heading. The name is never truncated — an advertiser looking for their own campaign has to be
 * able to recognise it.
 */
function header(doc, { tenant, kind, subject }) {
  const top = doc.y;
  try {
    doc.image(LOGO, MARGIN, top, { height: 26 });
  } catch {
    // A missing or unreadable logo must not fail a report somebody is waiting for.
    doc.fontSize(14).fillColor(ACCENT).text('Loop Player', MARGIN, top);
  }

  const x = MARGIN + 150;
  const w = doc.page.width - MARGIN - x;

  doc.fontSize(9).fillColor(MUTED).text(kind, x, top, { width: w });

  let size = 15;
  const name = String(subject || '');
  while (size > 9 && doc.fontSize(size).heightOfString(name, { width: w }) > size * 2.6) size -= 0.5;
  doc.fontSize(size).fillColor(INK).text(name, x, doc.y, { width: w });

  if (tenant) doc.fontSize(9).fillColor(MUTED).text(tenant, x, doc.y + 1, { width: w });

  doc.y = Math.max(doc.y, top + 30);
  rule(doc);
}

function sectionTitle(doc, text) {
  if (doc.y > doc.page.height - 110) doc.addPage();
  doc.fontSize(11).fillColor(INK).font('Helvetica-Bold').text(text, MARGIN, doc.y);
  doc.font('Helvetica').moveDown(0.4);
}

/*
 * The facts, in three columns.
 *
 * Grouped by what KIND of fact each one is, because mixing them is how a reader concludes that a
 * file was on one screen when the report also says it played on two. Left: what was measured, over
 * the period. Middle: what is true today, which does not depend on the period at all. Right: what
 * the document itself is — its period, its code, where to check it.
 */
function factsBlock(doc, columns) {
  const startY = doc.y;
  const colW = (usableWidth(doc) - 40) / 3;
  let lowest = startY;

  columns.forEach((items, i) => {
    const x = MARGIN + i * (colW + 20);
    let y = startY;
    for (const [label, value, opts] of items) {
      doc.fontSize(8.5).fillColor(MUTED).text(label, x, y, { width: colW });
      if (opts && opts.strong) {
        // The verification code is copied by hand off the paper, so it is given the size and the
        // letter spacing that makes each character unambiguous.
        doc.fontSize(13).fillColor(INK).font('Helvetica-Bold')
          .text(String(value), x, doc.y, { width: colW, characterSpacing: 1 });
        doc.font('Helvetica');
      } else if (opts && opts.small) {
        doc.fontSize(8).fillColor(MUTED).text(String(value), x, doc.y, { width: colW });
      } else {
        doc.fontSize(11).fillColor(INK).text(String(value), x, doc.y, { width: colW });
      }
      y = doc.y + 5;
    }
    lowest = Math.max(lowest, y);
  });

  doc.y = lowest;
  rule(doc);
}

/*
 * The code, given the room a code deserves.
 *
 * Printed on its own with the URL beneath it in small type. The first version put the URL in a
 * narrow column, where it wrapped in the middle of the code — "…/verificar/WBB-" and "KVG-LFS" on
 * the next line — so a customer typing what they saw could easily type the wrong thing.
 */
function verifyBlock(doc, { code, url, generatedAt }) {
  const when = new Date(generatedAt * 1000)
    .toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });

  doc.fontSize(8.5).fillColor(MUTED).text('Código de verificação', MARGIN, doc.y);
  doc.fontSize(13).fillColor(INK).font('Helvetica-Bold')
    .text(code, MARGIN, doc.y, { characterSpacing: 1 });
  doc.font('Helvetica');
  doc.fontSize(8).fillColor(MUTED).text(`Gerado em ${when}`, MARGIN, doc.y + 1);
  if (url) { doc.fontSize(8).fillColor(MUTED); cell(doc, url, MARGIN, doc.y, usableWidth(doc)); doc.y += 10; }
  doc.moveDown(0.6);
}

/*
 * Where the record starts, when the period asks for more than there is.
 *
 * Without this the empty columns read as dark screens. See lib/history-coverage.js.
 */
function coverageNote(doc, { historyFrom, window: win }) {
  if (!historyFrom || !win.start || win.start >= historyFrom) return;
  doc.fontSize(8).fillColor(MUTED).text(
    `Registro de exibições disponível a partir de ${fmtDate(historyFrom)}. `
    + 'Períodos anteriores aparecem vazios por ausência de registro, não por ausência de exibição.',
    MARGIN, doc.y, { width: usableWidth(doc) }
  );
  doc.moveDown(0.5);
}

/* ---------------------------------------------------------------- drawing text that fits */

/*
 * ONE LINE, ALWAYS — and this is not paranoia, it is a measured fact about PDFKit.
 *
 * `text(str, x, y, { width, lineBreak: false, ellipsis: true })` still wraps. Both options are
 * accepted and neither is honoured once a width is given: "10 ago" in a 19pt cell prints as "10"
 * above "ago", and a file name prints as four stacked fragments. The first release of this report
 * relied on them and shipped a grid nobody could read.
 *
 * So no width is passed at all — without one PDFKit draws a single line — and the truncation and
 * the alignment are done here, by measuring.
 */
function fit(doc, text, w) {
  const str = String(text ?? '');
  if (doc.widthOfString(str) <= w) return str;

  // Binary search rather than a character-at-a-time walk: a row label can be ninety characters and
  // this runs once per cell on a grid that may hold five hundred of them.
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(str.slice(0, mid) + '…') <= w) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? str.slice(0, lo) + '…' : '';
}

/* One line of text, truncated to w and placed within it. */
function cell(doc, text, x, y, w, align = 'left') {
  const str = fit(doc, text, w);
  if (!str) return;
  const tw = doc.widthOfString(str);
  const dx = align === 'center' ? (w - tw) / 2 : (align === 'right' ? w - tw : 0);
  doc.text(str, x + Math.max(0, dx), y, { lineBreak: false });
}

/* ---------------------------------------------------------------- the grid */

/*
 * Rows down the side, columns across the top, on as many pages as it takes.
 *
 * The font is MEASURED, not assumed. The widest figure the grid holds decides the size, down to a
 * floor of 5.5pt — at which four digits need 12.2pt and even a 31-column grid has 18.6. The first
 * version fixed the size at 7.5 and let PDFKit wrap what did not fit, which turned "1164" into
 * "11" above "64" and made a correct total look like two wrong ones. Numbers are never abbreviated:
 * this document is read as evidence, and 1,2 mil is not a figure anybody can check.
 */
function grid(doc, matrix, { rowLabel }) {
  if (!matrix || matrix.kind === 'none' || !matrix.total) return;

  const usable = usableWidth(doc);
  const labelW = Math.min(150, usable * 0.22);
  const totalW = 42;
  const cellW = (usable - labelW - totalW) / matrix.columns.length;
  const rowH = 15;

  /*
   * The size is measured against the widest thing the grid has to draw — which is usually a COLUMN
   * LABEL, not a figure. The ladder in lib/report-matrix.js already picks a unit whose labels fit
   * at 7.5pt; this is the guard for the case it did not anticipate, and it shrinks rather than
   * letting fit() eat a character off a date.
   */
  const widest = [
    fmtInt(Math.max(matrix.peak, ...matrix.col_totals, matrix.total)),
    ...matrix.columns,
  ].reduce((a, b) => (doc.fontSize(7.5).widthOfString(a) >= doc.widthOfString(String(b)) ? a : String(b)));

  let size = 7.5;
  while (size > 5.5 && doc.fontSize(size).widthOfString(widest) > cellW - 3) size -= 0.25;

  const headerRow = () => {
    const y = doc.y;
    let x = MARGIN;
    doc.fontSize(size).fillColor(MUTED).font('Helvetica-Bold');
    cell(doc, rowLabel, x + 2, y + 4, labelW - 6);
    x += labelW;
    for (const c of matrix.columns) {
      cell(doc, c, x, y + 4, cellW, 'center');
      x += cellW;
    }
    cell(doc, 'Total', x, y + 4, totalW, 'center');
    doc.font('Helvetica');
    doc.y = y + rowH;
    doc.strokeColor(RULE).lineWidth(0.7).moveTo(MARGIN, doc.y - 2).lineTo(doc.page.width - MARGIN, doc.y - 2).stroke();
  };

  headerRow();

  const drawRow = (label, cells, total, bold) => {
    if (doc.y > doc.page.height - 55) {
      doc.addPage();
      headerRow();
    }
    const y = doc.y;
    let x = MARGIN;

    if (bold) doc.rect(MARGIN, y, usable, rowH).fillColor(TINT).fill();

    doc.fontSize(size).fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica');
    cell(doc, label, x + 2, y + 4, labelW - 8);
    x += labelW;

    for (const v of cells) {
      if (v && matrix.peak && !bold) {
        /*
         * Shaded relative to the busiest cell — the fastest way to find the hour that matters
         * without reading every number. Kept pale enough that the figure on top stays black.
         */
        const a = 0.12 + 0.35 * (v / matrix.peak);
        doc.rect(x, y, cellW, rowH).fillColor(ACCENT).fillOpacity(a).fill().fillOpacity(1);
      }
      doc.fillColor(INK);
      cell(doc, v ? fmtInt(v) : '', x, y + 4, cellW, 'center');
      x += cellW;
    }

    // The total column is tinted on every row, so the eye can find it without counting across.
    if (!bold) doc.rect(x, y, totalW, rowH).fillColor(TINT).fillOpacity(0.7).fill().fillOpacity(1);
    doc.fillColor(INK).font('Helvetica-Bold');
    cell(doc, fmtInt(total), x, y + 4, totalW, 'center');
    doc.font('Helvetica');
    doc.y = y + rowH;
  };

  for (const r of matrix.rows) {
    drawRow(r.name === null ? `outros ${r.count}` : r.name, r.cells, r.total, false);
  }

  doc.strokeColor(RULE).moveTo(MARGIN, doc.y).lineTo(doc.page.width - MARGIN, doc.y).stroke();
  drawRow('Total', matrix.col_totals, matrix.total, true);

  // One line, not the competitor's five-colour legend on a page of its own.
  doc.moveDown(0.3);
  doc.fontSize(7.5).fillColor(MUTED)
    .text('Células mais escuras indicam mais exibições. O total da grade é o total do período.', MARGIN, doc.y);
  doc.moveDown(0.8);
}

/* ---------------------------------------------------------------- ranked tables */

function rankTable(doc, columns, rows, empty) {
  if (!rows.length) {
    doc.fontSize(9).fillColor(MUTED).text(empty, MARGIN, doc.y);
    doc.moveDown(0.8);
    return;
  }

  const usable = usableWidth(doc);
  const numW = 90;
  const widths = columns.map((c, i) => (i === 0 ? usable - numW * (columns.length - 1) : numW));
  const rowH = 14;

  const head = () => {
    const y = doc.y;
    let x = MARGIN;
    doc.fontSize(8).fillColor(MUTED).font('Helvetica-Bold');
    columns.forEach((c, i) => {
      cell(doc, c.label, x, y, widths[i], i ? 'right' : 'left');
      x += widths[i];
    });
    doc.font('Helvetica');
    doc.y = y + 12;
    doc.strokeColor(RULE).lineWidth(0.7).moveTo(MARGIN, doc.y - 2).lineTo(doc.page.width - MARGIN, doc.y - 2).stroke();
  };

  head();

  for (const r of rows) {
    if (doc.y > doc.page.height - 55) { doc.addPage(); head(); }
    const y = doc.y;
    let x = MARGIN;
    doc.fontSize(9).fillColor(INK);
    columns.forEach((c, i) => {
      cell(doc, c.get(r), x, y, widths[i], i ? 'right' : 'left');
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
 * THE BUG THIS FIXES: writing at page.height - 28 puts the text BELOW the bottom margin, which
 * PDFKit treats as an overflow and answers by adding a page. The first release produced a
 * three-page document — the content, then a page holding only the footnote, then a page holding
 * only "1 / 1" — and the count was read before those pages existed, so it lied as well.
 *
 * Dropping the bottom margin for the duration is the fix: there is nothing below the footer for
 * the text to overflow into.
 */
function stampFooters(doc, note) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = doc.page.height - 26;
    doc.fontSize(7.5).fillColor(MUTED);
    cell(doc, note, MARGIN, y, usableWidth(doc) - 70);
    cell(doc, `${i + 1} / ${range.count}`, doc.page.width - MARGIN - 60, y, 60, 'right');

    doc.page.margins.bottom = keep;
  }
}

/* ---------------------------------------------------------------- documents */

function screenPdf(data, meta) {
  const doc = newDoc();
  header(doc, { tenant: meta.tenant, kind: 'Relatório de exibições — tela', subject: data.device.name });

  factsBlock(doc, [
    [
      ['Exibições no período', fmtInt(data.totals.plays)],
      ['Tempo no ar', hms(data.totals.seconds)],
    ],
    [
      ['Arquivos distintos', fmtInt(data.totals.distinct_files)],
      ['Widgets distintos', fmtInt(data.totals.distinct_widgets)],
    ],
    [['Período', `${fmtDate(data.window.start)} a ${fmtDate(data.window.end)}`]],
  ]);

  verifyBlock(doc, meta);
  coverageNote(doc, { historyFrom: meta.historyFrom, window: data.window });

  sectionTitle(doc, GRID_TITLE[data.matrix.kind] || 'Exibições');
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

/*
 * THE ONE DOCUMENT THAT LEAVES THE BUILDING.
 *
 * A screen report and a list report are written for the operator. This one is handed to the
 * advertiser who paid for the slot, and it is built to the shortest shape that answers what they
 * ask: what ran, on how many screens, how many times, over what period, and since when the file
 * has existed at all.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *
 *   Time on air. Out-of-home media is sold by INSERTION, not by the hour, and the competitor's
 *   report carries no time figure either. (It is also, in this product, a broken number — 19 rows
 *   out of 9,319 carry 90% of all recorded seconds, because a play that was never closed gets its
 *   duration measured against the next morning. That is a separate fix, and dropping the figure
 *   here is not it.)
 *
 *   "In how many lists" and "on how many screens today". An advertiser does not know what a list
 *   is, and what a screen is showing today is not what was delivered last month.
 *
 *   A "by screen" table. It is the grid's own Total column, printed a second time.
 *
 * WHAT IS DELIBERATELY DIFFERENT from the competitor's: their grid covers the last seven days
 * while the totals above it cover the whole period, so the page shows 4,751 at the top and 1,811
 * in the table with nothing to explain the gap. Ours covers the period it declares.
 */
function filePdf(data, meta) {
  const doc = newDoc();
  header(doc, { tenant: meta.tenant, kind: 'Relatório de exibições — arquivo', subject: data.file.filename });

  factsBlock(doc, [
    [
      ['Total de exibições', fmtInt(data.totals.plays)],
      // The screens it PLAYED on, which is what was delivered — not the screens it sits on today.
      ['Telas em que exibiu', fmtInt(data.by_screen.length)],
      ['Dias em exibição', fmtInt(data.totals.days_on_air)],
    ],
    [
      ['Período', `${fmtDate(data.window.start)} a ${fmtDate(data.window.end)}`],
      /*
       * When the file entered the system. Structural, free, and it bounds the question before it is
       * asked: "why did it not run in July" is answered on the paper by the upload date.
       */
      ['Arquivo enviado em', data.file.created_at
        ? new Date(data.file.created_at * 1000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
        : '--'],
    ],
    [
      ['Código de verificação', meta.code, { strong: true }],
      ['Gerado em', new Date(meta.generatedAt * 1000)
        .toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }),
      { small: true }],
      ...(meta.url ? [['Confira em', meta.url, { small: true }]] : []),
    ],
  ]);

  coverageNote(doc, { historyFrom: meta.historyFrom, window: data.window });

  sectionTitle(doc, (GRID_TITLE[data.matrix.kind] || 'Exibições') + ' e tela');
  grid(doc, data.matrix, { rowLabel: 'Tela' });

  stampFooters(doc, 'Horários na hora de cada tela. Histórico mantido por 90 dias.');
  doc.end();
  return doc;
}

function playlistPdf(data, meta) {
  const doc = newDoc();
  header(doc, { tenant: meta.tenant, kind: 'Relatório de exibições — lista', subject: data.playlist.name });

  factsBlock(doc, [
    [
      ['Exibições no período', fmtInt(data.totals.plays)],
      ['Tempo no ar', hms(data.totals.seconds)],
      ['Itens que exibiram', fmtInt(data.totals.distinct_items)],
    ],
    [
      ['Telas que rodam hoje', fmtInt(data.reach.screen_count)],
      ['Itens na lista', fmtInt(data.reach.item_count)],
    ],
    [['Período', `${fmtDate(data.window.start)} a ${fmtDate(data.window.end)}`]],
  ]);

  verifyBlock(doc, meta);
  coverageNote(doc, { historyFrom: meta.historyFrom, window: data.window });

  sectionTitle(doc, (GRID_TITLE[data.matrix.kind] || 'Exibições') + ' e tela');
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

module.exports = { screenPdf, filePdf, playlistPdf, hms, fmtDate, kindLabel };
