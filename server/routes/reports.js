const express = require('express');
const router = express.Router();
const { db } = require('../db/database');

// Phase 2.2g: scope reports to the caller's current workspace.
// No platform_admin bypass - cross-workspace reporting comes from
// switch-workspace, not a magic role-based "see all" path. This matches
// the precedent set in devices.js.
function getWorkspaceDeviceFilter(req) {
  if (!req.workspaceId) return { sql: ' AND 1=0', params: [] }; // no workspace -> empty result
  return { sql: ' AND d.workspace_id = ?', params: [req.workspaceId] };
}

function getWorkspaceDeviceSubquery(req) {
  if (!req.workspaceId) return { sql: ' AND device_id IN (SELECT id FROM devices WHERE 1=0)', params: [] };
  return { sql: ' AND device_id IN (SELECT id FROM devices WHERE workspace_id = ?)', params: [req.workspaceId] };
}

const { screensReport, filesReport, playlistsReport, groupsReport, toCsv, csvCell } = require('../lib/reports');
const exhibition = require('../lib/exhibition');

/*
 * Reports by TYPE — screens, files, playlists, groups.
 *
 * One route shape for all four, and one export route rather than four nearly identical ones. The
 * alternative was eight endpoints differing only in a SELECT, which is eight places for the
 * workspace filter to be forgotten in exactly one of them.
 *
 * Every builder scopes on workspace_id itself; this layer never widens that. There is deliberately
 * no platform-admin bypass — cross-workspace reporting comes from switching workspace, the same
 * precedent as devices.js, and an aggregate is the easiest place for a leak to look like a
 * slightly larger number instead of like somebody else's data.
 */
const BUILDERS = {
  screens: screensReport,
  files: filesReport,
  playlists: playlistsReport,
  groups: groupsReport,
};

/*
 * The columns each type exports. Kept beside the builders so a column added to a report and not to
 * its export produces a CSV that is quietly missing the thing the operator opened it for.
 */
const COLUMNS = {
  screens: [
    { label: 'Tela', get: (r) => r.name },
    { label: 'Situação', get: (r) => r.status },
    { label: 'Grupos', get: (r) => r.group_names || '' },
    { label: 'Lista', get: (r) => r.playlist_name || '' },
    { label: 'Exibições', get: (r) => r.plays },
    { label: 'Tempo (s)', get: (r) => r.seconds },
    { label: 'Arquivos distintos', get: (r) => r.distinct_files },
    { label: 'Última exibição', get: (r) => (r.last_play ? new Date(r.last_play * 1000).toISOString() : '') },
  ],
  files: [
    { label: 'Arquivo', get: (r) => r.filename },
    { label: 'Tipo', get: (r) => r.mime_type || '' },
    { label: 'Exibições', get: (r) => r.plays },
    { label: 'Tempo (s)', get: (r) => r.seconds },
    { label: 'Em listas', get: (r) => r.in_playlists },
    { label: 'Em telas', get: (r) => r.on_screens },
    { label: 'Última exibição', get: (r) => (r.last_play ? new Date(r.last_play * 1000).toISOString() : '') },
  ],
  playlists: [
    { label: 'Lista', get: (r) => r.name },
    { label: 'Situação', get: (r) => r.status },
    { label: 'Itens', get: (r) => r.items },
    { label: 'Duração (s)', get: (r) => r.duration_sec },
    { label: 'Em telas', get: (r) => r.on_screens },
    { label: 'Exibições', get: (r) => r.plays },
    { label: 'Tempo (s)', get: (r) => r.seconds },
  ],
  groups: [
    { label: 'Grupo', get: (r) => r.name },
    { label: 'Telas', get: (r) => r.screens },
    { label: 'Online', get: (r) => r.online },
    { label: 'Exibições', get: (r) => r.plays },
  ],
};

