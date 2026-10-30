'use strict';
/**
 * Patch notes v2 (devblog §3). One module owns the pipeline:
 *
 *   collect (server/changelog.js) → enrich (commit body, files, PR) → cluster and rank (stories.js)
 *   → draft (draft.js: the template, with OpenVibe.AI's story prose when it is configured)
 *   → check (review.js: slop, looks, links, alt, review) → a DRAFT for a person; never a publish.
 *
 * The draft is a post in the "Patch notes" series, authored as AI-generated (workflow blog.draft_post) when the
 * AI wrote the prose, else imported from the repositories; in both cases it stays a draft and noindex, and a
 * blocking check or a missing person's approval stops posts.publish.
 */
const { build } = require('./stories');
const { compose, briefFor, mergeAi } = require('./draft');
const review = require('./review');
const { createVoiceCards } = require('./voice');

const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const asJson = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : v);

function createPatchNotes({ config, store, blogs, posts, publication, aiDrafts = null, voiceCards = null, changelog = null, fetchImpl = globalThis.fetch, log = console }) {
    const db = store.db;
    const voice = voiceCards || createVoiceCards({ store });
    const maxStories = Math.max(2, Math.min(8, (config.patchNotes && config.patchNotes.maxStories) || 6));
    const sampleCount = Math.max(0, Math.min(4, (config.patchNotes && config.patchNotes.samples) || 2));
    const q = {
        get: db.prepare('SELECT * FROM blog_patch_note_drafts WHERE post_id = ?'),
        put: db.prepare(`INSERT INTO blog_patch_note_drafts (post_id, blog_id, stories, entries, checks, voice_card, override, created_at, updated_at)
            VALUES (@post_id, @blog_id, @stories, @entries, @checks, @voice_card, @override, @now, @now)
            ON CONFLICT (post_id) DO UPDATE SET stories = excluded.stories, entries = excluded.entries, checks = excluded.checks,
                voice_card = excluded.voice_card, override = COALESCE(excluded.override, blog_patch_note_drafts.override), updated_at = excluded.updated_at`),
        checks: db.prepare('UPDATE blog_patch_note_drafts SET checks = ?, updated_at = ? WHERE post_id = ?'),
        override: db.prepare('UPDATE blog_patch_note_drafts SET override = ?, updated_at = ? WHERE post_id = ?'),
    };
    const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

    function attach({ changelog: cl }) { changelog = cl; return api; }

    const ownerSubject = () => (config.official.owners || []).find((s) => /^usr_/.test(s)) || null;

    /** The two newest published posts of the blog, cut to a source's size: the voice samples in the prompt. */
    async function samplesOf(blog) {
        if (!sampleCount || !posts.listPublished) return [];
        const { posts: rows } = await posts.listPublished({ blogId: blog.id, limit: sampleCount, order: 'recent' });
        const out = [];
        for (const p of rows) {
            const rev = p.published_revision ? await posts.revision(p, p.published_revision) : null;
            if (!rev) continue;
            out.push({ title: rev.fields.title, dek: rev.fields.summary || '', body: String(rev.content || '').slice(0, 3000), url: publication.postUrl(blog, p) });
        }
        return out;
    }

    const entryView = (e) => ({ service: e.service, repo: e.repo, sha: e.sha, subject: e.subject, url: e.url || `https://github.com/${e.repo}/commit/${e.sha}`, deployed_at: e.deployed_at });

    /** The prompt's numbered sources: the commits (with their bodies) and the voice samples. */
    function sourcesFor(entries, samples) {
        const out = [];
        for (const e of entries) {
            out.push({
                source_type: 'git.commit', source_id: String(e.sha || ''), url: String(e.url || `https://github.com/${e.repo}/commit/${e.sha}`).slice(0, 2048),
                title: clean(e.subject, 500), author: clean(e.author, 200) || undefined,
                published_at: e.committed_at || e.deployed_at || undefined,
                content: String(e.body || e.message_body || e.subject || '').slice(0, 20000),
            });
        }
        for (const s of samples) {
            out.push({ source_type: 'blog.post.sample', url: String(s.url || '').slice(0, 2048), title: clean(s.title, 500), snippet: String(s.body || '').slice(0, 4000) });
        }
        return out.filter((s) => s.source_type !== 'blog.post.sample' || s.url);
    }

    /**
     * The whole draft without writing it: { doc, map, checks, card, samples, usedAi }.
     * `useAi: false` always gives the deterministic post (the CLI's --no-ai, and tests).
     */
    async function plan({ entries, blog, pullRequests = null, account = 'official', useAi = true, traceparent = null }) {
        const owner = ownerSubject();
        if (!owner) throw Object.assign(new Error('BLOG_OFFICIAL_OWNERS names no usr_ owner to file the draft as'), { code: 'patch_notes.author_required' });
        const list = (entries || []).map((e) => ({ ...e }));
        if (!list.length) return null;
        const map = build(list, { maxStories });
        const card = await voice.get(account);
        const samples = await samplesOf(blog);
        const pulls = pullRequests || (changelog && changelog.openPulls ? await changelog.openPulls().catch(() => []) : []);
        const det = compose({ map, voice: card, pulls });
        let usedAi = false;
        let ai = null;
        if (useAi && aiDrafts && aiDrafts.enabled && aiDrafts.rawDraft) {
            try {
                ai = await aiDrafts.rawDraft({ kind: 'user', subject: owner, staff: false }, blog, {
                    topic: det.title, brief: briefFor({ map, voice: card, blog }), tone: 'specific, dry, plain, first person plural',
                    audience: 'OpenVibe members and contributors, many on a phone', sources: sourcesFor(list, samples),
                }, { traceparent });
                if (ai && ai.output && String(ai.output.body_markdown || '').trim()) {
                    det.body = mergeAi(ai.output.body_markdown, det, card);
                    det.title = clean(ai.output.title, 200) || det.title;
                    det.dek = clean(ai.output.dek, 400) || det.dek;
                    if (Array.isArray(ai.output.tags)) det.tags = ['patch-notes', ...ai.output.tags.map((t) => clean(t, 50)).filter(Boolean)].slice(0, 8);
                    usedAi = true;
                }
            } catch (err) {
                log.warn && log.warn(`[patch-notes] AI prose not used: ${err.message}`);
            }
        }
        const authorship = usedAi
            ? { mode: 'ai', workflow: ai.workflow, stubProvider: Boolean(ai.synthetic), source: { label: 'Commit messages from the OpenVibers repositories on GitHub' } }
            : { mode: 'imported', importedFrom: { label: 'Commit messages from the OpenVibers repositories on GitHub', originalAuthor: 'OpenVibers' } };
        const checks = await review.evaluate({
            title: det.title, dek: det.dek, body: det.body, tags: det.tags, attachments: [], entries: list,
            storyMap: map.stories.map((s) => ({ key: s.key, title: s.title, kind: s.kind, sites: s.sites, commits: s.entries.length })),
            review: null, authorship, override: null,
        });
        return { doc: det, map, card, samples, usedAi, ai, authorship, checks, owner, entries: list };
    }

    /** Write the draft (never publish). Returns { created, post, url, checks, doc }. */
    async function draftPending({ entries = null, pullRequests = null, reason = 'manual', account = 'official', useAi = true, traceparent = null } = {}) {
        const blog = await blogs.byHandle(config.changelog.blogHandle) || await blogs.ensureOfficial();
        let list = entries;
        if (!list) list = changelog ? await changelog.pendingEntries() : [];
        if (changelog && changelog.enrich && list.length && list.some((e) => e.id != null)) {
            try { list = await changelog.enrich(list); } catch (err) { log.warn && log.warn(`[patch-notes] enrichment skipped: ${err.message}`); }
        }
        if (!list.length) return { created: false, reason: 'nothing pending' };
        const p = await plan({ entries: list, blog, pullRequests, account, useAi, traceparent });
        if (!p) return { created: false, reason: 'nothing pending' };
        const viewer = p.usedAi
            ? { kind: 'service', service: 'svc:patch-notes', origin: 'ai', subject: p.owner }
            : { kind: 'service', service: 'svc:patch-notes', origin: 'patch-notes', subject: p.owner };
        const citations = p.usedAi && p.ai ? (p.ai.citations || []).filter((c) => c && (c.url || c.title)).map((c) => ({
            url: c.url || null, title: c.title || null, retrievedAt: c.retrieved_at || null, quote: c.snippet ? { text: String(c.snippet).slice(0, 1000) } : null,
        })) : undefined;
        const { post, revision } = await posts.create(viewer, blog, {
            title: p.doc.title, summary: p.doc.dek, body: p.doc.body, tags: p.doc.tags, series: 'Patch notes',
            authorship: p.authorship, citations, message: `Patch notes draft from ${list.length} commits (${reason})`,
        }, { traceparent });
        await q.put.run({
            post_id: post.id, blog_id: blog.id, stories: asJson(p.map.stories.map((s) => ({ key: s.key, title: s.title, kind: s.kind, sites: s.sites, commits: s.entries.map((e) => e.sha) }))),
            entries: asJson(list.map(entryView)), checks: asJson(p.checks), voice_card: asJson(p.card.card), override: null, now: store.now(),
        });
        if (changelog && changelog.markEntries) await changelog.markEntries(list, post.id);
        log.log && log.log(`[patch-notes] drafted ${post.id} from ${list.length} commits${p.usedAi ? ' (AI prose)' : ''}`);
        return { created: true, post, revision, url: publication.postUrl(blog, post), doc: p.doc, checks: p.checks, usedAi: p.usedAi, stories: p.map.stories };
    }

    async function load(postId) {
        const row = await q.get.get(String(postId));
        if (!row) return null;
        return { ...row, stories: parse(row.stories) || [], entries: parse(row.entries) || [], checks: parse(row.checks), voice_card: parse(row.voice_card), override: parse(row.override) };
    }

    /** Run the checks on the head revision and store them for the reviewer. */
    async function check(postId, { verifyLinks = null } = {}) {
        const row = await load(postId);
        if (!row) return null;
        const post = await posts.get(postId);
        if (!post) return null;
        const rev = await posts.head(post);
        const rec = rev ? publication.authorshipOf(rev) : null;
        const revReview = await publication.reviewOf(post, rev);
        const attachments = await posts.attachments(post);
        const result = await review.evaluate({
            title: rev.fields.title, dek: rev.fields.summary || '', body: rev.content, tags: (await publication.termsOf(post)).tags || [],
            captions: attachments.map((a) => a.caption).filter(Boolean), attachments,
            entries: row.entries, storyMap: row.stories, review: revReview, authorship: rec, override: row.override, verifyLinks,
        });
        await q.checks.run(asJson(result), store.now(), postId);
        return { row, post, rev, result, review: revReview };
    }

    /** The publish gate for posts.applyPublish: null for anything that is not a Patch notes draft. */
    async function gate(post, rev) {
        const row = await load(post.id);
        if (!row) return null;
        const rec = rev ? publication.authorshipOf(rev) : null;
        const revReview = await publication.reviewOf(post, rev);
        const attachments = await posts.attachments(post);
        const result = await review.evaluate({
            title: rev.fields.title, dek: rev.fields.summary || '', body: rev.content, tags: (await publication.termsOf(post)).tags || [],
            captions: attachments.map((a) => a.caption).filter(Boolean), attachments,
            entries: row.entries, storyMap: row.stories, review: revReview, authorship: rec, override: row.override,
        });
        await q.checks.run(asJson(result), store.now(), post.id);
        return result;
    }

    async function setOverride(postId, { reason, phrases = [], by = null } = {}) {
        const row = await load(postId);
        if (!row) return null;
        const text = clean(reason, 500);
        if (!text) throw Object.assign(new Error('An override needs a reason the reviewer can read'), { status: 422, code: 'patch_notes.override_reason' });
        const override = { reason: text, phrases: phrases.map((p) => String(p).toLowerCase()).slice(0, 20), by, at: store.now() };
        await q.override.run(asJson(override), store.now(), postId);
        return override;
    }

    async function storyMap(postId) { const row = await load(postId); return row ? row.stories : []; }
    async function isPatchNotes(postId) { return Boolean(await q.get.get(String(postId))); }

    const api = { plan, draftPending, check, gate, load, setOverride, storyMap, isPatchNotes, attach, voice, ownerSubject, samplesOf };
    return api;
}

module.exports = { createPatchNotes };
