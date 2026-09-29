'use strict';
/**
 * IndexNow (openvibe-shared/indexnow): INDEXNOW_KEY unset → the feature is off (no key route, nothing
 * sent). With a key, the key file is served at /<key>.txt as text/plain and publishing an indexable
 * post pings the engines with the post's path and the sitemap. Drafts never ping.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const KEY = 'k'.repeat(32);
const LONG = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');

(async () => {
    const off = await boot();
    await check('without a key IndexNow is off: no key route and nothing sent', async () => {
        assert.strictEqual(off.ctx.indexnow.enabled, false);
        const res = await off.get(`/${KEY}.txt`);
        assert.strictEqual(res.status, 404, res.text);
    });
    await off.close();

    const on = await boot({ env: { INDEXNOW_KEY: KEY } });
    await check('with a key the key file answers text/plain with the key', async () => {
        assert.strictEqual(on.ctx.indexnow.enabled, true);
        const res = await on.get(`/${KEY}.txt`);
        assert.strictEqual(res.status, 200, res.text);
        assert.match(res.headers.get('content-type'), /text\/plain/);
        assert.strictEqual(res.text, KEY);
    });
    await on.close();

    // A spy in place of the module's HTTP send: records every pingSoon batch.
    const pings = [];
    const spy = {
        enabled: true,
        keyFile: (_req, _res, next) => next(),
        pingSoon: (urls) => { const a = Array.isArray(urls) ? urls : [urls]; pings.push(...a); return a.length; },
        ping: async () => ({ sent: 0, status: 0 }),
        flush: async () => ({ sent: 0, status: 0 }),
    };
    const t = await boot({ indexnow: spy });
    const alice = t.network.addUser('alice', { display_name: 'Alice Writer' });
    await t.get('/api/v1/blogs', { as: alice, json: {} });
    let post;

    await check('a draft never pings', async () => {
        const r = await t.get('/api/v1/blogs/alice/posts', { as: alice, json: { title: 'First light', body: `Hello **world**.\n\n${LONG}` } });
        assert.strictEqual(r.status, 201, r.text);
        post = r.json().post;
        assert.deepStrictEqual(pings, []);
    });

    await check('a publish pings the page path and the sitemap', async () => {
        const r = await t.get(`/api/v1/posts/${post.id}/publish`, { as: alice, json: {} });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(pings.includes('https://openvibe.blog/@alice/first-light'), JSON.stringify(pings));
        assert.ok(pings.includes('https://openvibe.blog/sitemap.xml'), JSON.stringify(pings));
    });

    await check('an unpublish pings the page and the sitemap again', async () => {
        pings.length = 0;
        const r = await t.get(`/api/v1/posts/${post.id}/unpublish`, { as: alice, json: {} });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(pings.includes('https://openvibe.blog/@alice/first-light'), JSON.stringify(pings));
        assert.ok(pings.includes('https://openvibe.blog/sitemap.xml'), JSON.stringify(pings));
    });
    await t.close();

    done();
})().catch((err) => { console.error(err); process.exit(1); });
