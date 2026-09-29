'use strict';
/**
 * Boots Blog on a temp database with a controllable clock and mocks of its neighbours, and returns
 * a small HTTP client. Every test file gets its own instance.
 *
 *   const t = await boot();                  // t.base, t.get(path, { as: user | token, ... })
 *   t.clock.advance(ms)                      // the app's clock (scheduler, revisions, gate)
 *   t.restart()                              // a new app on the SAME database (a worker restart)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startNetwork, startCommunity, startMedia } = require('./mocks');

function makeClock(start = Date.parse('2026-09-22T12:00:00Z')) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; return t; }, set: (v) => { t = v; } };
}

async function boot(opts = {}) {
    const network = await startNetwork();
    const community = await startCommunity({ network });
    const media = await startMedia({ network });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-blog-test-'));
    const clock = opts.clock || makeClock();
    const official = network.addUser('lead', { display_name: 'The Lead' });
    const env = {
        NODE_ENV: 'test', PORT: '0', BASE_URL: 'https://openvibe.blog', TRUST_PROXY: '1',
        OV_NETWORK_URL: network.url, OV_NETWORK_INTERNAL_URL: network.url,
        OV_OAUTH_CLIENT_ID: 'blog', OV_OAUTH_CLIENT_SECRET: 'shh', COOKIE_SECURE: 'false',
        OV_COMMUNITY_URL: 'https://openvibe.community', OV_COMMUNITY_INTERNAL_URL: community.url,
        OV_MEDIA_URL: 'https://openvibe.media', OV_MEDIA_INTERNAL_URL: media.url,
        BLOG_OFFICIAL_OWNERS: official.subject, BLOG_WORKER: 'off', BLOG_FORM_SECRET: 'test-form-secret',
        ...(opts.env || {}),
    };
    const configLib = require('../../server/config');
    const { createApp } = require('../../server/app');
    const quiet = { log() {}, warn() {}, error: (...a) => { if (process.env.VERBOSE) console.error(...a); } };

    const { createStore } = require('../../server/db');
    // One database per boot (PGlite, or BLOG_TEST_STORE=pg: the containers); it stays up across a restart.
    const testdb = await require('./db').testDb();
    let server = null;
    let built = null;
    async function start() {
        const config = configLib.load(env);
        built = await createApp({ config, store: createStore(testdb.db, { now: clock.now }), now: clock.now, log: opts.log || quiet, entitlementCheck: opts.entitlementCheck, limitsNow: opts.limitsNow });
        // Warm the shared JWKS cache so an immediately-verified token does not race the first fetch.
        await require('openvibe-sdk/auth').jwksClient(`${network.url}/api/.well-known/jwks`).keysForKid(null);
        server = await new Promise((resolve) => { const s = http.createServer(built.app); s.listen(0, '127.0.0.1', () => resolve(s)); });
        t.base = `http://127.0.0.1:${server.address().port}`;
        t.app = built.app;
        t.ctx = built.ctx;
    }
    async function stop() {
        if (server) await new Promise((r) => server.close(r));
        if (built) { built.ctx.worker.stop(); await built.ctx.outbox.stop(); }
        server = null; built = null;
    }

    /** as: a network user ({ subject, … }) → ov_token cookie; a string → Bearer token. */
    async function get(p, o = {}) {
        const headers = { ...(o.headers || {}) };
        if (o.as && typeof o.as === 'object') headers.cookie = `ov_token=${network.userToken(o.as)}`;
        if (typeof o.as === 'string') headers.authorization = `Bearer ${o.as}`;
        let body = o.body;
        if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
        if (o.form) { body = new URLSearchParams(o.form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
        const res = await fetch(t.base + p, { method: o.method || (body ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
        const text = await res.text();
        return { status: res.status, headers: res.headers, text, json() { return JSON.parse(text); } };
    }

    /** Rows of event_outbox as parsed envelopes. */
    async function events(type = null) {
        return (await t.ctx.store.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all()).map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope)).filter((e) => !type || e.event_type === type || (type instanceof RegExp && type.test(e.event_type)));
    }

    const t = {
        network, community, media, clock, official, get, events,
        csrf: (user) => require('../../server/auth/forms').csrfToken({ formSecret: env.BLOG_FORM_SECRET }, user),
        async restart() { await stop(); await start(); },
        async close() { await stop(); await testdb.close(); await network.close(); await community.close(); await media.close(); fs.rmSync(dir, { recursive: true, force: true }); },
    };
    await start();
    return t;
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')); }
}
function done() { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }

module.exports = { boot, check, done, makeClock };
