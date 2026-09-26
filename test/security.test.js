'use strict';
/**
 * Security regressions: names of drafts' and private posts' series and categories never reach
 * public pages; an unpublished post's Community thread is hidden; /auth/me is never cacheable.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');

(async () => {
    const t = await boot();
    const carol = t.network.addUser('carol');
    await t.get('/api/v1/blogs', { as: carol, json: {} });

    const make = async (title, { publish = true, ...extra } = {}) => {
        const p = (await t.get('/api/v1/blogs/carol/posts', { as: carol, json: { title, body: `${title} ${LONG}`, ...extra } })).json().post;
        if (publish) await t.get(`/api/v1/posts/${p.id}/publish`, { as: carol, json: {} });
        return p;
    };
    const open = await make('Open post', { categories: 'Science', series: 'Public series' });
    await make('Launch draft', { publish: false, categories: 'Launches > Project Nightingale', series: 'Nightingale countdown' });
    await make('Minutes', { visibility: 'private', categories: 'Board minutes', series: 'Board series' });

    await check('the blog front page lists only series and categories that hold posts the viewer may see', async () => {
        const r = await t.get('/@carol');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /Public series/);
        assert.match(r.text, /Science/);
        for (const secret of ['Nightingale', 'Launches', 'Board minutes', 'Board series']) assert.doesNotMatch(r.text, new RegExp(secret), `${secret} leaked`);
        const own = await t.get('/@carol', { as: carol });
        assert.match(own.text, /Board minutes/, 'a member sees the private post’s category');
    });

    await check('series and category pages without a visible post answer 404 without their names', async () => {
        for (const p of ['/@carol/series/nightingale-countdown', '/@carol/categories/project-nightingale', '/@carol/categories/launches', '/@carol/categories/board-minutes', '/@carol/series/board-series']) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 404, p);
            assert.doesNotMatch(r.text, /Nightingale|Launches|Board/, p);
        }
        assert.strictEqual((await t.get('/@carol/categories/board-minutes', { as: carol })).status, 200, 'members still see it');
        assert.strictEqual((await t.get('/@carol/series/public-series')).status, 200);
    });

    await check('unpublishing a public post hides its Community thread; publishing again shows it', async () => {
        await t.get('/@carol/open-post');   // the first view resolves the thread
        const thread = () => [...t.community.threads.values()][0];
        assert.ok(thread(), 'thread created');
        assert.strictEqual(thread().visibility, 'public');
        await t.get(`/api/v1/posts/${open.id}/unpublish`, { as: carol, json: {} });
        await new Promise((r) => setTimeout(r, 100));
        assert.strictEqual(thread().visibility, 'hidden');
        await t.get(`/api/v1/posts/${open.id}/publish`, { as: carol, json: {} });
        await new Promise((r) => setTimeout(r, 100));
        assert.strictEqual(thread().visibility, 'public');
    });

    await check('/auth/me is private, no-store', async () => {
        const r = await t.get('/auth/me', { as: carol });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
    });

    await check('/auth/me: a guest is signed out (200 { user: null }), a bad credential is 401', async () => {
        const guest = await t.get('/auth/me');
        assert.strictEqual(guest.status, 200, 'no cookie or token at all: not an error');
        assert.deepStrictEqual(guest.json(), { user: null });
        assert.strictEqual(guest.headers.get('cache-control'), 'private, no-store');
        assert.strictEqual((await t.get('/auth/me', { headers: { cookie: 'ov_token=expired.or.forged' } })).status, 401, 'a present but invalid cookie');
        assert.strictEqual((await t.get('/auth/me', { as: 'garbage' })).status, 401, 'a present but invalid bearer token');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
