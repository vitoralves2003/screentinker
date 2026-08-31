const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { PLATFORM_ROLES, ELEVATED_ROLES } = require('../middleware/auth');
// Phase 2.2j: workspace-aware access. Underlying tables (devices, playlists)
// already carry workspace_id from Phase 1; this route can use them even
// though playlists.js itself isn't yet workspace-filtered.
const { accessContext } = require('../lib/tenancy');
const { zoneInLayout } = require('../lib/zone-validate');
// #237 + #widget zero-duration loop: one place decides what duration a new item gets —
// explicit value, else the content's own length, else the 10s default (and never a 0).
const { resolveItemDuration } = require('../lib/item-duration');
/*
 * As regras de uma lista dentro de um espaco vem de lib/sublists.js, e nao de uma copia
 * aqui: duas portas para a mesma tabela nao podem discordar sobre o que e valido.
 */
const { requireSingleTarget, validateSubList, SubListError } = require('../lib/sublists');
const { checkSublistsEnabled } = require('../middleware/subscription');

// Como o espaco de uma lista toca dentro da tela. Validado contra esta lista, e nao aceito
// como texto livre: um valor desconhecido cairia em sequencial sem avisar, e "marquei
// aleatorio e toca em ordem" e um defeito que ninguem consegue ver.
const SUB_ORDERS = ['sequence', 'random'];

/*
 * PoR UMA LISTA NUMA TELA E PAGO; por um arquivo, nao.
 *
 * A trava roda SO quando o pedido traz uma lista. Um middleware geral neste router trancaria
 * adicionar um arquivo comum a uma tela atras do upgrade -- que e o caminho mais curto do
 * produto, e nao e o que se esta vendendo.
 */
function gateListaNaTela(req, res, next) {
  if (!req.body || !req.body.sub_playlist_id) return next();
  return checkSublistsEnabled(req, res, next);
}

// Mark playlist as draft (called after any item mutation)
/*
 * O ESPAÇO PRÓPRIO DA TELA PUBLICA NA HORA; a lista compartilhada vira rascunho.
 *
 * O par rascunho/publicado existe para alguém editar uma lista COMPARTILHADA sem mexer, no meio
 * da edição, nas telas que a rodam. O espaço próprio de uma tela não tem essa necessidade: você
 * está editando aquela tela, e o que você põe nela é o que ela deve exibir.
 *
 * Antes disto, pôr um arquivo numa tela devolvia 201, gravava o item, marcava rascunho — e o
 * `published_snapshot` que o player lê não mudava. A parede não mudava, e o aviso que explicaria
 * isso estava na OUTRA aba, porque a Etapa 5 moveu o conteúdo para "Conteúdos" e deixou o banner
 * em "Configurações". O passo obrigatório que a Etapa 5 apagou tinha voltado pela porta dos
 * fundos, e em silêncio.
 */
function aplicarNaTela(playlistId, req) {
  const pl = db.prepare('SELECT is_auto_generated FROM playlists WHERE id = ?').get(playlistId);

  if (pl && pl.is_auto_generated) {
    // Exigido aqui dentro: routes/playlists.js requer este arquivo de volta, e pedi-lo no topo
    // fecharia o ciclo.
    const { publishPlaylist } = require('./playlists');
    publishPlaylist(playlistId, req || null);
    return;
  }

  db.prepare("UPDATE playlists SET status = 'draft', updated_at = strftime('%s','now') WHERE id = ?").run(playlistId);
}

// Hardening (#zone-orphan): a zone_id only renders if it belongs to the layout the
// device is actually showing. Assigning a zone from a DIFFERENT layout (e.g. after a
// layout switch/duplicate) creates an item that the players can't place. We CLEAR a
// stale zone_id to null here (-> "unassigned", which the players route sensibly) rather
// than reject, so this can't break a caller; the cleared write is logged. NOTE for
// review: switch to a 400 reject if you'd rather surface the bad zone to the operator.
// Returns the zone_id to persist (the given one, or null if it isn't in the device's
// active layout). deviceLayoutId may be null (device on fullscreen) -> any zone_id is
// stale, so cleared.
function validZoneForLayout(zoneId, deviceLayoutId, ctx) {
  if (!zoneId) return null;
  if (zoneInLayout(zoneId, deviceLayoutId)) return zoneId;
  console.warn(`[assign] cleared stale zone_id ${zoneId} (not in active layout ${deviceLayoutId || 'none'})${ctx ? ' ' + ctx : ''}`);
  return null;
}

