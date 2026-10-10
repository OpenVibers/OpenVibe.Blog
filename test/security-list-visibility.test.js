'use strict';
/**
 * A blog listing must never name a post the same viewer's post page refuses (roadmap WS-R task 5, the
 * list-vs-read class). listPublished's `restricted` flag used to be "is a member at all" (owner/editor/
 * author), while the read check (memberCanSee) admits only an editor+ or the post's own author — so an
 * author-level member saw every private and members-only post's title, author and — with no summary —
 * a body-prefix excerpt on /@blog, the API and tag pages, while the post page itself answered 404/403.
 * The list now takes access.listingScope: editor+ (and staff) see every restricted post, an
 * author-level member only their own, matching canReadPost.
 *
 *   node test/security-list-visibility.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
// Body-only sentinels (words absent from the titles): a listing with no summary renders the body prefix,
// so the leak the review found surfaces these even when a title check alone would not.
const PRIV_MARKER = 'private-board-minutes-body-marker';
const MEM_MARKER = 'members-only-post-body-marker';

(async () => {
    // No entitlement service: the members-only post is readable only by the blog's members (and staff).
    const t = await boot({ entitlementCheck: async () => false });
    const carol = t.network.addUser('carol');
    const dave = t.network.addUser('dave');
    const erin = t.network.addUser('erin');
    const boss = t.network.addUser('boss', { role: 'admin' });
    await t.get('/api/v1/blogs', { as: carol, json: {} });

    const make = async (as, title, visibility, { secret = '', ...extra } = {}) => {
        const p = (await t.get('/api/v1/blogs/carol/posts', { as, json: { title, body: `${secret} ${title} ${LONG}`, visibility, ...extra } })).json().post;
        const r = await t.get(`/api/v1/posts/${p.id}/publish`, { as, json: {} });
        assert.strictEqual(r.status, 200, r.text);
        return p;
    };

    // Carol's restricted posts carry no summary, so a leak would surface the body-only secret; a public
    // post is the control.
    const pub = await make(carol, 'Open Post', 'public', { tags: ['pubtag'], secret: 'public-control' });
    const priv = await make(carol, 'Board Minutes', 'private', { tags: ['boardtag'], secret: PRIV_MARKER });
    const mem = await make(carol, 'Backstage Notes', 'members', { entitlement_key: 'vip:carol', tags: ['boardtag'], secret: MEM_MARKER });
    assert.ok(pub.id && priv.id && mem.id);

    const addMember = (subject, role) => t.get(`/api/v1/blogs/carol/members/${subject}`, { as: carol, method: 'PUT', json: { role } });
    await addMember(dave.subject, 'author');
    await addMember(erin.subject, 'editor');

    const RESTRICTED = ['Board Minutes', 'Backstage Notes'];
    const leaked = (text) => RESTRICTED.some((s) => text.includes(s)) || text.includes(PRIV_MARKER) || text.includes(MEM_MARKER);

    await check('an author-level member is refused the post, and no list names it or excerpts its body', async () => {
        assert.strictEqual((await t.get(`/@carol/${priv.slug}`, { as: dave })).status, 404, 'the private post is refused');
        assert.strictEqual((await t.get(`/@carol/${mem.slug}`, { as: dave })).status, 403, 'the members post is refused');
        for (const p of ['/@carol', '/@carol/tags/boardtag', '/api/v1/blogs/carol/posts']) {
            const r = await t.get(p, { as: dave });
            assert.ok(!leaked(r.text), `${p}: names a restricted post or excerpts its body`);
        }
        assert.ok((await t.get('/@carol', { as: dave })).text.includes('Open Post'), 'the public post is still listed');
    });

    await check('the owner, an editor and staff see every restricted post in the list (control)', async () => {
        for (const [who, as] of [['owner', carol], ['editor', erin], ['staff', boss]]) {
            const r = await t.get('/@carol', { as });
            assert.ok(RESTRICTED.every((s) => r.text.includes(s)), `${who} should see the restricted posts`);
        }
    });

    await check('an author-level member sees their own restricted post, and no other author\'s', async () => {
        const own = await make(dave, 'Dave Private', 'private');
        const seen = (await t.get('/@carol', { as: dave })).text;
        assert.ok(seen.includes('Dave Private'), 'their own private post is listed to them');
        assert.ok(!leaked(seen), 'another author\'s restricted posts are not');

        const frank = t.network.addUser('frank');
        await addMember(frank.subject, 'author');
        const other = await t.get('/@carol', { as: frank });
        assert.ok(!other.text.includes('Dave Private'), 'a peer author does not see Dave\'s private post');
        assert.strictEqual((await t.get(`/@carol/${own.slug}`, { as: frank })).status, 404);
    });

    await check('a signed-in non-member and an anonymous reader see only the public post', async () => {
        const reader = t.network.addUser('reader');
        for (const [who, as] of [['reader', reader], ['anonymous', undefined]]) {
            for (const p of ['/@carol', '/api/v1/blogs/carol/posts']) {
                const r = await t.get(p, { as });
                assert.ok(!leaked(r.text), `${p} (${who})`);
            }
        }
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
