'use strict';
/**
 * The whole write → publish → comment journey with plain HTML forms (what a browser without
 * JavaScript does), Network SSO cookies and form tokens; comments are Community threads that are
 * referenced, never copied.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
const idFrom = (location) => (location.match(/\/write\/posts\/(pst_[0-9A-Z]+)/) || [])[1];

(async () => {
    const t = await boot();
    const eve = t.network.addUser('eve', { display_name: 'Eve' });
    const csrf = t.csrf(eve);
    let postId;

    await check('the editor sends a signed-out browser to Network sign-in', async () => {
        const r = await t.get('/write');
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.headers.get('location'), '/auth/login?next=%2Fwrite');
        const login = await t.get('/auth/login?next=/write');
        assert.strictEqual(login.status, 302);
        assert.match(login.headers.get('location'), /\/oauth\/authorize\?.*client_id=blog/);
    });

    await check('first use: the start form creates the member blog', async () => {
        const home = await t.get('/write', { as: eve });
        assert.strictEqual(home.status, 200);
        assert.match(home.text, /<form method="post" action="\/write\/start">/);
        assert.strictEqual(home.headers.get('cache-control'), 'private, no-store');
        assert.match(home.headers.get('x-robots-tag'), /noindex/);
        const r = await t.get('/write/start', { as: eve, form: { _csrf: csrf, handle: 'eve', title: 'Eve’s notes' } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.headers.get('location').split('?')[0], '/write/@eve');
    });

    await check('a form without the token is refused', async () => {
        const r = await t.get('/write/@eve/new', { as: eve, form: { title: 'No token', body: 'x' } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM blog_posts').get().n, 0);
    });

    await check('new draft, edit and publish with forms', async () => {
        const form = await t.get('/write/@eve/new', { as: eve });
        assert.match(form.text, /<textarea id="body" name="body"/);
        let r = await t.get('/write/@eve/new', { as: eve, form: { _csrf: csrf, title: 'Notes without script', body: `# Heading\n\nPlain *text*. ${LONG}`, tags: 'nojs', series: 'Field notes', seriesPosition: '1', visibility: 'public', allowComments: '1' } });
        assert.strictEqual(r.status, 303, r.text);
        postId = idFrom(r.headers.get('location'));
        assert.ok(postId);
        const edit = await t.get(`/write/posts/${postId}`, { as: eve });
        assert.match(edit.text, /name="expectedRevision" value="1"/);
        assert.match(edit.text, /Search engines: <strong>noindex, nofollow<\/strong>|Search engines: indexable/);
        r = await t.get(`/write/posts/${postId}`, { as: eve, form: { _csrf: csrf, expectedRevision: '1', title: 'Notes without script', body: `# Heading\n\nPlain *text*, edited. ${LONG}`, tags: 'nojs', series: 'Field notes', seriesPosition: '1', visibility: 'public', allowComments: '1' } });
        assert.strictEqual(r.status, 303, r.text);
        assert.match(decodeURIComponent(r.headers.get('location')), /revision 2/);
        r = await t.get(`/write/posts/${postId}/publish`, { as: eve, form: { _csrf: csrf, revision: '2' } });
        assert.strictEqual(r.status, 303);
        const page = await t.get('/@eve/notes-without-script');
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /Plain <em>text<\/em>, edited\./);
        assert.match(page.text, /Part 1 of the series <a href="\/@eve\/series\/field-notes">Field notes<\/a>/);
        assert.match((await t.get('/@eve/series/field-notes')).text, /Notes without script/);
    });

    await check('a stale form (someone saved first) is a clear refusal, not a lost edit', async () => {
        const r = await t.get(`/write/posts/${postId}`, { as: eve, form: { _csrf: csrf, expectedRevision: '1', title: 'Stale', body: 'stale' } });
        assert.strictEqual(r.status, 412);
        assert.match(r.text, /Someone saved revision 2/);
        assert.strictEqual(t.ctx.store.revisions.head(postId).fields.title, 'Notes without script');
    });

    await check('history, diff and preview are plain pages', async () => {
        const h = await t.get(`/write/posts/${postId}/revisions?from=1&to=2`, { as: eve });
        assert.match(h.text, /<ins>/);
        const p = await t.get(`/write/posts/${postId}/preview`, { as: eve });
        assert.strictEqual(p.status, 200);
        assert.strictEqual(p.headers.get('cache-control'), 'private, no-store');
        assert.match(p.text, /<meta name="robots" content="noindex, nofollow">/);
    });

    await check('the post page shows the Community thread and takes a comment by form', async () => {
        const page = await t.get('/@eve/notes-without-script', { as: eve });
        assert.match(page.text, /No comments yet\./);
        assert.match(page.text, /<form method="post" action="\/@eve\/notes-without-script\/comments"/);
        const r = await t.get('/@eve/notes-without-script/comments', { as: eve, form: { _csrf: csrf, message: 'First!' } });
        assert.strictEqual(r.status, 303, r.text);
        const again = await t.get('/@eve/notes-without-script');
        assert.match(again.text, /First!/);
        const thread = [...t.community.threads.values()][0];
        assert.deepStrictEqual(thread.ref, { service: 'blog', type: 'post', id: postId, label: 'Notes without script' });
        const posted = t.community.calls.find((c) => c.method === 'POST' && /\/comments$/.test(c.url));
        assert.strictEqual(posted.subject, eve.subject, 'commented as the member (X-OV-Subject)');
        const cols = t.ctx.store.db.prepare("SELECT name FROM pragma_table_info('blog_post_discussion_refs')").all().map((c) => c.name);
        assert.deepStrictEqual(cols.sort(), ['entity_id', 'ref', 'resolved_at', 'thread_id'], 'only the reference is stored');
    });

    await check('Community down: the page still serves and says comments are unavailable', async () => {
        t.community.setDown(true);
        const page = await t.get('/@eve/notes-without-script');
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /Comments could not be loaded/);
        t.community.setDown(false);
    });

    await check('a post that stops being public: its thread is hidden, no thread for non-public posts', async () => {
        await t.get(`/write/posts/${postId}`, { as: eve, form: { _csrf: csrf, visibility: 'private' } });
        await new Promise((r) => setTimeout(r, 100));
        assert.strictEqual([...t.community.threads.values()][0].visibility, 'hidden');
        const page = await t.get('/@eve/notes-without-script', { as: eve });
        assert.match(page.text, /Comments are available on public posts only\./);
    });

    await check('delete needs the confirmation box, then answers 410', async () => {
        let r = await t.get(`/write/posts/${postId}/delete`, { as: eve, form: { _csrf: csrf } });
        assert.strictEqual(r.status, 422);
        r = await t.get(`/write/posts/${postId}/delete`, { as: eve, form: { _csrf: csrf, confirm: '1' } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual((await t.get('/@eve/notes-without-script')).status, 410);
    });

    await check('settings: theme preset, feed switches and members', async () => {
        const mallory = t.network.addUser('mallory');
        await t.get('/write', { as: mallory });   // signs in once: now known by username
        let r = await t.get('/write/@eve/settings', { as: eve, form: { _csrf: csrf, title: 'Eve’s notes', description: 'Field notes', language: 'en', theme: 'paper', rss: '1', atom: '1', itemCount: '10', fullContent: '1' } });
        assert.strictEqual(r.status, 303, r.text);
        const blog = t.ctx.blogs.byHandle('eve');
        assert.strictEqual(blog.theme, 'paper');
        assert.strictEqual(t.ctx.blogs.feedSettings(blog).json, 0);
        assert.strictEqual((await t.get('/@eve/feed.json')).status, 404);
        assert.match((await t.get('/@eve')).text, /data-blog-theme="paper"/);
        r = await t.get('/write/@eve/members', { as: eve, form: { _csrf: csrf, member: 'mallory', role: 'author' } });
        assert.strictEqual(r.status, 303, r.text);
        assert.strictEqual(t.ctx.blogs.membership(blog, mallory.subject).role, 'author');
        const bad = await t.get('/write/@eve/settings', { as: eve, form: { _csrf: csrf, title: 'x', theme: 'my-own-css-engine' } });
        assert.strictEqual(bad.status, 422);
        const notOwner = await t.get('/write/@eve/settings', { as: mallory });
        assert.strictEqual(notOwner.status, 404);
    });

    await t.close();
    done();
})();
