'use strict';

// Asaas payment webhook. Mounted UNAUTHENTICATED (Asaas is the caller, not a logged-in user),
// so the access token below is the entire gate — see the notes on each guard.
//
// IDEMPOTENCY: Asaas retries a delivery until it receives a 2xx, and will happily replay the
// same event after a timeout, so "payment confirmed" arrives more than once in normal
// operation. billing_webhook_events is the dedupe ledger, keyed on the event id; the INSERT
// itself is the lock (PRIMARY KEY collision = already handled), which is race-free in a way
// that SELECT-then-INSERT is not. routes/stripe.js has no such guard — this is the first one
// in the codebase, and the Stripe path should grow the same thing before it is used in anger.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../db/database');
const config = require('../config');

// Payment events that mean "this workspace has paid — let it in".
const PAID_EVENTS = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);
// Events that mean the opposite. Access is NOT cut here (that is a dunning decision with a
// grace period); the status is recorded so the UI and any future dunning job can act on it.
const UNPAID_EVENTS = new Set(['PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED']);

// Constant-time compare that also survives length mismatches (timingSafeEqual throws on
// differing lengths, which would itself leak length via the error path).
function tokenMatches(received, expected) {
  const a = Buffer.from(String(received || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Find the workspace a payment belongs to. subscription id first (what a recurring charge
// carries), then customer, then the externalReference we stamp on both.
function resolveWorkspace(payment) {
  if (!payment) return null;
  const q = (sql, val) => (val ? db.prepare(sql).get(val) : null);
  return (
    q('SELECT * FROM workspaces WHERE asaas_subscription_id = ?', payment.subscription) ||
    q('SELECT * FROM workspaces WHERE asaas_customer_id = ?', payment.customer) ||
    q('SELECT * FROM workspaces WHERE id = ?', payment.externalReference)
  );
}

// Access runs to the paid period's end: the invoice's due date plus one cycle, plus a few
// days of slack so a payment that clears late never bounces a live screen. Falls back to
// "now + a cycle" when Asaas omits dueDate.
const CYCLE_DAYS = 30;
const GRACE_DAYS = 5;
function accessEndsAt(payment) {
  const due = payment?.dueDate ? Date.parse(`${payment.dueDate}T00:00:00Z`) : NaN;
  const base = Number.isNaN(due) ? Date.now() : due;
  return Math.floor((base + (CYCLE_DAYS + GRACE_DAYS) * 86400000) / 1000);
}

router.post('/webhook', express.json({ limit: '256kb' }), (req, res) => {
  // No token configured means the endpoint is not ready to trust anything. Refuse rather than
  // accept unauthenticated payment events — the same posture routes/stripe.js takes when its
  // signing secret is missing.
  if (!config.asaas.webhookToken) {
    console.error('[asaas] ASAAS_WEBHOOK_TOKEN not configured — rejecting webhook');
    return res.status(503).json({ error: 'Webhook not configured' });
  }
  if (!tokenMatches(req.headers['asaas-access-token'], config.asaas.webhookToken)) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const { id: eventId, event, payment } = req.body || {};
  if (!eventId || !event) return res.status(400).json({ error: 'Malformed event' });

  const workspace = resolveWorkspace(payment);

  // Claim the event. A duplicate delivery loses the race here and returns 200 without
  // touching the subscription — Asaas needs the 2xx or it keeps retrying forever.
  try {
    db.prepare(
      'INSERT INTO billing_webhook_events (id, provider, event_type, workspace_id) VALUES (?, ?, ?, ?)'
    ).run(eventId, 'asaas', event, workspace?.id || null);
  } catch (err) {
    if (/UNIQUE constraint failed|PRIMARY KEY/i.test(err.message)) {
      return res.json({ received: true, duplicate: true });
    }
    console.error(`[asaas] webhook ledger write failed: ${err.message}`);
    return res.status(500).json({ error: 'Ledger error' });
  }

  // Unknown workspace: the event is recorded (so a retry is not reprocessed) and acknowledged,
  // because retrying will not make the workspace appear. Logged loudly — in practice it means
  // a charge exists in Asaas that this install has no record of.
  if (!workspace) {
    console.warn(`[asaas] ${event} for unknown workspace (payment ${payment?.id}, customer ${payment?.customer})`);
    return res.json({ received: true, matched: false });
  }

  try {
    if (PAID_EVENTS.has(event)) {
      db.prepare(`UPDATE workspaces
                    SET subscription_status = 'active', subscription_ends = ?,
                        updated_at = strftime('%s','now')
                  WHERE id = ?`).run(accessEndsAt(payment), workspace.id);
      console.log(`[asaas] ${event}: workspace ${workspace.id} active until ${new Date(accessEndsAt(payment) * 1000).toISOString().slice(0, 10)}`);
    } else if (UNPAID_EVENTS.has(event)) {
      const status = event === 'PAYMENT_OVERDUE' ? 'past_due' : 'unpaid';
      db.prepare("UPDATE workspaces SET subscription_status = ?, updated_at = strftime('%s','now') WHERE id = ?")
        .run(status, workspace.id);
      console.warn(`[asaas] ${event}: workspace ${workspace.id} -> ${status}`);
    }
    // Any other event type is acknowledged and ignored on purpose; Asaas sends a broad set
    // and silently 200-ing the ones we do not model keeps it from retrying them.
  } catch (err) {
    console.error(`[asaas] webhook processing error: ${err.message}`);
  }

  res.json({ received: true });
});

module.exports = router;
