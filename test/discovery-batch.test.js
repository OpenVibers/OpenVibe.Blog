'use strict';
/**
 * The sitemap and llms-full routes build their gate decisions from the whole public corpus per
 * request (roadmap hardening): each post's review must be fetched in ONE batched query, never one
 * round-trip per post — an O(posts) sequential lookup that 40 concurrent /sitemap.xml requests would
 * turn into tens of thousands of queries. This pins that no per-post review lookup happens while the
 * sitemap is built (the decision batch is passed in), and that the sitemap is still correct.
 *
 *   node test/discovery-batch.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');

(async () => {
    const t = await boot();
    const carol = t.network.addUser('carol');
    await t.get('/api/v1/blogs', { as: carol, json: {} });
    const posts = [];
    for (const title of ['First Post', 'Second Post', 'Third Post']) {
        const p = (await t.get('/api/v1/blogs/carol/posts', { as: carol, json: { title, body: `${title} ${LONG}`, visibility: 'public' } })).json().post;
        await t.get(`/api/v1/posts/${p.id}/publish`, { as: carol, json: {} });
        posts.push(p);
    }

    // Count the per-post review lookup the route used to make (publication.decide → reviewOf → latest).
    let perPostLookups = 0;
    const realLatest = t.ctx.store.reviews.latest.bind(t.ctx.store.reviews);
    t.ctx.store.reviews.latest = (...args) => { perPostLookups++; return realLatest(...args); };

    await check('the sitemap builds every decision without a per-post review lookup', async () => {
        perPostLookups = 0;
        const r = await t.get('/sitemaps/posts.xml');
        assert.strictEqual(r.status, 200, r.text.slice(0, 120));
        assert.strictEqual(perPostLookups, 0, `per-post review lookups: ${perPostLookups}`);
        for (const p of posts) assert.ok(r.text.includes(`/@carol/${p.slug}`), `sitemap names ${p.slug}`);
    });

    await check('llms-full.txt likewise, and still lists the posts', async () => {
        perPostLookups = 0;
        const r = await t.get('/llms-full.txt');
        assert.strictEqual(r.status, 200, r.text.slice(0, 120));
        assert.strictEqual(perPostLookups, 0, `per-post review lookups: ${perPostLookups}`);
        assert.ok(r.text.includes('First Post') && r.text.includes('Second Post') && r.text.includes('Third Post'));
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
