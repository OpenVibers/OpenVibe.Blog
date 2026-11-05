'use strict';
/**
 * GET /api/v1/review-queue: the posts whose AI-written head revision nobody has reviewed yet,
 * editorial staff only, oldest first, with the gate's reasons and both actions (the service's
 * own review route, and publish for a draft). Reviewing and publishing clears the queue.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
const WORKFLOW = { id: 'blog.draft_post', version: 1, runId: 'run_01J8Z3K4M5N6P7Q8R9S0T1V2W3' };

(async () => {
    const t = await boot();
    const lead = t.official;                              // the official blog's owner (BLOG_OFFICIAL_OWNERS)
    const admin = t.network.addUser('admin', { role: 'admin' });
    const person = t.network.addUser('person');
    const ai = t.network.serviceToken('ai', ['blog.post.create', 'blog.post.read', 'blog.post.publish']);
    let draft;
    try {
        await check('an AI draft on the official blog waits in the queue', async () => {
            const r = await t.get('/api/v1/blogs/openvibe/posts', { as: ai, headers: { 'X-OV-Origin': 'ai', 'X-OV-Subject': lead.subject }, json: { title: 'An AI draft', body: LONG, authorship: { workflow: WORKFLOW } } });
            assert.strictEqual(r.status, 201, r.text);
            draft = r.json().post;
            const q = await t.get('/api/v1/review-queue', { as: admin });
            assert.strictEqual(q.status, 200, q.text);
            const item = q.json().items.find((i) => i.id === draft.id);
            assert.ok(item, 'the AI draft is waiting');
            assert.deepStrictEqual([item.site, item.kind, item.state, item.revision], ['blog', 'blog_draft', 'draft', 1]);
            assert.strictEqual(item.title, 'An AI draft');
            assert.strictEqual(item.review.path, `/api/v1/posts/${draft.id}/reviews`);
            assert.strictEqual(item.publish.path, `/api/v1/posts/${draft.id}/publish`);
            assert.ok(item.reasons.some((x) => x.code === 'ai_generated_unreviewed' && /AI-generated/.test(x.text)));
            assert.deepStrictEqual(q.json().items.map((i) => Date.parse(i.createdAt)), q.json().items.map((i) => Date.parse(i.createdAt)).sort((a, b) => a - b));
        });

        await check('a non-staff person gets 403', async () => {
            const r = await t.get('/api/v1/review-queue', { as: person });
            assert.strictEqual(r.status, 403);
            assert.strictEqual(r.json().code, 'review.forbidden');
        });

        await check('approve through the post\'s own review, then publish, clears it and the page is indexable', async () => {
            const q = await t.get('/api/v1/review-queue', { as: admin });
            const item = q.json().items.find((i) => i.id === draft.id);
            const review = await t.get(item.review.path, { as: admin, json: { revision: item.revision, decision: 'approved', note: 'Checked' } });
            assert.strictEqual(review.status, 201, review.text);
            const pub = await t.get(item.publish.path, { as: admin, json: { revision: item.revision } });
            assert.strictEqual(pub.status, 200, pub.text);
            assert.strictEqual(pub.json().post.state, 'published');
            const after = await t.get('/api/v1/review-queue', { as: admin });
            assert.ok(!after.json().items.some((i) => i.id === draft.id), 'a reviewed post leaves the queue');
            const page = await t.get(new URL(item.url).pathname);
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /<meta name="robots" content="index, follow">/);
            assert.ok((await t.ctx.store.reviews.history(draft.id)).length >= 1, 'the review log is the audit');
        });

        await check('a rejected revision stays hidden and leaves the queue', async () => {
            const r = await t.get('/api/v1/blogs/openvibe/posts', { as: ai, headers: { 'X-OV-Origin': 'ai', 'X-OV-Subject': lead.subject }, json: { title: 'Another AI draft', body: LONG, authorship: { workflow: WORKFLOW } } });
            assert.strictEqual(r.status, 201, r.text);
            const post = r.json().post;
            const q = await t.get('/api/v1/review-queue', { as: admin });
            const item = q.json().items.find((i) => i.id === post.id);
            const rej = await t.get(item.review.path, { as: admin, json: { revision: item.revision, decision: 'rejected', note: 'Needs a person' } });
            assert.strictEqual(rej.status, 201, rej.text);
            const after = await t.get('/api/v1/review-queue', { as: admin });
            assert.ok(!after.json().items.some((i) => i.id === post.id), 'a rejected revision is reviewed and leaves the queue');
        });
    } finally {
        await t.close();
        done();
    }
})().catch((e) => { console.error(e); process.exit(1); });
