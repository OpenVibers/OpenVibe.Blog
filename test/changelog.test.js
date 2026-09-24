'use strict';
/**
 * The network changelog: releases seen at Network become entries from GitHub's compare; a batch, a
 * major release after a quiet spell, or age publishes one "Patch notes" post (imported authorship,
 * grouped by site, highlights first); the public /api/v1/changelog feeds every site.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { createChangelog, subjectOf } = require('../server/changelog');

const H = (n) => n.toString(16).padStart(40, 'a');
(async () => {
    const t = await boot();
    const releases = { live: 'aaaaaaa00001', tools: 'bbbbbbb00001' };
    const compares = {};
    const ghCalls = [];
    const fetchImpl = async (url) => {
        const u = new URL(url);
        const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
        if (u.pathname === '/api/v1/registry/services') return json({ services: [
            { id: 'live', name: 'OpenVibe.Live', repository: 'OpenVibers/OpenVibe.Live', publicOrigin: 'https://openvibe.live' },
            { id: 'tools', name: 'OpenVibe.Tools', repository: 'OpenVibers/OpenVibe.Tools', publicOrigin: 'https://openvibe.tools' },
            { id: 'norepo', name: 'X' },
        ] });
        if (u.pathname === '/api/v1/registry/releases') return json({ releases: Object.entries(releases).map(([id, r]) => ({ id, release: r, released_at: new Date(t.clock.now()).toISOString() })) });
        if (u.hostname === 'api.github.com') {
            ghCalls.push(u.pathname);
            const m = u.pathname.match(/^\/repos\/(.+)\/compare\/(.+)\.\.\.(.+)$/);
            if (m && compares[m[3]]) return json(compares[m[3]]);
            return json({ message: 'Not Found' }, 404);
        }
        return json({}, 404);
    };
    const config = { ...t.ctx.config, changelog: { ...t.ctx.config.changelog, enabled: true, batchSize: 5, majorLines: 500, quietMs: 30 * 60 * 1000, maxAgeMs: 7 * 24 * 3600 * 1000, minGapMs: 6 * 3600 * 1000, since: null, aiDraft: false, blogHandle: 'openvibe' } };
    const cl = createChangelog({ config, store: t.ctx.store, blogs: t.ctx.blogs, posts: t.ctx.posts, aiDrafts: null, fetchImpl, log: { log() {}, warn() {} } });
    const commit = (i, msg) => ({ sha: H(i), commit: { message: msg, author: { date: new Date(t.clock.now()).toISOString() } } });

    await check('a service seen for the first time only records its release', async () => {
        await cl.tick();
        assert.strictEqual(cl.entries().length, 0);
        assert.deepStrictEqual(ghCalls, [], 'no history dump');
    });

    await check('a new release adds its commits; small ones wait for a batch', async () => {
        releases.live = 'aaaaaaa00002';
        compares.aaaaaaa00002 = { status: 'ahead', commits: [commit(1, 'Fix the chat scroll\n\nbody text'), commit(2, 'Merge branch main')], files: [{ additions: 10, deletions: 2 }] };
        const r = await cl.tick();
        assert.strictEqual(r, null, 'not due yet');
        const e = cl.entries({ service: 'live' });
        assert.deepStrictEqual(e.map((x) => x.subject), ['Fix the chat scroll'], 'first lines only; merges skipped');
        assert.strictEqual(e[0].url, `https://github.com/OpenVibers/OpenVibe.Live/commit/${H(1)}`);
        assert.strictEqual(e[0].major, false);
    });

    await check('a major release publishes patch notes after a quiet spell', async () => {
        releases.tools = 'bbbbbbb00002';
        compares.bbbbbbb00002 = { status: 'ahead', commits: [commit(3, 'Recent tools in the launcher: anonymous and account history'), commit(4, 'Tidy the docs')], files: [{ additions: 700, deletions: 20 }] };
        assert.strictEqual(await cl.tick(), null, 'major, but deploys are not quiet yet');
        t.clock.advance(31 * 60 * 1000);
        const r = await cl.tick();
        assert.ok(r && r.post, 'published');
        const post = t.ctx.posts.get(r.post.id);
        assert.strictEqual(post.state, 'published');
        const head = t.ctx.posts.head(post);
        assert.strictEqual(head.fields.title, 'Patch notes: Recent tools in the launcher');
        assert.ok(head.content.includes('## Highlights') && head.content.includes('**OpenVibe.Tools:** Recent tools in the launcher'));
        assert.ok(head.content.includes('## OpenVibe.Live') && head.content.includes('Fix the chat scroll'));
        assert.strictEqual(head.meta.authorship.mode, 'imported');
        assert.strictEqual(cl.entries().filter((x) => !x.post_id).length, 0, 'every entry now belongs to the post');
    });

    await check('the public feed names the entries and the latest post', async () => {
        const r = await t.get('/api/v1/changelog?service=tools&limit=5');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
        const j = r.json();
        assert.deepStrictEqual(j.entries.map((x) => x.subject).sort(), ['Recent tools in the launcher: anonymous and account history', 'Tidy the docs']);
        assert.ok(j.entries.every((x) => x.service === 'tools' && x.post_id));
        assert.ok(j.latest_post && /\/@openvibe\//.test(j.latest_post.url), 'the latest patch notes post, to link to');
        assert.strictEqual(j.latest_post.title, 'Patch notes: Recent tools in the launcher');
    });

    await check('a batch publishes without a major, but never sooner than the gap after the last post', async () => {
        releases.live = 'aaaaaaa00003';
        compares.aaaaaaa00003 = { status: 'ahead', commits: [5, 6, 7, 8, 9].map((i) => commit(i, `Small change ${i}`)), files: [{ additions: 5, deletions: 5 }] };
        assert.strictEqual(await cl.tick(), null, 'too soon after the last post');
        t.clock.advance(6 * 3600 * 1000 + 1000);
        const r = await cl.tick();
        assert.ok(r && r.post);
        assert.ok(t.ctx.posts.head(t.ctx.posts.get(r.post.id)).fields.title.startsWith('Patch notes: 5 changes across 1 site'));
    });

    await check('subjects are cut at a word; version bumps count as major', async () => {
        assert.strictEqual(subjectOf('short'), 'short');
        const long = subjectOf(`${'word '.repeat(80)}end`, 60);
        assert.ok(long.endsWith('…') && long.length <= 61);
        releases.tools = 'bbbbbbb00003';
        compares.bbbbbbb00003 = { status: 'ahead', commits: [commit(10, '1.7.0: openvibe-shared/trace')], files: [{ additions: 3, deletions: 1 }] };
        await cl.tick();
        assert.strictEqual(cl.entries({ service: 'tools' })[0].major, true);
    });

    await t.close();
    done();
})();
