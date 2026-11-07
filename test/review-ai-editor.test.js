'use strict';
/**
 * The AI editor (plan 2026-10-22 §"The editorial queue"): a second reviewer kind, `ai_editor`,
 * recorded on the review by the orchestrator's service principal. Its approval lets an AI draft be
 * published and indexed exactly as a person's does, but the post says "Checked by OpenVibe's AI
 * editor" (with the date) — never "Reviewed by a person". A person's review path and label do not
 * change, and a page can show both.
 *
 * Only a service token whose principal holds blog.review.ai_editor may record one; a token without
 * it is refused and writes nothing.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
const WORKFLOW = { id: 'blog.draft_post', version: 1, runId: 'run_01J8Z3K4M5N6P7Q8R9S0T1V2W3' };
const AI_LABEL = "Checked by OpenVibe's AI editor";
// The page escapes the apostrophe; the rendered text still reads "Checked by OpenVibe's AI editor".
const AI_ON_PAGE = /Checked by OpenVibe(?:&#39;|')s AI editor/;

(async () => {
    const t = await boot();
    const lead = t.official;
    const admin = t.network.addUser('admin', { role: 'admin' });
    const ai = t.network.serviceToken('ai', ['blog.post.create', 'blog.post.read', 'blog.post.publish']);
    const editor = t.network.signService({ sub: 'svc:orchestrator', aud: ['openvibe.blog'], cap: ['blog.review.ai_editor'] });
    const noCap = t.network.signService({ sub: 'svc:orchestrator', aud: ['openvibe.blog'], cap: ['blog.post.publish'] });
    const makeDraft = async (title) => {
        const r = await t.get('/api/v1/blogs/openvibe/posts', { as: ai, headers: { 'X-OV-Origin': 'ai', 'X-OV-Subject': lead.subject }, json: { title, body: LONG, authorship: { workflow: WORKFLOW } } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json().post;
    };
    try {
        const post = await makeDraft('An AI draft');

        await check('a token without blog.review.ai_editor is refused and writes nothing', async () => {
            const r = await t.get(`/api/v1/posts/${post.id}/reviews`, { as: noCap, json: { revision: 1, decision: 'approved' } });
            assert.strictEqual(r.status, 403, r.text);
            assert.strictEqual(r.json().code, 'capability.denied');
            assert.strictEqual((await t.ctx.store.reviews.history(post.id)).length, 0, 'nothing was recorded');
        });

        await check('the AI editor approves: the draft publishes and reads "Checked by OpenVibe\'s AI editor"', async () => {
            const r = await t.get(`/api/v1/posts/${post.id}/reviews`, { as: editor, json: { revision: 1, decision: 'approved', note: 'Checked against the sources' } });
            assert.strictEqual(r.status, 201, r.text);
            assert.deepStrictEqual([r.json().review.reviewerKind, r.json().review.reviewer, r.json().review.decision], ['ai_editor', 'svc:orchestrator', 'approved']);

            const pub = await t.get(`/api/v1/posts/${post.id}/publish`, { as: admin, json: { revision: 1 } });
            assert.strictEqual(pub.status, 200, pub.text);
            assert.strictEqual(pub.json().post.state, 'published');

            const path = new URL(pub.json().post.url).pathname;
            const page = await t.get(path);
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('<meta name="robots" content="index, follow">'), 'indexable');
            assert.ok(AI_ON_PAGE.test(page.text), 'the page says who checked it');
            assert.ok(!/reviewed by a person/i.test(page.text), 'never as a person\'s review');
            assert.ok(!page.text.includes('not yet reviewed by a person'));

            const json = await t.get(`${path}.json`);
            assert.strictEqual(json.status, 200, json.text);
            assert.strictEqual(json.json().authorship.reviewed, true);
            assert.ok(json.json().authorship.labels.some((l) => l.startsWith(AI_LABEL)), JSON.stringify(json.json().authorship));
            assert.deepStrictEqual([json.json().authorship.reviews.ai_editor.decision, json.json().authorship.reviews.person], ['approved', null]);
        });

        await check('a person\'s review still says "Reviewed by a person"', async () => {
            const other = await makeDraft('A person-checked draft');
            const r = await t.get(`/api/v1/posts/${other.id}/reviews`, { as: admin, json: { revision: 1, decision: 'approved' } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().review.reviewerKind, 'person');
            const pub = await t.get(`/api/v1/posts/${other.id}/publish`, { as: admin, json: { revision: 1 } });
            assert.strictEqual(pub.status, 200, pub.text);
            const page = await t.get(new URL(pub.json().post.url).pathname);
            assert.ok(/reviewed by a person/i.test(page.text), 'the person\'s label is unchanged');
            assert.ok(!AI_ON_PAGE.test(page.text));
        });

        await check('both reviews on one post show both labels', async () => {
            const r = await t.get(`/api/v1/posts/${post.id}/reviews`, { as: admin, json: { revision: 1, decision: 'approved' } });
            assert.strictEqual(r.status, 201, r.text);
            const page = await t.get(new URL((await t.get(`/api/v1/posts/${post.id}`, { as: admin })).json().post.url).pathname);
            assert.ok(/reviewed by a person/i.test(page.text));
            assert.ok(AI_ON_PAGE.test(page.text));
            assert.ok(page.text.toLowerCase().indexOf('reviewed by a person') < page.text.indexOf('Checked by OpenVibe'), 'the person\'s sentence, then the AI editor\'s');
        });

        await check('an AI editor rejection keeps the draft out of publish and names its kind in the queue', async () => {
            const third = await makeDraft('Kept hidden');
            const r = await t.get(`/api/v1/posts/${third.id}/reviews`, { as: editor, json: { revision: 1, decision: 'rejected', note: 'Not accurate' } });
            assert.strictEqual(r.status, 201, r.text);
            const pub = await t.get(`/api/v1/posts/${third.id}/publish`, { as: admin, json: { revision: 1 } });
            assert.notStrictEqual(pub.status, 200, 'a rejected revision cannot be published');
            const q = await t.get('/api/v1/review-queue', { as: admin });
            const item = q.json().items.find((i) => i.id === third.id);
            assert.ok(item, 'the AI editor\'s rejection leaves the draft in the person\'s queue');
            assert.deepStrictEqual([item.reviewed.kind, item.reviewed.decision, item.reviewed.by], ['ai_editor', 'rejected', 'svc:orchestrator']);
            assert.ok(item.reviewed.label.startsWith('Kept hidden by OpenVibe\'s AI editor'), item.reviewed.label);
        });
    } finally {
        await t.close();
        done();
    }
})().catch((e) => { console.error(e); process.exit(1); });
