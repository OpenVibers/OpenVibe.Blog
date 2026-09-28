'use strict';
/**
 * Blog's secrets never leave in a response or an event (roadmap WS-R task 5, the internal-secret
 * class). The Blog boots with sentinels as its Network OAuth client secret, its form (CSRF) secret
 * and its changelog GitHub token; Network refuses the sentinel client secret, so every call the Blog
 * makes to Community and Media with a service token fails too, and those failures are among the
 * paths read. Every route the booted app has (listed from Express's router stack,
 * test/security-crawl.js) is requested as anonymous, a reader, an author and Network staff, with
 * real and nonsense ids, plus the probes, unknown paths, the sign-in callback with a forged code,
 * and every write route with a broken body and with a well-formed one. No body or header may carry a
 * sentinel (a form token derived from the form secret is fine; the secret itself is not), nor may
 * any event in the outbox.
 *
 *   node test/security-secrets.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { getPaths, crawl, listRoutes, expand, leaks, nextAddress } = require('./security-crawl');

const SECRETS = {
    OV_OAUTH_CLIENT_SECRET: 'sentinel-not-a-secret-blog-oauth-client',
    BLOG_FORM_SECRET: 'sentinel-not-a-secret-blog-form',
    CHANGELOG_GITHUB_TOKEN: 'sentinel-not-a-secret-blog-github',
};
const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');

(async () => {
    const t = await boot({ env: SECRETS });
    const author = t.network.addUser('author');
    const reader = t.network.addUser('reader');
    const staff = t.network.addUser('staffer', { role: 'admin' });
    await t.get('/api/v1/blogs', { as: author, json: {} });
    const post = (await t.get('/api/v1/blogs/author/posts', { as: author, json: { title: 'A Post', body: LONG, visibility: 'public' } })).json().post;
    await t.get(`/api/v1/posts/${post.id}/publish`, { as: author, json: {} });
    const people = { anonymous: null, reader, author, staff };

    await check('every GET route, page and probe, as four people: no sentinel', async () => {
        const nonsense = ['-1', 'pst_00000000000000000000000000', "'\"<x>", 'x'.repeat(300)];
        const values = (name) => (name === 'handle' ? ['author', ...nonsense] : name === 'slug' ? [post.slug, ...nonsense] : [post.id, 1, ...nonsense]);
        const paths = getPaths(t.app, values, {
            query: 'q=x&next=%2F&page=-1&code=forged&state=forged',
            extra: ['/api/health', '/api/ready', '/api/nope', '/nope/nope', '/.env', '/api/%', '/callback?code=forged&state=forged', '/login?next=/', '/changelog', '/me'],
        });
        const r = await crawl(t, paths, people, () => SECRETS);
        console.log(`    (${paths.length} paths × 4 people; answers ${JSON.stringify(r.statuses)})`);
        assert.ok(r.answered >= paths.length * 3);
        assert.deepStrictEqual(r.found, []);
    });

    await check('every write route, broken and well-formed, anonymous and as the author: no sentinel in the answer', async () => {
        const found = [];
        const values = (name) => (name === 'handle' ? ['author'] : name === 'slug' ? [post.slug] : name === 'subject' ? [reader.subject] : name === 'aid' ? ['att_x'] : [post.id]);
        for (const route of listRoutes(t.app)) {
            for (const method of route.methods.filter((m) => ['post', 'put', 'patch', 'delete'].includes(m))) {
                for (const p of expand(route.path, values)) {
                    for (const as of [null, author]) {
                        for (const raw of ['{"broken": ', JSON.stringify({ title: 'x', body: LONG, visibility: 'public', expected_revision: 1, media_id: 'med_x', comment: 'hi' })]) {
                            const r = await t.get(p, { method: method.toUpperCase(), ...(as ? { as } : {}), body: raw, headers: { 'content-type': 'application/json', origin: 'https://openvibe.blog', 'x-forwarded-for': nextAddress() } });
                            for (const l of leaks(r, SECRETS)) found.push(`${method} ${p} → ${r.status} carries ${l.label}`);
                        }
                    }
                }
            }
        }
        assert.deepStrictEqual(found, []);
    });

    await check('the events outbox carries no sentinel', async () => {
        const text = JSON.stringify(await t.events());
        for (const [k, v] of Object.entries(SECRETS)) assert.ok(!text.includes(v), `outbox carries ${k}`);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
