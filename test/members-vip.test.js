'use strict';
/**
 * Members-only posts through OpenVibe.VIP (roadmap Wave 10 / §12.6): Blog asks VIP's
 * policies/evaluate with the blog owner as `owner` and its default gate { member, blog:gated_post };
 * a reader VIP admits reads the post, everyone else (signed out, not a member, VIP down) gets a
 * teaser and a join link and the body never leaves Blog — not through the page, the .json twin, the
 * API, feeds, sitemaps, Search documents or the product events. Convergence: a cached "yes" ends
 * within BLOG_VIP_CACHE_TTL_MS after VIP stops granting, and at once on vip.membership.changed.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

const SENTINEL = 'ZEBRA-SENTINEL-7731';
const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
const TTL = 30_000;

/** A stand-in for VIP's POST /api/v1/policies/evaluate: answers from `allow` (subject → bool). */
function startVip() {
    const state = { allow: new Map(), down: false, calls: [] };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            if (state.down) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"code":"vip.unavailable"}'); }
            const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
            let claims = {};
            try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { /* */ }
            const body = raw ? JSON.parse(raw) : {};
            state.calls.push({ path: req.url, body, claims });
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url !== '/api/v1/policies/evaluate' || req.method !== 'POST') return json(404, { code: 'not_found' });
            if (!(claims.cap || []).includes('vip.resource.policy.evaluate') || !(claims.aud || []).includes('openvibe.vip')) return json(403, { code: 'capability.denied' });
            const ok = state.allow.get(body.subject) === true;
            return json(200, { allow: ok, reason: ok ? 'member' : 'not_a_member', rule: null, fallback: true, entitlement: ok ? { status: 'active', active: true, expires_at: new Date(Date.parse('2027-01-01')).toISOString() } : null });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ ...state, state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

