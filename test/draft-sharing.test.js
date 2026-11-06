'use strict';
/**
 * Sharing on Blog posts and drafts (design 2026-11-06, VISIBILITY-EVERYWHERE step 4; the pilot is
 * Community's pastes). A new draft is Only me; the Share sheet's four audiences are enforced by
 * canView on the page, the JSON twin and the API; a post that leaves Everyone leaves the feed and the
 * sitemap at once; publishing a draft widens it to the visibility its author chose.
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
        const r = await t.get('/api/v1/blogs/carol/posts', { as: carol, json: { title: 'The LOOI bridge notes', body: `SECRET-LOOI notes. ${Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ')}`, visibility: 'public', ...input } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json().post;
    };
    const share = (id, opts = {}) => t.get(`/api/v1/post/${id}/share`, { headers: { 'x-requested-with': 'ov-share' }, ...opts });
    const putShare = (id, json, as = carol) => share(id, { method: 'PUT', as, json });
    const row = async (id) => await t.ctx.store.db.prepare('SELECT * FROM shares WHERE service = ? AND kind = ? AND resource_id = ?').get('blog', 'post', id);
    const post = async (id) => await t.ctx.store.db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(id);

    await check('a new draft is registered Only me, owned by its author; the page never opens for anyone else', async () => {
        const p = await make();
        const s = await row(p.id);
        assert.strictEqual(s.audience, 'private', 'drafts are Only me');
        assert.deepStrictEqual(s.owner_subject, { type: 'user', id: carol.subject });
        const url = `/@carol/${p.slug}`;
        assert.strictEqual((await t.get(url, { as: carol })).status, 200);
        assert.strictEqual((await t.get(url, { as: maticus })).status, 404);
        assert.strictEqual((await t.get(url)).status, 404);
        assert.strictEqual((await t.get(`/api/v1/posts/${p.id}`, { as: maticus })).status, 404);
        assert.strictEqual((await t.get(`/@carol/${p.slug}.json`, { as: maticus })).status, 404);
    });

    await check('Specific people: the named person reads the draft, a stranger gets the gate and never the title', async () => {
        const p = await make({ title: 'Board pack', body: `SECRET-LOOI board pack. ${Array.from({ length: 100 }, (_, i) => `b${i}`).join(' ')}` });
        const put = await putShare(p.id, { audience: 'people', members: [{ name: '@maticus', role: 'viewer' }] });
        assert.strictEqual(put.status, 200, put.text);
        assert.strictEqual(put.json().audience, 'people');
        assert.strictEqual((await post(p.id)).visibility, 'private', 'the old column fails closed');
        const url = `/@carol/${p.slug}`;
        const member = await t.get(url, { as: maticus });
        assert.strictEqual(member.status, 200);
        assert.ok(member.text.includes('SECRET-LOOI board pack'));
        const strangerBody = (await t.get(url, { as: sam })).text;
        const stranger = await t.get(url, { as: sam });
        assert.strictEqual(stranger.status, 404);
        assert.ok(stranger.text.includes('shared with specific people'), 'OVShare.gate');
        assert.ok(stranger.text.includes('ov-share.js') && stranger.text.includes('OVShare.gate'));
        assert.ok(!stranger.text.includes('Board pack') && !stranger.text.includes('SECRET-LOOI'), 'no title, no text');
        const anon = await t.get(url);
        assert.strictEqual(anon.status, 404);
        assert.ok(anon.text.includes('/auth/login?next='), 'sign in');
        assert.strictEqual((await t.get(`/api/v1/post/${p.id}/share`, { as: sam })).status, 404, 'the sheet is the owner’s');
        assert.strictEqual((await t.get(`/@carol/${p.slug}.json`, { as: sam })).status, 404);
    });

    await check('Everyone and the link: a shared draft is readable by whoever holds the address, still not listed', async () => {
        const p = await make({ title: 'Everyone draft' });
        const everyone = await putShare(p.id, { audience: 'public' });
        assert.strictEqual(everyone.status, 200, everyone.text);
        assert.strictEqual((await row(p.id)).audience, 'public');
        assert.strictEqual((await t.get(`/@carol/${p.slug}`)).status, 200, 'Everyone');
        const link = await putShare(p.id, { audience: 'link' });
        assert.strictEqual(link.status, 200, link.text);
        assert.strictEqual((await t.get(`/@carol/${p.slug}`)).status, 200, 'the link is the key');
        const feed = await t.get('/@carol/feed.xml');
        assert.ok(!feed.text.includes('Everyone draft'), 'a draft is never in a feed');
    });

    await check('publishing widens a draft to the visibility its author chose, and it enters the feed', async () => {
        const p = await make({ title: 'Ready to ship' });
        assert.strictEqual((await row(p.id)).audience, 'private');
        const pub = await t.get(`/api/v1/posts/${p.id}/publish`, { as: carol, json: {} });
        assert.strictEqual(pub.status, 200, pub.text);
        assert.strictEqual((await row(p.id)).audience, 'public', 'the author chose Everyone');
        assert.strictEqual((await t.get(`/@carol/${p.slug}`)).status, 200);
        assert.ok((await t.get('/@carol/feed.xml')).text.includes('Ready to ship'));
    });

    await check('leaving Everyone takes the post out of the feed, the sitemap and the page at once', async () => {
        const p = await make({ title: 'Going quiet' });
        await t.get(`/api/v1/posts/${p.id}/publish`, { as: carol, json: {} });
        assert.ok((await t.get('/@carol/feed.xml')).text.includes('Going quiet'));
        const put = await putShare(p.id, { audience: 'private' });
        assert.strictEqual(put.status, 200, put.text);
        assert.strictEqual((await post(p.id)).visibility, 'private');
        assert.strictEqual((await t.get(`/@carol/${p.slug}`)).status, 404);
        assert.ok(!(await t.get('/@carol/feed.xml')).text.includes('Going quiet'));
        assert.ok(!(await t.get('/sitemap.xml')).text.includes(`/@carol/${p.slug}`));
        assert.strictEqual((await t.get(`/@carol/${p.slug}`, { as: carol })).status, 200, 'the owner still reads it');
        const idx = await t.events(/^blog\.index_document\.deleted$/);
        assert.ok(idx.some((e) => JSON.stringify(e.payload || {}).includes(p.id)), 'a search tombstone went out');
    });

    await check('the agent API (subjects) and the sheet API (names) agree; members are listed for the owner', async () => {
        const p = await make({ title: 'Two readers' });
        const put = await putShare(p.id, { audience: 'people', members: [{ subject: { type: 'user', id: sam.subject }, role: 'viewer' }] });
        assert.strictEqual(put.status, 200, put.text);
        assert.strictEqual((await t.get(`/@carol/${p.slug}`, { as: sam })).status, 200);
        const mine = await share(p.id, { as: carol });
        assert.strictEqual(mine.status, 200);
        assert.strictEqual(mine.json().members[0].username, 'sam');
        assert.strictEqual(mine.json().you.role, 'owner');
    });

    await done();
})();