// Phase 2.2j: workspace-aware device access check. Returns access context
// (with workspaceRole/actingAs) or null. Caller decides if read or write.
function checkDeviceAccess(req, res, paramName = 'deviceId', requireWrite = true) {
  const device = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(req.params[paramName]);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return null; }
  if (!device.workspace_id) { res.status(403).json({ error: 'Device not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (requireWrite && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return { device, ctx };
}

// Ensure device has a playlist; auto-create one if missing.
// Phase 2.2j: stamps workspace_id on the auto-created playlist so it remains
// visible once playlists.js migrates. Mirrors the 2.2i fix in device-groups.js.
function ensureDevicePlaylist(deviceId, userId) {
  const device = db.prepare('SELECT playlist_id, workspace_id, name FROM devices WHERE id = ?').get(deviceId);

  if (device?.playlist_id) {
    const atual = db.prepare('SELECT id, is_auto_generated FROM playlists WHERE id = ?').get(device.playlist_id);

    /*
     * A LISTA ATUAL E COMPARTILHADA: ela nao e o espaco desta tela, e sim uma lista que a tela
     * roda -- o modelo antigo, "escolha qual lista esta tela exibe".
     *
     * Se devolvessemos o id dela, o proximo arquivo adicionado A ESTA TELA cairia dentro da
     * lista de todo mundo, editando em silencio todas as telas que a rodam. Nada daria erro; o
     * video so apareceria onde nao devia.
     *
     * Entao a tela ganha o espaco dela agora, e a lista compartilhada entra nesse espaco como
     * ITEM. O que esta no ar continua no ar -- mesma lista, mesmo conteudo, mesma rotacao --
     * e o que muda e so quem e o dono do espaco.
     */
    if (atual && !atual.is_auto_generated) {
      const proprio = uuidv4();
      db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, is_auto_generated) VALUES (?, ?, ?, ?, 1)')
        .run(proprio, userId, device.workspace_id || null, `${device.name || 'Display'} playlist`);
      db.prepare('INSERT INTO playlist_items (playlist_id, sub_playlist_id, sub_order, sort_order) VALUES (?, ?, ?, ?)')
        .run(proprio, atual.id, 'sequence', 1);
      db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(proprio, deviceId);
      console.warn(`[assign] tela ${deviceId}: "${device.name}" rodava a lista compartilhada ${atual.id}; ela virou item do espaco proprio ${proprio}`);
      return proprio;
    }

    return device.playlist_id;
  }

  const playlistId = uuidv4();
  db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, is_auto_generated) VALUES (?, ?, ?, ?, 1)')
    .run(playlistId, userId, device?.workspace_id || null, `${device?.name || 'Display'} playlist`);
  db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(playlistId, deviceId);
  return playlistId;
}

// Standard item query with joined content/widget info
const ITEM_SELECT = `
  SELECT pi.id, pi.playlist_id, pi.content_id, pi.widget_id, pi.zone_id, pi.sort_order, pi.duration_sec, pi.muted,
         pi.created_at, pi.updated_at,
         /*
          * O NOME DE UM ITEM vem de onde ele existe: arquivo, widget, ou a lista que ele
          * representa. Sem o terceiro, uma lista posta numa tela grava certo e aparece SEM
          * NOME -- pior que nao poder poe-la.
          */
         COALESCE(c.filename, w.name, sp.name) as filename,
         pi.sub_playlist_id, pi.sub_order, sp.name as sub_playlist_name,
         (SELECT COUNT(*) FROM playlist_items spi WHERE spi.playlist_id = pi.sub_playlist_id) as sub_playlist_count,
         c.mime_type, c.filepath, c.thumbnail_path,
         c.duration_sec as content_duration, c.file_size, c.remote_url,
         w.name as widget_name, w.widget_type, w.config as widget_config
  FROM playlist_items pi
  LEFT JOIN content c ON pi.content_id = c.id
  LEFT JOIN widgets w ON pi.widget_id = w.id
  LEFT JOIN playlists sp ON pi.sub_playlist_id = sp.id
`;