(async () => {
    const vip = await startVip();
    const t = await boot({ env: { OV_VIP_INTERNAL_URL: vip.url, OV_VIP_URL: 'https://openvibe.vip', BLOG_VIP_CACHE_TTL_MS: String(TTL) } });
    const carol = t.network.addUser('carol');
    const fan = t.network.addUser('fan');
    const stranger = t.network.addUser('stranger');
    const late = t.network.addUser('late');
    const admin = t.network.addUser('boss', { role: 'admin' });
    await t.get('/api/v1/blogs', { as: carol, json: {} });
    vip.state.allow.set(fan.subject, true);

    const make = async (as, handle, title, visibility, extra = {}) => {
        const p = (await t.get(`/api/v1/blogs/${handle}/posts`, { as, json: { title, body: `Opening line. ${LONG} ${SENTINEL} ${title}`, visibility, ...extra } })).json().post;
        const r = await t.get(`/api/v1/posts/${p.id}/publish`, { as, json: {} });
        assert.strictEqual(r.status, 200, r.text);
        return p;
    };
    const mem = await make(carol, 'carol', 'Backstage notes', 'members', { summary: 'What happened backstage this week.' });
    const official = await make(t.official, 'openvibe', 'Staff memo', 'members');
    const noBody = (text, where) => assert.ok(!String(text).includes(SENTINEL), `${where}: the body leaked`);
    const lastCall = () => vip.state.calls[vip.state.calls.length - 1];

    await check('the provider defaults to vip when Blog has a client secret', async () => {
        assert.strictEqual(t.ctx.entitlements.provider, 'vip');
        assert.strictEqual(t.ctx.vip.enabled, true);
    });

    await check('a VIP member reads the full post; Blog asked VIP with the owner, the resource and its default gate', async () => {
        const r = await t.get('/@carol/backstage-notes', { as: fan });
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes(SENTINEL));
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        const c = lastCall();
        assert.strictEqual(c.path, '/api/v1/policies/evaluate');
        assert.deepStrictEqual(c.body.resource, { service: 'blog', type: 'post', id: mem.id });
        assert.strictEqual(c.body.owner, carol.subject);
        assert.strictEqual(c.body.subject, fan.subject);
        assert.deepStrictEqual(c.body.fallback, { requirement: 'member', binding: 'blog:gated_post' });
        assert.strictEqual(c.claims.sub, 'svc:blog');
        const j = await t.get(`/api/v1/posts/${mem.id}`, { as: fan });
        assert.strictEqual(j.status, 200);
        const tw = await t.get('/@carol/backstage-notes.json', { as: fan });
        assert.strictEqual(tw.status, 200);
        assert.ok(tw.json().body_markdown.includes(SENTINEL));
    });

    await check('a stranger and a signed-out reader get the teaser and a join link, never the body', async () => {
        for (const as of [stranger, undefined]) {
            const who = as ? 'stranger' : 'anonymous';
            const page = await t.get('/@carol/backstage-notes', { as });
            assert.strictEqual(page.status, 403, who);
            noBody(page.text, `${who} page`);
            assert.match(page.text, /Backstage notes/);
            assert.match(page.text, /What happened backstage this week\./);
            assert.match(page.text, /href="https:\/\/openvibe\.vip\/carol"/);
            assert.strictEqual(page.headers.get('cache-control'), 'private, no-store');
            assert.match(page.headers.get('x-robots-tag') || '', /noindex/);
            const twin = await t.get('/@carol/backstage-notes.json', { as });
            assert.strictEqual(twin.status, 403);
            noBody(twin.text, `${who} .json`);
            assert.strictEqual(twin.json().teaser.join_url, 'https://openvibe.vip/carol');
            const api = await t.get(`/api/v1/posts/${mem.id}`, { as });
            assert.strictEqual(api.status, 403);
            noBody(api.text, `${who} API`);
            const b = api.json();
            assert.strictEqual(b.code, 'post.members_only');
            assert.strictEqual(b.teaser.title, 'Backstage notes');
            assert.strictEqual(b.teaser.summary, 'What happened backstage this week.');
            assert.strictEqual(b.teaser.join_url, 'https://openvibe.vip/carol');
            assert.strictEqual(b.teaser.members_only, true);
            for (const k of ['body', 'body_markdown', 'content', 'html']) assert.ok(!(k in b.teaser) && !(k in b), `no ${k}`);
        }
        assert.strictEqual(lastCall().body.subject, stranger.subject, 'a signed-out reader never reaches VIP');
    });

    await check('the blog\'s own members (the owner) and staff read without VIP', async () => {
        const before = vip.state.calls.length;
        assert.strictEqual((await t.get('/@carol/backstage-notes', { as: carol })).status, 200);
        assert.strictEqual((await t.get('/@carol/backstage-notes', { as: admin })).status, 200);
        assert.strictEqual(vip.state.calls.length, before);
    });

    await check('VIP down: refused with the teaser (fail closed)', async () => {
        vip.state.down = true;
        try {
            const r = await t.get('/@carol/backstage-notes', { as: late });
            assert.strictEqual(r.status, 403);
            noBody(r.text, 'VIP down');
            assert.match(r.text, /could not be checked/);
            assert.strictEqual((await t.get(`/api/v1/posts/${mem.id}`, { as: late })).json().teaser.reason, 'vip_unavailable');
        } finally { vip.state.down = false; }
    });

    await check('the official blog has no VIP owner: outsiders are refused without asking VIP, and no join link', async () => {
        const before = vip.state.calls.length;
        const r = await t.get(`/api/v1/posts/${official.id}`, { as: fan });
        assert.strictEqual(r.status, 403);
        noBody(r.text, 'official');
        assert.strictEqual(r.json().teaser.join_url, null);
        assert.strictEqual(r.json().teaser.reason, 'no_owner');
        assert.strictEqual(vip.state.calls.length, before);
        assert.strictEqual((await t.get(`/api/v1/posts/${official.id}`, { as: t.official })).status, 200);
    });

    await check('feeds, sitemaps, listings, Search documents and product events never carry the body', async () => {
        for (const p of ['/@carol/feed.xml', '/@carol/atom.xml', '/@carol/feed.json', '/feed.xml', '/sitemap.xml', '/sitemaps/posts.xml', '/sitemaps/blogs.xml', '/@carol', '/api/v1/blogs/carol/posts', '/api/v1/blogs/carol/feed', '/llms.txt']) {
            for (const as of [undefined, fan]) noBody((await t.get(p, { as })).text, p);
        }
        const all = t.events();
        assert.ok(all.length > 0);
        for (const e of all) noBody(JSON.stringify(e), e.event_type);
        assert.strictEqual(t.events('blog.index_document.upserted').filter((e) => e.payload.id === mem.id).length, 0, 'Search never got the members post');
        const doc = t.ctx.publication.documentFor(t.ctx.blogs.byHandle('carol'), t.ctx.posts.get(mem.id), { forSearch: false }).doc;
        assert.strictEqual(doc.body, '');
        assert.strictEqual(doc.summary, 'What happened backstage this week.');
        assert.deepStrictEqual(doc.acl.entitlements, ['vip:carol'], 'the default gate label names the blog');
    });

    await check('convergence: a cached yes ends within the TTL after VIP stops granting', async () => {
        const reader = t.network.addUser('reader1');
        vip.state.allow.set(reader.subject, true);
        assert.strictEqual((await t.get('/@carol/backstage-notes', { as: reader })).status, 200);
        vip.state.allow.set(reader.subject, false);                    // VIP applied the cancellation
        t.clock.advance(TTL - 1);
        assert.strictEqual((await t.get('/@carol/backstage-notes', { as: reader })).status, 200, 'inside the bound Blog may still admit');
        t.clock.advance(2);
        const r = await t.get('/@carol/backstage-notes', { as: reader });
        assert.strictEqual(r.status, 403, 'past the TTL Blog has asked VIP again');
        noBody(r.text, 'after convergence');
    });

    await check('convergence: vip.membership.changed handed to the cache refuses at once', async () => {
        const reader = t.network.addUser('reader2');
        vip.state.allow.set(reader.subject, true);
        assert.strictEqual((await t.get(`/api/v1/posts/${mem.id}`, { as: reader })).status, 200);
        vip.state.allow.set(reader.subject, false);
        assert.strictEqual((await t.get(`/api/v1/posts/${mem.id}`, { as: reader })).status, 200, 'still the cached yes');
        assert.strictEqual(t.ctx.vip.cache.handleEvent({ event_type: 'vip.membership.changed', payload: { member: { type: 'user', id: reader.subject }, creator: { type: 'user', id: carol.subject } } }), true);
        assert.strictEqual((await t.get(`/api/v1/posts/${mem.id}`, { as: reader })).status, 403);
    });

    await check('a new member waits at most the deny TTL', async () => {
        const reader = t.network.addUser('reader3');
        assert.strictEqual((await t.get(`/api/v1/posts/${mem.id}`, { as: reader })).status, 403);
        vip.state.allow.set(reader.subject, true);
        t.clock.advance(10_001);
        assert.strictEqual((await t.get(`/api/v1/posts/${mem.id}`, { as: reader })).status, 200);
    });

    await t.close();
    await vip.close();
    done();
})();
