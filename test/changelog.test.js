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
    const history = {};
    const fetchImpl = async (url) => {
        const u = new URL(url);
        const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
        if (u.pathname === '/api/v1/registry/services') return json({ services: [
            { id: 'live', name: 'OpenVibe.Live', repository: 'OpenVibers/OpenVibe.Live', publicOrigin: 'https://openvibe.live' },
            { id: 'tools', name: 'OpenVibe.Tools', repository: 'OpenVibers/OpenVibe.Tools', publicOrigin: 'https://openvibe.tools' },
            { id: 'norepo', name: 'X' },
        ] });
        if (u.pathname === '/api/v1/registry/releases') return json({ checked_at: null, libraries: [], behind: [], services: Object.entries(releases).map(([id, r]) => ({ id, release: r, released_at: new Date(t.clock.now()).toISOString() })) });
        if (u.hostname === 'api.github.com') {
            ghCalls.push(u.pathname);
            const m = u.pathname.match(/^\/repos\/(.+)\/compare\/(.+)\.\.\.(.+)$/);
            if (m && compares[m[3]]) return json(compares[m[3]]);
            const h = u.pathname.match(/^\/repos\/(.+)\/commits$/);
            if (h && history[h[1]]) return json(history[h[1]]);
            return json({ message: 'Not Found' }, 404);
        }
        return json({}, 404);
    };
    const config = { ...t.ctx.config, changelog: { ...t.ctx.config.changelog, enabled: true, batchSize: 5, majorLines: 500, quietMs: 30 * 60 * 1000, maxAgeMs: 7 * 24 * 3600 * 1000, minGapMs: 6 * 3600 * 1000, since: null, aiDraft: false, blogHandle: 'openvibe', history: 0 } };
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

    await check('history: each site\'s earlier commits once, never pending, with authors; the feed pages by cursor', async () => {
        history['OpenVibers/OpenVibe.Live'] = [20, 21, 22].map((i) => ({ sha: H(i), commit: { message: `Earlier change ${i}\n\nbody`, author: { name: 'OpenVibers', date: new Date(t.clock.now() - (30 - i) * 86400000).toISOString() } } }))
            .concat([{ sha: H(5), commit: { message: 'Small change 5', author: { name: 'OpenVibers', date: new Date(t.clock.now()).toISOString() } } }]);
        const hc = createChangelog({ config: { ...config, changelog: { ...config.changelog, history: 50 } }, store: t.ctx.store, blogs: t.ctx.blogs, posts: t.ctx.posts, fetchImpl, log: { log() {}, warn() {} } });
        const before = hc.stats().pending;
        await hc.collect();
        assert.strictEqual(hc.stats().pending, before, 'history never waits for a patch notes post');
        const all = hc.entries({ service: 'live', limit: 100 });
        assert.ok(all.some((e) => e.subject === 'Earlier change 20' && e.author === 'OpenVibers' && e.post_id === null));
        assert.strictEqual(all.find((e) => e.sha === H(5)).author, 'OpenVibers', 'a known commit gains its author');
        const calls = ghCalls.length;
        await hc.collect();
        assert.strictEqual(ghCalls.length, calls, 'imported once (a repository GitHub will not list is not asked again either)');
        const p1 = hc.page({ service: 'live', limit: 2 });
        assert.strictEqual(p1.entries.length, 2);
        assert.ok(p1.next);
        const p2 = hc.page({ service: 'live', limit: 2, before: p1.next });
        assert.ok(p2.entries.length >= 1 && !p2.entries.some((e) => p1.entries.some((x) => x.sha === e.sha)), 'the next page continues without repeats');
        const r = (await t.get(`/api/v1/changelog?limit=2&before=${encodeURIComponent(p1.next)}`)).json();
        assert.ok(Array.isArray(r.sites) && r.sites.some((x) => x.service === 'live'), 'network-wide answers list the sites');
        assert.ok(Array.isArray(r.posts) && r.posts.length >= 1);
        const one = (await t.get('/api/v1/changelog?service=live&limit=1')).json();
        assert.strictEqual(one.sites, undefined);
        assert.ok(one.next);
    });

    await check('the GitHub token: CHANGELOG_GITHUB_TOKEN, else the network\'s (Blog service token, kept ten minutes), else anonymous', async () => {
        const seen = { auth: [], network: 0, oauth: [] };
        let networkAnswer = { status: 200, body: { token: 'ghp_fromnetwork', source: 'database' } };
        const fx = async (url, opts = {}) => {
            const u = new URL(url);
            const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
            if (u.pathname === '/oauth/token') { seen.oauth.push(String(opts.body)); return json({ access_token: 'svc-tok', token_type: 'Bearer', expires_in: 300 }); }
            if (u.pathname === '/internal/integrations/github-token') {
                seen.network++;
                assert.strictEqual(opts.headers.Authorization || opts.headers.authorization, 'Bearer svc-tok');
                return json(networkAnswer.body, networkAnswer.status);
            }
            if (u.hostname === 'api.github.com') seen.auth.push((opts.headers && opts.headers.Authorization) || null);
            return fetchImpl(url, opts);
        };
        const mk = (extra, oauth = { clientId: 'blog', clientSecret: 's3cret' }) => createChangelog({ config: { ...config, oauth, networkInternalUrl: 'http://network.internal', changelog: { ...config.changelog, ...extra } }, store: t.ctx.store, blogs: t.ctx.blogs, posts: t.ctx.posts, aiDrafts: null, fetchImpl: fx, log: { log() {}, warn() {} } });
        const release = async (cl2, n) => { releases.live = `aaaaaaa1000${n}`; compares[releases.live] = { status: 'ahead', commits: [commit(900 + n, `Token check ${n}`)], files: [{ additions: 1, deletions: 0 }] }; await cl2.collect(); };

        const net = mk({ githubToken: '' });
        await release(net, 1);
        assert.strictEqual(seen.auth.pop(), 'Bearer ghp_fromnetwork');
        assert.ok(seen.oauth[0].includes('audience=openvibe.network') && seen.oauth[0].includes('network.integration.github.read'));
        assert.strictEqual(net.stats().github_token, 'network');
        await release(net, 2);
        assert.strictEqual(seen.auth.pop(), 'Bearer ghp_fromnetwork');
        assert.strictEqual(seen.network, 1, 'kept ten minutes');

        networkAnswer = { status: 404, body: { error: 'not_configured' } };
        t.clock.advance(11 * 60 * 1000);
        await release(net, 3);
        assert.strictEqual(seen.auth.pop(), null, 'none set: anonymous');
        assert.strictEqual(net.stats().github_token, 'none');

        const env = mk({ githubToken: 'ghp_fromenv' });
        const before = seen.network;
        await release(env, 4);
        assert.strictEqual(seen.auth.pop(), 'Bearer ghp_fromenv');
        assert.strictEqual(seen.network, before, 'the environment wins; Network is not asked');

        const none = mk({ githubToken: '' }, { clientId: 'blog', clientSecret: '' });
        await release(none, 5);
        assert.strictEqual(seen.auth.pop(), null, 'no service credentials: anonymous');
    });

    await t.close();
    done();
})();
