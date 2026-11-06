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
const shotsMod = require('./shots');
const { compose, briefFor, mergeAi } = require('./draft');
const review = require('./review');
const { createVoiceCards } = require('./voice');

const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const asJson = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : v);

function createPatchNotes({ config, store, blogs, posts, publication, aiDrafts = null, voiceCards = null, changelog = null, media = null, fetchImpl = globalThis.fetch, log = console }) {
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
        waiting: db.prepare(`SELECT d.post_id FROM blog_patch_note_drafts d JOIN blog_posts p ON p.id = d.post_id
            WHERE d.blog_id = ? AND p.state = 'draft' ORDER BY d.created_at DESC`),
        reviewed: db.prepare('SELECT 1 AS x FROM blog_post_reviews WHERE entity_id = ? LIMIT 1'),
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

    /**
     * The screenshot pass (plan L9, devblog §3.3): for every story, the shots Host captured of the pages
     * that story names — the newest one taken before the release and the first one taken after it. When the
     * two differ by more than 0.5 % of the pixels, both are attached (before, after); when they do not, only
     * the one after is attached; when there is no shot, the draft keeps its "No screenshot" line.
     *
     * Nothing is published here: the shots go on the draft, and a person still reviews it.
     */
    async function attachShots(viewer, post, { entries = [], stories = [] } = {}) {
        if (!media || typeof media.listShots !== 'function') return { attached: [], reason: 'the shot index is not configured' };
        let shots = [];
        try { shots = await media.listShots(); } catch (err) {
            log.warn && log.warn(`[patch-notes] the shots were not read: ${err.message}`);
            return { attached: [], reason: 'the shots could not be read' };
        }
        if (!shots.length) return { attached: [], reason: 'no shot yet' };
        const groups = new Map();
        for (const s of shots) {
            const key = shotsMod.groupKey(s);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(s);
        }
        const attached = [];
        for (const story of stories || []) {
            const at = (story.entries || []).map((e) => Date.parse(e.deployed_at || 0)).filter(Boolean).sort((a, b) => b - a)[0] || null;
            let best = null;
            for (const [key, list] of groups) {
                const service = String(key).split('|')[0];
                if (!story.sites || !story.sites.includes(service)) continue;
                const pair = shotsMod.pickPair(list, at);
                if (!pair.after) continue;
                let ratio = 1;
                if (pair.before) {
                    try {
                        const [a, b] = await Promise.all([media.download(pair.before.id), media.download(pair.after.id)]);
                        ratio = shotsMod.diffRatio(a, b);
                    } catch (err) {
                        log.warn && log.warn(`[patch-notes] the shots of ${key} were not compared: ${err.message}`);
                        continue;
                    }
                }
                const mode = shotsMod.decide(pair.before, pair.after, ratio);
                if (!best || ratio > best.ratio) best = { key, ...pair, ratio, mode };
            }
            if (!best || best.mode === 'none') continue;
            const meta = (best.after.metadata || {});
            const date = String(meta.captured_at || new Date().toISOString()).slice(0, 10);
            const whatChanged = (story.title || 'the page changed');
            const whatWasWrong = 'the page looked different before this release';
            const caption = shotsMod.captionFor({ before: best.before, after: best.after, viewport: meta.viewport, date, whatWasWrong, whatChanged });
            const alt = shotsMod.altFor({ mode: best.mode, whatWasWrong, whatChanged });
            if (best.mode === 'both' && best.before) {
                attached.push(await posts.attach(viewer, post, { mediaId: best.before.id, role: 'inline', alt, caption, position: 0 }));
                attached.push(await posts.attach(viewer, post, { mediaId: best.after.id, role: 'inline', alt, caption, position: 1 }));
            } else {
                attached.push(await posts.attach(viewer, post, { mediaId: best.after.id, role: 'inline', alt, caption, position: 0 }));
            }
        }
        return { attached };
    }

    // ── One waiting draft per day (11-02) ──────────────────────────────────────────────────────────────────
    // A person reviews every Patch notes post (devblog §3.6). Filed every few hours, the drafts piled up faster than
    // anyone could read them (27 waiting on 11-02, none published since v2). So a day has one waiting draft: a batch
    // whose day already has one nobody has touched is folded into it. The fold writes a fresh draft from all of the
    // day's commits and soft-deletes the old one (posts.remove); rewriting the old one in place would record the
    // pipeline's second pass as a person's edit. A draft someone edited or reviewed is never folded.
    const dayOf = (list) => {
        const t = (list || []).reduce((m, e) => Math.max(m, Date.parse(e.deployed_at) || Number(e.deployed_at) || 0), 0);
        return t ? new Date(t).toISOString().slice(0, 10) : null;
    };
    const pipelineAuthor = (rev) => /^svc:patch-notes( |$)/.test(String((rev && rev.author) || ''));

    /** The waiting drafts nobody has touched (one revision, the pipeline's; no review), newest first, with their day. */
    async function waitingDrafts(blog) {
        if (!changelog || !changelog.entriesOf) return [];
        const out = [];
        for (const r of await q.waiting.all(blog.id)) {
            const post = await posts.get(r.post_id);
            if (!post || post.state !== 'draft') continue;
            const head = await posts.head(post);
            if (!head || head.number !== 1 || !pipelineAuthor(head)) continue;
            if (await q.reviewed.get(post.id)) continue;
            const owned = await changelog.entriesOf(post.id);
            if (!owned.length) continue;
            out.push({ post, entries: owned, day: dayOf(owned) });
        }
        return out;
    }

    /** A fresh draft from the drafts' commits and any new ones; the drafts it replaces are soft-deleted. */
    async function fold(drafts, extra = [], opts = {}) {
        const seen = new Set();
        const all = [...drafts.flatMap((d) => d.entries), ...extra].filter((e) => (e.id == null || !seen.has(e.id)) && (e.id == null || seen.add(e.id)))
            .sort((a, b) => (Date.parse(a.deployed_at) || 0) - (Date.parse(b.deployed_at) || 0) || Number(a.id || 0) - Number(b.id || 0));
        const out = await draftPending({ ...opts, entries: all, reason: opts.reason || 'folded', noFold: true });
        if (!out || !out.created) return out;
        const owner = ownerSubject();
        for (const d of drafts) {
            await changelog.moveEntries(d.post.id, out.post.id);
            await posts.remove({ kind: 'service', service: 'svc:patch-notes', origin: 'patch-notes', subject: owner }, d.post);
        }
        log.log && log.log(`[patch-notes] folded ${drafts.length} waiting draft(s) of ${dayOf(all)} into ${out.post.id} (${all.length} commits)`);
        return { ...out, folded: drafts.map((d) => d.post.id) };
    }

    /** The backlog: every day with more than one untouched waiting draft becomes one. Returns the days folded. */
    async function compact() {
        const blog = await blogs.byHandle(config.changelog.blogHandle);
        if (!blog) return [];
        const byDay = new Map();
        for (const d of await waitingDrafts(blog)) {
            if (!byDay.has(d.day)) byDay.set(d.day, []);
            byDay.get(d.day).push(d);
        }
        const done = [];
        for (const [day, list] of byDay) {
            if (list.length < 2) continue;
            const out = await fold(list);
            if (out && out.created) done.push(day);
        }
        return done;
    }

    /** Write the draft (never publish). Returns { created, post, url, checks, doc }. */
    async function draftPending({ entries = null, pullRequests = null, reason = 'manual', account = 'official', useAi = true, traceparent = null, noFold = false } = {}) {
        const blog = await blogs.byHandle(config.changelog.blogHandle) || await blogs.ensureOfficial();
        let list = entries;
        if (!list) list = changelog ? await changelog.pendingEntries() : [];
        if (!noFold && list.length) {
            const same = (await waitingDrafts(blog)).filter((d) => d.day === dayOf(list));
            if (same.length) return await fold(same, list, { pullRequests, reason, account, useAi, traceparent });
        }
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
        const shotResult = await attachShots(viewer, post, { entries: list, stories: p.map.stories });
        if (changelog && changelog.markEntries) await changelog.markEntries(list, post.id);
        log.log && log.log(`[patch-notes] drafted ${post.id} from ${list.length} commits${p.usedAi ? ' (AI prose)' : ''}`);
        return { created: true, post, revision, url: publication.postUrl(blog, post), doc: p.doc, checks: p.checks, usedAi: p.usedAi, stories: p.map.stories, shots: shotResult };
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

    const api = { plan, draftPending, compact, waitingDrafts, check, gate, load, setOverride, storyMap, isPatchNotes, attach, voice, ownerSubject, samplesOf };
    return api;
}

module.exports = { createPatchNotes };
