'use strict';
/**
 * Rich blocks in a post: the body is Markdown plus blocks, the page renders them server-side (every
 * block a plain-HTML form), the API hands the blocks out next to the Markdown and takes them in, and
 * a reader's reaction to a section is a form that posts without script.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const MED = 'med_01J8ZQ4X3M000000000000000A';
const body = (by) => [
    ':::hero{art="' + MED + '" kicker="Devblog" date="2026-11-09"}',
    '# Printed & Polished',
    'This month: blueprints rework, the Uzi, our biggest optimisation pass yet.',
    ':::',
    '',
    ':::section{id="blueprint-rework" by="' + by + '" react}',
    '## Blueprint rework',
    'Workbenches no longer need fragments.',
    ':::figure{src="' + MED + '" alt="The channel header"}',
    ':::',
    ':::',
    '',
    ':::patchnotes{from="2026-11-02" to="2026-11-09"}:::',
].join('\n');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice', { display_name: 'Alice Writer' });
    const BODY = body(alice.subject);
    let post;

    await check('a body with blocks is stored as the Markdown that parses back into them', async () => {
        await t.get('/api/v1/blogs', { as: alice, json: {} });
        const r = await t.get('/api/v1/blogs/alice/posts', { as: alice, json: { title: 'Blocks', body: BODY } });
        assert.strictEqual(r.status, 201, r.text);
        post = r.json().post;
        assert.match(post.body, /:::section\{id="blueprint-rework"/);
        // The hero art and the section picture are attached Media objects: the renderer shows what Media has.
        t.media.objects.set(MED, 'ready');
        const at = await t.get(`/api/v1/posts/${post.id}/attachments`, { as: alice, json: { media_id: MED, role: 'cover', alt: 'The channel header' } });
        assert.strictEqual(at.status, 201, at.text);
    });

    await check('the API hands the blocks out next to the Markdown, and ?format=blocks asks for them alone', async () => {
        const r = await t.get(`/api/v1/posts/${post.id}`, { as: alice });
        assert.strictEqual(r.status, 200, r.text);
        const dto = r.json().post;
        assert.match(dto.body, /:::hero/);
        assert.strictEqual(dto.blocks.type, 'root');
        assert.deepStrictEqual(dto.blocks.children.map((c) => c.type), ['hero', 'section', 'patchnotes']);
        const section = dto.blocks.children[1];
        assert.strictEqual(section.attrs.id, 'blueprint-rework');
        assert.strictEqual(section.attrs.react, true);

        const only = await t.get(`/api/v1/posts/${post.id}?format=blocks`, { as: alice });
        assert.strictEqual(only.status, 200);
        assert.strictEqual(only.json().blocks.type, 'root');
    });

    await check('a reader gets the published blocks alone, without the Markdown', async () => {
        await t.get(`/api/v1/posts/${post.id}/publish`, { as: alice, json: {} });
        const r = await t.get(`/api/v1/posts/${post.id}?format=blocks`);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().blocks.type, 'root');
        assert.deepStrictEqual(r.json().blocks.children.map((c) => c.type), ['hero', 'section', 'patchnotes']);
        assert.strictEqual(r.json().post, undefined, 'the blocks are the whole answer');
    });

    await check('a malformed block tree is refused, never stored', async () => {
        const r = await t.get('/api/v1/blogs/alice/posts', { as: alice, json: { title: 'Broken', blocks: { type: 'root', children: [{ type: 'figure', attrs: { src: 'not-a-media-id' } }] } } });
        assert.strictEqual(r.status, 422, r.text);
        assert.match(r.json().detail, /figure src must be a Media object id/);
    });

    await check('a caller may post blocks instead of Markdown; the post keeps the Markdown', async () => {
        const tree = {
            type: 'root',
            children: [{
                type: 'section', attrs: { id: 'from-blocks' },
                children: [{ type: 'text', value: '## From blocks' }],
            }],
        };
        const r = await t.get('/api/v1/blogs/alice/posts', { as: alice, json: { title: 'Posted as blocks', blocks: tree } });
        assert.strictEqual(r.status, 201, r.text);
        assert.match(r.json().post.body, /:::section\{id="from-blocks"/);
        assert.match(r.json().post.body, /## From blocks/);
    });

    await check('the published page renders the blocks: the hero art, the section, the byline, the rail', async () => {
        await t.get(`/api/v1/posts/${post.id}/publish`, { as: alice, json: {} });
        const page = await t.get('/@alice/blocks');
        const sharedCss = page.text.match(/<link rel="stylesheet" href="(\/css\/publishing-blocks\.css\?v=[0-9a-f]{10})">/);
        assert.ok(sharedCss, 'the post links the library blocks sheet');
        assert.ok(page.text.indexOf(sharedCss[0]) < page.text.indexOf('<link rel="stylesheet" href="/css/blocks.css?'), 'the library sheet loads before Blog placement rules');
        assert.strictEqual(page.status, 200, page.text);
        assert.match(page.text, /class="ov-media ov-hero-art"/);
        assert.match(page.text, /id="blueprint-rework"/);
        assert.match(page.text, /Blueprint rework/);
        assert.match(page.text, /ov-reactions/);
        assert.doesNotMatch(page.text, /&lt;script&gt;/, 'the blocks are not escaped into text');
        // The hero's name is the page's h1: the post's own title does not stand beside it.
        assert.strictEqual((page.text.match(/<h1\b/g) || []).length, 1, 'one h1');
        assert.match(page.text, /<h1>Printed &amp; Polished<\/h1>/);
        assert.doesNotMatch(page.text, /class="post-title"/);
        // The section's byline names the person it names, with their profile link.
        assert.match(page.text, /class="ov-section-by">by <a href="[^"]*authors\/[^"]*" rel="author">Alice Writer<\/a>/);
        // The picture appears once as the hero art and once in the section, never as a second header art.
        assert.strictEqual((page.text.match(new RegExp(`data-media-id="${MED}"`, 'g')) || []).length, 2, 'the hero art and the section figure, once each');
        assert.ok(page.text.indexOf('id="blueprint-rework"') > page.text.indexOf('ov-hero-art'), 'the hero comes before the sections');
    });

    await check('the folded patch notes list the window’s commits, grouped by site and linked', async () => {
        const db = t.ctx.store.db;
        const ins = db.prepare(`INSERT INTO changelog_entries (service, repo, sha, subject, deployed_at, release) VALUES (?, ?, ?, ?, ?, 'r1')`);
        await ins.run('live', 'OpenVibers/Live', 'abc1234def', 'Fix the channel header', '2026-11-05T12:00:00.000Z');
        await ins.run('chat', 'OpenVibers/Chat', 'def5678abc', 'Faster messages', '2026-11-06T12:00:00.000Z');
        const page = await t.get('/@alice/blocks');
        assert.match(page.text, /<details class="ov-patchnotes"><summary>2 changes across 2 sites<\/summary>/);
        assert.match(page.text, /<section class="ov-patchnotes-site"><h3[^>]*>live<\/h3><ul><li><a href="https:\/\/github.com\/OpenVibers\/Live\/commit\/abc1234def" rel="noopener"><code>abc1234<\/code><\/a> Fix the channel header<\/li>/);
        assert.match(page.text, /Faster messages/);
    });

    await check('the reaction of a reader is a form that posts without script', async () => {
        const page = await t.get('/@alice/blocks', { as: alice });
        assert.match(page.text, /<form class="ov-reactions" method="post" action="\/@alice\/blocks\/react"/);
        assert.match(page.text, /name="section" value="blueprint-rework"/);
        assert.match(page.text, /name="reaction" value="up"/);
        assert.match(page.text, /name="reaction" value="down"/);
    });

    await check('a signed-out reader is asked to sign in instead', async () => {
        const page = await t.get('/@alice/blocks');
        assert.match(page.text, /Sign in to react/);
        assert.doesNotMatch(page.text, /<form class="ov-reactions"/);
    });

    await check('the JSON-LD names the sections as the parts of the article, and the image is the hero art', async () => {
        const page = await t.get('/@alice/blocks');
        const blocks = [...page.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
        const posting = blocks.find((x) => x['@type'] === 'BlogPosting');
        assert.ok(posting, 'no BlogPosting on the page');
        assert.ok(posting.hasPart, 'the article has no parts');
        assert.strictEqual(posting.hasPart[0].name, 'Blueprint rework');
        assert.match(posting.hasPart[0].url, /#blueprint-rework$/);
        assert.match(posting.image, /\/o\//);
    });

    await check('a reaction that posts lands in Community and the counts come back', async () => {
        const bob = t.network.addUser('bob', { display_name: 'Bob Reader' });
        const csrf = t.csrf(bob);
        const r = await t.get('/@alice/blocks/react', { as: bob, form: { _csrf: csrf, section: 'blueprint-rework', reaction: 'up' } });
        assert.strictEqual(r.status, 303, r.text);
        assert.match(r.headers.get('location'), /#blueprint-rework$/);
        const page = await t.get('/@alice/blocks', { as: bob });
        assert.match(page.text, /👍 <span class="ov-react-count">1<\/span>/);
    });

    await check('a reaction without a valid CSRF token is refused', async () => {
        const bob = t.network.addUser('bob2', { display_name: 'Bob Two' });
        const r = await t.get('/@alice/blocks/react', { as: bob, form: { section: 'blueprint-rework', reaction: 'up' } });
        assert.strictEqual(r.status, 403, r.text);
    });

    done();
})();