// Get assignments (playlist items) for a device
router.get('/device/:deviceId', (req, res) => {
  if (!checkDeviceAccess(req, res, 'deviceId', false)) return;
  const device = db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!device?.playlist_id) return res.json([]);

  const items = db.prepare(`${ITEM_SELECT} WHERE pi.playlist_id = ? ORDER BY pi.sort_order ASC`)
    .all(device.playlist_id);
  res.json(items);
});

// Add content or widget to device playlist.
// Phase 2.2j: closes 2 pre-existing cross-tenant leaks:
//   1. Content gate: today checks content.user_id == caller. A workspace_admin
//      who happens to own content in another workspace could push it into a
//      device in this workspace. Now: content must be in device's workspace
//      (or be a platform-template, workspace_id IS NULL).
//   2. Widget gate: today checks ONLY existence - any user could attach any
//      widget UUID to their own device's playlist. Now: widget must be in
//      device's workspace (or be a platform-template).
router.post('/device/:deviceId', gateListaNaTela, (req, res) => {
  const access = checkDeviceAccess(req, res, 'deviceId', true);
  if (!access) return;
  const { content_id, widget_id, sub_playlist_id, zone_id, sort_order, sub_order } = req.body;

  /*
   * UM ITEM E UMA COISA SO: um arquivo, um widget, ou uma lista. Dois alvos na mesma linha a
   * deixam ambigua, e o snapshot escolheria o que o COALESCE alcancasse primeiro -- uma decisao
   * tomada por acidente.
   */
  try { requireSingleTarget({ content_id, widget_id, sub_playlist_id }); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  if (sub_order !== undefined && !SUB_ORDERS.includes(sub_order)) {
    return res.status(400).json({ error: `sub_order must be one of: ${SUB_ORDERS.join(', ')}` });
  }

  let content = null;
  if (content_id) {
    content = db.prepare('SELECT id, workspace_id, duration_sec FROM content WHERE id = ?').get(content_id);
    if (!content) return res.status(404).json({ error: 'Content not found' });
    if (content.workspace_id && content.workspace_id !== access.device.workspace_id) {
      return res.status(403).json({ error: 'Content is not in this device\'s workspace' });
    }
  }
  // #237: pushing a video straight at a display is the shortest path in the product, so it
  // has to default to the clip's length too — not the 10s that cut it off mid-play.
  const duration_sec = resolveItemDuration(req.body.duration_sec, content);
  if (widget_id) {
    const widget = db.prepare('SELECT id, workspace_id FROM widgets WHERE id = ?').get(widget_id);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    if (widget.workspace_id && widget.workspace_id !== access.device.workspace_id) {
      return res.status(403).json({ error: 'Widget is not in this device\'s workspace' });
    }
  }

  const playlistId = ensureDevicePlaylist(req.params.deviceId, req.user.id);

  /*
   * A VALIDACAO SO CABE AQUI, porque ela precisa saber qual e o espaco da TELA -- e ate esta
   * linha a tela pode nao ter nenhum. `ensureDevicePlaylist` acabou de garantir que tem.
   *
   * Ela cobre tres coisas que nao da para conferir depois: uma lista nao pode conter a si mesma,
   * nao pode vir de outro workspace, e o aninhamento para em UM nivel -- nos dois sentidos,
   * porque tanto "esta lista ja tem listas dentro" quanto "esta lista ja esta dentro de outra"
   * quebram a expansao do snapshot.
   */
  if (sub_playlist_id) {
    try { validateSubList(playlistId, sub_playlist_id, access.device.workspace_id); }
    catch (e) {
      if (e instanceof SubListError) return res.status(e.status || 400).json({ error: e.message });
      throw e;
    }
  }

  // Hardening: clear a zone_id that isn't in THIS device's active layout (prevents new orphans).
  const devLayout = db.prepare('SELECT layout_id FROM devices WHERE id = ?').get(req.params.deviceId);
  const effZone = validZoneForLayout(zone_id, devLayout?.layout_id, `on add to device ${req.params.deviceId}`);

  let order = sort_order;
  if (order === undefined || order === null) {
    const max = db.prepare('SELECT MAX(sort_order) as max_order FROM playlist_items WHERE playlist_id = ?')
      .get(playlistId);
    order = (max.max_order || 0) + 1;
  }

  /*
   * sub_order fica 'sequence' mesmo quando o item NAO e uma lista -- e nao null.
   *
   * A coluna e NOT NULL DEFAULT 'sequence' (veio de uma migracao, nao esta no schema.sql), entao
   * um null explicito estoura. E estoura em TODA adicao de arquivo a uma tela, nao so nas listas:
   * o caminho mais usado do produto quebraria inteiro.
   *
   * Escrevi `: null` por parecer mais honesto ("este item nao e lista, entao nao tem ordem"). A
   * rota vizinha em playlists.js escreve `: 'sequence'` desde sempre, e bastava copiar o vizinho
   * em vez de inventar uma variante. Os testes de atribuicao pegaram na hora.
   */
  try {
    const result = db.prepare(`
      INSERT INTO playlist_items (playlist_id, content_id, widget_id, sub_playlist_id, sub_order, zone_id, sort_order, duration_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(playlistId, content_id || null, widget_id || null, sub_playlist_id || null,
           sub_playlist_id ? (sub_order || 'sequence') : 'sequence', effZone, order, duration_sec);

    aplicarNaTela(playlistId, req);

    const item = db.prepare(`${ITEM_SELECT} WHERE pi.id = ?`).get(result.lastInsertRowid);
    res.status(201).json(item);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Content already in playlist' });
    }
    throw err;
  }
});

// Helper: load a playlist item and check write access via the parent
// playlist's workspace. Returns the item row or null after sending 403/404.
function checkItemWrite(req, res) {
  const item = db.prepare('SELECT pi.*, p.workspace_id AS pl_workspace_id FROM playlist_items pi JOIN playlists p ON pi.playlist_id = p.id WHERE pi.id = ?').get(req.params.id);
  if (!item) { res.status(404).json({ error: 'Item not found' }); return null; }
  if (!item.pl_workspace_id) { res.status(403).json({ error: 'Playlist not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(item.pl_workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return item;
}

// #129 + mute-fix: per-item mute has to do TWO things, because the device plays from
// playlists.published_snapshot (deviceSocket.buildPlaylistPayload), NOT the draft
// playlist_items the toggle writes:
//   (1) LIVE — tell every device on this playlist to silence the matching currently-playing
//       item NOW (device matches by content_id/widget_id). Mutes the in-progress playthrough.
//   (2) PERSIST — patch the matching item's `muted` inside the published_snapshot the device
//       actually plays, then re-push the playlist. Without this the snapshot kept muted=0, so
//       every loop/reload re-applied full volume — the "icon red but audio plays across 3
//       playthroughs" bug (Android re-loads each loop; web's native <video> loop masked it).
// We patch the snapshot SURGICALLY (just the muted field of matching items) rather than calling
// publishPlaylist, so a mute toggle can't prematurely publish other pending draft edits or flip
// the playlist's draft/published status. muted is written as 0/1 to match buildSnapshotItems'
// format (the player reads it via optInt). playlist_items.muted is still updated by the caller,
// so a later full publish stays consistent.
function emitMuteChanged(req, item, muted) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const deviceNs = io.of('/device');
    const m = !!muted;

    // (2) PERSIST: patch the published snapshot the device reads from.
    const pl = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(item.playlist_id);
    if (pl && pl.published_snapshot) {
      let snap = null;
      try { snap = JSON.parse(pl.published_snapshot); } catch (e) { snap = null; }
      if (Array.isArray(snap)) {
        let changed = false;
        for (const s of snap) {
          const match = item.content_id ? s.content_id === item.content_id
            : (item.widget_id ? s.widget_id === item.widget_id : false);
          if (match && (s.muted ? 1 : 0) !== (m ? 1 : 0)) { s.muted = m ? 1 : 0; changed = true; }
        }
        if (changed) {
          db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?')
            .run(JSON.stringify(snap), item.playlist_id);
        }
      }
    }

    // (1) LIVE toggle + re-deliver the patched snapshot so loops re-apply the correct flag.
    // Lazy require (matches playlists.pushToDevices) to avoid a route<->ws circular import.
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const devices = db.prepare('SELECT id FROM devices WHERE playlist_id = ?').all(item.playlist_id);
    const payload = { content_id: item.content_id || null, widget_id: item.widget_id || null, muted: m };
    for (const d of devices) {
      deviceNs.to(d.id).emit('device:mute-changed', payload);                        // current playthrough
      commandQueue.queueOrEmitPlaylistUpdate(deviceNs, d.id, buildPlaylistPayload);  // future loads (no reload of current item)
    }
    console.log(`[mute] item ${item.id} (content ${item.content_id || item.widget_id}) -> ${m ? 'MUTED' : 'unmuted'}; snapshot patched + notified ${devices.length} device(s)`);
  } catch (e) { /* best-effort; playlist_items.muted is still updated for the next full publish */ }
}

// Update playlist item
router.put('/:id', (req, res) => {
  const item = checkItemWrite(req, res);
  if (!item) return;

  const { sort_order, duration_sec, zone_id, muted } = req.body;
  const updates = [];
  const values = [];

  if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }
  if (duration_sec !== undefined) { updates.push('duration_sec = ?'); values.push(resolveItemDuration(duration_sec, null)); }
  // zone_id can be null (clear the zone) - treat undefined as "no change",
  // any other value (including null) as "write this".
  if (zone_id !== undefined) {
    // Hardening: if this playlist is bound to exactly ONE device with a layout, clear a
    // zone_id that isn't in that layout (prevents new orphans). Multi-device / fullscreen
    // playlists can't be bound to one layout here, so we leave those to the player fallback.
    let effZone = zone_id || null;
    if (effZone) {
      const devs = db.prepare('SELECT layout_id FROM devices WHERE playlist_id = ? AND layout_id IS NOT NULL').all(item.playlist_id);
      if (devs.length === 1) effZone = validZoneForLayout(effZone, devs[0].layout_id, `on update of item ${req.params.id}`);
    }
    updates.push('zone_id = ?'); values.push(effZone);
  }
  // #129: per-item mute (coerced to 0/1). Was silently dropped here before, so the
  // dashboard toggle did nothing.
  const mutedChanged = muted !== undefined && (item.muted ? 1 : 0) !== (muted ? 1 : 0);
  if (muted !== undefined) { updates.push('muted = ?'); values.push(muted ? 1 : 0); }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.id);
    db.prepare(`UPDATE playlist_items SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    aplicarNaTela(item.playlist_id, req);
    if (mutedChanged) emitMuteChanged(req, item, muted ? 1 : 0);
  }

  const updated = db.prepare(`${ITEM_SELECT} WHERE pi.id = ?`).get(req.params.id);
  res.json(updated);
});

// Delete playlist item
router.delete('/:id', (req, res) => {
  const item = checkItemWrite(req, res);
  if (!item) return;

  db.prepare('DELETE FROM playlist_items WHERE id = ?').run(req.params.id);
  aplicarNaTela(item.playlist_id, req);

  res.json({ success: true, content_id: item.content_id });
});

// Reorder items for a device's playlist
router.post('/device/:deviceId/reorder', (req, res) => {
  if (!checkDeviceAccess(req, res, 'deviceId', true)) return;
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of item IDs' });

  const device = db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!device?.playlist_id) return res.json([]);

  const updateStmt = db.prepare('UPDATE playlist_items SET sort_order = ? WHERE id = ? AND playlist_id = ?');
  const transaction = db.transaction(() => {
    order.forEach((itemId, index) => {
      updateStmt.run(index, itemId, device.playlist_id);
    });
  });
  transaction();

  aplicarNaTela(device.playlist_id, req);

  const items = db.prepare(`${ITEM_SELECT} WHERE pi.playlist_id = ? ORDER BY pi.sort_order ASC`)
    .all(device.playlist_id);
  res.json(items);
});

// Copy playlist from one device to another.
// Phase 2.2j: closes a pre-existing cross-tenant leak. Today both deviceIds
// only got the user_id ownership check; a caller with reach into a foreign
// workspace could copy that workspace's playlist into a device in their own
// workspace (or vice versa). Now: both devices must be in the same workspace,
// and the caller must have write access there.
router.post('/device/:deviceId/copy-to/:targetDeviceId', (req, res) => {
  const sourceAccess = checkDeviceAccess(req, res, 'deviceId', true);
  if (!sourceAccess) return;
  const targetAccess = checkDeviceAccess(req, res, 'targetDeviceId', true);
  if (!targetAccess) return;
  if (sourceAccess.device.workspace_id !== targetAccess.device.workspace_id) {
    return res.status(403).json({ error: 'Source and target devices must be in the same workspace' });
  }

  const sourceDevice = db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!sourceDevice?.playlist_id) return res.status(404).json({ error: 'Source device has no playlist' });

  const sourceItems = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order')
    .all(sourceDevice.playlist_id);
  if (!sourceItems.length) return res.status(404).json({ error: 'Source playlist is empty' });

  const target = db.prepare('SELECT id, user_id FROM devices WHERE id = ?').get(req.params.targetDeviceId);
  if (!target) return res.status(404).json({ error: 'Target device not found' });

  const targetPlaylistId = ensureDevicePlaylist(req.params.targetDeviceId, target.user_id || req.user.id);

  if (req.body.replace) {
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(targetPlaylistId);
  }

  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM playlist_items WHERE playlist_id = ?')
    .get(targetPlaylistId).m || 0;
  const stmt = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, widget_id, zone_id, sort_order, duration_sec) VALUES (?, ?, ?, ?, ?, ?)');

  const transaction = db.transaction(() => {
    sourceItems.forEach((a, i) => {
      stmt.run(targetPlaylistId, a.content_id, a.widget_id, a.zone_id || null, maxOrder + i + 1, resolveItemDuration(a.duration_sec, null));
    });
  });
  transaction();

  aplicarNaTela(targetPlaylistId, req);
  res.json({ success: true, copied: sourceItems.length });
});


