'use strict';
/**
 * Rich blocks in a post: the body is Markdown plus blocks, the page renders them server-side (every
 * block a plain-HTML form), the API hands the blocks out next to the Markdown and takes them in, and
 * a reader's reaction to a section is a form that posts without script.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const MED = 'med_01J8ZQ4X3M000000000000000A';
const BODY = [
    ':::hero{art="' + MED + '" kicker="Devblog" date="2026-11-09"}',
    'This month: blueprints rework, the Uzi, our biggest optimisation pass yet.',
    ':::',
    '',
    ':::section{id="blueprint-rework" by="usr_01J8ZQ4X3M000000000000000D" react}',
    '## Blueprint rework',
    'Workbenches no longer need fragments.',
    ':::figure{src="' + MED + '" alt="The channel header"}',
    ':::',
    ':::',
].join('\n');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice', { display_name: 'Alice Writer' });
    let post;

    await check('a body with blocks is stored as the Markdown that parses back into them', async () => {
        await t.get('/api/v1/blogs', { as: alice, json: {} });
        const r = await t.get('/api/v1/blogs/alice/posts', { as: alice, json: { title: 'Blocks', body: BODY } });
        assert.strictEqual(r.status, 201, r.text);
        post = r.json().post;
        assert.match(post.body, /:::section\{id="blueprint-rework"/);
    });

    await check('the API hands the blocks out next to the Markdown, and ?format=blocks asks for them alone', async () => {
        const r = await t.get(`/api/v1/posts/${post.id}`, { as: alice });
        assert.strictEqual(r.status, 200, r.text);
        const dto = r.json().post;
        assert.match(dto.body, /:::hero/);
        assert.strictEqual(dto.blocks.type, 'root');
        assert.deepStrictEqual(dto.blocks.children.map((c) => c.type), ['hero', 'section']);
        const section = dto.blocks.children[1];
        assert.strictEqual(section.attrs.id, 'blueprint-rework');
        assert.strictEqual(section.attrs.react, true);

        const only = await t.get(`/api/v1/posts/${post.id}?format=blocks`, { as: alice });
        assert.strictEqual(only.status, 200);
        assert.strictEqual(only.json().blocks.type, 'root');
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
        assert.strictEqual(page.status, 200, page.text);
        assert.match(page.text, /class="post-hero-art"/);
        assert.match(page.text, /id="blueprint-rework"/);
        assert.match(page.text, /Blueprint rework/);
        assert.match(page.text, /ov-reactions/);
        assert.doesNotMatch(page.text, /&lt;script&gt;/, 'the blocks are not escaped into text');
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
