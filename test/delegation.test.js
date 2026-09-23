'use strict';
/**
 * Third-party principals: a developer app (app:…) or module (mod:…) token acts only for the person
 * in its on_behalf_of claim. X-OV-Subject naming anyone else is refused (403 subject.not_delegated),
 * and so are sandbox tokens (401 token.sandbox_refused). First-party services (svc:…) still name the
 * person they act for.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const APP = 'app:app_01J8ZQ4Y7N3M2K1H0G9F8E7D6C';
const MOD = 'mod:mod_01J8ZQ4Y7N3M2K1H0G9F8E7D6C';
const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');

(async () => {
    const t = await boot();
    const carol = t.network.addUser('carol');
    const appUser = t.network.addUser('appuser');
    await t.get('/api/v1/blogs', { as: carol, json: {} });
    const secret = (await t.get('/api/v1/blogs/carol/posts', { as: carol, json: { title: 'Private minutes', body: `Minutes ${LONG}`, visibility: 'private' } })).json().post;
    const caps = ['blog.post.read', 'blog.post.create'];
    const token = (sub, actorType, extra) => t.network.signService({ sub, actorType, aud: ['openvibe.blog'], cap: caps, extra });
    const postsOf = () => t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM blog_posts').get().n;

    await check('an app or module cannot act for someone else by naming them in X-OV-Subject', async () => {
        const before = postsOf();
        for (const [sub, type] of [[APP, 'app'], [MOD, 'mod']]) {
            for (const extra of [{ on_behalf_of: appUser.subject }, {}]) {
                const read = await t.get(`/api/v1/posts/${secret.id}`, { as: token(sub, type, extra), headers: { 'x-ov-subject': carol.subject } });
                assert.strictEqual(read.status, 403, `${type} ${JSON.stringify(extra)}: ${read.text}`);
                assert.strictEqual(read.json().code, 'subject.not_delegated');
                assert.doesNotMatch(read.text, /Minutes/);
                const write = await t.get('/api/v1/blogs/carol/posts', { as: token(sub, type, extra), headers: { 'x-ov-subject': carol.subject }, json: { title: 'Planted', body: LONG } });
                assert.strictEqual(write.status, 403, `${type} write: ${write.text}`);
            }
        }
        assert.strictEqual(postsOf(), before, 'nothing written as carol');
    });

    await check('an app acts for its on_behalf_of person, with that person\'s rights', async () => {
        const r = await t.get(`/api/v1/posts/${secret.id}`, { as: token(APP, 'app', { on_behalf_of: appUser.subject }) });
        assert.strictEqual(r.status, 404, r.text);
        const own = await t.get(`/api/v1/posts/${secret.id}`, { as: token(APP, 'app', { on_behalf_of: carol.subject }), headers: { 'x-ov-subject': carol.subject } });
        assert.strictEqual(own.status, 200, own.text);
    });

    await check('sandbox app tokens are refused', async () => {
        const r = await t.get(`/api/v1/posts/${secret.id}`, { as: token(APP, 'app', { on_behalf_of: carol.subject, env: 'sandbox' }) });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.json().code, 'token.sandbox_refused');
    });

    await check('first-party services still name the person they act for', async () => {
        const r = await t.get(`/api/v1/posts/${secret.id}`, { as: t.network.serviceToken('tools', caps), headers: { 'x-ov-subject': carol.subject } });
        assert.strictEqual(r.status, 200, r.text);
    });

    await t.close();
    done();
})();
