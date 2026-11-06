'use strict';
/**
 * Every blog post carries the network's one Share button (openvibe-shared 4.114.0): one [data-ov-share-sheet] under
 * the title, with the post's canonical address, title, summary and cover picture. The navbar loads the sheet on the
 * first press; the page loads nothing more.
 */
const assert = require('assert');
const { boot } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const created = await t.get('/api/v1/blogs/openvibe/posts', { as: t.official, json: { title: 'A shareable post', summary: 'One line about the post.', body: 'The post body is long enough to publish.\n\n## One\n\nText.\n\n## Two\n\nMore.\n\n## Three\n\nEnd.' } });
        assert.strictEqual(created.status, 201, created.text);
        const post = created.json().post;
        const published = await t.get(`/api/v1/posts/${post.id}/publish`, { as: t.official, json: {} });
        assert.strictEqual(published.status, 200, published.text);
        const r = await t.get(`/@openvibe/${post.slug}`);
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.strictEqual((r.text.match(/data-ov-share-sheet/g) || []).length, 1, 'one Share button');
        assert.ok(r.text.includes(`data-url="https://openvibe.blog/@openvibe/${post.slug}"`), 'the post address');
        assert.ok(r.text.includes('data-title="A shareable post"'), 'its title');
        assert.ok(r.text.includes('data-text="One line about the post."'), 'its summary');
        assert.ok(r.text.includes('<p class="post-share">'), 'under the title');
        console.log('blog share sheet ok');
    } finally {
        await t.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
