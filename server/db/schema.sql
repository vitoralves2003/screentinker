CREATE TABLE IF NOT EXISTS plans (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    max_devices     INTEGER NOT NULL DEFAULT 2,
    max_storage_mb  INTEGER NOT NULL DEFAULT 500,
    remote_control  INTEGER NOT NULL DEFAULT 0,
    remote_url      INTEGER NOT NULL DEFAULT 0,
    priority_support INTEGER NOT NULL DEFAULT 0,
    price_monthly   REAL NOT NULL DEFAULT 0,
    price_yearly    REAL NOT NULL DEFAULT 0,
    stripe_monthly_id TEXT,
    stripe_yearly_id  TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    active          INTEGER NOT NULL DEFAULT 1,
    -- Portas de recurso. Mesma convencao 0/1 de remote_control; aplicadas em
    -- middleware/subscription.js.
    widgets_enabled  INTEGER NOT NULL DEFAULT 0,
    sublists_enabled INTEGER NOT NULL DEFAULT 0,
    layouts_enabled  INTEGER NOT NULL DEFAULT 0,
    -- O modulo de Gestao -- clientes, contratos, cobrancas, financeiro -- e um direito do
    -- plano como qualquer outro. Sem esta porta, a federacao entregaria a Gestao a QUALQUER
    -- plano, inclusive o Free: o endpoint so perguntava quem e a pessoa, nunca o que ela
    -- comprou.
    gestao_enabled   INTEGER NOT NULL DEFAULT 0,
    -- E o espelho: este plano inclui o modulo de Operacao (telas)? Sem ele, um cliente de
    -- Gestao avulsa veria no painel um cartao de telas eternamente zerado -- anunciando um
    -- modulo que ele nao comprou e nao pode usar. Um zero que nao pode mudar nao e
    -- informacao, e propaganda mal colocada.
    operacao_enabled INTEGER NOT NULL DEFAULT 1,
    -- Piso da antiga banda Corporativo, anterior ao modelo de pacote. A coluna fica
    -- porque linhas antigas ainda a carregam; NENHUM plano atual a usa. O Master
    -- cobra por PACOTE (package_size/package_price abaixo), nao por piso.
    min_devices      INTEGER NOT NULL DEFAULT 0,

    -- ================== COMO UM PLANO COBRA ==================
    -- Exatamente um destes tres modos vale, avaliados nesta ordem:
    --
    --   1. package_size > 0      PACOTE (Master). Cada dia consome
    --                            teto(telas_do_dia / package_size) pacotes, e o mes custa
    --                            (soma dos pacotes-dia / dias_do_mes) x package_price.
    --                            Quem abre o segundo pacote no dia 20 paga so os dias em
    --                            que ele esteve aberto -- e quem reduz antes do fim do mes
    --                            tambem para de pagar por ele. Nao existe devolucao porque
    --                            o pacote inteiro nunca chega a ser cobrado.
    --
    --   2. price_per_device > 0  LICENCA-DIA (Pro). A mesma conta, com a tela como unidade.
    --
    --   3. flat_monthly > 0      FIXO (Gestao avulsa). Nao tem telas; o valor nao varia.
    --
    -- Nenhum dos tres = plano gratuito, que nao gera fatura.
    price_per_device REAL NOT NULL DEFAULT 0,
    package_size     INTEGER NOT NULL DEFAULT 0,
    package_price    REAL NOT NULL DEFAULT 0,
    flat_monthly     REAL NOT NULL DEFAULT 0,
    currency        TEXT NOT NULL DEFAULT 'BRL',

    -- ================== ARMAZENAMENTO ==================
    -- Teto = max_storage_mb + storage_mb_per_unit x unidades do plano, onde "unidade" e
    -- a mesma coisa que ele cobra: a tela no Pro, o pacote no Master. Com
    -- storage_mb_cap > 0 o resultado para de crescer ali. Isso existe para o Master nao
    -- acabar com menos espaco que o Pro -- 1 GB por tela ultrapassa um teto fixo de
    -- 25 GB ja na 26a tela, e entao subir de plano REDUZIRIA o armazenamento.
    storage_mb_per_unit INTEGER NOT NULL DEFAULT 0,
    storage_mb_cap      INTEGER NOT NULL DEFAULT 0
);

