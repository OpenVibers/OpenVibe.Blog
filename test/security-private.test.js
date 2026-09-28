'use strict';
/**
 * Private, draft, members-only and unlisted posts reach nobody who may not read them, on any path
 * (roadmap WS-R task 5, the private-object class). privacy.test.js and members-vip.test.js pin the
 * rules on the known surfaces (cache headers, Search, feeds, sitemaps, the teaser); this suite
 * covers the class: Carol's blog holds a private post, a draft, a members-only post, an unlisted
 * post and an unpublished second revision of a public post, each with words found nowhere else.
 * Then it GETs EVERY route the booted app has (listed from Express's router stack,
 * test/security-crawl.js), with those posts' ids, slugs, revision numbers, tags and categories in
 * every parameter, plus the machine surfaces, as anonymous, a signed-in reader and the author of
 * another blog. The private post, the draft and the unpublished revision never appear; the members
 * post's text never does (its title is the teaser, by design); the unlisted post is reachable by its
 * own address (by design) but on no list, feed, sitemap or search. Public events and Search
 * documents carry none of it.
 *
 *   node test/security-private.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { getPaths, crawl } = require('./security-crawl');

const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');

(async () => {
    const t = await boot({ entitlementCheck: async () => false });
    const carol = t.network.addUser('carol');
    const reader = t.network.addUser('reader');
    const dave = t.network.addUser('dave');
    await t.get('/api/v1/blogs', { as: carol, json: {} });
    await t.get('/api/v1/blogs', { as: dave, json: {} });
    const make = async (title, words, visibility, { publish = true, extra = {} } = {}) => {
        const r = await t.get('/api/v1/blogs/carol/posts', { as: carol, json: { title, body: `${words} ${LONG}`, visibility, tags: ['sectag'], category: 'seccat', ...extra } });
        assert.ok([200, 201].includes(r.status), r.text.slice(0, 200));
        const p = r.json().post;
        if (publish) await t.get(`/api/v1/posts/${p.id}/publish`, { as: carol, json: {} });
        return p;
    };
    const SECRET = {
        privTitle: 'Private Diary Title', privWords: 'private-diary-words', draftTitle: 'Draft Idea Title', draftWords: 'draft-idea-words',
        membersWords: 'members-body-words', rev2Words: 'unpublished-revision-words', unlistedWords: 'unlisted-body-words',
    };
    const pub = await make('Open Post', 'open-control-words', 'public');
    const priv = await make(SECRET.privTitle, SECRET.privWords, 'private');
    const draft = await make(SECRET.draftTitle, SECRET.draftWords, 'public', { publish: false });
    const mem = await make('Members Post', SECRET.membersWords, 'members', { extra: { entitlement_key: 'vip:carol' } });
    const unl = await make('Unlisted Post', SECRET.unlistedWords, 'unlisted');
    const edit = await t.get(`/api/v1/posts/${pub.id}`, { as: carol, method: 'PATCH', json: { body: `${SECRET.rev2Words} ${LONG}`, expected_revision: 1 } });
    const posts = [priv, draft, mem, unl, pub];

    await check('control: the author reads all of it; the open post is public', async () => {
        assert.ok((await t.get(`/api/v1/posts/${priv.id}`, { as: carol })).text.includes(SECRET.privWords));
        assert.ok((await t.get(`/api/v1/posts/${draft.id}`, { as: carol })).text.includes(SECRET.draftWords));
        assert.strictEqual((await t.get('/@carol/open-post')).status, 200);
        assert.strictEqual(edit.status, 200, `the unpublished second revision exists: ${edit.status} ${edit.text.slice(0, 160)}`);
        assert.ok((await t.get(`/api/v1/posts/${pub.id}/revisions/2`, { as: carol })).text.includes(SECRET.rev2Words));
    });

    await check('every GET route, page and machine surface: nothing private, draft, members-only or unpublished reaches anonymous, a reader or another author', async () => {
        const values = (name) => {
            if (name === 'handle') return ['carol'];
            if (name === 'slug') return posts.map((p) => p.slug);
            if (name === 'id') return posts.map((p) => p.id);
            if (name === 'n') return [1, 2, 3, 1, 2];
            if (name === 'tag') return ['sectag'];
            if (name === 'category') return ['seccat'];
            if (name === 'who' || name === 'subject') return [carol.subject, 'carol'];
            return posts.map((p) => p.id);
        };
        const paths = getPaths(t.app, values, {
            query: 'q=diary&page=2&before=9999999999999&include_private=1&visibility=private&drafts=1',
            extra: ['/sitemap.xml', '/sitemaps/posts.xml', '/sitemaps/blogs.xml', '/llms.txt', '/updates', '/', '/@carol', '/@carol?page=2', '/blogs/carol/feed',
                '/api/v1/blogs/carol/posts?status=draft', '/api/v1/blogs/carol/posts?visibility=private', '/tags/sectag', '/@carol/tags/sectag', '/@carol/categories/seccat',
                `/api/v1/posts/${pub.id}/revisions/2`, `/api/v1/posts/${pub.id}/diff?from=1&to=2`, `/api/v1/posts/${pub.id}/preview`, '/@carol/open-post?revision=2'],
        });
        const r = await crawl(t, paths, { anonymous: null, reader, 'another author': dave }, () => {
            const n = { ...SECRET };
            delete n.unlistedWords;   // reachable at its own address, by design (checked below on the lists)
            return n;
        });
        console.log(`    (${paths.length} paths × 3 people; answers ${JSON.stringify(r.statuses)})`);
        assert.ok(r.answered >= paths.length * 2);
        assert.deepStrictEqual(r.found, []);
    });

    await check('the unlisted post is on no list, feed, sitemap, tag page or search', async () => {
        for (const p of ['/', '/updates', '/@carol', '/blogs/carol/feed', '/sitemap.xml', '/sitemaps/posts.xml', '/llms.txt', '/tags/sectag', '/@carol/tags/sectag',
            '/@carol/categories/seccat', '/api/v1/blogs/carol/posts', '/api/v1/blogs/carol', '/authors/carol', `/@carol/authors/${carol.subject}`]) {
            for (const as of [null, reader]) {
                const r = await t.get(p, as ? { as } : {});
                assert.ok(!r.text.includes(SECRET.unlistedWords) && !r.text.includes(unl.slug), `${p} (${as ? 'reader' : 'anonymous'}) lists the unlisted post`);
            }
        }
    });

    await check('public events and Search documents carry none of it', async () => {
        const text = JSON.stringify((await t.events()).filter((e) => e.visibility === 'public' || /index_document\.upserted$/.test(e.event_type)));
        assert.ok(text.includes('Open Post') || text.includes('open-control-words'), 'the open post is there (control)');
        const hits = Object.entries(SECRET).filter(([, w]) => text.includes(w)).map(([k]) => k);
        assert.deepStrictEqual(hits, []);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