/*
 * PARA VARIAS TELAS DE UMA VEZ — arquivos e listas, por tela ou por grupo.
 *
 * O caminho de uma tela por vez já existe (POST /device/:id). Este é o mesmo trabalho feito em
 * lote, e ele existe porque a alternativa é abrir oito telas e repetir o mesmo clique — que é
 * exatamente onde "coloquei em 7 de 8" acontece sem ninguém notar.
 *
 * ── A TRAVA DE PLANO VEM JUNTO, E NÃO DEPOIS ────────────────────────────────────────────
 * Pôr uma LISTA numa tela é Pró ou Master; pôr um ARQUIVO é de graça. Já havia duas portas por
 * onde uma lista entra numa tela, e `provar_lista_na_tela.sh` existe porque um cadeado em só uma
 * delas é um cadeado ao lado de uma janela aberta. Esta é a terceira porta.
 *
 * ── E NADA É ESCRITO ANTES DE TUDO SER VÁLIDO ───────────────────────────────────────────
 * Um lote que valida enquanto escreve deixa as duas primeiras telas mudadas e a terceira
 * recusada — o estado que ninguém sabe desfazer, e que numa parede de loja significa metade da
 * campanha no ar.
 */
function gateListaEmLote(req, res, next) {
  const listas = Array.isArray(req.body?.playlist_ids) ? req.body.playlist_ids : [];
  if (!listas.length) return next();
  return checkSublistsEnabled(req, res, next);
}