-- A SEMENTE DOS PLANOS NAO FICA AQUI, e isso e deliberado.
--
-- Este arquivo e exec-ado no boot ANTES das migracoes de coluna (database.js:18).
-- Um INSERT que cite package_size, num banco criado antes dessa coluna existir, falha
-- com "no such column" -- e essa falha nao e capturada, entao o servidor nao sobe.
-- A semente vive na lista de migracoes, depois dos ALTER TABLE, onde as colunas ja
-- existem nos dois casos: banco novo e banco antigo.

CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    email           TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL DEFAULT '',
    password_hash   TEXT,
    auth_provider   TEXT NOT NULL DEFAULT 'local',
    provider_id     TEXT,
    avatar_url      TEXT,
    role            TEXT NOT NULL DEFAULT 'user',
    plan_id         TEXT DEFAULT 'free' REFERENCES plans(id),
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT DEFAULT 'active',
    subscription_ends  INTEGER,
    -- #100: TOTP MFA (opt-in, local accounts only). totp_secret_enc is secretbox-
    -- encrypted (REVERSIBLE - the server recomputes codes). totp_last_step blocks
    -- intra-window replay (a code from an already-consumed 30s step is rejected).
    totp_secret_enc TEXT,
    totp_enabled    INTEGER NOT NULL DEFAULT 0,
    totp_last_step  INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- #100: single-use TOTP recovery codes. SHA-256 hashed (same discipline as
