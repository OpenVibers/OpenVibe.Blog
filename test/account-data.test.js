'use strict';
/**
 * ADR-033: Blog's part of an account export and of an account deletion, through the signed loopback route
 * POST /internal/events with a stand-in Network. Alice has her own blog with a published post, and is an author on
 * Bob's blog with a published post there. Her export carries her blog, memberships, posts and revisions. Her deletion
 * removes her own blog's posts (as its owner would) and closes it, removes her memberships, leaves her post on Bob's
 * blog published without her id (the text unchanged), and confirms once.
 */
const assert = require('assert');
const http = require('http');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/boot');

const SECRET = `whsec_${'fixture'.repeat(6)}`;
const LONG = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_blog', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    const stub = await startNetworkStub();
    const t = await boot({ env: { BLOG_EVENTS_SECRET: SECRET }, accountSend: createNetworkSender({ networkInternalUrl: stub.url, clientId: 'blog', clientSecret: 'shh' }) });
    const alice = t.network.addUser('alice', { display_name: 'Alice Writer' });
    const bob = t.network.addUser('bob', { display_name: 'Bob Editor' });
    const db = t.ctx.store.db;
    const count = async (sql, args) => Number(await db.value(sql, args));
    const deliver = async (event, { secret = SECRET, headers = {} } = {}) => {
        const body = JSON.stringify({ event, seq: 1 });
        const res = await fetch(`${t.base}/internal/events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, secret), ...headers } });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });
    const post = async (user, handle, title) => {
        const r = await t.get(`/api/v1/blogs/${handle}/posts`, { as: user, json: { title, body: `${title}. ${LONG}` } });
        assert.strictEqual(r.status, 201, r.text);
        const p = r.json().post;
        assert.strictEqual((await t.get(`/api/v1/posts/${p.id}/publish`, { as: user, json: {} })).status, 200);
        return p;
    };
    let mine;
    let onBobs;

    try {
        await check('alice\'s own blog and post, and her post as an author on bob\'s blog', async () => {
            assert.strictEqual((await t.get('/api/v1/blogs', { as: alice, json: {} })).status, 201);
            assert.strictEqual((await t.get('/api/v1/blogs', { as: bob, json: {} })).status, 201);
            assert.strictEqual((await t.get(`/api/v1/blogs/bob/members/${alice.subject}`, { method: 'PUT', as: bob, json: { role: 'author' } })).status, 200);
            mine = await post(alice, 'alice', 'Alice at home');
            onBobs = await post(alice, 'bob', 'Alice visiting');
        });

        await check('the export carries her blog, memberships, posts and revisions, and nothing of bob\'s', async () => {
            const r = await deliver(ev('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX1', subject: alice.subject }));
            assert.deepStrictEqual([r.status, r.json && r.json.outcome], [200, 'exported'], JSON.stringify(r.json));
            const part = stub.calls.find((c) => c.url === '/internal/account-exports/exp_01JZ0000000000000000000EX1/parts');
            assert.strictEqual(part.auth, 'Bearer tok_blog');
            const names = part.body.files.map((f) => f.name);
            for (const f of ['blogs.json', 'memberships.json', 'posts.json', 'revisions.json']) assert.ok(names.includes(f), `${f} in ${names}`);
            assert.strictEqual(part.body.files.find((f) => f.name === 'posts.json').content.length, 2);
            assert.ok(!JSON.stringify(part.body).includes(bob.subject));
        });

        await check('the deletion closes her blog, removes its posts and her memberships, leaves her post on bob\'s blog authorless; once', async () => {
            const event = ev('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: 'del_01JZ0000000000000000000DE1', subject: alice.subject });
            const r = await deliver(event);
            assert.deepStrictEqual([r.status, r.json && r.json.outcome], [200, 'erased'], JSON.stringify(r.json));
            const blog = await db.maybe("SELECT status, owner_subject, title FROM blogs WHERE handle = 'alice'");
            assert.deepStrictEqual([blog.status, blog.owner_subject, blog.title], ['suspended', null, 'Deleted blog']);
            assert.strictEqual(await db.value('SELECT state FROM blog_posts WHERE id = $1', [mine.id]), 'deleted');
            assert.strictEqual((await t.get('/alice')).status, 404, 'her blog is no longer served');
            const visiting = await db.maybe('SELECT state, author_subject FROM blog_posts WHERE id = $1', [onBobs.id]);
            assert.deepStrictEqual([visiting.state, visiting.author_subject], ['published', 'deleted'], 'her post on bob\'s blog stays, authorless');
            assert.strictEqual(await count('SELECT count(*) FROM blog_memberships WHERE subject = $1', [alice.subject]), 0);
            assert.strictEqual(await count('SELECT count(*) FROM blog_post_revisions WHERE author = $1', [alice.subject]), 0);
            assert.ok((await db.value('SELECT content FROM blog_post_revisions WHERE entity_id = $1 ORDER BY number DESC LIMIT 1', [onBobs.id])).includes('Alice visiting'), 'the text never changes');
            assert.strictEqual(await count("SELECT count(*) FROM blogs WHERE handle = 'bob' AND status = 'active' AND owner_subject = $1", [bob.subject]), 1);
            const conf = stub.calls.filter((c) => c.url === '/internal/account-deletions/del_01JZ0000000000000000000DE1/confirmations');
            assert.strictEqual(conf.length, 1);
            assert.strictEqual(conf[0].body.erased.blog_posts, 1);
            assert.strictEqual(conf[0].body.erased.blog_memberships, 2);
            assert.strictEqual(conf[0].body.retained.blogs, 1);
            assert.strictEqual((await deliver(event)).json.outcome, 'unchanged');
            assert.strictEqual(stub.calls.filter((c) => c.url.includes('/confirmations')).length, 1);
        });

        await check('revisions stay append-only outside the erasure, and inside it only the id may change', async () => {
            await assert.rejects(db.exec('UPDATE blog_post_revisions SET author = NULL WHERE entity_id = $1', [onBobs.id]), /immutable/);
            await assert.rejects(db.tx(async (tx) => {
                await tx.value("SELECT set_config('blog.account_erasure', 'on', true)");
                await tx.exec("UPDATE blog_post_revisions SET content = 'rewritten' WHERE entity_id = $1", [onBobs.id]);
            }), /immutable/);
        });

        await check('the route refuses a bad signature and a request that came through a proxy', async () => {
            const event = ev('evt_01JZ0000000000000000000E02', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX2', subject: alice.subject });
            assert.strictEqual((await deliver(event, { secret: `whsec_${'mismatch'.repeat(5)}` })).status, 401);
            assert.strictEqual((await deliver(event, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 403);
        });
    } finally {
        await t.close();
        await stub.close();
    }
    done();
})();
