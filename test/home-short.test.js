'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const db = t.ctx.store.db;
    try {
        await check('setup: a week of changes, two desk posts and a tagged post, so the lists have something to show', async () => {
            const now = t.clock.now();
            const iso = (ms) => new Date(ms).toISOString();
            const entry = db.prepare('INSERT INTO changelog_entries (service, repo, sha, subject, deployed_at, release) VALUES (?, ?, ?, ?, ?, ?)');
            await entry.run('live', 'OpenVibers/live', 'sha1', 'change 1', iso(now - 86400_000), 'r1');
            await entry.run('wiki', 'OpenVibers/wiki', 'sha2', 'change 2', iso(now - 2 * 86400_000), 'r1');
            const desk = db.prepare('INSERT INTO blog_desk_posts (id, desk, slug, status, title, dek, period_from, period_to, created_at, published_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            await desk.run('dp_news', 'news', 'headlines-oct-21', 'published', 'Headlines of Oct 21', 'What governments announced.', now - 2 * 86400_000, now - 86400_000, now, now, now);
            await desk.run('dp_satire', 'satire', 'too-many-vibes', 'published', 'Is it possible to take too many vibes?', 'A sober inquiry.', now - 86400_000, now, now, now, now);
            const post = await t.get('/api/v1/blogs/openvibe/posts', { as: t.official, json: { body: 'A letter from the team.\n\nThe network ships.', title: 'A letter from the team', tags: 'live,patch-notes' } });
            assert.strictEqual(post.status, 201, post.text);
            await t.get('/api/v1/posts/' + post.json().post.id + '/publish', { as: t.official, json: {} });
        });

        await check('the AI desks are a pick block: a chip per desk, the first picked, every desk in the page', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            const start = page.indexOf('<div class="pick" id="pick-desks">');
            assert.ok(start > 0, 'the desks are a pick block on the home');
            const block = page.slice(start, start + 6000);
            assert.match(block, /<div class="pick-row" role="radiogroup" aria-label="From the AI desks">/);
            const chips = [...block.matchAll(/<input type="radio" name="pick-desks" id="pk-desks-(\d+)" value="\1"( checked)?><label for="pk-desks-\1">([^<]+)<\/label>/g)];
            assert.ok(chips.length >= 1, 'a chip per desk (' + chips.length + ')');
            assert.deepStrictEqual(chips.filter((m) => m[2]).map((m) => m[1]), [chips[0][1]], 'the first desk is picked');
            const desks = [...block.matchAll(/<li data-i="(\d+)"><p class="bh-desk">/g)];
            assert.strictEqual(desks.length, chips.length, 'every desk is in the page');
            assert.deepStrictEqual(desks.map((m) => m[1]), chips.map((m) => m[1]), 'each desk knows its chip');
        });

        await check('the CSS guard: the chips are hidden and the desks all show until 640 px and where :has() is understood', async () => {
            const r = await t.get('/');
            const page = r.text;
            assert.match(page, /<style>@supports selector\(:has\(\*\)\)\{@media \(max-width:640px\)\{\.pick#pick-desks:has\(#pk-desks-0:checked\) \.pick-list>li\[data-i="0"\]\{display:block\}/, 'the rule that shows the picked desk');
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'blog.css'), 'utf8');
            assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
            assert.match(css, /@supports selector\(:has\(\*\)\) \{ @media \(max-width: 640px\) \{/, 'the phone rules are under :has() and 640 px');
            assert.match(css, /\.pick-row label \{[^}]*min-height: 44px/, 'a chip is a 44 px target');
            assert.match(css, /\.pick \.pick-list > li \{ display: none; \}/, 'the desks are hidden on a phone');
        });

        await check('the parts a reader rarely needs are folds, open in the page and closed on a phone', async () => {
            const r = await t.get('/');
            const page = r.text;
            for (const id of ['week', 'topics', 'faq', 'shipped']) {
                assert.ok(page.includes('<details class="bl-fold bl-fold-block" id="' + id + '" open>'), id + ' is a fold, open in the page');
                assert.ok(page.includes('document.getElementById("' + id + '")'), id + ' has the script that closes it on a phone');
            }
            assert.match(page, /<h2 id="bh-week-h">This week across OpenVibe<\/h2>/);
            assert.match(page, /<h2 id="bh-tags-h">Topics<\/h2>/);
            assert.match(page, /<h2 id="bh-faq-h">Questions<\/h2>/);
            assert.match(page, /<h2 id="bh-shipped-h">Recently shipped on OpenVibe.Blog<\/h2>/);
            assert.match(page, /<summary>Who can start a blog\?<\/summary>/, 'the questions are still on the page');
        });
    } finally {
        await done(t);
    }
})().catch((e) => { console.error(e); process.exit(1); });
