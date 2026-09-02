/*
 * ESPELHA O DOMÍNIO DE TELAS/CONTEÚDO no Postgres da Gestão — Fase B (02/09).
 *
 * Lê as 24 tabelas vivas do SQLite e emite UM script SQL (TRUNCATE + INSERTs, numa
 * transação) no stdout, para ser aplicado no Postgres onde a Fase A criou as tabelas
 * gêmeas. Antes do corte, é o que dá dados de verdade ao caminho paralelo — a prova de
 * diff compara os dois lados servindo O MESMO conteúdo. No corte, roda de novo, fresco.
 *
 * Re-rodável por construção: o TRUNCATE zera o espelho antes de encher. NUNCA aponte o
 * psql para o banco de produção — o espelho é do staging (novo_gestao).
 *
 *   docker exec novo-operacao node /app/scripts/migracao/espelhar_dominio.js \
 *     | docker exec -i novo-gestao-postgres psql -U novo -d novo_gestao -v ON_ERROR_STOP=1
 */
const Database = require('/app/server/node_modules/better-sqlite3');
const db = new Database(process.env.DB_ORIGEM || '/data/db/remote_display.db', { readonly: true });

/* Ordem segura para as FKs: pais antes de filhos. */
const TABELAS = [
  'layouts', 'layout_zones', 'widgets', 'content', 'playlists', 'playlist_items',
  'playlist_item_schedules', 'devices', 'device_telemetry', 'device_events',
  'device_status_log', 'device_fingerprints', 'device_hours', 'device_usage_daily',
  'device_settings', 'device_sublist_state', 'device_zone_playlists', 'play_logs',
  'screenshots', 'player_debug_logs', 'contratos_limites', 'contratos_suspensos',
  'content_schedules', 'content_schedule_rules',
];

/* Só aspa simples precisa dobrar: standard_conforming_strings é o padrão do Postgres. */
function valor(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

console.log('BEGIN;');
console.log('TRUNCATE ' + TABELAS.map((t) => '"' + t + '"').join(', ') + ' CASCADE;');

let total = 0;
for (const t of TABELAS) {
  const linhas = db.prepare('SELECT * FROM ' + t).all();
  for (const linha of linhas) {
    const colunas = Object.keys(linha);
    console.log(
      'INSERT INTO "' + t + '" (' + colunas.map((c) => '"' + c + '"').join(', ') + ') VALUES ('
      + colunas.map((c) => valor(linha[c])).join(', ') + ');',
    );
    total++;
  }
}

/*
 * As sequências dos ids AUTOINCREMENT: sem isto, o primeiro INSERT novo no Postgres
 * nasceria com id 1 e colidiria com o espelho.
 */
for (const t of ['device_telemetry', 'device_events', 'device_status_log', 'playlist_items', 'play_logs', 'screenshots', 'player_debug_logs']) {
  console.log(
    "SELECT setval(pg_get_serial_sequence('\"" + t + "\"', 'id'), COALESCE((SELECT MAX(id) FROM \"" + t + '"), 0) + 1, false);',
  );
}

console.log('COMMIT;');
console.error('espelhadas ' + TABELAS.length + ' tabelas, ' + total + ' linhas');