-- api_tokens.token_hash); plaintext shown once at enrollment. used_at NULL = available.
CREATE TABLE IF NOT EXISTS totp_recovery_codes (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash   TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    used_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_totp_recovery_user ON totp_recovery_codes(user_id);

CREATE TABLE IF NOT EXISTS devices (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id),
    name            TEXT NOT NULL DEFAULT 'Unnamed Display',
    pairing_code    TEXT UNIQUE,
    settings_pin    TEXT,
    status          TEXT NOT NULL DEFAULT 'offline',
    blocked         INTEGER NOT NULL DEFAULT 0,
    last_heartbeat  INTEGER,
    ip_address      TEXT,
    android_version TEXT,
    app_version     TEXT,
    screen_width    INTEGER,
    screen_height   INTEGER,
    playlist_id     TEXT REFERENCES playlists(id) ON DELETE SET NULL,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS device_telemetry (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    battery_level   INTEGER,
    battery_charging INTEGER NOT NULL DEFAULT 0,
    storage_free_mb INTEGER,
    storage_total_mb INTEGER,
    ram_free_mb     INTEGER,
    ram_total_mb    INTEGER,
    cpu_usage       REAL,
    wifi_ssid       TEXT,
    wifi_rssi       INTEGER,
    uptime_seconds  INTEGER,
    reported_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_telemetry_device ON device_telemetry(device_id, reported_at DESC);

CREATE TABLE IF NOT EXISTS content (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id),
    filename        TEXT NOT NULL,
    filepath        TEXT NOT NULL DEFAULT '',
    mime_type       TEXT NOT NULL,
    file_size       INTEGER NOT NULL DEFAULT 0,
    duration_sec    REAL,
    thumbnail_path  TEXT,
    width           INTEGER,
    height          INTEGER,
    remote_url      TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    -- Bumped whenever the BYTES change (PUT /:id/replace, and the compression pass in
    -- lib/video-compress.js). Players cache media by id, and an id whose bytes changed
    -- underneath them is the one way a cached asset can be stale forever: the URL is identical,
    -- so every offline cache we have would keep serving the old file. This is what makes the
    -- URL differ exactly when the content differs.
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    -- Loop OS media compression. 'done' is the resting state and the DEFAULT, so every row that
    -- predates compression (and every asset that needs none — images are compressed inline,
    -- remote URLs have no bytes of ours) reads as finished without a backfill.
    --   pending    queued for the video compressor
    --   processing ffmpeg is running on it now
    --   done       compressed, or deliberately left as-is (already small enough / unsupported)
    --   failed     ffmpeg could not do it; the ORIGINAL file is intact and still playable
    processing_status TEXT NOT NULL DEFAULT 'done',
    -- DE QUAL CONTRATO ESTE ARQUIVO E (Etapa 6). O id e da Gestao, que vive noutro banco --
    -- por isso TEXT sem chave estrangeira: uma FK seria uma promessa que este banco nao pode
    -- cumprir. NULL e o normal: material do proprio assinante nao pertence a contrato nenhum.
    contrato_id     TEXT
);

CREATE TABLE IF NOT EXISTS assignments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    content_id      TEXT REFERENCES content(id) ON DELETE CASCADE,
    widget_id       TEXT REFERENCES widgets(id) ON DELETE CASCADE,
    zone_id         TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    duration_sec    INTEGER NOT NULL DEFAULT 10,
    schedule_start  TEXT,
    schedule_end    TEXT,
    schedule_days   TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS screenshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    filepath        TEXT NOT NULL,
    captured_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_screenshots_device ON screenshots(device_id, captured_at DESC);

-- ===================== LAYOUTS & ZONES =====================

CREATE TABLE IF NOT EXISTS layouts (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id),
    team_id         TEXT,
    name            TEXT NOT NULL,
    width           INTEGER NOT NULL DEFAULT 1920,
    height          INTEGER NOT NULL DEFAULT 1080,
    is_template     INTEGER NOT NULL DEFAULT 0,
    template_category TEXT,
    thumbnail_data  TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS layout_zones (
    id              TEXT PRIMARY KEY,
    layout_id       TEXT NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    name            TEXT NOT NULL DEFAULT 'Zone',
    x_percent       REAL NOT NULL DEFAULT 0,
    y_percent       REAL NOT NULL DEFAULT 0,
    width_percent   REAL NOT NULL DEFAULT 100,
    height_percent  REAL NOT NULL DEFAULT 100,
    z_index         INTEGER NOT NULL DEFAULT 0,
    zone_type       TEXT NOT NULL DEFAULT 'content',
    fit_mode        TEXT NOT NULL DEFAULT 'contain',
    background_color TEXT DEFAULT '#000000',
    sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_zones_layout ON layout_zones(layout_id);

-- Seed templates
INSERT OR IGNORE INTO layouts (id, user_id, name, is_template, template_category) VALUES
  ('tpl-fullscreen',  NULL, 'Tela cheia',           1, 'basic'),
  ('tpl-split-h',     NULL, 'Duas colunas',     1, 'split'),
  ('tpl-split-v',     NULL, 'Duas faixas',       1, 'split'),
  ('tpl-l-bar',       NULL, 'Barra em L com letreiro',    1, 'news'),
  ('tpl-pip',         NULL, 'Janela sobreposta',   1, 'overlay'),
  ('tpl-thirds',      NULL, 'Três colunas',         1, 'grid'),
  ('tpl-quad',        NULL, 'Quatro quadrantes',       1, 'grid');

INSERT OR IGNORE INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, sort_order) VALUES
  ('z-fs-1',    'tpl-fullscreen', 'Principal',           0, 0, 100, 100, 0, 0),
  ('z-sh-1',    'tpl-split-h',   'Esquerda',            0, 0, 50, 100, 0, 0),
  ('z-sh-2',    'tpl-split-h',   'Direita',           50, 0, 50, 100, 0, 1),
  ('z-sv-1',    'tpl-split-v',   'Topo',             0, 0, 100, 50, 0, 0),
  ('z-sv-2',    'tpl-split-v',   'Base',          0, 50, 100, 50, 0, 1),
  ('z-lb-1',    'tpl-l-bar',     'Conteúdo principal',    0, 0, 75, 85, 0, 0),
  ('z-lb-2',    'tpl-l-bar',     'Painel lateral',      75, 0, 25, 100, 0, 1),
  ('z-lb-3',    'tpl-l-bar',     'Letreiro inferior',   0, 85, 75, 15, 1, 2),
  ('z-pip-1',   'tpl-pip',       'Fundo',      0, 0, 100, 100, 0, 0),
  ('z-pip-2',   'tpl-pip',       'Janela sobreposta',      65, 5, 30, 30, 1, 1),
  ('z-th-1',    'tpl-thirds',    'Esquerda',            0, 0, 33.33, 100, 0, 0),
  ('z-th-2',    'tpl-thirds',    'Centro',          33.33, 0, 33.34, 100, 0, 1),
  ('z-th-3',    'tpl-thirds',    'Direita',           66.67, 0, 33.33, 100, 0, 2),
  ('z-q-1',     'tpl-quad',      'Superior esquerdo',        0, 0, 50, 50, 0, 0),
  ('z-q-2',     'tpl-quad',      'Superior direito',       50, 0, 50, 50, 0, 1),
  ('z-q-3',     'tpl-quad',      'Inferior esquerdo',     0, 50, 50, 50, 0, 2),
  ('z-q-4',     'tpl-quad',      'Inferior direito',    50, 50, 50, 50, 0, 3);

-- Portrait templates. Zones are percentages, so these differ from the landscape set only in the
-- layout's own width/height and in PROPORTIONS chosen for a tall screen. A landscape template
-- rotated is not a portrait template: "Three Column" at 33% each becomes three tall slivers, and a
-- 15%-tall ticker that reads well across 1080px is a 288px band on a 1920px-tall panel.
INSERT OR IGNORE INTO layouts (id, user_id, name, width, height, is_template, template_category) VALUES
  ('tpl-p-full',    NULL, 'Retrato — tela cheia',         1080, 1920, 1, 'basic'),
  ('tpl-p-halves',  NULL, 'Retrato — duas faixas',              1080, 1920, 1, 'split'),
  ('tpl-p-ticker',  NULL, 'Retrato com letreiro',        1080, 1920, 1, 'news'),
  ('tpl-p-banner',  NULL, 'Retrato com faixa no topo',      1080, 1920, 1, 'news'),
  ('tpl-p-thirds',  NULL, 'Retrato — três faixas',      1080, 1920, 1, 'grid'),
  ('tpl-p-pip',     NULL, 'Retrato com janela sobreposta', 1080, 1920, 1, 'overlay');

INSERT OR IGNORE INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, sort_order) VALUES
  ('z-pf-1',   'tpl-p-full',   'Principal',            0, 0, 100, 100, 0, 0),
  ('z-ph-1',   'tpl-p-halves', 'Topo',             0, 0, 100, 50, 0, 0),
  ('z-ph-2',   'tpl-p-halves', 'Base',          0, 50, 100, 50, 0, 1),
  ('z-pt-1',   'tpl-p-ticker', 'Conteúdo principal',    0, 0, 100, 88, 0, 0),
  ('z-pt-2',   'tpl-p-ticker', 'Letreiro inferior',   0, 88, 100, 12, 1, 1),
  ('z-pb-1',   'tpl-p-banner', 'Faixa superior',      0, 0, 100, 15, 0, 0),
  ('z-pb-2',   'tpl-p-banner', 'Corpo',            0, 15, 100, 85, 0, 1),
  ('z-p3-1',   'tpl-p-thirds', 'Topo',             0, 0, 100, 33.33, 0, 0),
  ('z-p3-2',   'tpl-p-thirds', 'Meio',          0, 33.33, 100, 33.34, 0, 1),
  ('z-p3-3',   'tpl-p-thirds', 'Base',          0, 66.67, 100, 33.33, 0, 2),
  ('z-pp-1',   'tpl-p-pip',    'Fundo',      0, 0, 100, 100, 0, 0),
  ('z-pp-2',   'tpl-p-pip',    'Janela sobreposta',      58, 4, 38, 20, 1, 1);

