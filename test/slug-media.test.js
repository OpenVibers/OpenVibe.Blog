'use strict';
/**
 * Canonical URLs and feed identities stay stable across slug changes (old paths 301, chains
 * collapse), and a deleted Media object turns into an explicit broken-asset state — never a
 * silently missing image, and never because Media was merely down.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
const MED_A = 'med_01J8Z3K4M5N6P7Q8R9S0T1V2W3';
const MED_B = 'med_01J8Z3K4M5N6P7Q8R9S0T1V2W4';

(async () => {
    const t = await boot();
    const dan = t.network.addUser('dan');
    await t.get('/api/v1/blogs', { as: dan, json: {} });
    const post = (await t.get('/api/v1/blogs/dan/posts', { as: dan, json: { title: 'Old name', body: `Intro\n\n[[media:${MED_A}]]\n\n${LONG}` } })).json().post;
    await t.get(`/api/v1/posts/${post.id}/publish`, { as: dan, json: {} });
    const feedIdBefore = (await t.get('/@dan/feed.json')).json().items[0].id;

    await check('slug change: the old URL answers 301 to the new canonical one', async () => {
        const r = await t.get(`/api/v1/posts/${post.id}`, { as: dan, method: 'PATCH', json: { slug: 'new-name' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().post.url, 'https://openvibe.blog/@dan/new-name');
        const old = await t.get('/@dan/old-name');
        assert.strictEqual(old.status, 301);
        assert.strictEqual(old.headers.get('location'), '/@dan/new-name');
        assert.strictEqual((await t.get('/@dan/old-name.json')).headers.get('location'), '/@dan/new-name.json');
        const page = await t.get('/@dan/new-name');
        assert.match(page.text, /<link rel="canonical" href="https:\/\/openvibe\.blog\/@dan\/new-name">/);
        assert.match(page.text, /"url":"https:\/\/openvibe\.blog\/@dan\/new-name"/);
    });

    await check('the feed item id is stable and the feed links the new canonical URL', async () => {
        const jf = (await t.get('/@dan/feed.json')).json();
        assert.strictEqual(jf.items[0].id, feedIdBefore);
        assert.strictEqual(jf.items[0].url, 'https://openvibe.blog/@dan/new-name');
        assert.match((await t.get('/@dan/feed.xml')).text, new RegExp(`<guid isPermaLink="false">${feedIdBefore}</guid>`));
        assert.strictEqual(t.events('blog.post.updated').length, 1, 'a canonical change of a published post is an update');
        const docs = t.events('blog.index_document.upserted');
        assert.strictEqual(docs[docs.length - 1].payload.canonical_url, 'https://openvibe.blog/@dan/new-name');
    });

    await check('a second rename collapses the chain: every old path goes straight to the newest', async () => {
        await t.get(`/api/v1/posts/${post.id}`, { as: dan, method: 'PATCH', json: { slug: 'newest-name' } });
        assert.strictEqual((await t.get('/@dan/old-name')).headers.get('location'), '/@dan/newest-name');
        assert.strictEqual((await t.get('/@dan/new-name')).headers.get('location'), '/@dan/newest-name');
        assert.deepStrictEqual(t.ctx.store.redirects.history(post.id).map((h) => h.path).sort(), ['/@dan/new-name', '/@dan/old-name']);
    });

    await check('a new post may take a freed slug; the redirect then yields to it', async () => {
        const p2 = (await t.get('/api/v1/blogs/dan/posts', { as: dan, json: { title: 'Old name', body: LONG } })).json().post;
        assert.strictEqual(p2.slug, 'old-name');
        await t.get(`/api/v1/posts/${p2.id}/publish`, { as: dan, json: {} });
        assert.strictEqual((await t.get('/@dan/old-name')).status, 200);
    });

    await check('a redirect never reveals the new slug of a post the reader may not see', async () => {
        await t.get(`/api/v1/posts/${post.id}`, { as: dan, method: 'PATCH', json: { visibility: 'private' } });
        const r = await t.get('/@dan/new-name');
        assert.strictEqual(r.status, 404);
        assert.strictEqual(r.headers.get('location'), null);
        await t.get(`/api/v1/posts/${post.id}`, { as: dan, method: 'PATCH', json: { visibility: 'public' } });
    });

    await check('attached media renders as a figure while Media has it', async () => {
        const a = await t.get(`/api/v1/posts/${post.id}/attachments`, { as: dan, json: { media_id: MED_A, alt: 'A comet' } });
        assert.strictEqual(a.status, 201, a.text);
        await t.get(`/api/v1/posts/${post.id}/attachments`, { as: dan, json: { media_id: MED_B, role: 'cover', alt: 'Cover' } });
        const bad = await t.get(`/api/v1/posts/${post.id}/attachments`, { as: dan, json: { media_id: 'https://evil.example/x.png' } });
        assert.strictEqual(bad.status, 422);
        t.media.objects.set(MED_A, 'ready');
        t.media.objects.set(MED_B, 'ready');
        await t.ctx.worker.verifyMedia();
        const page = await t.get('/@dan/newest-name');
        assert.match(page.text, new RegExp(`<img src="https://openvibe.media/o/${MED_A}" alt="A comet"`));
        assert.match(page.text, /data-state="available"/);
    });

    await check('Media down: nothing changes (check_failed), the image is not declared missing', async () => {
        t.media.setDown(true);
        const out = await t.ctx.worker.verifyMedia();
        assert.ok(out[0].results.every((r) => r.outcome === 'check_failed'));
        t.media.setDown(false);
        assert.doesNotMatch((await t.get('/@dan/newest-name')).text, /no longer available/);
    });

    await check('Media deleted the object: an explicit broken-asset state in the page, JSON, feed and editor', async () => {
        t.media.objects.set(MED_A, 'deleted');
        t.media.objects.set(MED_B, 'gone');
        const out = await t.ctx.worker.verifyMedia();
        assert.deepStrictEqual(out[0].results.map((r) => `${r.outcome}:${r.reason}`).sort(), ['broken:deleted', 'broken:not_found']);
        const page = await t.get('/@dan/newest-name');
        assert.match(page.text, new RegExp(`data-media-id="${MED_A}" data-state="broken"`));
        assert.match(page.text, /This media is no longer available\./);
        assert.doesNotMatch(page.text, new RegExp(`<img src="https://openvibe.media/o/${MED_A}"`));
        assert.doesNotMatch(page.text, /og:image/, 'a broken cover is not advertised');
        const json = (await t.get('/@dan/newest-name.json')).json();
        const m = json.media.find((x) => x.media_id === MED_A);
        assert.strictEqual(m.state, 'broken');
        assert.strictEqual(m.broken_reason, 'deleted');
        assert.strictEqual(m.url, null);
        assert.match((await t.get('/@dan/feed.json')).text, /no longer available/);
        const editor = await t.get(`/write/posts/${post.id}`, { as: dan });
        assert.match(editor.text, /unavailable \(deleted\)/);
    });

    await check('an id in the text that is not attached says so', async () => {
        const p = (await t.get('/api/v1/blogs/dan/posts', { as: dan, json: { title: 'Dangling', body: `[[media:${MED_B}]]\n\n${LONG}` } })).json().post;
        await t.get(`/api/v1/posts/${p.id}/publish`, { as: dan, json: {} });
        assert.match((await t.get('/@dan/dangling')).text, /data-state="not_attached"/);
    });

    await t.close();
    done();
})();
