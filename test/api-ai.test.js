'use strict';
/**
 * Service tokens: one capability per route (3-segment ids), the acting person in X-OV-Subject,
 * membership still applies. OpenVibe.AI's blog.draft_post arrives as an AI-generated draft that is
 * noindex and cannot be published or scheduled until a person reviews it.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
const WORKFLOW = { id: 'blog.draft_post', version: 1, runId: 'run_01J8Z3K4M5N6P7Q8R9S0T1V2W3' };

(async () => {
    const t = await boot();
    const fay = t.network.addUser('fay', { display_name: 'Fay' });
    await t.get('/api/v1/blogs', { as: fay, json: {} });
    const ai = t.network.serviceToken('ai', ['blog.post.create', 'blog.post.read']);
    let draft;

    await check('a service token without the capability is refused (problem+json)', async () => {
        const tok = t.network.serviceToken('ai', ['blog.post.read']);
        const r = await t.get('/api/v1/blogs/fay/posts', { as: tok, headers: { 'X-OV-Subject': fay.subject }, json: { title: 'x', body: 'y' } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json().code, 'capability.denied');
    });

    await check('a token for another audience, or a forged one, is refused', async () => {
        const wrong = t.network.signService({ sub: 'svc:ai', aud: ['openvibe.community'], cap: ['blog.post.create'] });
        assert.strictEqual((await t.get('/api/v1/blogs/fay/posts', { as: wrong, json: { title: 'x', body: 'y' } })).status, 401);
        const forged = `${ai.split('.').slice(0, 2).join('.')}.AAAA`;
        assert.strictEqual((await t.get('/api/v1/blogs/fay/posts', { as: forged, json: { title: 'x', body: 'y' } })).status, 401);
    });

    await check('a service must act for a member of the blog', async () => {
        const r = await t.get('/api/v1/blogs/fay/posts', { as: ai, headers: { 'X-OV-Origin': 'ai' }, json: { title: 'x', body: 'y', authorship: { workflow: WORKFLOW } } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json().code, 'subject.required');
        const stranger = t.network.addUser('stranger');
        const s = await t.get('/api/v1/blogs/fay/posts', { as: ai, headers: { 'X-OV-Origin': 'ai', 'X-OV-Subject': stranger.subject }, json: { title: 'x', body: 'y', authorship: { workflow: WORKFLOW } } });
        assert.strictEqual(s.status, 403);
    });

    await check('blog.draft_post output becomes an AI-generated draft for the member who asked', async () => {
        const r = await t.get('/api/v1/blogs/fay/posts', { as: ai, headers: { 'X-OV-Origin': 'ai', 'X-OV-Subject': fay.subject }, json: { title: 'An AI draft', body: LONG, authorship: { workflow: WORKFLOW } } });
        assert.strictEqual(r.status, 201, r.text);
        draft = r.json().post;
        assert.strictEqual(draft.state, 'draft');
        assert.strictEqual(draft.authorship.mode, 'ai');
        assert.strictEqual(draft.authorship.workflow.id, 'blog.draft_post');
        assert.deepStrictEqual(draft.authorship.authors, [], 'AI output is never attributed to the person');
        const created = t.events('blog.post.created')[0];
        assert.deepStrictEqual(created.actor, { type: 'service', id: 'ai' });
        assert.strictEqual(created.payload.authorship, 'ai');
        const noWorkflow = await t.get('/api/v1/blogs/fay/posts', { as: ai, headers: { 'X-OV-Origin': 'ai', 'X-OV-Subject': fay.subject }, json: { title: 'No run', body: LONG } });
        assert.strictEqual(noWorkflow.status, 400);
        assert.strictEqual(noWorkflow.json().code, 'authorship.workflow_required');
    });

    await check('it cannot be published or scheduled before a person reviews it', async () => {
        const p = await t.get(`/api/v1/posts/${draft.id}/publish`, { as: fay, json: {} });
        assert.strictEqual(p.status, 409);
        assert.strictEqual(p.json().code, 'post.review_required');
        const s = await t.get(`/api/v1/posts/${draft.id}/schedule`, { as: fay, json: { at: new Date(t.clock.now() + 3600e3).toISOString() } });
        assert.strictEqual(s.status, 409);
        const editor = await t.get(`/write/posts/${draft.id}`, { as: fay });
        assert.match(editor.text, /AI-generated/);
        assert.match(editor.text, /Review needed/);
        assert.match(editor.text, /ai_generated_unreviewed/);
    });

    await check('a service cannot review; the member can, then publish; the page discloses it', async () => {
        const svc = t.network.serviceToken('ai', ['blog.post.create', 'blog.post.publish']);
        const bad = await t.get(`/api/v1/posts/${draft.id}/reviews`, { as: svc, headers: { 'X-OV-Subject': fay.subject }, json: { revision: 1, decision: 'approved' } });
        assert.strictEqual(bad.status, 403);
        const ok = await t.get(`/api/v1/posts/${draft.id}/reviews`, { as: fay, json: { revision: 1, decision: 'approved' } });
        assert.strictEqual(ok.status, 201, ok.text);
        const p = await t.get(`/api/v1/posts/${draft.id}/publish`, { as: fay, json: {} });
        assert.strictEqual(p.status, 200, p.text);
        const page = await t.get('/@fay/an-ai-draft');
        assert.match(page.text, /AI-generated/);
        assert.match(page.text, /reviewed by a person/);
        const doc = t.events('blog.index_document.upserted').pop().payload;
        assert.strictEqual(doc.authorship, 'ai_generated');
        assert.ok(doc.provenance.some((r) => r.service === 'ai' && r.type === 'run' && r.id === WORKFLOW.runId));
    });

    await check('a person editing the AI text makes an AI-assisted (hybrid) revision', async () => {
        const r = await t.get(`/api/v1/posts/${draft.id}`, { as: fay, method: 'PATCH', json: { expected_revision: 1, body: `${LONG} edited by Fay` } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().post.authorship.mode, 'hybrid');
        assert.deepStrictEqual(r.json().post.authorship.authors, [fay.subject]);
    });

    await check('user tokens are judged by membership, not capabilities; staff may moderate any blog', async () => {
        const admin = t.network.addUser('admin', { role: 'admin' });
        const r = await t.get(`/api/v1/posts/${draft.id}/unpublish`, { as: admin, json: {} });
        assert.strictEqual(r.status, 200, r.text);
        const edit = await t.get(`/api/v1/posts/${draft.id}`, { as: admin, method: 'PATCH', json: { expected_revision: 2, title: 'Staff rewrite' } });
        assert.strictEqual(edit.status, 403, 'moderation is not authorship');
    });

    await check('theme and configuration go through their own capabilities', async () => {
        const svc = t.network.serviceToken('network', ['blog.theme.set']);
        const r = await t.get('/api/v1/blogs/fay/theme', { as: svc, method: 'PUT', headers: { 'X-OV-Subject': fay.subject }, json: { theme: 'nord' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().blog.theme, 'nord');
        const c = await t.get('/api/v1/blogs/fay', { as: svc, method: 'PATCH', headers: { 'X-OV-Subject': fay.subject }, json: { title: 'No' } });
        assert.strictEqual(c.status, 403);
    });

    await check('responses carry the request id and trace', async () => {
        const r = await t.get('/api/v1/blogs/fay', { headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', 'X-OpenVibe-Request-Id': 'req_testtesttest' } });
        assert.strictEqual(r.headers.get('x-openvibe-request-id'), 'req_testtesttest');
        assert.match(r.headers.get('traceparent'), /^00-0af7651916cd43dd8448eb211c80319c-/);
        const nf = await t.get('/api/v1/nothing', { headers: { 'X-OpenVibe-Request-Id': 'req_testtesttest' } });
        assert.strictEqual(nf.json().request_id, 'req_testtesttest');
    });

    await t.close();
    done();
})();