router.post('/batch', gateListaEmLote, (req, res) => {
  const b = req.body || {};
  const deviceIds = Array.isArray(b.device_ids) ? [...new Set(b.device_ids)] : [];
  const groupIds = Array.isArray(b.group_ids) ? [...new Set(b.group_ids)] : [];
  const contentIds = Array.isArray(b.content_ids) ? [...new Set(b.content_ids)] : [];
  const playlistIds = Array.isArray(b.playlist_ids) ? [...new Set(b.playlist_ids)] : [];

  if (!deviceIds.length && !groupIds.length) {
    return res.status(400).json({ error: 'Escolha ao menos uma tela ou grupo.' });
  }
  if (!contentIds.length && !playlistIds.length) {
    return res.status(400).json({ error: 'Escolha ao menos um arquivo ou lista.' });
  }
  if (contentIds.length + playlistIds.length > 200) {
    return res.status(400).json({ error: 'Itens demais num lote só (máximo 200).' });
  }

  /*
   * O GRUPO VIRA TELAS AQUI, e o resultado responde em telas.
   *
   * Guardar "este arquivo foi para o grupo X" faria a colocação mudar sozinha quando alguém
   * mexesse no grupo depois — e uma mídia que aparece numa tela nova sem ninguém ter decidido é
   * o oposto do que o plano combinou ("colocar nas telas é manual").
   */
  const alvos = new Set(deviceIds);
  for (const g of groupIds) {
    const membros = db.prepare(
      'SELECT device_id FROM device_group_members WHERE group_id = ?').all(g);
    for (const m of membros) alvos.add(m.device_id);
  }
  if (!alvos.size) {
    return res.status(400).json({ error: 'Os grupos escolhidos não têm nenhuma tela.' });
  }
  if (alvos.size > 100) {
    return res.status(400).json({ error: 'Telas demais num lote só (máximo 100).' });
  }

  // ── tudo conferido antes de qualquer escrita ──────────────────────────────────────────
  const telas = [];
  for (const id of alvos) {
    const d = db.prepare('SELECT id, name, workspace_id, playlist_id FROM devices WHERE id = ?').get(id);
    if (!d) return res.status(404).json({ error: `Tela não encontrada: ${id}` });
    if (d.workspace_id !== req.workspaceId) {
      return res.status(403).json({ error: 'Uma das telas não é deste cliente.' });
    }
    telas.push(d);
  }

  for (const id of contentIds) {
    const c = db.prepare('SELECT id, workspace_id FROM content WHERE id = ?').get(id);
    if (!c) return res.status(404).json({ error: `Arquivo não encontrado: ${id}` });
    if (c.workspace_id && c.workspace_id !== req.workspaceId) {
      return res.status(403).json({ error: 'Um dos arquivos não é deste cliente.' });
    }
  }
  for (const id of playlistIds) {
    const pl = db.prepare('SELECT id, workspace_id, is_auto_generated FROM playlists WHERE id = ?').get(id);
    if (!pl) return res.status(404).json({ error: `Lista não encontrada: ${id}` });
    if (pl.workspace_id !== req.workspaceId) {
      return res.status(403).json({ error: 'Uma das listas não é deste cliente.' });
    }
    /*
     * O espaço próprio de uma tela não é uma lista que se manda para outra: ele pertence àquela
     * tela e só se alcança por ela. Aceitar aqui seria pôr o conteúdo de uma tela dentro de
     * outra por um caminho que ninguém associa a isso.
     */
    if (pl.is_auto_generated) {
      return res.status(400).json({ error: 'O espaço próprio de uma tela não pode ser enviado para outra.' });
    }
  }

  // ── e agora escreve ───────────────────────────────────────────────────────────────────
  let postos = 0;
  const porTela = [];

  const gravar = db.transaction(() => {
    for (const tela of telas) {
      const listaDaTela = ensureDevicePlaylist(tela.id, req.user.id);
      const proxima = db.prepare(
        'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM playlist_items WHERE playlist_id = ?')
        .get(listaDaTela).n;
      let ordem = proxima;
      let nesta = 0;

      const ins = db.prepare(`
        INSERT INTO playlist_items (playlist_id, content_id, sub_playlist_id, sub_order, sort_order, duration_sec)
        VALUES (?, ?, ?, ?, ?, ?)`);

      for (const c of contentIds) {
        const dur = resolveItemDuration(undefined, db.prepare('SELECT duration_sec FROM content WHERE id = ?').get(c));
        ins.run(listaDaTela, c, null, 'sequence', ordem++, dur);
        nesta++; postos++;
      }
      for (const pid of playlistIds) {
        // Uma lista dentro de si mesma o servidor recusa; aqui ela nem chega, porque o espaço
        // próprio da tela nunca está entre as listas escolhidas (barrado acima).
        if (pid === listaDaTela) continue;
        ins.run(listaDaTela, null, pid, 'sequence', ordem++, resolveItemDuration(undefined, null));
        nesta++; postos++;
      }

      porTela.push({ device_id: tela.id, name: tela.name, postos: nesta });
    }
  });

  try {
    gravar();
  } catch (e) {
    return res.status(500).json({ error: 'Não foi possível concluir o envio.', detail: e.message });
  }

  /*
   * E cada tela passa a exibir: aplicarNaTela publica o espaco proprio na hora -- o mesmo que
   * o caminho de uma tela por vez faz. Sem isto, mandar para oito telas deixaria oito rascunhos e
   * nenhuma parede mudando, que e exatamente o defeito que acabou de ser consertado.
   */
  for (const t of telas) {
    const lista = db.prepare("SELECT playlist_id FROM devices WHERE id = ?").get(t.id).playlist_id;
    if (lista) aplicarNaTela(lista, req);
  }

  res.json({ telas: telas.length, postos, por_tela: porTela });
});

module.exports = router;
// Exposta para a prova poder chamar A FUNCAO, e nao uma copia dela. Mesmo idioma de
// routes/playlists.js: uma prova que reimplementa a regra prova a propria copia.
module.exports.__test = { aplicarNaTela };
