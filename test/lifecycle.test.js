'use strict';
/**
 * Draft → edit → publish → revise → diff → revert → unpublish → delete, through the API with a
 * member's Network JWT, and what readers, feeds, sitemaps, Search and subscribers see at each step.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { CHARTER_TABLES } = require('../server/db');

const LONG = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice', { display_name: 'Alice Writer' });
    let post;

    await check('the ten charter tables exist (package tables and views included)', async () => {
        const names = new Set(t.ctx.store.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => r.name));
        for (const n of CHARTER_TABLES) assert.ok(names.has(n), `missing ${n}`);
        for (const n of ['blog_schedule_jobs', 'blog_terms', 'blog_term_links', 'blog_post_citations', 'blog_post_attachments', 'blog_index_revisions', 'event_outbox']) assert.ok(names.has(n), `missing ${n}`);
    });

    await check('the official blog exists at / and its owner comes from BLOG_OFFICIAL_OWNERS', async () => {
        const blog = t.ctx.blogs.official();
        assert.strictEqual(blog.handle, 'openvibe');
        assert.strictEqual(t.ctx.blogs.membership(blog, t.official.subject).role, 'owner');
        const r = await t.get('/');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /The OpenVibe blog/);
    });

    await check('a member gets a blog on first use, owned by their Network subject', async () => {
        const r = await t.get('/api/v1/blogs', { as: alice, json: {} });
        assert.strictEqual(r.status, 201, r.text);
        const b = r.json().blog;
        assert.strictEqual(b.handle, 'alice');
        assert.strictEqual(b.owner_subject, alice.subject);
        const again = await t.get('/api/v1/blogs', { as: alice, json: {} });
        assert.strictEqual(again.status, 200);
        assert.strictEqual(again.json().created, false);
    });

    await check('create a draft: revision 1, blog.post.created, nothing public, nothing sent to Search', async () => {
        const r = await t.get('/api/v1/blogs/alice/posts', { as: alice, json: { title: 'First light', body: `Hello **world**.\n\n${LONG}`, tags: 'Astronomy, night sky', categories: 'Science > Space' } });
        assert.strictEqual(r.status, 201, r.text);
        post = r.json().post;
        assert.strictEqual(post.state, 'draft');
        assert.strictEqual(post.revision, 1);
        assert.deepStrictEqual(post.tags, ['Astronomy', 'night sky']);
        assert.strictEqual(t.events('blog.post.created').length, 1);
        assert.strictEqual(t.events(/index_document/).length, 0);
        assert.strictEqual((await t.get('/@alice/first-light')).status, 404);
        assert.doesNotMatch((await t.get('/@alice/feed.xml')).text, /First light/);
    });

    await check('edit: a new immutable revision; a stale expected_revision is a 412 and loses nothing', async () => {
        const r = await t.get(`/api/v1/posts/${post.id}`, { as: alice, method: 'PATCH', json: { expected_revision: 1, body: `Hello **stars**.\n\n${LONG}` } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().revision, 2);
        const stale = await t.get(`/api/v1/posts/${post.id}`, { as: alice, method: 'PATCH', json: { expected_revision: 1, body: 'lost update' } });
        assert.strictEqual(stale.status, 412);
        assert.strictEqual(stale.json().code, 'revision.conflict');
        const missing = await t.get(`/api/v1/posts/${post.id}`, { as: alice, method: 'PATCH', json: { body: 'no base' } });
        assert.strictEqual(missing.status, 428);
        assert.throws(() => t.ctx.store.db.prepare('UPDATE blog_post_revisions SET content = ? WHERE entity_id = ?').run('x', post.id), /immutable/);
    });

    await check('publish: page served without JavaScript, BlogPosting from real fields, events + Search document', async () => {
        const r = await t.get(`/api/v1/posts/${post.id}/publish`, { as: alice, json: {} });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().post.published_revision, 2);
        const page = await t.get('/@alice/first-light');
        assert.strictEqual(page.status, 200);
        const beforeScripts = page.text.split('<script src=')[0];
        assert.match(page.text, /<h1>First light<\/h1>/);
        assert.match(page.text, /Hello <strong>stars<\/strong>/);
        assert.match(beforeScripts, /<link rel="canonical" href="https:\/\/openvibe\.blog\/@alice\/first-light">/);
        assert.match(page.text, /<meta name="robots" content="index, follow">/);
        const ld = [...page.text.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
        const posting = ld.find((x) => x['@type'] === 'BlogPosting');
        assert.ok(posting, 'BlogPosting JSON-LD');
        assert.strictEqual(posting.headline, 'First light');
        assert.strictEqual(posting.url, 'https://openvibe.blog/@alice/first-light');
        assert.strictEqual(posting.author[0].name, 'Alice Writer');
        assert.strictEqual(posting.datePublished, new Date(t.clock.now()).toISOString());
        assert.strictEqual(posting.publisher, undefined, 'no publisher invented for a member blog');
        assert.strictEqual(posting.aggregateRating, undefined);
        assert.strictEqual(t.events('blog.post.published').length, 1);
        const idx = t.events('blog.index_document.upserted');
        assert.strictEqual(idx.length, 1);
        assert.strictEqual(idx[0].payload.visibility, 'public');
        assert.strictEqual(idx[0].payload.canonical_url, 'https://openvibe.blog/@alice/first-light');
        assert.ok(require('openvibe-contracts').validate('search.index-document@1', idx[0].payload).valid);
        for (const e of t.events()) assert.ok(require('openvibe-contracts').validate('events.event-envelope@1', e).valid, `${e.event_type} envelope`);
    });

    await check('feeds (RSS, Atom, JSON Feed), sitemaps, tag/category/author pages list it', async () => {
        const rss = await t.get('/@alice/feed.xml');
        assert.match(rss.text, /<guid isPermaLink="false">tag:openvibe\.blog,2026:post\/pst_/);
        assert.match((await t.get('/@alice/atom.xml')).text, /<link rel="alternate" type="text\/html" href="https:\/\/openvibe\.blog\/@alice\/first-light"\/>/);
        const jf = (await t.get('/@alice/feed.json')).json();
        assert.strictEqual(jf.items[0].url, 'https://openvibe.blog/@alice/first-light');
        assert.match((await t.get('/sitemaps/posts.xml')).text, /@alice\/first-light/);
        assert.match((await t.get('/sitemaps/blogs.xml')).text, /https:\/\/openvibe\.blog\/@alice</);
        assert.match((await t.get('/@alice/tags/astronomy')).text, /First light/);
        assert.match((await t.get('/tags/astronomy')).text, /First light/);
        assert.match((await t.get('/@alice/categories/science')).text, /First light/, 'parent category includes children');
        assert.match((await t.get('/@alice/authors/alice')).text, /First light/);
        assert.match((await t.get('/@alice/first-light.json')).text, /"body_markdown"/);
    });

    await check('a revision after publication does not change what readers see until it is published', async () => {
        const r = await t.get(`/api/v1/posts/${post.id}`, { as: alice, method: 'PATCH', json: { expected_revision: 2, title: 'First light (revised)' } });
        assert.strictEqual(r.json().revision, 3);
        assert.match((await t.get('/@alice/first-light')).text, /<h1>First light<\/h1>/);
        assert.strictEqual(t.events('blog.post.updated').length, 0);
        await t.get(`/api/v1/posts/${post.id}/publish`, { as: alice, json: { revision: 3 } });
        assert.match((await t.get('/@alice/first-light')).text, /<h1>First light \(revised\)<\/h1>/);
        assert.strictEqual(t.events('blog.post.updated').length, 1);
        assert.strictEqual(t.events('blog.index_document.upserted').length, 2);
    });

    await check('history: diff and revert as a new revision; revisions 1–3 are untouched', async () => {
        const d = (await t.get(`/api/v1/posts/${post.id}/diff?from=1&to=3&mode=word`, { as: alice })).json().diff;
        assert.ok(d.fields.some((f) => f.field === 'title'));
        const rv = await t.get(`/api/v1/posts/${post.id}/revert`, { as: alice, json: { to_revision: 1, expected_revision: 3 } });
        assert.strictEqual(rv.status, 201, rv.text);
        assert.strictEqual(rv.json().revision, 4);
        const revs = (await t.get(`/api/v1/posts/${post.id}/revisions`, { as: alice })).json().revisions;
        assert.deepStrictEqual(revs.map((x) => x.number), [4, 3, 2, 1]);
        assert.strictEqual(revs[0].kind, 'revert');
        assert.strictEqual(revs[0].revertedTo, 1);
        assert.strictEqual(t.ctx.store.revisions.get(post.id, 4).content, t.ctx.store.revisions.get(post.id, 1).content);
    });

    await check('unpublish: gone from pages, feeds, sitemap; Search gets a tombstone', async () => {
        const r = await t.get(`/api/v1/posts/${post.id}/unpublish`, { as: alice, json: {} });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual((await t.get('/@alice/first-light')).status, 404);
        assert.doesNotMatch((await t.get('/@alice/feed.xml')).text, /first-light/);
        assert.doesNotMatch((await t.get('/sitemaps/posts.xml')).text, /first-light/);
        const del = t.events('blog.index_document.deleted');
        assert.strictEqual(del.length, 1);
        assert.deepStrictEqual(Object.keys(del[0].payload).sort(), ['id', 'revision', 'type']);
        assert.strictEqual(t.events('blog.post.unpublished').length, 1);
    });

    await check('delete: 410 Gone for readers, blog.post.deleted, revisions kept', async () => {
        await t.get(`/api/v1/posts/${post.id}/publish`, { as: alice, json: { revision: 4 } });
        const r = await t.get(`/api/v1/posts/${post.id}`, { as: alice, method: 'DELETE' });
        assert.strictEqual(r.status, 200, r.text);
        const page = await t.get('/@alice/first-light');
        assert.strictEqual(page.status, 410);
        assert.strictEqual(page.headers.get('cache-control'), 'private, no-store');
        assert.strictEqual(t.events('blog.post.deleted').length, 1);
        assert.strictEqual(t.ctx.store.revisions.list(post.id).length, 4);
        const last = t.events(/index_document/).pop();
        assert.strictEqual(last.event_type, 'blog.index_document.deleted');
    });

    await check('a stranger cannot write on someone else’s blog', async () => {
        const bob = t.network.addUser('bob');
        const r = await t.get('/api/v1/blogs/alice/posts', { as: bob, json: { title: 'Intrusion', body: 'x' } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.headers.get('content-type'), 'application/problem+json');
    });

    await t.close();
    done();
})();