router.get('/by/:type', (req, res) => {
  const build = BUILDERS[req.params.type];
  if (!build) return res.status(404).json({ error: 'unknown report type' });
  const { start, end } = req.query;
  /*
   * The window travels back with the rows. play_logs is pruned at 90 days, so an empty report can
   * mean "nothing played" or "it played before the window" — and the page cannot say which unless
   * it knows what it asked for.
   */
  res.json({ type: req.params.type, start: start || null, end: end || null, retention_days: 90, rows: build(req.workspaceId, { start, end }) });
});

router.get('/by/:type/export', (req, res) => {
  const build = BUILDERS[req.params.type];
  const cols = COLUMNS[req.params.type];
  if (!build || !cols) return res.status(404).json({ error: 'unknown report type' });
  const { start, end } = req.query;
  const csv = toCsv(cols, build(req.workspaceId, { start, end }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=loop-player-${req.params.type}.csv`);
  res.send(csv);
});

// Query play logs
router.get('/plays', (req, res) => {
  const { device_id, content_id, start, end, limit: lim } = req.query;
  const scope = getWorkspaceDeviceFilter(req);
  let sql = `SELECT pl.*, d.name as device_name
    FROM play_logs pl
    JOIN devices d ON pl.device_id = d.id
    WHERE 1=1${scope.sql}`;
  const params = [...scope.params];

  if (device_id) { sql += ' AND pl.device_id = ?'; params.push(device_id); }
  if (content_id) { sql += ' AND pl.content_id = ?'; params.push(content_id); }
  if (start) { sql += ' AND pl.started_at >= ?'; params.push(Math.floor(new Date(start).getTime() / 1000)); }
  if (end) { sql += ' AND pl.started_at <= ?'; params.push(Math.floor(new Date(end).getTime() / 1000)); }

  sql += ' ORDER BY pl.started_at DESC LIMIT ?';
  params.push(parseInt(lim) || 500);

  res.json(db.prepare(sql).all(...params));
});

// Summary report
router.get('/summary', (req, res) => {
  const { device_id, start, end, group_by } = req.query;
  const startEpoch = start ? Math.floor(new Date(start).getTime() / 1000) : Math.floor(Date.now() / 1000) - 30 * 86400;
  const endEpoch = end ? Math.floor(new Date(end + 'T23:59:59').getTime() / 1000) : Math.floor(Date.now() / 1000);

  // Phase 2.2g: workspace-scope all summary queries, no admin bypass.
  const wsScope = getWorkspaceDeviceSubquery(req);
  let deviceFilter = wsScope.sql;
  const params = [startEpoch, endEpoch, ...wsScope.params];
  if (device_id) { deviceFilter += ' AND device_id = ?'; params.push(device_id); }

  // Overall stats
  const overall = db.prepare(`
    SELECT COUNT(*) as total_plays,
           COALESCE(SUM(duration_sec), 0) as total_duration_sec,
           COUNT(DISTINCT content_id) as unique_content,
           COUNT(DISTINCT device_id) as unique_devices,
           AVG(duration_sec) as avg_duration_sec
    FROM play_logs
    WHERE started_at >= ? AND started_at <= ? ${deviceFilter}
  `).get(...params);

  // By content
  const byContent = db.prepare(`
    SELECT content_id, content_name, COUNT(*) as plays,
           COALESCE(SUM(duration_sec), 0) as total_seconds,
           SUM(completed) as completed_plays
    FROM play_logs
    WHERE started_at >= ? AND started_at <= ? ${deviceFilter}
    GROUP BY content_id, content_name
    ORDER BY plays DESC LIMIT 50
  `).all(...params);

  // By device
  const byDevice = db.prepare(`
    SELECT pl.device_id, d.name as device_name, COUNT(*) as plays,
           COALESCE(SUM(pl.duration_sec), 0) as total_seconds
    FROM play_logs pl
    JOIN devices d ON pl.device_id = d.id
    WHERE pl.started_at >= ? AND pl.started_at <= ? ${deviceFilter}
    GROUP BY pl.device_id
    ORDER BY plays DESC
  `).all(...params);

  // By hour of day
  const byHour = db.prepare(`
    SELECT CAST(strftime('%H', started_at, 'unixepoch', 'localtime') AS INTEGER) as hour,
           COUNT(*) as plays
    FROM play_logs
    WHERE started_at >= ? AND started_at <= ? ${deviceFilter}
    GROUP BY hour ORDER BY hour
  `).all(...params);

  // By day
  const byDay = db.prepare(`
    SELECT date(started_at, 'unixepoch', 'localtime') as day, COUNT(*) as plays,
           COALESCE(SUM(duration_sec), 0) as total_seconds
    FROM play_logs
    WHERE started_at >= ? AND started_at <= ? ${deviceFilter}
    GROUP BY day ORDER BY day
  `).all(...params);

  res.json({
    period: { start: new Date(startEpoch * 1000).toISOString(), end: new Date(endEpoch * 1000).toISOString() },
    overall: {
      total_plays: overall.total_plays,
      total_hours: Math.round(overall.total_duration_sec / 3600 * 10) / 10,
      unique_content: overall.unique_content,
      unique_devices: overall.unique_devices,
      avg_duration_sec: Math.round(overall.avg_duration_sec || 0),
    },
    by_content: byContent,
    by_device: byDevice,
    by_hour: byHour,
    by_day: byDay,
  });
});

// Export CSV. Phase 2.2g: workspace-scoped. Previously this route had no scope
// filter at all - any authenticated user could export the entire platform's
// play_logs. The added WHERE clause closes that pre-existing cross-tenant leak.
router.get('/export', (req, res) => {
  const { device_id, start, end } = req.query;
  const startEpoch = start ? Math.floor(new Date(start).getTime() / 1000) : 0;
  const endEpoch = end ? Math.floor(new Date(end + 'T23:59:59').getTime() / 1000) : Math.floor(Date.now() / 1000);

  const scope = getWorkspaceDeviceFilter(req);
  let sql = `SELECT pl.*, d.name as device_name FROM play_logs pl JOIN devices d ON pl.device_id = d.id WHERE pl.started_at >= ? AND pl.started_at <= ?${scope.sql}`;
  const params = [startEpoch, endEpoch, ...scope.params];
  if (device_id) { sql += ' AND pl.device_id = ?'; params.push(device_id); }
  sql += ' ORDER BY pl.started_at ASC';

  const rows = db.prepare(sql).all(...params);

  const header = 'Device,Content,Started,Ended,Duration (sec),Completed\n';
  const csv = header + rows.map(r => {
    const started = new Date(r.started_at * 1000).toISOString();
    const ended = r.ended_at ? new Date(r.ended_at * 1000).toISOString() : '';
    return `"${r.device_name}","${r.content_name}","${started}","${ended}",${r.duration_sec || ''},${r.completed ? 'Yes' : 'No'}`;
  }).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=proof-of-play.csv');
  res.send(csv);
});

// Device uptime report. Phase 2.2g: workspace-scoped. Previously this route
// had no scope filter at all - any authenticated user could see telemetry
// summaries for every device on the platform. The added WHERE clause closes
// that pre-existing cross-tenant leak.
router.get('/uptime', (req, res) => {
  const { device_id, start, end } = req.query;
  const startEpoch = start ? Math.floor(new Date(start).getTime() / 1000) : Math.floor(Date.now() / 1000) - 30 * 86400;
  const endEpoch = end ? Math.floor(new Date(end + 'T23:59:59').getTime() / 1000) : Math.floor(Date.now() / 1000);

  const scope = getWorkspaceDeviceFilter(req);
  let sql = `SELECT dt.device_id, d.name as device_name,
    COUNT(*) as heartbeat_count,
    MIN(dt.reported_at) as first_seen,
    MAX(dt.reported_at) as last_seen
    FROM device_telemetry dt
    JOIN devices d ON dt.device_id = d.id
    WHERE dt.reported_at >= ? AND dt.reported_at <= ?${scope.sql}`;
  const params = [startEpoch, endEpoch, ...scope.params];
  if (device_id) { sql += ' AND dt.device_id = ?'; params.push(device_id); }
  sql += ' GROUP BY dt.device_id ORDER BY d.name';

  const uptimeData = db.prepare(sql).all(...params);

  // Estimate uptime: heartbeats are every 15s, so heartbeat_count * 15 / total_period
  const totalPeriod = endEpoch - startEpoch;
  uptimeData.forEach(d => {
    d.estimated_uptime_pct = Math.min(100, Math.round((d.heartbeat_count * 15 / totalPeriod) * 100 * 10) / 10);
  });

  res.json(uptimeData);
});

/*
 * The exhibition timeline for ONE screen: what it played, in the order it played it.
 *
 * Deliberately not a variant of /plays. That route answers questions about the fleet and returns
 * flat rows on the server's clock; this one belongs to a single screen, is grouped into that
 * screen's own days, and is what an operator shows a customer as proof of play.
 *
 * A 404 covers both "no such screen" and "not yours" — the workspace check lives in the builder,
 * and separating the two here would confirm the existence of another tenant's device id.
 */
router.get('/device/:id/timeline', (req, res) => {
  const { start, end, limit } = req.query;
  const data = exhibition.deviceTimeline({
    workspaceId: req.workspaceId,
    deviceId: req.params.id,
    start,
    end,
    limit,
  });
  if (!data) return res.status(404).json({ error: 'device not found' });
  // Retention travels with the answer for the same reason as the reports above: an empty week is
  // either a quiet week or a pruned one, and only a caller who knows the limit can tell which.
  res.json({ ...data, retention_days: 90 });
});

router.get('/device/:id/timeline/export', (req, res) => {
  const { start, end } = req.query;
  const data = exhibition.deviceTimelineRows({
    workspaceId: req.workspaceId,
    deviceId: req.params.id,
    start,
    end,
  });
  if (!data) return res.status(404).json({ error: 'device not found' });

  const cols = [
    { label: 'Data', get: (r) => r.date },
    { label: 'Hora', get: (r) => r.time },
    { label: 'Arquivo', get: (r) => r.content_name },
    // Three states, three words. One empty cell for all of them would file "we never recorded
    // this" and "the list was deleted since" under the same heading.
    { label: 'Lista', get: (r) => (r.playlist_name || (r.playlist_deleted ? 'lista excluida' : 'nao registrada')) },
    { label: 'Zona', get: (r) => r.zone_id || '' },
    { label: 'Duracao (s)', get: (r) => r.duration_sec || 0 },
    { label: 'Concluido', get: (r) => (r.completed ? 'sim' : 'nao') },
  ];

  /*
   * The zone goes in the FILE, not only on the page that offered it. A CSV outlives the screen it
   * came from, and a column of times with no zone beside it will eventually be read in the wrong
   * one — by which point nothing in the file can settle the argument.
   */
  const body = toCsv(cols, data.rows);
  const note = 'Tela: ' + data.device.name
    + ' | Fuso: ' + data.timezone + (data.timezone_assumed ? ' (assumido)' : '')
    + ' | Periodo: ' + data.window.start + ' a ' + data.window.end
    + (data.truncated ? ' | TRUNCADO em ' + exhibition.MAX_EXPORT_ROWS + ' linhas' : '');
  // After the BOM, before the header row: Excel keeps reading the BOM as UTF-8 and the note is
  // the first thing a human sees.
  const csv = body.replace('\uFEFF', '\uFEFF' + csvCell(note) + '\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  const safe = String(data.device.name || 'tela').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40);
  res.setHeader(
    'Content-Disposition',
    'attachment; filename=exibicoes-' + safe + '-' + data.window.start + '_' + data.window.end + '.csv'
  );
  res.send(csv);
});

module.exports = router;
