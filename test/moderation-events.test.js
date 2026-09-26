'use strict';
/**
 * blog.moderation.action (ADR-022): staff unpublishing or deleting someone else's post goes to
 * Network's moderation audit log, from the outbox in the same transaction; the author doing the
 * same to their own post reports nothing.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');

(async () => {
    const t = await boot();
    const dana = t.network.addUser('dana');
    const admin = t.network.addUser('admin', { role: 'admin' });
    await t.get('/api/v1/blogs', { as: dana, json: {} });
    const make = async (title) => {
        const p = (await t.get('/api/v1/blogs/dana/posts', { as: dana, json: { title, body: `${title} ${LONG}` } })).json().post;
        assert.strictEqual((await t.get(`/api/v1/posts/${p.id}/publish`, { as: dana, json: {} })).status, 200);
        return p;
    };
    const moderation = () => t.ctx.store.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all()
        .map((r) => JSON.parse(r.envelope)).filter((e) => e.event_type === 'blog.moderation.action');
    const valid = (e) => {
        assert.strictEqual(contracts.validate('events.event-envelope@1', e).valid, true, JSON.stringify(e));
        const r = contracts.validate('blog.moderation.action@1', e.payload);
        assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
        assert.strictEqual(e.source, 'blog');
        assert.strictEqual(e.visibility, 'internal');
        assert.deepStrictEqual(e.actor, { type: 'user', id: admin.subject });
        assert.strictEqual(e.payload.actor_subject, admin.subject);
    };

    await check('the author unpublishing and deleting their own posts reports nothing', async () => {
        const a = await make('Own unpublish');
        const b = await make('Own delete');
        assert.strictEqual((await t.get(`/api/v1/posts/${a.id}/unpublish`, { as: dana, json: {} })).status, 200);
        assert.strictEqual((await t.get(`/api/v1/posts/${b.id}`, { as: dana, method: 'DELETE' })).status < 300, true);
        assert.strictEqual(moderation().length, 0);
    });

    await check('staff unpublishing someone else\'s post: exactly one valid event', async () => {
        const p = await make('Staff unpublish');
        const r = await t.get(`/api/v1/posts/${p.id}/unpublish`, { as: admin, json: {} });
        assert.strictEqual(r.status, 200, r.text);
        const ev = moderation();
        assert.strictEqual(ev.length, 1);
        valid(ev[0]);
        assert.deepStrictEqual(ev[0].subject, { type: 'moderation_action', id: `post:${p.id}` });
        assert.strictEqual(ev[0].payload.action, 'post.unpublished');
        assert.deepStrictEqual(ev[0].payload.target, { type: 'post', id: p.id, owner_subject: dana.subject });
        assert.strictEqual(ev[0].payload.details.previous, 'published');
        const again = await t.get(`/api/v1/posts/${p.id}/unpublish`, { as: admin, json: {} });
        assert.strictEqual(again.status, 200);
        assert.strictEqual(moderation().length, 1, 'nothing changed, nothing reported');
    });

    await check('staff deleting someone else\'s post: exactly one valid event', async () => {
        const p = await make('Staff delete');
        const r = await t.get(`/api/v1/posts/${p.id}`, { as: admin, method: 'DELETE' });
        assert.ok(r.status < 300, r.text);
        const ev = moderation();
        assert.strictEqual(ev.length, 2);
        valid(ev[1]);
        assert.strictEqual(ev[1].payload.action, 'post.deleted');
        assert.deepStrictEqual(ev[1].payload.target, { type: 'post', id: p.id, owner_subject: dana.subject });
    });

    await t.close();
    done();
})();
