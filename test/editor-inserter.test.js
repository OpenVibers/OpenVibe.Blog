'use strict';
/**
 * The editor's block inserter (stage B1): the script is served and the page opts into it, the live preview
 * is the server's own renderer (so a block looks in the editor exactly as it will in the post), and
 * "Make an image" is honest about an OpenVibe.AI that is not configured. The form itself still posts
 * without any of this.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const MED = 'med_01J8ZQ4X3M000000000000000A';

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice', { display_name: 'Alice' });
    t.media.objects.set(MED, 'ready');
    await t.get('/api/v1/blogs', { as: alice, json: {} });
    const created = await t.get('/api/v1/blogs/alice/posts', { as: alice, json: { title: 'In the editor', body: 'A first draft.' } });
    const id = created.json().post.id;

    await check('the edit page carries the inserter and its script; the form still works without it', async () => {
        const page = await t.get(`/write/posts/${id}`, { as: alice });
        assert.strictEqual(page.status, 200, page.text);
        assert.match(page.text, /data-ov-editor data-post="pst_[^"]+" data-csrf="[^"]+" data-preview="\/write\/preview" data-image="\/write\/make-image" data-find="\/write\/find-images"/);
        assert.match(page.text, /<script src="\/js\/blog-editor\.js" defer><\/script>/);
        assert.match(page.text, /<textarea id="body" name="body" rows="22">A first draft.<\/textarea>/, 'the textarea saves without script');
    });

    await check('the script is served, and the preview renders through the post renderer', async () => {
        const js = await t.get('/js/blog-editor.js');
        assert.strictEqual(js.status, 200);
        assert.match(js.text, /data-ov-editor/);
        const preview = await t.get('/write/preview', {
            as: alice,
            form: { _csrf: t.csrf(alice), markdown: `:::section{id="previewed"}\n## A previewed section\nHello.\n:::` },
        });
        assert.strictEqual(preview.status, 200, preview.text);
        assert.strictEqual(preview.json().ok, true);
        assert.match(preview.json().html, /<section class="ov-section" id="previewed"/);
        assert.match(preview.json().html, /<h2>A previewed section<\/h2>/);
        assert.deepStrictEqual(preview.json().sections.map((s) => s.id), ['previewed']);
    });

    await check('a figure in the preview resolves the post’s own attachments', async () => {
        await t.get(`/api/v1/posts/${id}/attachments`, { as: alice, json: { media_id: MED, role: 'inline', alt: 'The workbench' } });
        const r = await t.get('/write/preview', {
            as: alice,
            form: { _csrf: t.csrf(alice), post_id: id, markdown: `:::figure{src="${MED}" alt="The workbench"}:::` },
        });
        assert.strictEqual(r.status, 200, r.text);
        assert.match(r.json().html, new RegExp(`<img src="https://openvibe\\.media/o/${MED}" alt="The workbench"`));
        const stranger = t.network.addUser('eve');
        const other = await t.get('/write/preview', { as: stranger, form: { _csrf: t.csrf(stranger), post_id: id, markdown: `:::figure{src="${MED}"}:::` } });
        assert.match(other.json().html, /ov-media-broken/, 'someone who may not edit the post sees no attachment');
    });

    await check('a preview without the form token is refused', async () => {
        const r = await t.get('/write/preview', { as: alice, form: { markdown: '## No token' } });
        assert.strictEqual(r.status, 403, r.text);
    });

    await check('the preview is a renderer of what was typed, not a read of anything stored', async () => {
        const stranger = t.network.addUser('mallory');
        const r = await t.get('/write/preview', { as: stranger, form: { _csrf: t.csrf(stranger), markdown: '## Mine' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.match(r.json().html, /Mine/);
    });

    await check('Make an image says OpenVibe.AI is not configured instead of faking one', async () => {
        const r = await t.get('/write/make-image', { as: alice, form: { _csrf: t.csrf(alice), prompt: 'A channel header' } });
        assert.strictEqual(r.status, 503, r.text);
        assert.strictEqual(r.json().code, 'ai.not_configured');
    });

    await t.close();
    done();
})();
