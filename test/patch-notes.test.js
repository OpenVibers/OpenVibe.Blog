'use strict';
/**
 * Patch notes v2: the story map is right on the real 10-29/10-30 batch, the post follows §3.1, and a draft
 * never publishes without a person and passing checks.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { build } = require('../server/patch-notes/stories');
const { compose, briefFor, mergeAi, nextItems } = require('../server/patch-notes/draft');
const { seedCard, OFFICIAL_TEXT } = require('../server/patch-notes/voice');
const { scan } = require('../server/patch-notes/slop');
const { evaluate } = require('../server/patch-notes/review');
const { isExplicit } = require('../server/patch-notes/explicit');
const { intentOf } = require('../server/patch-notes/text');
const fixture = require('./fixtures/changelog-2026-10-30.json');

const entry = (service, sha, subject, body = null) => ({
    service, repo: `OpenVibers/OpenVibe.${service}`, sha, subject, message_body: body,
    committed_at: '2026-10-30T02:00:00.000Z', deployed_at: '2026-10-30T02:00:00.000Z', release: 'r1', major: 0, id: null,
});

(async () => {
    // ── the story map, on the real feed ─────────────────────
    await check('the real 29–30 October batch becomes the four stories the spec names', async () => {
        const map = build(fixture.entries);
        const titles = map.stories.slice(0, 4).map((s) => s.title);
        assert.deepStrictEqual(titles, ['44px, or it doesn\'t count', 'One sign-in, twenty-three sites', 'Homes that scroll sideways', 'The orbit stays put']);
        const byTitle = Object.fromEntries(map.stories.map((s) => [s.title, s]));
        assert.strictEqual(byTitle['44px, or it doesn\'t count'].sites.length, 34);
        assert.strictEqual(byTitle['One sign-in, twenty-three sites'].sites.length, 23);
        assert.ok(byTitle['The orbit stays put'].entries.length === 2);
        assert.ok(map.stories.every((s) => s.kind === 'fix' || s.kind === 'feature'));
    });

    await check('a one-off change is user-facing only when it names something a reader uses', async () => {
        assert.strictEqual(intentOf({ service: 'network', repo: 'OpenVibers/OpenVibe.Network', subject: 'The site switcher follows the account (#430)' }).kind, 'feature');
        assert.strictEqual(intentOf({ service: 'bench', repo: 'OpenVibers/OpenVibe.Bench', subject: 'Generation: a token cap per showcase kind (#17)' }).kind, 'internal');
        assert.strictEqual(intentOf({ service: 'codes', repo: 'OpenVibers/OpenVibe.Codes', subject: 'engine/: the agent engine, ported from the portal (C1) (#159)' }).kind, 'internal');
        assert.strictEqual(intentOf({ service: 'blog', repo: 'OpenVibers/OpenVibe.Blog', subject: 'Patch notes v2: commits become stories, and a person publishes them (#131)', major: 1 }).kind, 'internal', 'a large diff is not a feature');
        assert.strictEqual(intentOf({ service: 'blog', repo: 'OpenVibers/OpenVibe.Blog', subject: 'patch notes: one-off changes get a line, and the full list is not prose (#134)', major: 1 }).kind, 'internal');
    });

    await check('a product name in a sourced line is not the writer\'s slop; the story still is', async () => {
        const sourced = scan({ body: "## What's next\n\n- **Next:** Showcase S2: seed rounds for the ten showcase tasks ([#19](https://github.com/OpenVibers/OpenVibe.Bench/pull/19)).\n\n## Also shipped\n\n- **Bench:** showcase: real outputs from two models.\n" });
        assert.strictEqual(sourced.blocking.length, 0);
        const story = scan({ body: '## A section\n\nWe showcase the new button.' });
        assert.ok(story.blocking.some((b) => b.phrase === 'showcase'));
    });

    await check('a one-off change is an Also shipped line, never a section shared with unrelated changes', async () => {
        const map = build([
            { ...entry('network', '9'.repeat(40), 'The site switcher follows the account') },
            { ...entry('codes', '8'.repeat(40), 'engine: the agent engine, ported from the portal') },
        ]);
        assert.strictEqual(map.stories.length, 0);
        assert.strictEqual(map.also.length, 2);
        const doc = compose({ map, voice: { card: seedCard() }, pulls: [] });
        assert.ok(!/^## The site switcher/m.test(doc.body));
        assert.ok(doc.body.includes('## Also shipped'));
        assert.ok(/agent engine/i.test(doc.body));
    });

    await check('the lockfile round folds into the chores, not into a story', async () => {
        const map = build(fixture.entries);
        assert.strictEqual(map.chores.filter((e) => /openvibe-shared v4\./.test(e.subject)).length, 24);
        assert.strictEqual(map.chores.filter((e) => /in the docs/.test(e.subject)).length, 4);
        assert.ok(!map.stories.some((s) => /openvibe-shared v4\.45\.0/.test(s.title)), 'no version in a headline');
    });

    await check('an explicit Workstream trailer wins over the words, and a 72-hour gap starts a new round', async () => {
        const a = { ...entry('play', 'a'.repeat(40), 'Tidy the launcher'), body: 'Workstream: launcher\nPlayer-facing: yes' };
        const b = { ...entry('tools', 'b'.repeat(40), 'Tidy the launcher'), body: 'Workstream: launcher\nPlayer-facing: yes' };
        const c = { ...entry('tools', 'c'.repeat(40), 'Tidy the launcher'), body: 'Workstream: launcher\nPlayer-facing: yes', deployed_at: '2026-11-04T02:00:00.000Z' };
        const map = build([a, b, c]);
        assert.ok(map.stories.some((s) => s.key === 'ws:launcher' || s.key.startsWith('ws:')), 'one workstream');
        assert.strictEqual(map.stories.length, 2, 'the third is three days later: a new round');
    });

    // ── the template ───────────────────────────────────────
    await check('the post has a title, a dek, three outcomes, one H2 per story, and the list only under details', async () => {
        const map = build(fixture.entries);
        const doc = compose({ map, voice: { card: seedCard() }, pulls: [] });
        const tw = doc.title.trim().split(/\s+/).length;
        assert.ok(tw >= 5 && tw <= 9, `title words: ${tw} (${doc.title})`);
        assert.ok(!/patch notes:/i.test(doc.title));
        assert.strictEqual((doc.body.match(/^## The short version$/gm) || []).length, 1);
        const short = doc.body.split('## The short version')[1].split(/^## /m)[0].trim().split('\n').filter((l) => /^- /.test(l));
        assert.strictEqual(short.length, 3);
        for (const s of map.stories) assert.ok(doc.body.includes(`## ${s.title}`), `section ${s.title}`);
        assert.ok(/## Under the hood/.test(doc.body), 'chores get one paragraph');
        assert.ok(doc.body.includes('<details>') && doc.body.includes('</details>'));
        assert.ok(doc.body.trim().endsWith('— the OpenVibe crew'));
        const story = doc.body.split('<details>')[0];
        assert.ok(!story.includes('Touch targets on phones (fleet audit)'), 'commit subjects stay in the list');
        assert.ok(!/OpenVibe\.[A-Za-z]+/.test(story), 'no repository names in the story');
    });

    await check('the AI brief carries the voice card and the story map; the AI body keeps our tail', async () => {
        const map = build(fixture.entries.slice(0, 60));
        const brief = briefFor({ map, voice: seedCard(), blog: { handle: 'openvibe' } });
        assert.ok(brief.includes(OFFICIAL_TEXT.slice(0, 60)));
        for (const s of map.stories.slice(0, 3)) assert.ok(brief.includes(s.title));
        const doc = compose({ map, voice: { card: seedCard() }, pulls: [] });
        const ai = `A short intro.\n\n## The short version\n\n- One thing.\n- Two things.\n- Three things.\n\n## A section\n\nBody.\n\n— the OpenVibe crew`;
        const merged = mergeAi(ai, doc, seedCard());
        assert.ok(merged.includes('## A section'));
        assert.ok(merged.includes('## The full list'));
        assert.strictEqual((merged.match(/— the OpenVibe crew/g) || []).length, 1, 'one sign-off');
    });

    await check('What\'s next takes user-facing PRs only, at most three, never a version bump', async () => {
        const pulls = [
            { number: 1, title: 'openvibe-shared v4.47.2 (was v4.43.0)', url: 'https://github.com/OpenVibers/OpenVibe.Play/pull/1' },
            { number: 2, title: 'Phones: a drag carries on into the page', url: 'https://github.com/OpenVibers/OpenVibe.Chat/pull/2' },
            { number: 3, title: 'One sign-in module', url: 'https://github.com/OpenVibers/OpenVibe.Actor/pull/3' },
            { number: 4, title: 'Sign in with OpenVibe for developer apps', url: 'https://github.com/OpenVibers/OpenVibe.SDK/pull/4' },
            { number: 5, title: 'A fourth thing', url: 'https://github.com/OpenVibers/OpenVibe.Tools/pull/5' },
        ];
        const picked = nextItems(pulls);
        assert.strictEqual(picked.length, 3);
        assert.ok(!picked.some((p) => p.number === 1));
        assert.ok(!picked.some((p) => p.number === 5));
    });

    // ── slop and looks ─────────────────────────────────────
    await check('the slop check blocks the banned phrases and warns on the structures', async () => {
        const r = scan({ body: 'We leverage a robust, seamless experience.\n\nIt\'s not just a fix, it\'s a transform.\n\nIn conclusion, this is overall a major thing.' });
        const phrases = r.blocking.map((b) => b.phrase);
        for (const p of ['leverage', 'robust', 'seamless', 'transform', 'major', 'overall', 'in conclusion']) assert.ok(phrases.includes(p), `blocked ${p}`);
        assert.ok(r.warnings.some((w) => w.code === 'structure.not_just'));
        assert.ok(r.warnings.some((w) => w.code === 'structure.restating_conclusion'));
        assert.strictEqual(scan({ body: 'A plain sentence about a button.\n\nAnother one about a link.' }).blocking.length, 0);
    });

    await check('the full list is exempt from the phrase check (commit subjects are exact names)', async () => {
        const body = `## Story\n\nA change.\n\n<details>\n<summary>All</summary>\n\n- Touch targets on phones (fleet audit) (#1)\n\n</details>`;
        assert.strictEqual(scan({ body }).blocking.length, 0);
    });

    await check('describing people is fine; sex acts and porn still block, nudity does not', async () => {
        assert.strictEqual(isExplicit('The draft says explicit adult content follows.'), true);
        assert.strictEqual(isExplicit('A nude figure study hangs on the wall.'), false);
        const r = await evaluate({ title: 'A fix', dek: 'A plain dek about the page and what it does for you.', body: 'A shirtless man sits at a desk.', review: null, authorship: { mode: 'human' } });
        assert.ok(!r.blocking.some((b) => b.code === 'explicit.sex'), 'describing a person is fine');
        const sex = await evaluate({ title: 'A fix', dek: 'A plain dek about the page and what it does for you.', body: 'The clip shows sex acts.', review: null, authorship: { mode: 'human' } });
        assert.ok(sex.blocking.some((b) => b.code === 'explicit.sex'));
    });

    // ── the service: a draft, the gates, a person ───────────
    const t = await boot();
    const owner = { kind: 'user', subject: t.official.subject, staff: false };
    const entries = [
        entry('design', 'd'.repeat(40), 'One sign-in module: openvibe-sdk/sso 0.73.0 (#24)'),
        entry('codes', 'c'.repeat(40), 'One sign-in module: openvibe-sdk/sso 0.73.0 (#157)'),
        entry('play', 'e'.repeat(40), 'Touch targets on phones (fleet audit) (#87)'),
        entry('help', 'f'.repeat(40), 'Touch targets on phones (fleet audit) (#135)'),
        entry('coupons', 'g'.repeat(40), 'The home page is wider than a phone (Coupons) (#144)'),
    ];

    await check('the official voice card is seeded with the exact text and a person can edit their own', async () => {
        const official = await t.ctx.patchNotes.voice.official();
        assert.strictEqual(official.card.text, OFFICIAL_TEXT);
        await t.ctx.patchNotes.voice.set(t.official.subject, { text: 'I. First person. I own the bug.', signoff: '— @lead' });
        const mine = await t.ctx.patchNotes.voice.get(t.official.subject);
        assert.strictEqual(mine.card.text, 'I. First person. I own the bug.');
        assert.strictEqual((await t.ctx.patchNotes.voice.official()).card.text, OFFICIAL_TEXT, 'the official card is unchanged');
    });

    // The commits live in the changelog table (as collect() writes them), so the feed and the marking are real.
    const db = t.ctx.store.db;
    let n = 0;
    for (const e of entries) {
        await db.prepare(`INSERT INTO changelog_entries (service, repo, sha, subject, author, committed_at, deployed_at, release, release_lines, major, post_id, message_body)
            VALUES (?, ?, ?, ?, 'OpenVibers', ?, ?, 'r1', 5, 0, NULL, ?)`).run(e.service, e.repo, e.sha, e.subject, e.committed_at, e.deployed_at, e.subject);
        n++;
    }
    assert.strictEqual(n, entries.length);

    let draft = null;
    await check('a batch becomes a draft, never a published post, and the feed does not point at it', async () => {
        const rows = await t.ctx.changelog.pendingEntries();
        const out = await t.ctx.patchNotes.draftPending({ entries: rows, pullRequests: [], useAi: false, reason: 'test' });
        assert.ok(out.created, JSON.stringify(out));
        draft = out;
        const post = await t.ctx.posts.get(out.post.id);
        assert.strictEqual(post.state, 'draft');
        const head = await t.ctx.posts.head(post);
        assert.strictEqual(head.meta.authorship.mode, 'imported');
        assert.match(head.fields.title, /^Sign-in/);
        assert.ok(head.content.includes('## The short version'));
        assert.ok(head.content.includes('## The full list'));
        const feed = await t.ctx.changelog.entries({ limit: 50 });
        assert.ok(feed.every((e) => e.post_id === null), 'a draft is not a feed link');
        const again = await t.ctx.patchNotes.draftPending({ pullRequests: [], useAi: false, reason: 'test' });
        assert.strictEqual(again.created, false, 'the same commits are not drafted twice');
    });

    await check('publishing needs a person: no review, no publish', async () => {
        const post = await t.ctx.posts.get(draft.post.id);
        await assert.rejects(async () => t.ctx.posts.publish(owner, post, {}), (e) => /review|blocked/i.test(e.message));
        assert.strictEqual((await t.ctx.posts.get(post.id)).state, 'draft');
    });

    await check('a banned phrase blocks; its override is recorded and a sex act still blocks', async () => {
        let post = await t.ctx.posts.get(draft.post.id);
        let head = await t.ctx.posts.head(post);
        await t.ctx.posts.update(owner, post, { body: `${head.content}\n\nWe leverage the new module. The clip shows sex acts.`, expectedRevision: head.number });
        const c1 = await t.ctx.patchNotes.check(post.id);
        assert.ok(c1.result.blocking.some((b) => b.code === 'slop.phrase' && b.phrase === 'leverage'));
        assert.ok(c1.result.blocking.some((b) => b.code === 'explicit.sex'));
        await t.ctx.patchNotes.setOverride(post.id, { reason: 'the word is the feature name here', phrases: ['leverage'], by: t.official.subject });
        const c2 = await t.ctx.patchNotes.check(post.id);
        assert.ok(!c2.result.blocking.some((b) => b.code === 'slop.phrase'), 'the phrase is overridden');
        assert.ok(c2.result.warnings.some((w) => w.code === 'slop.overridden'));
        assert.ok(c2.result.blocking.some((b) => b.code === 'explicit.sex'), 'sex acts cannot be overridden');
        await assert.rejects(async () => t.ctx.posts.publish(owner, await t.ctx.posts.get(post.id), {}), /blocking/i);
    });

    await check('after the sex-act sentence goes and a person approves the revision, it publishes', async () => {
        let post = await t.ctx.posts.get(draft.post.id);
        let head = await t.ctx.posts.head(post);
        await t.ctx.posts.update(owner, post, { body: head.content.replace(' The clip shows sex acts.', ''), expectedRevision: head.number });
        post = await t.ctx.posts.get(post.id);
        head = await t.ctx.posts.head(post);
        await t.ctx.posts.review(owner, post, { revision: head.number, decision: 'approved', note: 'checked' });
        const out = await t.ctx.posts.publish(owner, post, {});
        assert.ok(out.changed);
        assert.strictEqual((await t.ctx.posts.get(post.id)).state, 'published');
        const feed = await t.ctx.changelog.entries({ limit: 50 });
        assert.ok(feed.some((e) => e.post_id === post.id), 'a published post links its commits');
        const page = await t.get(`/@openvibe/${post.slug}`);
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('<details class="ov-details">'), 'the full list is a real collapsible block');
        assert.ok(!page.text.includes('&lt;details&gt;'), 'the block is not escaped text');
    });

    await check('the editor shows the story map and the checks', async () => {
        const page = await t.get(`/write/posts/${draft.post.id}`, { as: t.official });
        assert.strictEqual(page.status, 200, page.text.slice(0, 200));
        assert.ok(page.text.includes('Patch notes review'));
        assert.ok(page.text.includes('Story map'));
        assert.ok(page.text.includes('Checklist'));
    });

    await t.close();
    done();
})();
