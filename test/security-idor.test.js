'use strict';
/**
 * One author cannot act on another's blog or posts by swapping ids (roadmap WS-R task 5, the IDOR
 * class). security.test.js and delegation.test.js pin role and delegation rules; this suite puts two
 * authors side by side. Bob owns his own blog (so blog-level checks pass for him there) and tries
 * every write that takes an id or a handle with Ann's instead: over the API (her posts by id: edit,
 * publish, unpublish, schedule, revert, review, media; her blog: settings, members, theme, new
 * posts, AI drafts) and over the editor forms with his own valid form token (edit, publish,
 * unpublish, delete, revert, review, schedule; her blog's new-post, settings and members forms).
 * Every refusal must leave every table as it was; controls show the routes work for their owner.
 *
 *   node test/security-idor.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { nextAddress } = require('./security-crawl');

const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');

(async () => {
    // An AI endpoint is configured (nobody answers there): the AI-draft route then decides who may write.
    const t = await boot({ env: { OV_AI_INTERNAL_URL: 'http://127.0.0.1:9' } });
    const ann = t.network.addUser('ann');
    const bob = t.network.addUser('bob');
    const cat = t.network.addUser('cat');
    await t.get('/api/v1/blogs', { as: ann, json: {} });
    await t.get('/api/v1/blogs', { as: bob, json: {} });
    const mk = async (as, handle, title, visibility = 'public', publish = true) => {
        const p = (await t.get(`/api/v1/blogs/${handle}/posts`, { as, json: { title, body: LONG, visibility } })).json().post;
        if (publish) await t.get(`/api/v1/posts/${p.id}/publish`, { as, json: {} });
        return p;
    };
    const annPost = await mk(ann, 'ann', 'Ann Public');
    const annPrivate = await mk(ann, 'ann', 'Ann Private', 'private');
    const annDraft = await mk(ann, 'ann', 'Ann Draft', 'public', false);
    await mk(bob, 'bob', 'Bob Post');

    const db = t.ctx.store.db;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('event_outbox')").all().map((r) => r.name);
    const snapshot = () => Object.fromEntries(tables.map((n) => [n, db.prepare(`SELECT * FROM "${n}"`).all()]));
    const same = (before, label) => { const after = snapshot(); for (const n of tables) assert.deepStrictEqual(after[n], before[n], `${label}: ${n} changed`); };
    const refused = (r, what) => assert.ok([401, 403, 404, 409].includes(r.status), `${what}: ${r.status} ${r.text.slice(0, 160)}`);
    const api = (method, p, json, as = bob) => t.get(`/api/v1${p}`, { as, method, json: json || {}, headers: { 'x-forwarded-for': nextAddress() } });
    // The editor's forms live under /write.
    const form = (p, fields, as = bob) => t.get(`/write${p}`, { as, form: { _csrf: t.csrf(as), ...fields }, headers: { origin: 'https://openvibe.blog', 'x-forwarded-for': nextAddress() } });

    await check('API: Bob cannot touch Ann\'s posts by id or her blog by handle', async () => {
        const before = snapshot();
        for (const p of [annPost, annPrivate, annDraft]) {
            refused(await api('PATCH', `/posts/${p.id}`, { title: 'pwned', body: `${LONG} pwned`, visibility: 'public', expected_revision: 1 }), `PATCH ${p.title}`);
            refused(await api('POST', `/posts/${p.id}/publish`, {}), `publish ${p.title}`);
            refused(await api('POST', `/posts/${p.id}/unpublish`, {}), `unpublish ${p.title}`);
            refused(await api('POST', `/posts/${p.id}/schedule`, { revision: 1, run_at: new Date(Date.now() + 3600e3).toISOString() }), `schedule ${p.title}`);
            refused(await api('POST', `/posts/${p.id}/revert`, { to_revision: 1, expected_revision: 1 }), `revert ${p.title}`);
            refused(await api('POST', `/posts/${p.id}/reviews`, { revision: 1, decision: 'approve' }), `review ${p.title}`);
            refused(await api('POST', `/posts/${p.id}/media/att_x/remove`, {}), `media ${p.title}`);
            refused(await api('DELETE', `/posts/${p.id}`, {}), `DELETE ${p.title}`);
        }
        refused(await api('PATCH', '/blogs/ann', { title: 'pwned', description: 'pwned' }), 'PATCH blog');
        refused(await api('PUT', `/blogs/ann/members/${bob.subject}`, { role: 'owner' }), 'make self owner');
        refused(await api('PUT', `/blogs/ann/members/${cat.subject}`, { role: 'editor' }), 'add Cat');
        refused(await api('DELETE', `/blogs/ann/members/${ann.subject}`), 'remove Ann');
        refused(await api('PUT', '/blogs/ann/theme', { theme: 'dark' }), 'theme');
        refused(await api('POST', '/blogs/ann/posts', { title: 'Bob in Ann', body: LONG }), 'post into Ann\'s blog');
        refused(await api('POST', '/blogs/ann/posts/ai-draft', { prompt: 'x' }), 'AI draft into Ann\'s blog');
        same(before, 'API');
    });

    await check('forms: Bob, with his own valid form token, cannot post to Ann\'s posts or blog', async () => {
        const before = snapshot();
        for (const p of [annPost, annPrivate, annDraft]) {
            refused(await form(`/posts/${p.id}`, { title: 'pwned', body: `${LONG} pwned`, expectedRevision: '1', visibility: 'public' }), `edit form ${p.title}`);
            for (const a of ['publish', 'unpublish', 'delete', 'revert', 'review', 'schedule', 'unschedule']) {
                refused(await form(`/posts/${p.id}/${a}`, { revision: '1', toRevision: '1', expectedRevision: '1', decision: 'approve', confirm: '1', runAt: new Date(Date.now() + 3600e3).toISOString() }), `${a} form ${p.title}`);
            }
        }
        refused(await form('/@ann/new', { title: 'Bob in Ann', body: LONG }), 'new-post form');
        refused(await form('/@ann/settings', { title: 'pwned' }), 'settings form');
        refused(await form('/@ann/members', { username: 'cat', role: 'editor' }), 'members form');
        refused(await form('/@ann/members/remove', { subject: ann.subject }), 'remove-member form');
        refused(await form('/@ann/ai-draft', { prompt: 'x' }), 'AI-draft form');
        same(before, 'forms');
    });

    await check('controls: Ann can do what Bob could not', async () => {
        const r = await api('PATCH', '/blogs/ann', { title: 'Ann Blog 2' }, ann);
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        const f = await form(`/posts/${annDraft.id}/publish`, { revision: '1' }, ann);
        assert.ok([200, 303].includes(f.status), `publish form: ${f.status}`);
        assert.strictEqual((await t.get('/@ann/ann-draft')).status, 200, 'the draft is published by its author');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
