'use strict';
/**
 * The home page (the official blog's first page): its own title and description, the numbers (public posts, AI desk
 * posts, the week's changes and sites), the official blog's newest posts as cards with the pager, the week's changes by
 * site, the AI desks' latest posts (hidden ones never), topics with counts, the series, members' public posts (never a
 * private one), the questions shown and given as FAQPage, and WebSite + ItemList structured data. Page 2 stays a plain
 * listing with the blog's own title.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { createHome } = require('../server/domain/home');

const LONG = 'The quick brown fox jumps over the lazy dog while the network ships. '.repeat(12);
const ld = (text) => [...text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice', { display_name: 'Alice' });
    const publish = async (as, handle, input) => {
        const r = await t.get(`/api/v1/blogs/${handle}/posts`, { as, json: { body: `${input.title} body.\n\n${LONG}`, ...input } });
        assert.strictEqual(r.status, 201, r.text);
        const p = await t.get(`/api/v1/posts/${r.json().post.id}/publish`, { as, json: {} });
        assert.strictEqual(p.status, 200, p.text);
        t.clock.advance(60_000);
        return r.json().post;
    };
    const now = t.clock.now();
    const iso = (ms) => new Date(ms).toISOString();
    const db = t.ctx.store.db;

    await check('setup: official posts in a series, a member blog with a public and a private post, changelog entries, desk posts', async () => {
        await publish(t.official, 'openvibe', { title: 'Patch notes: Voice channels', tags: 'patch-notes, chat', series: 'Patch notes' });
        await publish(t.official, 'openvibe', { title: 'Patch notes: The Rundown', tags: 'patch-notes, live', series: 'Patch notes' });
        await publish(t.official, 'openvibe', { title: 'A letter from the team', tags: 'live' });
        assert.strictEqual((await t.get('/api/v1/blogs', { as: alice, json: {} })).status, 201);
        await publish(alice, 'alice', { title: 'My first stream', tags: 'live' });
        await publish(alice, 'alice', { title: 'Private notes', visibility: 'private' });
        const entry = db.prepare(`INSERT INTO changelog_entries (service, repo, sha, subject, deployed_at, release) VALUES (?, ?, ?, ?, ?, 'r1')`);
        let n = 0;
        for (const [service, ago] of [['live', 1], ['live', 2], ['live', 3], ['wiki', 1], ['media-hub', 5], ['news', 9]]) await entry.run(service, `OpenVibers/${service}`, `sha${n++}`, `change ${n}`, iso(now - ago * 86400_000));
        const desk = db.prepare(`INSERT INTO blog_desk_posts (id, desk, slug, status, title, dek, period_from, period_to, created_at, published_at, updated_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        await desk.run('dp_news', 'news', 'headlines-oct-21', 'published', 'Headlines of Oct 21', 'What governments announced.', now - 2 * 86400_000, now - 86400_000, now, now, now);
        await desk.run('dp_satire', 'satire', 'too-many-vibes', 'published', 'Is it possible to take too many vibes?', 'A sober inquiry.', now - 86400_000, now, now, now, now);
        await desk.run('dp_hidden', 'deals', 'hidden-deals', 'hidden', 'A hidden digest', null, now - 86400_000, now, now, now, now);
    });

    let home;
    await check('the home: its own title and description, the numbers, the hero', async () => {
        home = await t.get('/');
        assert.strictEqual(home.status, 200);
        assert.match(home.text, /<title>OpenVibe\.Blog: start a blog, read what OpenVibe ships<\/title>/);
        const desc = /<meta name="description" content="([^"]*)"/.exec(home.text)[1];
        assert.ok(desc.length <= 160 && /drafts, scheduling, feeds and comments/.test(desc), desc);
        assert.strictEqual((home.text.match(/<h1\b/g) || []).length, 1, 'one h1 (the hero)');
        const stats = await createHome({ store: t.ctx.store }).stats();
        assert.deepStrictEqual(stats, { posts: 4, blogs: 2, writers: 2, deskPosts: 2, weekChanges: 5, weekSites: 3 });
        assert.match(home.text, /<dt>Posts published<\/dt><dd>4<\/dd>/);
        assert.match(home.text, /<dt>Changes shipped this week<\/dt><dd>5<\/dd>/);
    });

    await check('the official blog\'s newest posts as cards; the week by site; the desks; topics; series; members\' posts', async () => {
        const text = home.text;
        assert.ok(text.indexOf('A letter from the team') < text.indexOf('Patch notes: The Rundown'), 'newest first');
        assert.ok(text.includes('class="bh-cards"'));
        assert.match(text, /OpenVibe\.Live<\/a><span class="bh-bar"[^>]*><span style="width:100%"><\/span><\/span><span class="bh-n">3 changes<\/span>/);
        assert.ok(text.includes('OpenVibe.MediaHub') && !text.includes('OpenVibe.News</a><span class="bh-bar"'), 'nine days ago is not this week');
        assert.ok(text.includes('href="/desks/news/headlines-oct-21"') && text.includes('href="/desks/satire/too-many-vibes"'));
        assert.ok(!text.includes('A hidden digest'), 'a hidden desk post never shows');
        assert.match(text, /<a href="\/tags\/live">#live <span>3<\/span><\/a>/);
        assert.ok(text.includes('href="/@openvibe/series/patch-notes">Patch notes</a> (2 posts)'));
        assert.ok(text.includes('My first stream') && !text.includes('Private notes'), 'members\' public posts only');
    });

    await check('questions, links, structured data', async () => {
        const text = home.text;
        assert.ok(text.includes('<summary>Who can start a blog?</summary>'));
        assert.ok(text.includes('href="/write"') && text.includes('href="/desks"') && text.includes('href="/updates"'));
        const blocks = ld(text);
        assert.ok(blocks.find((b) => b['@type'] === 'Blog') && blocks.find((b) => b['@type'] === 'WebSite'));
        const list = blocks.find((b) => b['@type'] === 'ItemList');
        assert.deepStrictEqual(list.itemListElement.map((x) => x.name), ['A letter from the team', 'Patch notes: The Rundown', 'Patch notes: Voice channels']);
        const faq = blocks.find((b) => b['@type'] === 'FAQPage');
        for (const q of faq.mainEntity) assert.ok(text.includes(`<summary>${q.name.replace(/'/g, '&#39;')}</summary>`), q.name);
    });

    await check('an empty network: sections with nothing to show are left out', async () => {
        await db.prepare('DELETE FROM changelog_entries').run();
        await db.prepare('DELETE FROM blog_desk_posts').run();
        const text = (await t.get('/')).text;
        assert.ok(!text.includes('This week across OpenVibe') && !text.includes('From the AI desks'));
        assert.ok(!text.includes('<dt>Changes shipped this week</dt>'));
    });

    await t.close();
    done();
})();
