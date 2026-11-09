'use strict';
const assert = require('assert');
const http = require('http');
const { boot, check, done, makeClock } = require('./helpers/boot');
const { meaningful, candidates, weekOf, WEEK } = require('../server/devblog');
const { main } = require('../scripts/devblog-backfill');
const MED = 'med_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const RUN = 'run_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const long = 'We added search to the channel page so readers can find a channel from the page. '.repeat(12);
(async () => {
    const requests = []; let fail = false, release, hold = false;
    const server = http.createServer(async (req, res) => {
        let raw = ''; for await (const c of req) raw += c;
        const send = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.method === 'GET') return send({ citations: [] });
        const body = JSON.parse(raw); requests.push(body);
        if (hold) await new Promise(r => { release = r; });
        if (fail) return send({ run: { id: RUN, status: 'failed', error: { code: 'devblog.check_failed' } } });
        send({ run: { id: RUN, status: 'succeeded', workflow: { key: 'content.devblog', version: 1 }, provenance: { model: 'local-test-writer' }, synthetic: false,
            output: { title: 'Search Party', summary: 'Channel search is ready.', checks: [], blocks: { type: 'root', children: [
                { type: 'hero', attrs: { kicker: 'Devblog' }, children: [{ type: 'text', value: '# Search Party\n\nChannel search is ready.' }] },
                { type: 'section', attrs: { id: 'channel-search' }, children: [{ type: 'text', value: `## Channel search\n\n${long}` }, { type: 'figure', attrs: { src: MED, alt: 'Channel search', caption: 'The search field' }, children: [] }] },
                { type: 'patchnotes', attrs: { from: body.input.from, to: body.input.to }, children: [] },
            ] } } } });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const clock = makeClock();
    const t = await boot({ clock, limitsNow: clock.now, env: { OV_AI_INTERNAL_URL: `http://127.0.0.1:${server.address().port}` } });
    const db = t.ctx.store.db; const blog = await t.ctx.blogs.official();
    t.media.objects.set(MED, 'ready');
    t.ctx.media.listShots = async () => [{ id: MED, metadata: { service: 'live', path: '/channels', viewport: '390', release: 'r1' } }];
    async function seed(service, at, subject = 'Add channel search', sha = 'abc') {
        await db.prepare(`INSERT INTO changelog_entries (service, repo, sha, subject, deployed_at, committed_at, release, release_lines, major) VALUES (?, ?, ?, ?, ?, ?, 'r1', 100, 0)`).run(service, `OpenVibers/OpenVibe.${service}`, sha, subject, at, at);
    }
    let post;
    await check('noise-only weeks never call AI; dry-run weeks are Monday based', async () => {
        assert.equal(weekOf('2026-11-08'), '2026-11-02');
        for (const subject of ['test: search page', 'docs: editor guide', 'openvibe-sdk v1.0.0', 'Pin search dependency']) assert.equal(meaningful({ subject }), false);
        assert.equal(meaningful({ subject: 'feat: Add video chapters' }), true);
        assert.equal(meaningful({ subject: 'fix: Restore stream playback' }), true);
        assert.equal(meaningful({ subject: 'Fix search', files: '["test/search.test.js"]' }), false);
        assert.deepEqual(candidates([{ service: 'live', deployed_at: '2026-11-03', subject: 'docs: search' }], { from: '2026-11-01', to: '2026-11-09' }), []);
        await seed('docs', new Date(t.clock.now()).toISOString(), 'docs: search');
        const r = await t.get('/api/v1/blogs/openvibe/posts/devblog', { as: t.official, json: { service: 'docs' } });
        assert.equal(r.status, 422, r.text); assert.equal(requests.length, 0);
    });
    await check('owner authorization, concurrent reservation, task request and attached blocks', async () => {
        await seed('live', new Date(t.clock.now()).toISOString());
        const stranger = t.network.addUser('stranger');
        assert.equal((await t.get('/api/v1/blogs/openvibe/posts/devblog', { as: stranger, json: { service: 'live' } })).status, 403);
        hold = true;
        const first = t.get('/api/v1/blogs/openvibe/posts/devblog', { as: t.official, json: { service: 'live' } });
        while (!release) await new Promise(r => setTimeout(r, 10));
        const second = await t.get('/api/v1/blogs/openvibe/posts/devblog', { as: t.official, json: { service: 'live' } });
        assert.equal(second.status, 409, second.text); release(); hold = false;
        const r = await first; assert.equal(r.status, 201, r.text); post = r.json().post;
        assert.equal(post.state, 'draft'); assert.equal(post.authorship.mode, 'ai');
        assert.equal(post.authorship.workflow.id, 'content.devblog');
        assert.equal(requests[0].task, 'blog.devblog.write'); assert.equal(requests[0].input.screenshots[0].media_id, MED);
        assert.equal((await t.ctx.posts.attachments(post))[0].mediaId, MED);
        const repeat = await t.get('/api/v1/blogs/openvibe/posts/devblog', { as: t.official, json: { service: 'live' } });
        assert.equal(repeat.json().post.id, post.id); assert.equal(requests.length, 1);
        assert.equal((await db.prepare('SELECT post_id FROM changelog_entries WHERE service = ?').get('live')).post_id, null, 'daily Patch notes still owns entry assignment');
    });
    await check('a person must approve; AI editor approval cannot publish or schedule it', async () => {
        assert.equal((await t.get(`/api/v1/posts/${post.id}/publish`, { as: t.official, json: {} })).status, 409);
        await t.ctx.store.reviews.recordAiEditor({ entityId: post.id, revision: 1, principal: 'svc:ai-editor', decision: 'approved' });
        await assert.rejects(() => t.ctx.posts.applyPublish(post.id, 1, { kind: 'service', service: 'svc:ai-editor' }), e => e.code === 'devblog.person_review_required');
        const r = await t.get(`/api/v1/posts/${post.id}/reviews`, { as: t.official, json: { revision: 1, decision: 'approved' } });
        assert.equal(r.status, 201, r.text);
        const published = await t.get(`/api/v1/posts/${post.id}/publish`, { as: t.official, json: {} }); assert.equal(published.status, 200, published.text);
        const page = await t.get('/devblog/live'); assert.match(page.text, /Search Party/); assert.match(page.text, /Channel search is ready/); assert(page.text.includes(MED));
        assert.doesNotMatch((await t.get('/devblog/blog')).text, /Search Party/);
        assert.match((await t.get('/devblog')).text, /Search Party/);
        const api = await t.get('/api/v1/devblogs?service=live');
        assert.equal(api.status, 200, api.text); assert.equal(api.json().posts[0].figure.mediaId, MED);
        assert.equal(api.json().posts[0].summary, 'Channel search is ready.');
        assert.equal((await t.get('/.well-known/agent.json')).json().skills[0].task, 'blog.devblog.write');
        const skill = (await t.get('/skills/devblog.json')).json();
        assert.equal(skill.skill, 'actor.skill@1');
        const { integrity, ...fields } = skill;
        assert.equal(integrity.hash, require('crypto').createHash('sha256').update(JSON.stringify(fields)).digest('hex'));

    });
    await check('seven-day guard survives a new week; failed runs leave no post and require an owner retry', async () => {
        t.clock.advance(6 * 86400000);
        await seed('live', new Date(t.clock.now()).toISOString(), 'Add search menu', 'def');
        assert.equal((await t.get('/api/v1/blogs/openvibe/posts/devblog', { as: t.official, json: { service: 'live' } })).status, 409);
        t.clock.advance(86400000 + 1); fail = true;
        const before = (await db.prepare('SELECT COUNT(*) AS n FROM blog_posts').get()).n;
        const failed = await t.get('/api/v1/blogs/openvibe/posts/devblog', { as: t.official, json: { service: 'live' } }); assert.equal(failed.status, 502, failed.text);
        assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM blog_posts').get()).n, before);
        await assert.rejects(() => t.ctx.devblog.draft({ kind: 'user', subject: t.official.subject }, blog, { service: 'live' }), e => e.code === 'devblog.failed');
        fail = false;
        const retry = await t.get('/api/v1/blogs/openvibe/posts/devblog', { as: t.official, json: { service: 'live' } }); assert.equal(retry.status, 201, retry.text);
    });
    await check('snapshot backfill is dry-run only and does not call AI', async () => {
        const fs = require('fs'), path = require('path'), os = require('os');
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devblog-plan-')), 'entries.json');
        fs.writeFileSync(file, JSON.stringify([{ service: 'live', subject: 'Add search menu', deployed_at: '2026-11-03' }]));
        const before = requests.length;
        const plan = await main(['--input', file, '--from', '2026-11-02', '--to', '2026-11-09']); assert.equal(plan.length, 1); assert.equal(requests.length, before);
        await assert.rejects(() => main(['--input', file, '--from', '2026-11-02', '--to', '2026-11-09', '--write']));
        fs.rmSync(path.dirname(file), { recursive: true });
    });
    await t.close(); await new Promise(r => server.close(r)); done();
})();
