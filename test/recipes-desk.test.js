'use strict';
/**
 * The budget-recipes desk (server/desks/, feed 'food-library'): the week's new recipes from OpenVibe.Food's library
 * (/recipes/library.json), written up by blog.write_digest with each recipe as a `food.recipe` source.
 *   - off without OV_FOOD_URL; the pull asks Food for what is new since the newest recipe Blog holds;
 *   - a week with fewer recipes than the desk's minimum gets no post; the post cites Food's recipe pages.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

const at = (s) => Date.parse(s);

function stub(handler) {
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                const out = handler(req, raw ? JSON.parse(raw) : null) || { status: 404, body: {} };
                res.writeHead(out.status || 200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(out.body));
            });
        }).listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) }));
    });
}

(async () => {
    const recipe = (slug, created_at, extra = {}) => ({
        slug, url: `https://openvibe.food/recipes/library/${slug}`, title: slug.replace(/-/g, ' '), theme: 'cheap dinners',
        serves: 2, minutes: 20, cost: 4.5, cost_partial: false, ingredients: ['rice', 'beans', 'onion'], reviewed: false, created_at, ...extra,
    });
    const library = [
        recipe('beans-and-rice', '2026-10-06T10:00:00.000Z', { reviewed: true }),
        recipe('lentil-soup', '2026-10-08T10:00:00.000Z'),
        recipe('egg-fried-rice', '2026-10-11T10:00:00.000Z'),
        recipe('next-week-pasta', '2026-10-13T10:00:00.000Z'),
    ];
    const asked = [];
    const food = await stub((req) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname !== '/recipes/library.json') return null;
        const since = u.searchParams.get('since');
        asked.push(since);
        return { body: { recipes: library.filter((x) => x.created_at >= since) } };
    });
    const runs = [];
    const ai = await stub((req, body) => {
        if (req.method === 'POST' && req.url.startsWith('/api/v1/runs')) {
            runs.push(body);
            const output = body.workflow === 'blog.write_satire'
                ? { title: 'Satire', dek: 'x', body_markdown: 'Made up.', tags: [] }
                : { title: 'Lentil soup and two rice dishes under five dollars', dek: 'Three cheap dinners.', sections: [
                    { heading: 'Dinners', paragraphs: [{ text: 'Beans and rice feeds two for about $4.50.', citations: [0] }, { text: 'Lentil soup and egg fried rice use the same pantry.', citations: [1, 2] }] },
                ], citations: [0], gaps: [] };
            return { status: 201, body: { run: { id: `run_${runs.length}`, status: 'succeeded', workflow: { key: body.workflow, version: 1 }, provenance: { model: 'gpt-test' }, output } } };
        }
        if (/^\/api\/v1\/runs\/[^/]+\/citations$/.test(req.url)) return { body: { citations: [] } };
        return null;
    });

    const off = await boot({ env: { OV_AI_INTERNAL_URL: ai.url } });
    await check('off without OV_FOOD_URL: nothing is asked of Food', async () => {
        off.clock.set(at('2026-10-15T09:00:00Z'));
        await off.ctx.desks.tick();
        assert.deepStrictEqual(asked, []);
        assert.strictEqual((await off.ctx.desks.list('recipes')).total, 0);
    });
    await off.close();
    runs.length = 0;

    const t = await boot({ env: { OV_AI_INTERNAL_URL: ai.url, OV_FOOD_URL: food.url } });
    t.clock.set(at('2026-10-15T09:00:00Z'));
    const desks = t.ctx.desks;

    await check('the week\'s recipes become one cited post; the next pull asks only for what is newer', async () => {
        const r = await desks.tick();
        assert.ok(r, 'the tick ran');
        assert.match(asked[0], /^2026-10-01T09:00:00/, 'the first pull reaches two weeks back');
        const digest = runs.find((x) => x.workflow === 'blog.write_digest' && x.input.desk === 'Budget recipes');
        assert.ok(digest, JSON.stringify(runs.map((x) => x.input && x.input.desk)));
        assert.deepStrictEqual(digest.input.sources.map((s) => s.source_id), ['food:egg-fried-rice', 'food:lentil-soup', 'food:beans-and-rice'], 'the week of 5 to 11 October, newest first');
        assert.ok(digest.input.sources.every((s) => s.source_type === 'food.recipe' && s.url.startsWith('https://openvibe.food/recipes/library/')));
        assert.ok(digest.input.sources[2].snippet.includes('$4.50 to buy') && digest.input.sources[2].snippet.includes('Checked by a person.'));
        const posts = (await desks.list('recipes')).posts;
        assert.strictEqual(posts.length, 1);
        assert.strictEqual(posts[0].title, 'Lentil soup and two rice dishes under five dollars');
        const page = await t.get(`/desks/recipes/${posts[0].slug}`);
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('https://openvibe.food/recipes/library/lentil-soup'), 'it links the recipes');
        await desks.tick();
        assert.match(asked[asked.length - 1], /^2026-10-13T10:00:00/, 'then only what is newer than the newest recipe Blog holds');
    });

    await check('a week below the minimum gets no post', async () => {
        t.clock.set(at('2026-10-22T09:00:00Z'));
        await desks.tick();
        assert.strictEqual((await desks.list('recipes')).total, 1, 'one recipe in the week of 12 October is not enough');
    });

    await t.close();
    await food.close();
    await ai.close();
    done();
})();
