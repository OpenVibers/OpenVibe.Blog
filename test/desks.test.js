'use strict';
/**
 * The AI desks (server/desks/): digests written by OpenVibe.AI from OpenVibe.Sources' items, and the satire desk.
 *   - a desk's period is the day (or Monday-to-Sunday week) before, written after its hour;
 *   - the first pull dates items by when Sources first saw them, a later revision by when Blog saw it, and a removed
 *     item is dropped; a period with fewer items than the desk's minimum gets no post;
 *   - a section the AI did not cite is left out and said so; a failure is retried with a new key; stub output is hidden;
 *   - every page and feed says the text is AI-written (the satire desk: made up), and nothing is indexed;
 *   - staff can hide a post and show it again; nobody else can.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { duePeriod, periodLabel } = require('../server/desks/desks');
const catalog = require('../server/desks/catalog');

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
    await check('periods: the day before after the desk\'s hour, Monday-to-Sunday weeks, satire by the day', () => {
        const news = catalog.byKey('news');
        assert.deepStrictEqual(duePeriod(news, at('2026-10-15T05:00:00Z')), { from: at('2026-10-13T00:00:00Z'), to: at('2026-10-14T00:00:00Z') });
        assert.deepStrictEqual(duePeriod(news, at('2026-10-15T06:00:00Z')), { from: at('2026-10-14T00:00:00Z'), to: at('2026-10-15T00:00:00Z') });
        const hosting = catalog.byKey('hosting');
        assert.deepStrictEqual(duePeriod(hosting, at('2026-10-12T07:30:00Z')), { from: at('2026-10-05T00:00:00Z'), to: at('2026-10-12T00:00:00Z') }, 'Monday after 07:00');
        assert.deepStrictEqual(duePeriod(hosting, at('2026-10-18T23:00:00Z')), { from: at('2026-10-05T00:00:00Z'), to: at('2026-10-12T00:00:00Z') }, 'Sunday: still last week');
        assert.strictEqual(periodLabel(news, { from: at('2026-10-14T00:00:00Z'), to: at('2026-10-15T00:00:00Z') }), 'Wednesday 14 October 2026');
        assert.strictEqual(periodLabel(hosting, { from: at('2026-10-05T00:00:00Z'), to: at('2026-10-12T00:00:00Z') }), 'the week of 5 October to 11 October 2026');
        assert.deepStrictEqual(catalog.questionFor(0), { topic: catalog.QUESTIONS[0], angle: catalog.ANGLES[0] });
        assert.strictEqual(catalog.questionFor(catalog.QUESTIONS.length).angle, catalog.ANGLES[1], 'the second round changes the angle');
    });

    // OpenVibe.Sources: the change feed by category.
    let seq = 0;
    const feed = [];
    const add = (category, source_key, item) => {
        const it = { id: item.id, source_key, category, kind: 'article', canonical_url: `https://example.gov/${item.id}`, title: `Item ${item.id}`, summary: `What ${item.id} says.`,
            published_at: null, fields: {}, revision: 1, removed: null, provenance: { first_seen_at: item.first_seen_at }, ...item, change_seq: ++seq };
        const i = feed.findIndex((x) => x.id === it.id);
        if (i >= 0) feed.splice(i, 1);
        feed.push(it);
    };
    const sources = await stub((req) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname !== '/api/v1/items') return null;
        const after = Number(u.searchParams.get('after'));
        const items = feed.filter((x) => x.category === u.searchParams.get('category') && x.change_seq > after).sort((a, b) => a.change_seq - b.change_seq);
        return { body: { items, next_after: items.length ? items[items.length - 1].change_seq : after, more: false, sources: {} } };
    });
    add('news', 'govuk-news', { id: 'n1', first_seen_at: '2026-10-14T09:00:00Z' });
    add('news', 'eu-press-corner', { id: 'n2', first_seen_at: '2026-10-14T11:00:00Z' });
    add('news', 'nasa-news-releases', { id: 'n3', first_seen_at: '2026-10-14T20:00:00Z' });
    add('news', 'govuk-news', { id: 'n0', first_seen_at: '2026-10-10T09:00:00Z' });
    add('news', 'some-other-feed', { id: 'x1', first_seen_at: '2026-10-14T09:00:00Z' });
    add('news', 'fda-food-recalls', { id: 'f1', first_seen_at: '2026-10-14T15:00:00Z', title: 'Company recalls hummus over undeclared sesame' });
    add('hosting', 'linode-types', { id: 'h1', first_seen_at: '2026-10-01T09:00:00Z', kind: 'plan', fields: { vcpus: 1, price_monthly: 5 } });

    // OpenVibe.AI: blog.write_digest and blog.write_satire.
    const runs = [];
    let mode = 'ok';
    const ai = await stub((req, body) => {
        if (req.method === 'POST' && req.url.startsWith('/api/v1/runs')) {
            runs.push(body);
            const id = `run_${runs.length}`;
            if (mode === 'fail') return { status: 201, body: { run: { id, status: 'failed', error: { code: 'provider.unavailable', detail: 'down' } } } };
            const n = body.input.sources ? body.input.sources.length : 0;
            const output = body.workflow === 'blog.write_satire'
                ? { title: 'Is it safe to let your air fryer vote?', dek: 'Experts at the Institute of Crisp are alarmed.', body_markdown: '## The crisis\n\nYour air fryer has opinions.\n\n# A stray title\n\nIt does.', tags: ['Appliances', 'democracy'] }
                : body.input.desk === 'Hosting digest'
                    // An answer in the first shape (one body per section) still makes a post.
                    ? { title: 'Hosting digest for the week (5 October 2026)', dek: 'Plans.', sections: [{ heading: 'Plans', body: 'A plan changed its price.', citations: [0] }], citations: [0], gaps: [] }
                    : { title: 'Recalls and releases', dek: 'What was announced.', sections: [
                        { heading: 'Announcements', paragraphs: [{ text: 'Two agencies announced things (Source 0).', citations: [0, 1, 99] }, { text: 'An uncited aside.', citations: [] }] },
                        { heading: 'Unsourced', paragraphs: [{ text: 'Something the AI made up.', citations: [] }] },
                        ...(n > 2 ? [{ heading: 'Space', paragraphs: [{ text: 'NASA said something [2].', citations: [2] }] }] : []),
                    ], citations: [0], gaps: ['Item 3 had no date.'] };
            return { status: 201, body: { run: { id, status: 'succeeded', workflow: { key: body.workflow, version: 1 }, synthetic: mode === 'stub', provenance: { model: 'gpt-test' }, output } } };
        }
        if (/^\/api\/v1\/runs\/[^/]+\/citations$/.test(req.url)) return { body: { citations: [] } };
        return null;
    });

    const t = await boot({ env: { OV_AI_INTERNAL_URL: ai.url, OV_SOURCES_INTERNAL_URL: sources.url } });
    t.clock.set(at('2026-10-15T08:00:00Z'));
    const desks = t.ctx.desks;
    const boss = t.network.addUser('boss', { role: 'admin' });
    const kim = t.network.addUser('kim');
    let news;
    let satire;

    await check('a tick pulls, then writes the news, food and satire posts; a desk below its minimum writes nothing', async () => {
        assert.ok(desks.enabled);
        const r = await desks.tick();
        assert.ok(r && r.written === 3, JSON.stringify(r));
        const byWorkflow = (w) => runs.filter((x) => x.workflow === w);
        const digests = byWorkflow('blog.write_digest');
        assert.deepStrictEqual(digests.map((x) => x.input.desk).sort(), ['Food safety digest', 'News digest']);
        const n = digests.find((x) => x.input.desk === 'News digest');
        assert.deepStrictEqual(n.input.sources.map((s) => s.source_id), ['n3', 'n2', 'n1'], 'the period\'s items of its own sources, newest first (n0 is older, x1 is another source)');
        assert.strictEqual(n.input.period, 'Wednesday 14 October 2026');
        assert.ok(n.input.sources[0].snippet.includes('New at the source.'));
        assert.match(n.idempotency_key, /^blog\.desk:dsk_[0-9a-f]{20}:1$/);
        assert.deepStrictEqual(byWorkflow('blog.write_satire').map((x) => x.input), [catalog.questionFor(0)]);
        news = await desks.bySlug('news', '2026-10-14');
        assert.strictEqual(news.status, 'published');
        assert.deepStrictEqual(news.body.sections.map((s) => [s.heading, s.paragraphs.map((p) => [p.text, p.cites])]),
            [['Announcements', [['Two agencies announced things.', [0, 1]]]], ['Space', [['NASA said something.', [2]]]]],
            'uncited paragraphs and sections dropped, out-of-range citations dropped, source numbers taken out of the text');
        assert.ok(news.body.gaps.includes('2 paragraph(s) the AI wrote without citing an item were left out.'));
        satire = (await desks.list('satire')).posts[0];
        assert.strictEqual(satire.slug, '2026-10-14-is-it-safe-to-let-your-air-fryer-vote');
        assert.deepStrictEqual(satire.body.tags, ['appliances', 'democracy']);
        assert.strictEqual((await desks.list('deals')).total, 0);
        assert.strictEqual((await desks.list('hosting')).total, 0, 'a plan first seen weeks ago is not news this week');
    });

    await check('nothing is written twice; a changed item is dated when Blog saw it; a removed item is dropped', async () => {
        const before = runs.length;
        await desks.tick();
        assert.strictEqual(runs.length, before, 'the period already has its posts');
        add('hosting', 'linode-types', { id: 'h1', first_seen_at: '2026-10-01T09:00:00Z', kind: 'plan', revision: 2, fields: { vcpus: 1, price_monthly: 6 } });
        add('news', 'govuk-news', { id: 'n1', removed: { at: '2026-10-15T08:00:00Z', reason: 'licence' } });
        await desks.pull();
        const h1 = await t.ctx.store.db.maybe('SELECT * FROM blog_desk_items WHERE item_id = $1', ['h1']);
        assert.strictEqual(Number(h1.changed_at), at('2026-10-15T08:00:00Z'));
        assert.strictEqual(await t.ctx.store.db.maybe('SELECT * FROM blog_desk_items WHERE item_id = $1', ['n1']), null);
        t.clock.set(at('2026-10-19T08:00:00Z'));
        await desks.tick();
        const hosting = (await desks.list('hosting')).posts[0];
        assert.ok(hosting, 'the week with the price change gets a post');
        assert.strictEqual(hosting.slug, '2026-10-12');
        assert.strictEqual(hosting.title, 'Hosting digest: the week of 12 October to 18 October 2026', 'a title naming the format gives way to the desk\'s own');
        assert.deepStrictEqual(hosting.body.sections[0].paragraphs, [{ text: 'A plan changed its price.', cites: [0] }]);
        const req = runs.filter((x) => x.input.desk === 'Hosting digest').pop();
        assert.ok(req.input.sources[0].snippet.includes('Changed at the source (revision 2)') && req.input.sources[0].snippet.includes('price_monthly: 6'));
    });

    await check('a failed run is retried after 30 minutes with a new key, three attempts at most; stub text is hidden', async () => {
        add('news', 'fda-food-recalls', { id: 'f2', first_seen_at: '2026-10-19T10:00:00Z' });
        t.clock.set(at('2026-10-20T08:00:00Z'));
        await desks.pull();
        mode = 'fail';
        await desks.compose();
        let row = await t.ctx.store.db.maybe("SELECT * FROM blog_desk_posts WHERE desk = 'food' AND slug = '2026-10-19'");
        assert.deepStrictEqual([row.status, row.attempts], ['failed', 1]);
        const n = runs.length;
        await desks.compose();
        assert.strictEqual(runs.filter((x) => x.input.desk === 'Food safety digest').length, runs.slice(0, n).filter((x) => x.input.desk === 'Food safety digest').length, 'not before 30 minutes');
        t.clock.advance(31 * 60_000);
        mode = 'stub';
        await desks.compose();
        row = await t.ctx.store.db.maybe("SELECT * FROM blog_desk_posts WHERE desk = 'food' AND slug = '2026-10-19'");
        assert.strictEqual(runs.filter((x) => x.input.desk === 'Food safety digest').pop().idempotency_key, `blog.desk:${row.id}:2`);
        assert.deepStrictEqual([row.status, row.synthetic, row.hidden_reason], ['hidden', true, 'Written by the stub provider (synthetic text).']);
        mode = 'ok';
    });

    await check('pages: labelled as AI, satire says it is made up, cited items linked, never indexed', async () => {
        const index = await t.get('/desks');
        assert.strictEqual(index.status, 200);
        assert.ok(index.text.includes('Written by AI.') && index.text.includes('/desks/news/2026-10-14') && index.text.includes('Is This Real?'));
        assert.match(index.headers.get('x-robots-tag'), /noindex/);
        assert.match(index.text, /<meta name="robots" content="noindex/);
        const page = await t.get('/desks/news/2026-10-14');
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('AI-generated</strong> from 3 items'));
        assert.ok(page.text.includes('href="https://example.gov/n2" rel="nofollow noopener"'));
        assert.ok(page.text.includes('<p>Two agencies announced things. <span class="desk-cites">[<a href="#src-1" aria-label="Item 1">1</a>, <a href="#src-2" aria-label="Item 2">2</a>]</span></p>') && page.text.includes('id="src-3"'));
        assert.ok(!page.text.includes('Something the AI made up'));
        assert.ok(page.text.includes('<h2>The items it cites</h2><ol><li id="src-1" value="1">'), 'cited items first, numbered as cited');
        assert.match(page.headers.get('cache-control'), /max-age=60/);
        const s = await t.get(`/desks/satire/${satire.slug}`);
        assert.ok(s.text.includes('<strong>Satire.</strong> This is made up'));
        assert.ok(s.text.includes('<title>Is it safe to let your air fryer vote? (satire)'));
        assert.ok(s.text.includes('<h2') && !/<h1[^>]*>A stray title/.test(s.text), 'the AI\'s headings sit under the page title');
        const rss = await t.get('/desks/satire/feed.xml');
        assert.ok(rss.text.includes('[Satire] Is it safe to let your air fryer vote?'));
        const atom = await t.get('/desks/news/atom.xml');
        assert.ok(atom.text.includes('<feed') && atom.text.includes('Recalls and releases'));
        const json = (await t.get('/desks/news/2026-10-14.json')).json();
        assert.deepStrictEqual([json.post.authorship.mode, json.post.authorship.reviewed, json.post.sources.length], ['ai', false, 3]);
        assert.strictEqual((await t.get('/desks/food/2026-10-19')).status, 404, 'hidden: not for readers');
        assert.strictEqual((await t.get('/desks/nope')).status, 404);
    });

    await check('staff hide a post and show it again; a member cannot', async () => {
        const denied = await t.get('/desks/news/2026-10-14/hide', { as: kim, form: { _csrf: t.csrf(kim), reason: 'no' } });
        assert.strictEqual(denied.status, 403);
        const hid = await t.get('/desks/news/2026-10-14/hide', { as: boss, form: { _csrf: t.csrf(boss), reason: 'Wrong numbers' } });
        assert.strictEqual(hid.status, 303);
        assert.strictEqual((await t.get('/desks/news/2026-10-14')).status, 404);
        const staffView = await t.get('/desks/news/2026-10-14', { as: boss });
        assert.ok(staffView.text.includes('Hidden: Wrong numbers') && staffView.text.includes('Show it again'));
        assert.ok(!(await t.get('/desks/news/feed.xml')).text.includes('Recalls and releases'));
        await t.get('/desks/news/2026-10-14/show', { as: boss, form: { _csrf: t.csrf(boss) } });
        assert.strictEqual((await t.get('/desks/news/2026-10-14')).status, 200);
    });

    await t.close();
    await ai.close();
    await sources.close();
    done();
})();
