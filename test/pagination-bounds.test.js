'use strict';
/**
 * Listings bound their page/offset (roadmap hardening): a pathological ?page= / ?offset= is clamped
 * before it reaches LIMIT/OFFSET — a huge OFFSET makes Postgres scan the skipped rows, and a value
 * past int4 is a query error answered as a 500. A page past the last still answers 404 (outOfRange).
 *
 *   node test/pagination-bounds.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const HUGE = '99999999999999999999';
const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');

(async () => {
    const t = await boot();
    const carol = t.network.addUser('carol');
    await t.get('/api/v1/blogs', { as: carol, json: {} });
    const p = (await t.get('/api/v1/blogs/carol/posts', { as: carol, json: { title: 'Only Post', body: LONG, visibility: 'public', tags: ['onlytag'] } })).json().post;
    await t.get(`/api/v1/posts/${p.id}/publish`, { as: carol, json: {} });

    await check('a page far past the end answers 404, not a query error', async () => {
        const r = await t.get(`/@carol?page=${HUGE}`);
        assert.strictEqual(r.status, 404, `page=${HUGE} → ${r.status} ${r.text.slice(0, 120)}`);
    });

    await check('the same on a collection page', async () => {
        const r = await t.get(`/@carol/tags/onlytag?page=${HUGE}`);
        assert.strictEqual(r.status, 404, `tag page: ${r.status}`);
    });

    await check('a huge API offset is clamped, not sent to LIMIT/OFFSET', async () => {
        const r = await t.get(`/api/v1/blogs/carol/posts?offset=${HUGE}`);
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.strictEqual(r.json().total, 1);
        assert.deepStrictEqual(r.json().posts, []);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
