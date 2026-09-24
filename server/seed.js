'use strict';

/**
 * The seed: the official blog's first post, "Released in the OpenVibe repositories", built ONLY
 * from verbatim quotes of commit messages and release notes (seed/week-*.json, collected from the
 * repositories' main branches with the commit, file and date of each quote). Every quote is
 * attached as a citation (URL, retrieval time, the quoted text) to the revision that uses it.
 *
 * It is created as a DRAFT. Nothing marks it reviewed unless a person is named: with
 * { reviewer: 'usr_…', publish: true } that person's approving review is recorded and the post is
 * published. The seed never invents a reviewer, a date or a feature.
 *
 * Authorship: 'imported' — the text is quoted from the repositories (original author OpenVibers);
 * the connecting sentences only say where each quote comes from.
 */
const fs = require('fs');
const path = require('path');
const { ids } = require('openvibe-contracts');

const SLUG = 'released-in-the-openvibe-repositories-16-22-september-2026';

function loadFacts(file = path.join(__dirname, '..', 'seed', 'week-2026-09-16.json')) {
    const facts = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!facts || !Array.isArray(facts.items) || !facts.items.length) throw new Error(`${file}: no items`);
    for (const it of facts.items) {
        for (const k of ['repo', 'quote', 'kind', 'ref', 'url']) if (!it[k]) throw new Error(`${file}: an item has no ${k}`);
        if (!/^https:\/\/github\.com\/OpenVibers\//.test(it.url)) throw new Error(`${file}: ${it.url} is not an OpenVibers GitHub URL`);
    }
    return facts;
}

const kindLabel = (it) => (it.kind === 'tag' ? `tag ${it.tag}, commit ${it.ref.slice(0, 7)}` : it.kind === 'commit' ? `commit ${it.ref.slice(0, 7)}` : it.kind === 'changelog' ? `CHANGELOG, ${it.ref.split('#')[1] || it.ref}` : it.kind);

function composeBody(facts) {
    const lines = [
        `This post quotes the commit messages and release notes that reached the main branch of the OpenVibers repositories between ${facts.week.from} and ${facts.week.to}. Each quote is copied as written and links to its source. A change listed here was released in its repository; this post does not say that it is running on an OpenVibe site.`,
        '',
    ];
    let current = null;
    for (const it of facts.items) {
        if (it.repo !== current) { lines.push(`# ${it.repo}`, ''); current = it.repo; }
        lines.push(`> ${it.quote}`, '', `Source: [${it.repo}, ${kindLabel(it)}](${it.url})`, '');
    }
    return lines.join('\n').trim() + '\n';
}

/**
 * Create the draft (idempotent by slug). opts: author (usr_ subject accountable for the post;
 * default the first official owner), reviewer (usr_), publish (bool), facts (parsed file).
 */
function seedOfficialPost(ctx, { author, reviewer = null, publish = false, facts = loadFacts() } = {}) {
    const { blogs, posts, store } = ctx;
    const blog = blogs.ensureOfficial();
    const owners = blogs.members(blog).filter((m) => m.role === 'owner').map((m) => m.subject);
    const subject = author || owners[0];
    if (!ids.isSubjectId('user', subject)) throw new Error('The seed needs an accountable author: set BLOG_OFFICIAL_OWNERS or pass --author usr_…');
    if (publish && !ids.isSubjectId('user', reviewer)) throw new Error('Publishing the seed needs the person who reviewed it: --reviewer usr_…');
    const actor = { kind: 'user', subject, staff: true, editorial: true, user: {} };

    let post = posts.bySlug(blog, SLUG);
    let created = false;
    if (!post) {
        const out = posts.create(actor, blog, {
            title: `Released in the OpenVibe repositories, ${facts.week.from.slice(8)}–${facts.week.to.slice(8)} September 2026`,
            slug: SLUG,
            summary: `Commit messages and release notes quoted from the OpenVibers repositories for ${facts.week.from} to ${facts.week.to}, each with a link to its source.`,
            body: composeBody(facts),
            tags: ['release notes', 'openvibe'],
            categories: ['Release notes'],
            authorship: { mode: 'imported', importedFrom: { label: 'commit messages and release notes in the OpenVibers repositories (quoted verbatim)', originalAuthor: 'OpenVibers' } },
            citations: facts.items.map((it) => ({ url: it.url, title: `${it.repo}: ${kindLabel(it)}`, retrievedAt: facts.collected_at, quote: { text: it.quote } })),
            message: `Seed: ${facts.items.length} verbatim quotes collected ${facts.collected_at}`,
        });
        post = out.post;
        created = true;
    }
    let review = null;
    let published = false;
    if (publish) {
        const head = store.revisions.head(post.id);
        review = posts.review({ kind: 'user', subject: reviewer, staff: true, editorial: true, user: {} }, post, { revision: head.number, decision: 'approved', note: 'Seed post reviewed: every quote checked against its source.' });
        published = posts.publish(actor, posts.get(post.id), { revision: head.number }).changed;
    }
    return { post: posts.get(post.id), created, review, published };
}

module.exports = { seedOfficialPost, loadFacts, composeBody, SLUG };
