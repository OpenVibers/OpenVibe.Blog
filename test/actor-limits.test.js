'use strict';
/**
 * Per-actor rate limits (server/http/actor-limits.js, roadmap WS-R task 4): past its limit one caller
 * gets 429 problem+json `rate_limited` with Retry-After, before the route does any work, while
 * another caller still passes; the window reopens on the clock. A person is counted as themselves
 * whether they call directly or a service names them; a service relaying signed-out visitors is
 * counted by each forwarded address; a service reading for itself, and Network reading the changelog
 * for every site, are not counted. Writes have their own budget, shared by the API and the editor
 * form. Health, ready, release.json and metrics are never limited; refusals are logged and counted.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { actor, serviceItself } = require('../server/http/actor-limits');

const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');

(async () => {
    // The limiter's clock: 15 s into a minute, so the minute window has 45 s left. Reads: 3 a minute.
    let clock = Date.UTC(2026, 8, 27, 12, 0, 15);
    const lines = [];
    const log = { log() {}, error() {}, warn: (m) => lines.push(String(m)) };
    const t = await boot({ env: { BLOG_LIMITS_MINUTE: '3', BLOG_LIMITS_HOUR: '100' }, limitsNow: () => clock, log });
    const fay = t.network.addUser('fay');
    const gus = t.network.addUser('gus');
    assert.strictEqual((await t.get('/api/v1/blogs', { as: fay, json: {} })).status, 201);
    assert.strictEqual((await t.get('/api/v1/blogs', { as: gus, json: {} })).status, 201);
    const svc = t.network.serviceToken('ai', ['blog.post.read', 'blog.post.create']);

    await check('a read: 3 a minute per person, then 429 rate_limited with Retry-After; another person passes', async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.get('/api/v1/blogs/fay', { as: fay })).status, 200);
        const r = await t.get('/api/v1/blogs/fay', { as: fay });
        assert.strictEqual(r.status, 429, r.text);
        assert.strictEqual(r.headers.get('retry-after'), '45');
        assert.ok(/^application\/problem\+json/.test(r.headers.get('content-type')), r.headers.get('content-type'));
        const body = r.json();
        assert.deepStrictEqual([body.code, body.status, body.retry_after_seconds], ['rate_limited', 429, 45]);
        assert.ok(body.detail.includes('blog.read'), body.detail);
        assert.strictEqual((await t.get('/api/v1/blogs/fay', { as: gus })).status, 200, 'another person still passes');
    });

    await check('a service naming the person counts against that person', async () => {
        const r = await t.get('/api/v1/blogs/fay', { as: svc, headers: { 'X-OV-Subject': fay.subject } });
        assert.deepStrictEqual([r.status, r.json().code], [429, 'rate_limited']);
    });

    await check('relayed visitors count by forwarded address; a service reading for itself and the changelog are not counted', async () => {
        const visitor = (ip) => t.get('/api/v1/blogs/fay', { as: svc, headers: { 'X-Forwarded-For': ip } });
        for (let i = 0; i < 3; i++) assert.strictEqual((await visitor('203.0.113.7')).status, 200);
        assert.strictEqual((await visitor('203.0.113.7')).status, 429);
        assert.strictEqual((await visitor('203.0.113.8')).status, 200, 'another visitor still passes');
        for (let i = 0; i < 6; i++) {
            assert.strictEqual((await t.get('/api/v1/blogs/fay', { as: svc })).status, 200);
            assert.strictEqual((await t.get('/api/v1/changelog')).status, 200, 'Network reads it for every site');
        }
    });

    await check('the next minute opens the window again', async () => {
        clock += 45 * 1000;
        assert.strictEqual((await t.get('/api/v1/blogs/fay', { as: fay })).status, 200);
    });

    await check('a write has its own budget (30 revisions a minute), shared by the API and the editor form; nothing stored past it', async () => {
        clock = Date.UTC(2026, 8, 27, 12, 5, 0);
        let r = await t.get('/api/v1/blogs/fay/posts', { as: fay, json: { title: 'Counted', body: LONG } });
        assert.strictEqual(r.status, 201, r.text);
        const id = r.json().post.id;
        let rev = r.json().revision;
        for (let i = 0; i < 29; i++) {
            r = await t.get(`/api/v1/posts/${id}`, { as: fay, method: 'PATCH', json: { expected_revision: rev, body: `${LONG} edit ${i}` } });
            assert.strictEqual(r.status, 200, `edit ${i + 1}: ${r.text}`);
            rev = r.json().revision;
        }
        r = await t.get(`/api/v1/posts/${id}/revert`, { as: fay, json: { to_revision: 1, expected_revision: rev } });
        assert.strictEqual(r.status, 201, `the 30th, a revert: ${r.text}`);
        rev = r.json().revision;
        const stored = async () => (await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM blog_post_revisions WHERE entity_id = ?').get(id)).n;
        const before = await stored();
        r = await t.get(`/write/posts/${id}`, { as: fay, form: { _csrf: t.csrf({ subject: fay.subject }), title: 'Counted', body: `${LONG} one more`, expectedRevision: String(rev) } });
        assert.deepStrictEqual([r.status, r.json().code, r.headers.get('retry-after')], [429, 'rate_limited', '60'], 'the form shares the API budget');
        assert.ok(r.json().detail.includes('blog.post.update'), r.json().detail);
        assert.strictEqual(await stored(), before, 'nothing stored');
        r = await t.get('/api/v1/blogs/gus/posts', { as: gus, json: { title: 'Mine', body: LONG } });
        assert.strictEqual(r.status, 201, 'another person still writes');
        r = await t.get(`/api/v1/posts/${r.json().post.id}`, { as: gus, method: 'PATCH', json: { expected_revision: r.json().revision, body: `${LONG} edited` } });
        assert.strictEqual(r.status, 200, r.text);
    });

    await check('health, ready, release.json and metrics are never limited', async () => {
        for (let i = 0; i < 6; i++) {
            assert.strictEqual((await t.get('/api/health')).status, 200);
            assert.notStrictEqual((await t.get('/api/ready')).status, 429);
            assert.strictEqual((await t.get('/release.json')).status, 200);
            assert.strictEqual((await t.get('/metrics')).status, 200);
        }
    });

    await check('refusals are counted in blog_rate_limited_total and logged without a token', async () => {
        const m = (await t.get('/metrics')).text;
        const counted = m.split('\n').filter((l) => l.includes('blog_rate_limited_total')).join('\n');
        assert.ok(/blog_rate_limited_total\{limit="blog.read",window="minute"\} 3/.test(m), counted);
        assert.ok(/blog_rate_limited_total\{limit="blog.post.update",window="minute"\} 1/.test(m), counted);
        assert.ok(lines.some((l) => l.includes(`blog.read: user:${fay.subject} refused`)), lines.join('\n'));
        assert.ok(!lines.some((l) => /eyJ/.test(l)), 'a token in the log');
    });

    await check('who is counted', () => {
        const q = (viewer, { xff = null, ip = '127.0.0.1' } = {}) => ({ viewer, ip, get: (n) => (n === 'x-forwarded-for' ? xff : undefined) });
        assert.strictEqual(actor(q({ kind: 'user', subject: 'usr_a' })), 'user:usr_a');
        assert.strictEqual(actor(q({ kind: 'service', service: 'svc:ai', subject: 'usr_a' })), 'user:usr_a');
        assert.strictEqual(actor(q({ kind: 'service', service: 'svc:ai', subject: null }, { xff: '203.0.113.9', ip: '203.0.113.9' })), 'ip:203.0.113.9');
        assert.strictEqual(actor(q({ kind: 'service', service: 'svc:ai', subject: null })), 'svc:ai', 'acting as itself');
        assert.strictEqual(actor(q({ kind: 'service', service: 'app:app_1', subject: null }, { xff: '203.0.113.9', ip: '203.0.113.9' })), 'app:app_1', 'an app never relays by address');
        assert.strictEqual(actor(q({ kind: 'anonymous', subject: null }, { ip: '198.51.100.4' })), 'ip:198.51.100.4');
        assert.strictEqual(serviceItself(q({ kind: 'service', service: 'svc:ai', subject: null })), true);
        assert.strictEqual(serviceItself(q({ kind: 'service', service: 'app:app_1', subject: null })), false);
    });

    await t.close();
    done();
})();
