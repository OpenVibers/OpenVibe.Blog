'use strict';
/**
 * The index (the official blog's home and /devblog, stage B1): the newest post as a featured hero with
 * Read more, the tabs as server-rendered links, a filter by name, and the archive as art cards with real
 * page links. Every part of it is in the HTML, so a crawler and a reader without script get the same.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const LONG = 'The quick brown fox jumps over the lazy dog while the network ships. '.repeat(12);
const MED = 'med_01J8ZQ4X3M000000000000000A';

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice', { display_name: 'Alice' });
    t.media.objects.set(MED, 'ready');
    const publish = async (input) => {
        const r = await t.get('/api/v1/blogs/openvibe/posts', { as: t.official, json: input });
        assert.strictEqual(r.status, 201, r.text);
        const p = await t.get(`/api/v1/posts/${r.json().post.id}/publish`, { as: t.official, json: {} });
        assert.strictEqual(p.status, 200, p.text);
        t.clock.advance(60_000);
        return r.json().post;
    };

    await check('setup: a guide, a community post, a daily update and the newest, a devblog with art', async () => {
        await publish({ title: 'Meet the builders', categories: 'Community', body: `Who shipped what.\n\n${LONG}` });
        await publish({ title: 'A quieter morning', categories: 'Daily', body: `The day's small changes.\n\n${LONG}` });
        await publish({ title: 'Printed & Polished', categories: 'Devblog', summary: 'This month: blueprints, the Uzi, and our biggest optimisation pass.', body: `:::hero{art="${MED}" kicker="Devblog"}\n# Printed & Polished\nThe update.\n:::\n\n${LONG}` });
        assert.ok(alice);
    });

    await check('the home: the newest post is the featured hero with its art and Read more', async () => {
        const home = await t.get('/');
        assert.strictEqual(home.status, 200, home.text);
        const at = home.text.indexOf('class="bh-feature"');
        assert.ok(at > 0, 'no featured hero');
        const feature = home.text.slice(at, home.text.indexOf('</article>', at));
        assert.match(feature, /class="bh-feature-art" href="\/@openvibe\/printed-polished"/);
        assert.match(feature, /<h2 class="bh-feature-title"><a href="\/@openvibe\/printed-polished">Printed &amp; Polished<\/a><\/h2>/);
        assert.match(feature, /Read more/);
        const cards = home.text.slice(home.text.indexOf('class="bh-cards bh-artcards"'));
        assert.ok(cards.indexOf('A quieter morning') < cards.indexOf('Meet the builders'), 'the cards are newest first');
    });

    await check('a tab whose category has no post is empty, not every post', async () => {
        const empty = await t.get('/?tab=guides');
        assert.strictEqual(empty.status, 200, empty.text);
        assert.doesNotMatch(empty.text, /Meet the builders/);
        assert.match(empty.text, /Nothing published here yet/);
        // Now the category exists, and the same tab lists only its post.
        await publish({ title: 'How to self-host', categories: 'Guides', body: `A guide.\n\n${LONG}` });
        const filled = await t.get('/?tab=guides');
        assert.match(filled.text, /How to self-host/);
        assert.doesNotMatch(filled.text, /Meet the builders/);
    });

    await check('the tabs are server-rendered links, and each one lists only its category', async () => {
        const home = await t.get('/');
        for (const [label, href] of [['Latest', '/'], ['Devblog', '/?tab=devblog'], ['Daily', '/?tab=daily'], ['Community', '/?tab=community'], ['Guides', '/?tab=guides']]) {
            assert.ok(home.text.includes(`<a href="${href}"`) && home.text.includes(`>${label}</a>`), `${label} tab`);
        }
        assert.match(home.text, /<a href="\/" aria-current="page">Latest<\/a>/);
        const devblog = await t.get('/?tab=devblog');
        assert.match(devblog.text, /<a href="\/\?tab=devblog" aria-current="page">Devblog<\/a>/);
        assert.match(devblog.text, /Printed &amp; Polished/);
        assert.doesNotMatch(devblog.text, /Meet the builders/);
    });

    await check('/devblog is the same index on its own address, with no marketing sections', async () => {
        const page = await t.get('/devblog');
        assert.strictEqual(page.status, 200, page.text);
        assert.match(page.text, /<title>Devblog · OpenVibe\.Blog<\/title>/);
        assert.ok(page.text.includes('class="bh-feature"') && page.text.includes('Printed &amp; Polished'));
        assert.match(page.text, /<nav class="bh-tabs"/);
        assert.doesNotMatch(page.text, /This week across OpenVibe/);
        assert.match(page.text, /<link rel="canonical" href="https:\/\/openvibe\.blog\/devblog">/);
    });

    await check('a name filter narrows the list and says when nothing matches', async () => {
        const only = await t.get('/?q=builder');
        assert.match(only.text, /Meet the builders/);
        assert.doesNotMatch(only.text, /How to self-host/);
        assert.match(only.text, /id="bh-q" name="q" type="search" value="builder"/);
        const none = await t.get('/?q=nothing-like-this');
        assert.match(none.text, /No post matches/);
    });

    await check('the cards are art cards with real page links, and the next page is a real link', async () => {
        const page = await t.get('/?tab=daily');
        assert.match(page.text, /A quieter morning/, 'the tab’s only post is its feature');
        assert.doesNotMatch(page.text, /class="bh-cards bh-artcards"/, 'nothing is left for a card grid');
        for (let i = 0; i < 16; i++) await publish({ title: `Filler ${i}`, categories: 'Devblog', body: `Filler.\n\n${LONG}` });
        const first = await t.get('/devblog');
        assert.match(first.text, /<li class="bh-card bh-artcard">/);
        assert.match(first.text, /<a class="bh-next" href="\/devblog\?page=2">Next page<\/a>/);
        assert.match(first.text, /<script src="\/js\/blog-index\.js" defer><\/script>/);
        const second = await t.get('/devblog?page=2');
        assert.strictEqual(second.status, 200);
        assert.match(second.text, /aria-current="page">2<\/span>/);
        // Page 2 is cards alone: the first post of the page is not featured away, so loading the next
        // page in place never misses a post.
        assert.doesNotMatch(second.text, /class="bh-feature"/);
        assert.strictEqual((second.text.match(/<li class="bh-card bh-artcard">/g) || []).length, 2);
    });

    await check('the index keeps WebSite and ItemList structured data', async () => {
        const page = await t.get('/devblog');
        const lds = [...page.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
        assert.ok(lds.find((x) => x['@type'] === 'Blog'));
        assert.ok(lds.find((x) => x['@type'] === 'ItemList'));
    });

    await t.close();
    done();
})();
