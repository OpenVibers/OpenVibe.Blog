'use strict';
/**
 * Draft with AI (W13, proof flow 5 on Blog): a member asks OpenVibe.AI's blog.draft_post for a draft;
 * Blog files the answer as an AI-authored, noindex draft with the run's citations. The API and the
 * no-JS editor form both work, a failed run makes no post, and without AI configured nothing is offered.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

const RUN = 'run_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const LONG = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');

(async () => {
    const asked = [];
    let mode = 'ok';
    const aiSrv = await new Promise((r) => { const s = http.createServer((req, res) => {
        let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
            const json = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
            if (req.method === 'POST' && req.url.startsWith('/api/v1/runs')) {
                asked.push({ auth: req.headers.authorization || null, body: JSON.parse(b) });
                if (mode === 'fail') return json(201, { run: { id: RUN, status: 'failed', error: { code: 'provider.unavailable', detail: 'down' } } });
                return json(201, { run: { id: RUN, status: 'succeeded', workflow: { key: 'blog.draft_post', version: 3 }, synthetic: false, provenance: { model: 'm-1' },
                    output: { title: 'Why we self-host', dek: 'Owning the stack', body_markdown: `## Why\n\n${LONG}`, tags: ['hosting', 'open source'], citations: [], gaps: [] } } });
            }
            if (req.url === `/api/v1/runs/${RUN}/citations`) return json(200, { citations: [{ url: 'https://example.org/self-hosting', title: 'Self-hosting notes', snippet: 'Costs fell.' }] });
            json(404, {});
        });
    }).listen(0, '127.0.0.1', () => r(s)); });

    const t = await boot({ env: { OV_AI_INTERNAL_URL: `http://127.0.0.1:${aiSrv.address().port}` } });
    const fay = t.network.addUser('fay', { display_name: 'Fay' });
    await t.get('/api/v1/blogs', { as: fay, json: {} });
    let draft;

    await check('the API writes an AI-authored draft for the member who asked', async () => {
        const r = await t.get('/api/v1/blogs/fay/posts/ai-draft', { as: fay, json: { topic: 'Why we self-host', tone: 'plain' } });
        assert.strictEqual(r.status, 201, r.text);
        draft = r.json().post;
        assert.strictEqual(draft.state, 'draft');
        assert.strictEqual(draft.authorship.mode, 'ai');
        assert.deepStrictEqual({ id: draft.authorship.workflow.id, runId: draft.authorship.workflow.runId }, { id: 'blog.draft_post', runId: RUN });
        assert.deepStrictEqual(draft.authorship.authors, [], 'the text is never attributed to the person');
        assert.strictEqual(asked[0].body.workflow, 'blog.draft_post');
        assert.deepStrictEqual(asked[0].body.input, { topic: 'Why we self-host', tone: 'plain' });
        assert.deepStrictEqual(asked[0].body.on_behalf_of, { type: 'user', id: fay.subject });
        assert.strictEqual(asked[0].body.target.service, 'blog');
        assert.ok(/^Bearer /.test(asked[0].auth), 'Blog\'s service token');
        const cites = t.ctx.posts.citations(t.ctx.store.db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(draft.id) || { id: draft.id }, 1);
        assert.ok(cites.some((c) => c.url === 'https://example.org/self-hosting'), 'the run\'s citations are on revision 1');
    });

    await check('it cannot be published before a person reviews it', async () => {
        const p = await t.get(`/api/v1/posts/${draft.id}/publish`, { as: fay, json: {} });
        assert.notStrictEqual(p.status, 200, p.text);
    });

    await check('the no-JS editor offers the form and files the draft', async () => {
        const page = await t.get('/write/@fay/new', { as: fay });
        assert.ok(page.text.includes('Draft with AI') && page.text.includes('/write/@fay/ai-draft'));
        const r = await t.get('/write/@fay/ai-draft', { as: fay, form: { _csrf: t.csrf(fay), topic: 'A second one' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 200));
        assert.ok(/^\/write\/posts\/[^?]+\?saved=/.test(r.headers.get('location')));
    });

    await check('a failed run makes no post; a stranger cannot ask', async () => {
        mode = 'fail';
        const before = t.ctx.store.db.prepare('SELECT count(*) AS n FROM blog_posts').get().n;
        const r = await t.get('/api/v1/blogs/fay/posts/ai-draft', { as: fay, json: { topic: 'x' } });
        assert.strictEqual(r.status, 502);
        assert.strictEqual(r.json().code, 'ai.run_failed');
        assert.strictEqual(t.ctx.store.db.prepare('SELECT count(*) AS n FROM blog_posts').get().n, before);
        mode = 'ok';
        const stranger = t.network.addUser('stranger');
        assert.strictEqual((await t.get('/api/v1/blogs/fay/posts/ai-draft', { as: stranger, json: { topic: 'x' } })).status, 403);
        assert.strictEqual((await t.get('/api/v1/blogs/fay/posts/ai-draft', { as: fay, json: {} })).status, 422, 'a topic is required');
    });

    await t.close();
    const t2 = await boot();
    await check('without OV_AI_INTERNAL_URL nothing is offered', async () => {
        const eve = t2.network.addUser('eve');
        await t2.get('/api/v1/blogs', { as: eve, json: {} });
        assert.ok(!(await t2.get('/write/@eve/new', { as: eve })).text.includes('Draft with AI'));
        assert.strictEqual((await t2.get('/api/v1/blogs/eve/posts/ai-draft', { as: eve, json: { topic: 'x' } })).status, 503);
    });
    await t2.close();
    aiSrv.close();
    done();
})();
