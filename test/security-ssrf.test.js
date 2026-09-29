'use strict';
/**
 * The Blog fetches no URL a user chose (roadmap WS-R task 5, the SSRF class). The URLs people type
 * here (links and images in a post, a cover, a comment) are stored and rendered, never fetched by
 * the Blog: media is attached by OpenVibe.Media object id and read from Media; the changelog reads
 * GitHub (fixed host) for the repositories Network's registry names. This suite writes posts full of
 * internal addresses in every spelling (loopback, decimal, octal, hex, IPv6, mapped, metadata,
 * private ranges, file:, gopher:) and drives every path that handles a post: create, edit, publish,
 * the page, the feed, the sitemap, llms.txt, the API, comments. Every outbound request the process
 * makes is recorded, and none may go to any of those addresses. And a ratchet: every file in
 * server/ that makes an outbound request itself is on a reviewed list with the reason its URLs are
 * configured services or fixed hosts, not a user's choice.
 *
 *   node test/security-ssrf.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Record every outbound fetch before anything captures fetch.
const outbound = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => { outbound.push(String((url && url.url) || url)); return realFetch(url, opts); };

const { boot, check, done } = require('./helpers/boot');
const { nextAddress } = require('./security-crawl');

const PROBE = '/ssrf-probe-path';
const INTERNAL = [
    `http://127.0.0.1:3000${PROBE}`, `http://2130706433${PROBE}`, `http://0177.0.0.1${PROBE}`, `http://0x7f000001${PROBE}`, `http://127.1${PROBE}`,
    `http://0.0.0.0${PROBE}`, `http://[::1]${PROBE}`, `http://[::ffff:127.0.0.1]${PROBE}`, `http://[::ffff:7f00:1]${PROBE}`, `http://169.254.169.254/latest/meta-data${PROBE}`,
    `http://[fd00::1]${PROBE}`, `http://10.0.0.1${PROBE}`, `http://192.168.1.1${PROBE}`, `http://localhost:4001${PROBE}`, `file:///etc/passwd${PROBE}`, `gopher://127.0.0.1:6379/_x${PROBE}`,
];
const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');

(async () => {
    const t = await boot();
    const carol = t.network.addUser('carol');
    const reader = t.network.addUser('reader');
    const opts = (as, extra = {}) => ({ as, headers: { 'x-forwarded-for': nextAddress() }, ...extra });

    await check('posts full of internal URLs are stored and rendered, never fetched', async () => {
        await t.get('/api/v1/blogs', opts(carol, { json: {} }));
        const body = `${LONG}\n\n${INTERNAL.map((u) => `![img](${u}) [link](${u}) <img src="${u}">`).join('\n')}`;
        const r = await t.get('/api/v1/blogs/carol/posts', opts(carol, { json: { title: 'Linky', body, visibility: 'public', cover_url: INTERNAL[0], canonical_url: INTERNAL[1], image: INTERNAL[2] } }));
        assert.ok([200, 201].includes(r.status), r.text.slice(0, 200));
        const post = r.json().post;
        await t.get(`/api/v1/posts/${post.id}/publish`, opts(carol, { json: {} }));
        await t.get(`/api/v1/posts/${post.id}`, opts(carol, { method: 'PATCH', json: { body: `${body}\nedited`, expected_revision: 1 } }));
        for (const p of ['/@carol/linky', '/@carol', '/blogs/carol/feed', '/sitemap.xml', '/sitemaps/posts.xml', '/llms.txt', `/api/v1/posts/${post.id}`, `/api/v1/posts/${post.id}/revisions`, '/updates', '/']) {
            await t.get(p, opts(reader));
            await t.get(p, { headers: { 'x-forwarded-for': nextAddress() } });
        }
        await t.get('/@carol/linky/comments', opts(reader, { form: { _csrf: t.csrf(reader), body: INTERNAL.join(' ') }, headers: { origin: 'https://openvibe.blog', 'x-forwarded-for': nextAddress() } }));
        const hit = outbound.filter((u) => u.includes(PROBE));
        assert.deepStrictEqual(hit, [], 'the Blog fetched a URL from a post');
    });

    await check('ratchet: every file that makes an outbound request itself is reviewed', () => {
        const REVIEWED = {
            // server/auth/sso.js and server/events/outbox.js are superseded by openvibe-sdk/sso and
            // openvibe-sdk/events and are no longer imported; they await deletion (the sandbox denies rm).
            'server/auth/sso.js': 'Network JWKS, OAuth token and revoke (configured); dead after the SDK move',
            'server/changelog.js': 'Network registry (configured) and api.github.com (fixed host) for the repositories the registry names',
            'server/clients/community.js': 'OpenVibe.Community (configured)',
            'server/clients/media.js': 'OpenVibe.Media (configured)',
            'server/clients/network.js': 'OpenVibe.Network (configured)',
        };
        const root = path.join(__dirname, '..');
        const found = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const f = path.join(dir, e.name);
                if (e.isDirectory()) walk(f);
                else if (e.name.endsWith('.js')) {
                    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
                    if (/(^|[^.\w])(fetch|fetchImpl)\(|\bhttps?\.(get|request)\(|new WebSocket\(|require\(['"](axios|got|node-fetch|undici)['"]\)/m.test(src)) found.push(path.relative(root, f));
                }
            }
        };
        walk(path.join(root, 'server'));
        assert.ok(found.length >= 4, `the scan finds the known sites (${found.join(', ')})`);
        assert.deepStrictEqual(found.filter((f) => !REVIEWED[f]).sort(), [], 'a new outbound request site: a user-chosen URL goes through openvibe-shared/egress; then add the file here with the reason');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
