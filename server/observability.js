'use strict';
/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready, Track O).
 *
 *   db              required  a real query on Blog's SQLite (the charter tables answer)
 *   network_jwks    optional  the Network signing key has loaded; without it pages and feeds still
 *                             serve, but nobody can sign in and service tokens are refused (503)
 *   events_relay    optional  the outbox relay is configured and has no rejected rows; when it is
 *                             off, events wait in event_outbox (Search and subscribers lag)
 *   scheduler       optional  no scheduled job has failed and none is overdue by more than 5 minutes
 *
 * Request metrics come from openvibe-shared/metrics in app.js; content counts are not metrics.
 */
const { createReadiness } = require('openvibe-shared/ready');
const { CHARTER_TABLES } = require('./db');

function createBlogReadiness({ store, auth, outbox, release = null }) {
    const { db } = store;
    return createReadiness({
        service: 'blog',
        release,
        checks: [
            {
                name: 'db', required: true,
                check: () => {
                    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => r.name));
                    const missing = CHARTER_TABLES.filter((t) => !names.has(t));
                    return missing.length ? `missing ${missing.join(', ')}` : true;
                },
            },
            {
                name: 'network_jwks', required: false,
                check: () => {
                    if (auth.client.publicKey) return true;
                    auth.ensureKey().catch(() => {});
                    return 'Network signing key not loaded yet: sign-in and service calls are unavailable';
                },
            },
            {
                name: 'events_relay', required: false,
                check: () => {
                    const s = outbox.status();
                    if (!s.enabled) return `relay off (EVENTS_URL or OV_OAUTH_CLIENT_SECRET unset); ${s.pending} events waiting`;
                    if (s.rejected) return `${s.rejected} events rejected by OpenVibe.Events`;
                    return { ok: true, detail: { pending: s.pending } };
                },
            },
            {
                name: 'scheduler', required: false,
                check: () => {
                    const failed = db.prepare("SELECT COUNT(*) AS n FROM blog_schedule_jobs WHERE status = 'failed' AND updated_at > ?").get(store.now() - 24 * 3600 * 1000).n;
                    const overdue = db.prepare("SELECT COUNT(*) AS n FROM blog_schedule_jobs WHERE status = 'pending' AND run_at < ?").get(store.now() - 5 * 60 * 1000).n;
                    if (failed || overdue) return `${failed} failed in the last 24 h, ${overdue} overdue`;
                    return true;
                },
            },
        ],
    });
}

module.exports = { createBlogReadiness };
