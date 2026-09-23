'use strict';
/**
 * Private, members-only (VIP) and unlisted posts never leak through cache headers, Search,
 * feeds or sitemaps — and a visibility change converges everywhere.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');

function assertPrivate(r, what) {
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-store', `${what}: Cache-Control`);
    assert.match(r.headers.get('vary') || '', /Cookie/i, `${what}: Vary Cookie`);
    assert.match(r.headers.get('vary') || '', /Authorization/i, `${what}: Vary Authorization`);
}

(async () => {
    const vipMember = { subject: null };
    const t = await boot({ entitlementCheck: async ({ subject, key }) => subject === vipMember.subject && key === 'vip:carol' });
    const carol = t.network.addUser('carol');
    const reader = t.network.addUser('reader');
    const vip = t.network.addUser('vipfan');
    vipMember.subject = vip.subject;
    await t.get('/api/v1/blogs', { as: carol, json: {} });

    const make = async (title, visibility, extra = {}) => {
        const p = (await t.get('/api/v1/blogs/carol/posts', { as: carol, json: { title, body: `${title} SECRET-${visibility} ${LONG}`, visibility, ...extra } })).json().post;
        await t.get(`/api/v1/posts/${p.id}/publish`, { as: carol, json: {} });
        return p;
    };
    const pub = await make('Open post', 'public');
    const mem = await make('Members post', 'members', { entitlement_key: 'vip:carol' });
    const priv = await make('Private post', 'private');
    const unl = await make('Unlisted post', 'unlisted');

    await check('a public post for an anonymous reader is shared-cacheable and varies on Cookie/Authorization', async () => {
        const r = await t.get('/@carol/open-post');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('cache-control'), /^public, max-age=60/);
        assert.match(r.headers.get('vary'), /Cookie/);
        assert.match(r.headers.get('vary'), /Authorization/);
    });

    await check('the same public post for a signed-in reader is private, no-store', async () => {
        assertPrivate(await t.get('/@carol/open-post', { as: reader }), 'signed-in view');
    });

    await check('members-only: anonymous → 403 teaser without the text; non-entitled member of the network → 403; no-store', async () => {
        const a = await t.get('/@carol/members-post');
        assert.strictEqual(a.status, 403);
        assert.doesNotMatch(a.text, /SECRET-members/);
        assert.match(a.text, /Members post/, 'the teaser names the post');
        assert.match(a.text, /data-members-only="1"/);
        assertPrivate(a, 'members 403');
        assert.match(a.headers.get('x-robots-tag'), /noindex/);
        const r = await t.get('/@carol/members-post', { as: reader });
        assert.strictEqual(r.status, 403);
        const j = await t.get('/@carol/members-post.json');
        assert.strictEqual(j.status, 403);
        assert.doesNotMatch(j.text, /SECRET/);
    });

    await check('members-only: the entitled viewer (entitlement seam) and the blog owner can read it — privately', async () => {
        const v = await t.get('/@carol/members-post', { as: vip });
        assert.strictEqual(v.status, 200);
        assert.match(v.text, /SECRET-members/);
        assertPrivate(v, 'entitled view');
        assert.match(v.text, /<meta name="robots" content="noindex, nofollow">/);
        const o = await t.get('/@carol/members-post', { as: carol });
        assert.strictEqual(o.status, 200);
        assertPrivate(o, 'owner view');
    });

    await check('private: 404 to everyone but the blog’s members; unlisted: readable by link but never cached publicly', async () => {
        assert.strictEqual((await t.get('/@carol/private-post')).status, 404);
        assert.strictEqual((await t.get('/@carol/private-post', { as: vip })).status, 404);
        assert.strictEqual((await t.get('/@carol/private-post', { as: carol })).status, 200);
        const u = await t.get('/@carol/unlisted-post');
        assert.strictEqual(u.status, 200);
        assertPrivate(u, 'unlisted');
        assert.match(u.text, /<meta name="robots" content="noindex, nofollow">/);
    });

    await check('feeds, sitemaps, blog index and tag pages carry only the public post', async () => {
        for (const p of ['/@carol/feed.xml', '/@carol/atom.xml', '/@carol/feed.json', '/sitemaps/posts.xml', '/sitemaps/blogs.xml', '/sitemap.xml', '/@carol', '/api/v1/blogs/carol/posts', '/api/v1/blogs/carol/feed']) {
            const r = await t.get(p);
            assert.doesNotMatch(r.text, /SECRET-(members|private|unlisted)|members-post|private-post|unlisted-post/, p);
        }
        assert.match((await t.get('/@carol/feed.xml')).text, /open-post/);
        // Even an entitled or owning reader gets the same public-only feed (feeds never vary by viewer).
        assert.doesNotMatch((await t.get('/@carol/feed.xml', { as: carol })).text, /members-post/);
    });

    await check('Search receives only the public post; the others were never sent', async () => {
        const ids = t.events('blog.index_document.upserted').map((e) => e.payload.id);
        assert.deepStrictEqual(ids, [pub.id]);
        const published = t.events('blog.post.published');
        assert.strictEqual(published.length, 4);
        for (const e of published) {
            if (e.subject.id === pub.id) assert.strictEqual(e.visibility, 'public');
            else assert.strictEqual(e.visibility, 'internal', 'non-public publication events are internal');
            assert.strictEqual(JSON.stringify(e.payload).includes('SECRET'), false, 'no body in product events');
        }
    });

    await check('public → members: a Search tombstone, gone from feeds/sitemaps, anonymous 403, no public cache', async () => {
        const r = await t.get(`/api/v1/posts/${pub.id}`, { as: carol, method: 'PATCH', json: { visibility: 'members', entitlement_key: 'vip:carol' } });
        assert.strictEqual(r.status, 200, r.text);
        const del = t.events('blog.index_document.deleted');
        assert.strictEqual(del.length, 1);
        assert.strictEqual(del[0].payload.id, pub.id);
        const up = t.events('blog.index_document.upserted').find((e) => e.payload.id === pub.id);
        assert.ok(del[0].payload.revision > up.payload.revision, 'the tombstone outranks the old document');
        assert.strictEqual(t.events('blog.post.updated').length, 1);
        const a = await t.get('/@carol/open-post');
        assert.strictEqual(a.status, 403);
        assertPrivate(a, 'after privatising');
        assert.doesNotMatch((await t.get('/@carol/feed.xml')).text, /open-post/);
        assert.doesNotMatch((await t.get('/sitemaps/posts.xml')).text, /open-post/);
    });

    await check('members → public again: re-indexed with a higher revision', async () => {
        await t.get(`/api/v1/posts/${pub.id}`, { as: carol, method: 'PATCH', json: { visibility: 'public' } });
        const ups = t.events('blog.index_document.upserted').filter((e) => e.payload.id === pub.id);
        const del = t.events('blog.index_document.deleted')[0];
        assert.strictEqual(ups.length, 2);
        assert.ok(ups[1].payload.revision > del.payload.revision);
    });

    await check('without an entitlement service the check fails closed', async () => {
        const { createEntitlementChecker } = require('../server/domain/access');
        const blog = t.ctx.blogs.byHandle('carol');
        const post = t.ctx.posts.get(mem.id);
        const args = { subject: vip.subject, blog, post };
        const none = createEntitlementChecker({ provider: 'none' });
        assert.strictEqual(await none.has(args), false);
        const unknown = createEntitlementChecker({ provider: 'vip-service-that-does-not-exist' });
        assert.strictEqual(await unknown.has(args), false);
        const unwired = createEntitlementChecker({ provider: 'vip' });
        assert.strictEqual(await unwired.has(args), false, 'vip without a client secret');
        const throwing = createEntitlementChecker({ check: async () => { throw new Error('down'); } });
        assert.strictEqual(await throwing.has(args), false);
        assert.deepStrictEqual(await throwing.decide(args), { allow: false, reason: 'error' });
    });

    await check('API reads of non-public posts are private and refused to outsiders', async () => {
        const r = await t.get(`/api/v1/posts/${priv.id}`, { as: reader });
        assert.strictEqual(r.status, 404);
        assertPrivate(r, 'api');
        const m = await t.get(`/api/v1/posts/${mem.id}`);
        assert.strictEqual(m.status, 403);
        assert.doesNotMatch(m.text, /SECRET/);
    });

    await t.close();
    done();
})();
