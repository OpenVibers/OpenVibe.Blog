'use strict';
/**
 * Sharing defaults on Blog (VISIBILITY-EVERYWHERE-DESIGN-2026-11-06 rules 1-2, step 5): a person's
 * default audience for new posts, the per-post override that still wins, and "Apply to all my
 * existing posts" moving every post they wrote (and the shares row beside it) at once.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot({ env: { BLOG_WORKER: 'off' } });
    const carol = t.network.addUser('carol');
    const maticus = t.network.addUser('maticus');
    const sam = t.network.addUser('sam');
    await t.get('/api/v1/blogs', { as: carol, json: {} });

    const make = async (input = {}) => {
        const r = await t.get('/api/v1/blogs/carol/posts', { as: carol, json: { title: `Post ${Math.random().toString(36).slice(2)}`, body: 'SECRET-SHARING-DEFAULTS text', ...input } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json().post;
    };
    const row = async (id) => await t.ctx.store.db.prepare('SELECT * FROM shares WHERE service = ? AND kind = ? AND resource_id = ?').get('blog', 'post', id);
    const post = async (id) => await t.ctx.store.db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(id);
    const saveDefault = (form) => t.get('/write/@carol/sharing', { as: carol, method: 'POST', form: { _csrf: t.csrf(carol), ...form } });

    await check('a blog shows the default and the form; a new post is Everyone until the default changes', async () => {
        const page = await t.get('/write/@carol', { as: carol });
        assert.strictEqual(page.status, 200, page.text.slice(0, 200));
        assert.ok(page.text.includes('New posts: Everyone'), 'the default is shown');
        assert.ok(page.text.includes('action="/write/@carol/sharing"'), 'the setting posts to its own route');
        const p = await make();
        assert.strictEqual(p.visibility, 'public', 'Everyone is the unchanged default');
        assert.strictEqual((await row(p.id)).audience, 'private', 'a new draft is still Only me');
    });

    await check('the default changes the new-post form and an API create that does not choose', async () => {
        const saved = await saveDefault({ audience: 'unlisted' });
        assert.strictEqual(saved.status, 303, saved.text);
        const dash = await t.get('/write/@carol', { as: carol });
        assert.ok(dash.text.includes('New posts: Anyone with the link'), 'the new default is shown');
        const form = await t.get('/write/@carol/new', { as: carol });
        assert.ok(/<option value="unlisted" selected>/.test(form.text), 'the new post form starts at the default');
        const p = await make();
        assert.strictEqual(p.visibility, 'unlisted', 'the API create uses the default');
        assert.strictEqual((await row(p.id)).audience, 'private', 'a new draft is still Only me');
        const pub = await t.get(`/api/v1/posts/${p.id}/publish`, { as: carol, json: {} });
        assert.strictEqual(pub.status, 200, pub.text);
        assert.strictEqual((await row(p.id)).audience, 'link', 'publishing widens the draft to the default');
        // A per-post override still wins.
        const q = await make({ visibility: 'private' });
        assert.strictEqual(q.visibility, 'private');
        assert.strictEqual((await row(q.id)).audience, 'private');
    });

    await check('apply to all moves every post this person wrote, and only theirs', async () => {
        const one = await make({ visibility: 'public', title: 'First public post' });
        const two = await make({ visibility: 'public', title: 'Second public post' });
        const published = await t.get(`/api/v1/posts/${one.id}/publish`, { as: carol, json: {} });
        assert.strictEqual(published.status, 200, published.text);
        assert.strictEqual((await t.get(`/@carol/${one.slug}`, { as: sam })).status, 200, 'public before the change');
        // Someone else's post in the same blog is not Carol's to move.
        await t.ctx.store.db.prepare("INSERT INTO blog_memberships (blog_id, subject, role, added_by, created_at, updated_at) VALUES ((SELECT id FROM blogs WHERE handle = 'carol'), ?, 'editor', ?, ?, ?)")
            .run(maticus.subject, carol.subject, Date.now(), Date.now());
        const theirs = await t.get('/api/v1/blogs/carol/posts', { as: maticus, json: { title: 'Maticus draft', body: 'not carol’s', visibility: 'public' } });
        assert.strictEqual(theirs.status, 201, theirs.text);
        const other = theirs.json().post;

        const applied = await saveDefault({ audience: 'private', apply: '1' });
        assert.strictEqual(applied.status, 303, applied.text);
        assert.ok(applied.headers.get('location').includes('Applied%20to%20'), applied.headers.get('location'));
        assert.strictEqual((await post(one.id)).visibility, 'private');
        assert.strictEqual((await post(two.id)).visibility, 'private');
        assert.strictEqual((await row(one.id)).audience, 'private');
        assert.strictEqual((await row(two.id)).audience, 'private');
        assert.strictEqual((await post(other.id)).visibility, 'public', 'a co-author’s post was left alone');
        assert.strictEqual((await row(other.id)).audience, 'private', 'the co-author’s draft stays Only me');
        assert.strictEqual((await t.get(`/@carol/${one.slug}`, { as: sam })).status, 404, 'the narrowed post is not readable');
        assert.strictEqual((await t.get(`/@carol/${two.slug}`, { as: carol })).status, 200, 'the owner still reads it');
        assert.strictEqual((await t.get(`/@carol/${other.slug}`, { as: maticus })).status, 200, 'the other post is untouched');
    });

    await check('a default cannot be Specific people, and a bad audience is refused', async () => {
        const bad = await saveDefault({ audience: 'people' });
        assert.strictEqual(bad.status, 422, bad.text.slice(0, 200));
        assert.ok(!bad.text.includes('New posts: Specific'), 'nothing changed');
        const dash = await t.get('/write/@carol', { as: carol });
        assert.ok(dash.text.includes('New posts: Only me'), 'the previous default is intact');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
