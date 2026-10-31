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

        await check('the AI desks are one list: no chip row, every desk in the page', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            assert.ok(!page.includes('pick-desks'), 'the desks are no longer a pick block');
            const desks = [...page.matchAll(/<li data-i="(\d+)"><p class="bh-desk">/g)];
            assert.ok(desks.length >= 1, 'the desks are in the page (' + desks.length + ')');
            assert.match(page, /<h2 id="bh-desks-h">From the AI desks<\/h2>/);
        });

        await check('nothing hides a post, a summary, a bar or a tag on a phone', async () => {
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'blog.css'), 'utf8');
            assert.ok(!/#posts \.bh-cards > li:nth-child\(n\+7\)/.test(css), 'no latest post is hidden');
            assert.ok(!/\.bh-card \.bh-sum \{ display: none/.test(css), 'a post keeps its summary');
            assert.ok(!/\.bh-bars > li:nth-child\(n\+6\)/.test(css), 'no week bar is hidden');
            assert.ok(!/\.bh-chips > li:nth-child\(n\+13\)/.test(css), 'no topic is hidden');
            assert.match(css, /#posts \.bh-cards \{ display: flex; overflow-x: auto;/, 'the latest posts scroll sideways instead');
            const r = await t.get('/');
            assert.ok(!r.text.includes('<style>@supports selector(:has(*)){@media (max-width:640px){.pick#pick-desks'), 'no pick rule is written for the desks');
        });

        await check('the parts a reader rarely needs are folds that start open on every screen', async () => {
            const r = await t.get('/');
            const page = r.text;
            for (const id of ['week', 'topics', 'faq', 'shipped']) {
                assert.ok(page.includes('<details class="bl-fold bl-fold-block" id="' + id + '" open>'), id + ' is a fold, open in the page');
                assert.ok(!page.includes('document.getElementById("' + id + '")'), id + ' is never closed by script');
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
