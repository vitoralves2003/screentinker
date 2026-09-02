/*
 * A FORMA CANÔNICA DO PAYLOAD DO PLAYER — extraída VERBATIM de ws/deviceSocket.js
 * (Fase C, 02/09) para as DUAS casas montarem o payload com o MESMO código: o gateway
 * daqui, o gateway novo de lá, e o preview de playlists nos dois. Pura de propósito —
 * tudo o que ela toca chega por parâmetro.
 */
const { normalizeTransitions } = require('./transition-config');

// #104: the canonical player payload shape, shared by the device path
// (buildPlaylistPayload) and the device-free dashboard preview.
// Zone reset: if this isn't a real multi-zone layout (single zone or no layout),
// strip any leftover zone_id so content falls back to the fullscreen renderer
// instead of binding to a now-gone left/right zone and never playing.
function assemblePayload({ assignments, layout, orientation, wall_config, group_sync, timezone }) {
  let a = Array.isArray(assignments) ? assignments : [];
  // Transition widgets are normalized OUT here (the single device+preview chokepoint): each is dropped
  // from the visible list and its config attached as an opaque `transition` on the item it plays into.
  // Old players simply see no transition widget and ignore the field (hard cut) — no regression.
  a = normalizeTransitions(a);
  const zoneCount = layout?.zones?.length || 0;
  if (zoneCount < 2) a = a.map(x => (x && x.zone_id != null ? { ...x, zone_id: null } : x));
  return {
    assignments: a,
    layout: layout || null,
    orientation: orientation || 'landscape',
    wall_config: wall_config || null,
    group_sync: group_sync || null,
    timezone: timezone || null,
  };
}

module.exports = { assemblePayload };