-- ===================== CONTRATOS SUSPENSOS =====================
--
-- So os SUSPENSOS, e nao um espelho dos contratos. A Operacao nao precisa saber quais existem:
-- precisa saber quais devem parar de exibir. Inserir e suspender; apagar e voltar a exibir.
--
-- Falha aberto: contrato que nao esta aqui exibe normal. Um espelho completo transformaria uma
-- sincronia falha em vitrine preta para quem esta em dia, e esse estrago e maior que um dia a
-- mais de veiculacao de quem nao pagou.
CREATE TABLE IF NOT EXISTS contratos_suspensos (
    contrato_id   TEXT PRIMARY KEY,
    workspace_id  TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    motivo        TEXT,
    suspenso_em   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_contratos_suspensos_ws ON contratos_suspensos(workspace_id);

-- ===================== WIDGETS =====================

CREATE TABLE IF NOT EXISTS widgets (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id),
    team_id         TEXT,
    widget_type     TEXT NOT NULL,
    name            TEXT NOT NULL,
    config          TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== SCHEDULES =====================

CREATE TABLE IF NOT EXISTS schedules (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    device_id       TEXT REFERENCES devices(id) ON DELETE CASCADE,
    group_id        TEXT REFERENCES device_groups(id) ON DELETE SET NULL,
    zone_id         TEXT REFERENCES layout_zones(id) ON DELETE CASCADE,
    content_id      TEXT REFERENCES content(id) ON DELETE CASCADE,
    widget_id       TEXT REFERENCES widgets(id) ON DELETE CASCADE,
    layout_id       TEXT REFERENCES layouts(id) ON DELETE SET NULL,
    playlist_id     TEXT REFERENCES playlists(id) ON DELETE SET NULL,
    title           TEXT NOT NULL DEFAULT '',
    start_time      TEXT NOT NULL,
    end_time        TEXT NOT NULL,
    timezone        TEXT NOT NULL DEFAULT 'UTC',
    recurrence      TEXT,
    recurrence_end  TEXT,
    priority        INTEGER NOT NULL DEFAULT 0,
    enabled         INTEGER NOT NULL DEFAULT 1,
    color           TEXT DEFAULT '#3B82F6',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    CHECK ((device_id IS NOT NULL AND group_id IS NULL) OR (device_id IS NULL AND group_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_schedules_device ON schedules(device_id, enabled);
-- Note: idx_schedules_group is created by the phase4 migration which rebuilds the table

-- ===================== VIDEO WALLS =====================

CREATE TABLE IF NOT EXISTS video_walls (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    team_id         TEXT,
    name            TEXT NOT NULL,
    grid_cols       INTEGER NOT NULL DEFAULT 2,
    grid_rows       INTEGER NOT NULL DEFAULT 2,
    bezel_h_mm      REAL NOT NULL DEFAULT 0,
    bezel_v_mm      REAL NOT NULL DEFAULT 0,
    screen_w_mm     REAL NOT NULL DEFAULT 400,
    screen_h_mm     REAL NOT NULL DEFAULT 225,
    sync_mode       TEXT NOT NULL DEFAULT 'leader',
    leader_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
    content_id      TEXT REFERENCES content(id) ON DELETE SET NULL,
    playlist_id     TEXT REFERENCES playlists(id) ON DELETE SET NULL,
    -- Free-form player rect on the wall canvas (NULL = use bounding box of screens)
    player_x        REAL,
    player_y        REAL,
    player_width    REAL,
    player_height   REAL,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS video_wall_devices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    wall_id         TEXT NOT NULL REFERENCES video_walls(id) ON DELETE CASCADE,
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    grid_col        INTEGER NOT NULL,
    grid_row        INTEGER NOT NULL,
    rotation        INTEGER NOT NULL DEFAULT 0,
    -- Free-form canvas rect (NULL = derive from grid_col/row + bezel as a fallback)
    canvas_x        REAL,
    canvas_y        REAL,
    canvas_width    REAL,
    canvas_height   REAL,
    UNIQUE(wall_id, device_id),
    UNIQUE(wall_id, grid_col, grid_row)
);

-- ===================== TEAMS =====================

CREATE TABLE IF NOT EXISTS teams (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    owner_id        TEXT NOT NULL REFERENCES users(id),
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS team_members (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'viewer',
    invited_by      TEXT REFERENCES users(id),
    joined_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(team_id, user_id)
);

CREATE TABLE IF NOT EXISTS team_invites (
    id              TEXT PRIMARY KEY,
    team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    email           TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'viewer',
    invited_by      TEXT NOT NULL REFERENCES users(id),
    expires_at      INTEGER NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== PROOF-OF-PLAY =====================

-- A report handed to somebody outside this system, and the code that lets them check it.
-- See lib/report-verify.js for why the numbers are frozen rather than re-queried.
CREATE TABLE IF NOT EXISTS report_exports (
    code            TEXT PRIMARY KEY,
    workspace_id    TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
    type            TEXT NOT NULL,
    subject_id      TEXT,
    -- The subject's name AS IT WAS. Same reasoning as play_logs.content_name: a receipt has to keep
    -- naming what it was about after the screen is unpaired or the file deleted, or the customer
    -- checking it a month later is shown a blank where their advertisement used to be.
    subject_name    TEXT NOT NULL DEFAULT '',
    period_start    TEXT NOT NULL,
    period_end      TEXT NOT NULL,
    -- The figures the PDF printed, frozen. NOT re-queried on verification: the log is pruned at 90
    -- days and a screen may be reassigned, so a live number would disagree with the paper for
    -- reasons that have nothing to do with whether the paper was honest.
    summary_json    TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_report_exports_ws ON report_exports(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS play_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    content_id      TEXT REFERENCES content(id) ON DELETE SET NULL,
    widget_id       TEXT REFERENCES widgets(id) ON DELETE SET NULL,
    zone_id         TEXT,
    -- Which list this play came from. SET NULL rather than CASCADE: deleting a playlist must not
    -- delete the record that its content was on screen — that history is the proof of play.
    playlist_id     TEXT REFERENCES playlists(id) ON DELETE SET NULL,
    -- Its index (idx_play_logs_playlist) lives in the migrations array, not here. This file is
    -- exec-ed against EXISTING databases too, where the CREATE TABLE above is a no-op — so an
    -- index naming a column the migrations have not added yet aborts boot before they can run.
    content_name    TEXT NOT NULL DEFAULT '',
    -- The list's name AS IT WAS, for the same reason content_name is here: SET NULL above keeps
    -- the play when the list is deleted, but takes the only way to say what it was with it. A
    -- report that says "list not recorded" for a list that ran for a year, because somebody
    -- tidied it up last week, is not proof of anything.
    playlist_name   TEXT NOT NULL DEFAULT '',
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    duration_sec    INTEGER,
    completed       INTEGER NOT NULL DEFAULT 0,
    trigger_type    TEXT DEFAULT 'playlist',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_play_logs_device ON play_logs(device_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_logs_content ON play_logs(content_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_logs_time ON play_logs(started_at, ended_at);

-- ===================== DEVICE GROUPS =====================

CREATE TABLE IF NOT EXISTS device_groups (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    name            TEXT NOT NULL,
    color           TEXT DEFAULT '#3B82F6',
    playlist_id     TEXT REFERENCES playlists(id) ON DELETE SET NULL,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS device_group_members (
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    group_id        TEXT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (device_id, group_id)
);

-- ===================== PLAYLISTS =====================

CREATE TABLE IF NOT EXISTS playlists (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    name            TEXT NOT NULL,
    description     TEXT DEFAULT '',
    is_auto_generated INTEGER NOT NULL DEFAULT 0,
    -- DE QUAL CONTRATO ESTA LISTA E (Etapa 7). O id vem da Gestao, noutro banco -- por isso TEXT
    -- sem chave estrangeira, como content.contrato_id.
    --
    -- NAO se confunde com is_auto_generated: aquilo e "o espaco proprio de UMA TELA", e uma lista
    -- de contrato vai para VARIAS. Duas coisas diferentes com a mesma marca viram a mesma coisa
    -- no primeiro WHERE que alguem escrever.
    contrato_id     TEXT,
    status          TEXT NOT NULL DEFAULT 'draft',
    -- What devices consume: the flat, fully-resolved item list. With sub-lists in play this is
    -- N flattened passes (see lib/sublists.js), so it no longer maps 1:1 to editor rows.
    published_snapshot TEXT,
    -- The same publish, BEFORE sub-list expansion: one entry per editor row. This is what
    -- POST /:id/discard rebuilds playlist_items from — reverting from published_snapshot would
    -- otherwise re-create every pass as real rows.
    published_draft TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS playlist_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id     TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    content_id      TEXT REFERENCES content(id) ON DELETE CASCADE,
    widget_id       TEXT REFERENCES widgets(id) ON DELETE CASCADE,
    -- Loop OS sub-lists: an item may instead point at ANOTHER playlist, which contributes one
    -- of its own items per pass through the parent (a rotating slot). TEXT, because playlists.id
    -- is a uuid — not the INTEGER that playlist_items.id happens to be.
    --
    -- Exactly one of content_id / widget_id / sub_playlist_id is set. That invariant is enforced
    -- in the application (lib/sublists.js), not as a CHECK constraint: adding one to this table
    -- would mean a full SQLite table rebuild, and playlist_items is referenced by
    -- playlist_item_schedules and read by every publish — not worth the rebuild risk for a rule
    -- only two routes can violate.
    --
    -- ON DELETE CASCADE: deleting a playlist that is used as a sub-list removes the slots that
    -- pointed at it, rather than leaving items that resolve to nothing.
    sub_playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE,
    zone_id         TEXT REFERENCES layout_zones(id) ON DELETE SET NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    duration_sec    INTEGER NOT NULL DEFAULT 10,
    muted           INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Where each device has got to in each sub-list's rotation. TELEMETRY ONLY: the rotation itself
-- is resolved at publish time (lib/sublists.js), and the player keeps its own local copy so a
-- content switch never waits on a round-trip. Losing this table costs reporting, not playback.
-- `size` is recorded with the cursor so a report stays readable after the sub-list is edited.
CREATE TABLE IF NOT EXISTS device_sublist_state (
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    sub_playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    cursor_index    INTEGER NOT NULL DEFAULT 0,
    size            INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (device_id, sub_playlist_id)
);

-- Per-playlist-item schedule blocks (#74 dayparting + #75 expiry). 1-to-many:
-- an item with ZERO rows here is always on; otherwise it shows when device-local
-- "now" matches at least one block. Wall-clock rules (local HH:MM + local dates),
-- evaluated on the device via the shared evaluator (server/lib/schedule-eval.js).
-- Pure child of playlist_items: cascade-deleted, and tenant isolation flows
-- through the parent item/playlist, so no workspace_id is needed here.
CREATE TABLE IF NOT EXISTS playlist_item_schedules (
    id               TEXT PRIMARY KEY,
    playlist_item_id INTEGER NOT NULL REFERENCES playlist_items(id) ON DELETE CASCADE,
    active_days      TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',  -- comma-separated 0(Sun)-6(Sat)
    start_time       TEXT NOT NULL DEFAULT '00:00',          -- local HH:MM
    end_time         TEXT NOT NULL DEFAULT '24:00',          -- local HH:MM ("24:00" = end of day)
    start_date       TEXT,                                   -- local YYYY-MM-DD, nullable = no lower bound
    end_date         TEXT,                                   -- local YYYY-MM-DD, nullable = no upper bound
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_playlist_item_schedules_item ON playlist_item_schedules(playlist_item_id);

-- ===================== ACTIVITY LOG =====================

CREATE TABLE IF NOT EXISTS activity_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT REFERENCES users(id),
    device_id       TEXT,
    action          TEXT NOT NULL,
    details         TEXT,
    ip_address      TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_log_time ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id, created_at DESC);

-- ===================== EMAIL ALERTS =====================

-- ===================== WHITE LABEL =====================

CREATE TABLE IF NOT EXISTS white_labels (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    brand_name      TEXT NOT NULL DEFAULT 'ScreenTinker',
    logo_url        TEXT,
    favicon_url     TEXT,
    primary_color   TEXT DEFAULT '#3B82F6',
    secondary_color TEXT DEFAULT '#1E293B',
    bg_color        TEXT DEFAULT '#111827',
    custom_domain   TEXT,
    custom_css      TEXT,
    hide_branding   INTEGER DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== AI (BYOK) SETTINGS =====================
-- #41: per-workspace AI design generation. Bring-your-own OpenAI-COMPATIBLE
-- endpoint (OpenAI cloud, or self-hosted: Ollama / LM Studio / llama.cpp, and
-- AUTOMATIC1111 etc. for images), so the operator bears no AI cost. api_key_enc
-- is AES-256-GCM encrypted (lib/secretbox.js); it is never returned to clients.
CREATE TABLE IF NOT EXISTS ai_settings (
    workspace_id    TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    base_url        TEXT,
    api_key_enc     TEXT,
    model           TEXT,
    image_base_url  TEXT,
    image_model     TEXT,
    image_provider  TEXT,
    image_api_key_enc TEXT,
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== KIOSK PAGES =====================

CREATE TABLE IF NOT EXISTS kiosk_pages (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    name            TEXT NOT NULL,
    config          TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== DEVICE STATUS LOG =====================

CREATE TABLE IF NOT EXISTS device_status_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL,
    status          TEXT NOT NULL,
    timestamp       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
-- #142: index the per-device + time-window access pattern. Both the dashboard
-- uptime query (WHERE device_id=? AND timestamp>?) and the retention prune
-- (WHERE device_id=? AND timestamp<?) were full table scans; at 1M+ rows that
-- was the dashboard-degradation cause in the outage report.
CREATE INDEX IF NOT EXISTS idx_device_status_log_device_ts ON device_status_log(device_id, timestamp);

-- ===================== EVENT LOOP LAG (#142) =====================
-- Event-loop delay telemetry from perf_hooks.monitorEventLoopDelay(). Bounded
-- from day one: indexed on sampled_at and pruned on a schedule (see
-- services/loop-lag.js, LAG_TELEMETRY_RETENTION_DAYS) so it can never become a
-- second unbounded-growth table.
CREATE TABLE IF NOT EXISTS event_loop_lag (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sampled_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    mean_ms     REAL NOT NULL,
    p50_ms      REAL NOT NULL,
    p99_ms      REAL NOT NULL,
    max_ms      REAL NOT NULL,
    band        TEXT NOT NULL DEFAULT 'normal'
);
CREATE INDEX IF NOT EXISTS idx_event_loop_lag_sampled ON event_loop_lag(sampled_at);

-- ===================== DEVICE FINGERPRINTS =====================

CREATE TABLE IF NOT EXISTS device_fingerprints (
    fingerprint     TEXT NOT NULL,
    device_id       TEXT REFERENCES devices(id) ON DELETE SET NULL,
    user_id         TEXT REFERENCES users(id),
    first_seen      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_seen       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (fingerprint)
);

CREATE TABLE IF NOT EXISTS alert_configs (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    alert_type      TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    config          TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== PLAYER DEBUG LOGS =====================
-- Smart TVs (Tizen, WebOS, Fire TV, etc.) have no accessible devtools. The
-- player captures errors into window.__debugLog client-side and POSTs them
-- to /api/player-debug. This table stores those reports. Submitter is
-- unauthenticated by design - the player may not have paired yet when an
-- error fires. device_id is nullable for unpaired players.
--
-- Capped at 10,000 rows with FIFO eviction on insert (route-side, no sweep).
-- error_fingerprint is a client-computed hash of (error message + first stack
-- frame) - indexed so a future "top N unique errors this week" query is fast
-- without a schema change.

CREATE TABLE IF NOT EXISTS player_debug_logs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id         TEXT,
    ip                TEXT,
    user_agent        TEXT,
    url               TEXT,
    error_fingerprint TEXT,
    error_data        TEXT,
    context           TEXT,
    created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_player_debug_fingerprint ON player_debug_logs(error_fingerprint);
CREATE INDEX IF NOT EXISTS idx_player_debug_created_at ON player_debug_logs(created_at);

-- ===================== API TOKENS (public API, Phase 1) =====================
-- Scoped personal access tokens for the public API. The full token (st_...) is
-- shown to its owner exactly once at creation; only its SHA-256 hash is stored.
-- A token is bound to ONE workspace and a scope (read|write|full) and always acts
-- with the owner's workspace role - never platform/cross-org powers (apiTokenAuth
-- forces the effective platform role to 'user').
CREATE TABLE IF NOT EXISTS api_tokens (
    id              TEXT PRIMARY KEY,
    token_hash      TEXT NOT NULL UNIQUE,                     -- SHA-256 hex of the full token
    prefix          TEXT NOT NULL,                            -- e.g. 'st_a1b2c3d4' (display only)
    name            TEXT NOT NULL,                            -- user-given label
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    scope           TEXT NOT NULL DEFAULT 'read',             -- 'read' | 'write' | 'full' | 'agency' | 'billing:read'
    auto_publish    INTEGER NOT NULL DEFAULT 0,                -- #73: agency only. 0 = items land DRAFT (default, fail-safe); 1 = admin opted this agency out of approval
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_used_at    INTEGER,
    revoked_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);

-- #73: target allowlist for capability-restricted ('agency') tokens. An agency token
-- (scope='agency', OFF the read/write/full ladder so tokenScopeGate rejects it on every
-- other router) may act ONLY on the playlists listed here, enforced at the single
-- agencyGate seam. FK cascade both ways: revoke the token or delete the playlist and the
-- grant disappears.
CREATE TABLE IF NOT EXISTS api_token_targets (
    token_id    TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (token_id, playlist_id)
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

-- #73: agency-upload notification queue. The agency endpoint enqueues one row per item added
-- (only when email is configured); a 15-min flush job groups per token+playlist+action and
-- sends one digest per group, stamping sent_at ONLY after a successful send (failed -> retry).
CREATE TABLE IF NOT EXISTS agency_notifications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    token_id     TEXT NOT NULL,
    playlist_id  TEXT NOT NULL,
    action       TEXT NOT NULL,                            -- 'draft' | 'published'
    content_id   TEXT,
    created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    sent_at      INTEGER                                   -- NULL = unsent
);
CREATE INDEX IF NOT EXISTS idx_agency_notifications_unsent ON agency_notifications(sent_at);

-- ===================== SCHEMA MIGRATIONS =====================

CREATE TABLE IF NOT EXISTS schema_migrations (
    id              TEXT PRIMARY KEY,
    ran_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
