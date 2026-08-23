const express = require('express');
const router = express.Router();
const { getActivity, getActivityUsers, pruneActivityLog } = require('../services/activity');
const { ELEVATED_ROLES } = require('../middleware/auth');
const { isOrgOwner } = require('../lib/permissions');

/*
 * Who did what, inside one tenant.
 *
 * THE LOG IS THE OWNER'S. It names every member and everything they changed, which is exactly the
 * kind of record an employee should not be able to read about their colleagues — so this is gated
 * on org_owner rather than on the ordinary workspace-admin used elsewhere. Platform staff keep
 * their own wider view; everyone else is refused outright rather than shown a filtered subset,
 * because a page that silently shows less is a page nobody can trust the emptiness of.
 *
 * AND IT IS SCOPED TO ONE WORKSPACE. getActivity() takes workspaceId and matches it strictly, so a
 * row with no workspace never appears; the alternative — treating NULL as "everyone's" — is how one
 * customer ends up reading another customer's activity.
 */
function requireTenantOwner(req, res, next) {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  if (!isOrgOwner(req)) return res.status(403).json({ error: 'Owner only' });
  next();
}

// Is this caller allowed to see the log? The Settings page asks before drawing the section, so a
// member simply does not see a panel they would only be refused from.
router.get('/available', (req, res) => {
  res.json({ available: !!req.workspaceId && isOrgOwner(req) });
});

router.get('/users', requireTenantOwner, (req, res) => {
  res.json(getActivityUsers(req.workspaceId));
});

router.get('/', requireTenantOwner, (req, res) => {
  const { device_id, user_id, limit, offset } = req.query;

  /*
   * A platform admin reading their own workspace still gets ONLY that workspace. The previous
   * version handed platform roles the unfiltered table, which made the same URL mean two different
   * things depending on who asked — and made the tenant-scoped page impossible to reason about.
   */
  res.json(getActivity({
    workspaceId: req.workspaceId,
    userId: user_id || null,
    deviceId: device_id || null,
    limit: Math.min(parseInt(limit) || 50, 200),
    offset: parseInt(offset) || 0,
  }));
});

// Prune old logs (platform staff only — this deletes audit history for every tenant at once).
router.delete('/prune', (req, res) => {
  if (!ELEVATED_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
  pruneActivityLog();
  res.json({ success: true });
});

module.exports = router;
