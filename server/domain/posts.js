'use strict';

/**
 * Posts: drafts, immutable revisions, publication, scheduling, unpublish, delete, slug changes,
 * taxonomy, series, citations, media attachments, and the human review AI drafts need.
 *
 * Every state change runs in one SQLite transaction together with its events (SDK outbox) and its
 * Search document (index-hooks), so the event exists if and only if the change committed.
 *
 * Content lives in blog_post_revisions (openvibe-publishing/revisions): content = Markdown body,
 * fields = { title, summary }, meta = { authorship } (openvibe-publishing/authorship record).
 * blog_posts.published_revision says which revision readers see; editing a published post adds a
 * revision without changing what readers see until that revision is published.
 *
 * Scheduled publication (openvibe-publishing/schedule) applies the idempotent effect "revision N is
 * the published one": a worker that dies after applying it and before recording the job as done
 * re-runs it after the lease expires, and the second run changes nothing and emits nothing.
 */
const { ids } = require('openvibe-contracts');
const { slugify } = require('openvibe-publishing/taxonomy');
const authorship = require('openvibe-publishing/authorship');
const { isMediaId } = require('openvibe-publishing/media');
const { ApiError } = require('../http/errors');
const { actorRef } = require('./publication');

const VISIBILITIES = ['public', 'unlisted', 'members', 'private'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const KEY_RE = /^[a-z][a-z0-9_.:-]{0,127}$/;
const MAX_BODY = 200000;
const MAX_TAGS = 20;
const MEDIA_ROLES = ['cover', 'inline', 'gallery'];

const newPostId = (now) => `pst_${ids.ulid(now)}`;

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'on' || v === 'true';

function listOf(v) {
    if (v == null || v === '') return [];
    const arr = Array.isArray(v) ? v : String(v).split(',');
    return arr.map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function createPosts({ store, blogs, publication, access, outbox, log = console }) {
    const { db } = store;
    const q = {
        byId: db.prepare('SELECT * FROM blog_posts WHERE id = ?'),
        bySlug: db.prepare("SELECT * FROM blog_posts WHERE blog_id = ? AND slug = ? AND state <> 'deleted'"),
        deletedBySlug: db.prepare("SELECT * FROM blog_posts WHERE blog_id = ? AND slug = ? AND state = 'deleted' ORDER BY deleted_at DESC LIMIT 1"),
        slugTaken: db.prepare("SELECT id FROM blog_posts WHERE blog_id = ? AND slug = ? AND state <> 'deleted'"),
        insert: db.prepare(`INSERT INTO blog_posts (id, blog_id, slug, state, visibility, entitlement_key, author_subject, series_id, series_position,
                            allow_comments, noindex, created_at, updated_at)
                            VALUES (@id, @blog_id, @slug, 'draft', @visibility, @entitlement_key, @author_subject, @series_id, @series_position,
                            @allow_comments, @noindex, @now, @now)`),
    };
    const blogOf = (post) => blogs.get(post.blog_id);

    // ── Input normalisation ─────────────────────────────────

    function title(v) {
        const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
        if (!t) throw new ApiError(422, 'post.invalid_title', 'A post needs a title');
        if (t.length > 200) throw new ApiError(422, 'post.invalid_title', 'A title is at most 200 characters');
        return t;
    }
    function body(v) {
        const b = String(v == null ? '' : v).replace(/\r\n/g, '\n');
        if (b.length > MAX_BODY) throw new ApiError(413, 'post.too_long', `A post is at most ${MAX_BODY} characters`);
        return b;
    }
    function summary(v) {
        if (v == null) return null;
        const s = String(v).replace(/\s+/g, ' ').trim().slice(0, 500);
        return s || null;
    }
    function visibilityOf(blog, v, key) {
        const vis = v == null || v === '' ? 'public' : String(v);
        if (!VISIBILITIES.includes(vis)) throw new ApiError(422, 'post.invalid_visibility', `visibility must be one of ${VISIBILITIES.join(', ')}`);
        if (vis !== 'members') return { visibility: vis, entitlement_key: null };
        const k = String(key || `vip:${blog.handle}`).trim().toLowerCase();   // informational: VIP decides (domain/access.js)
        if (!KEY_RE.test(k)) throw new ApiError(422, 'post.invalid_entitlement', 'entitlement key must match ^[a-z][a-z0-9_.:-]{0,127}$');
        return { visibility: vis, entitlement_key: k };
    }
    function slugFor(blog, wanted, postId = null) {
        let base;
        try { base = slugify(wanted); } catch { throw new ApiError(422, 'post.invalid_slug', 'That title or slug has no letters or digits to make a URL from'); }
        if (!SLUG_RE.test(base)) throw new ApiError(422, 'post.invalid_slug', 'slug must be lowercase letters, digits and dashes');
        for (let i = 1; i < 1000; i++) {
            const s = i === 1 ? base : `${base.slice(0, 75)}-${i}`;
            const hit = q.slugTaken.get(blog.id, s);
            if (!hit || hit.id === postId) return s;
        }
        throw new ApiError(409, 'post.slug_taken', 'No free slug for that title');
    }

    /** The acting person (usr_) or refuse. */
    function actingSubject(viewer) {
        if (!viewer || !viewer.subject) throw new ApiError(403, 'subject.required', 'This needs a signed-in member (or a service acting for one with X-OV-Subject)');
        return viewer.subject;
    }

    /** The authorship record of a new revision, from who is writing and what came before. */
    function authorshipFor(viewer, input, previous) {
        const subject = viewer.subject;
        const a = input.authorship || {};
        if (viewer.kind === 'service' && viewer.origin === 'ai') {
            // OpenVibe.AI output (blog.draft_post): AI-generated, draft + noindex until a person reviews it.
            return authorship.record({ mode: 'ai', workflow: a.workflow, stubProvider: Boolean(a.stubProvider || a.stub_provider), source: a.source || null });
        }
        if (a.mode === 'hybrid' || (previous && (previous.mode === 'ai' || previous.mode === 'hybrid'))) {
            const workflow = a.workflow || (previous && previous.workflow);
            return authorship.record({ mode: 'hybrid', authors: [subject], workflow });
        }
        if (a.mode === 'imported') {
            return authorship.record({ mode: 'imported', authors: [], importedFrom: a.importedFrom || a.imported_from });
        }
        return authorship.record({ mode: 'human', authors: [subject] });
    }

    function authorLabel(viewer) {
        if (viewer.kind === 'service') return viewer.origin === 'ai' ? `${viewer.service} (ai)` : `${viewer.service} for ${viewer.subject}`;
        return viewer.subject;
    }

    function setTerms(blog, post, input) {
        if (input.tags !== undefined) {
            const tags = listOf(input.tags);
            if (tags.length > MAX_TAGS) throw new ApiError(422, 'post.too_many_tags', `At most ${MAX_TAGS} tags`);
            for (const t of tags) if (t.length > 50) throw new ApiError(422, 'post.invalid_tag', 'A tag is at most 50 characters');
            store.taxonomy.setTerms(post.id, 'tag', tags);
        }
        if (input.categories !== undefined) {
            const vocab = blogs.categoryVocabulary(blog);
            const termIds = [];
            // "Parent > Child" makes a nested category (breadcrumbs, parent pages include children).
            for (const pathText of listOf(input.categories).slice(0, 10)) {
                let parentId = null;
                for (const name of pathText.split('>').map((s) => s.trim()).filter(Boolean).slice(0, 4)) {
                    const term = store.taxonomy.ensureTerm({ vocabulary: vocab, name: name.slice(0, 80), parentId });
                    parentId = term.id;
                }
                if (parentId != null) termIds.push(parentId);
            }
            store.taxonomy.setTerms(post.id, vocab, termIds);
        }
    }

    function seriesOf(blog, input, current) {
        if (input.series === undefined && input.seriesId === undefined && input.series_id === undefined) return current;
        const v = input.seriesId ?? input.series_id ?? input.series;
        if (v == null || v === '') return { series_id: null, series_position: null };
        let series = typeof v === 'string' && v.startsWith('ser_') ? blogs.seriesById(v) : blogs.ensureSeries(blog, typeof v === 'object' ? v.title : v);
        if (!series || series.blog_id !== blog.id) throw new ApiError(422, 'post.invalid_series', 'That series is not on this blog');
        const posRaw = input.seriesPosition ?? input.series_position;
        const pos = posRaw == null || posRaw === '' ? null : parseInt(posRaw, 10);
        if (pos != null && (!Number.isInteger(pos) || pos < 1 || pos > 10000)) throw new ApiError(422, 'post.invalid_series_position', 'series position is a whole number from 1');
        return { series_id: series.id, series_position: pos };
    }

    function attachCitations(post, revision, list) {
        if (!Array.isArray(list) || !list.length) return;
        store.citations.attachMany(post.id, revision, list.slice(0, 100).map((c) => ({
            url: c.url || null, sourceItemId: c.sourceItemId || c.source_item_id || null, title: c.title || null,
            retrievedAt: c.retrievedAt || c.retrieved_at || null,
            quote: c.quote ? (typeof c.quote === 'string' ? { text: c.quote } : c.quote) : null,
            licenseNote: c.licenseNote || c.license_note || null,
        })));
    }

    // ── Reads ───────────────────────────────────────────────

    const api = {
        VISIBILITIES, MEDIA_ROLES,

        get: (id) => q.byId.get(String(id || '')) || null,
        bySlug: (blog, slug) => q.bySlug.get(blog.id, String(slug || '')) || null,
        deletedBySlug: (blog, slug) => q.deletedBySlug.get(blog.id, String(slug || '')) || null,
        blogOf,

        /** Must exist and not be deleted, else 404. */
        mustGet(id) {
            const p = api.get(id);
            if (!p || p.state === 'deleted') throw new ApiError(404, 'post.not_found', 'No such post');
            return p;
        },

        /**
         * Published posts for listings. `restricted` = also members/private posts (the viewer is a
         * member of the blog or staff). Unlisted posts are never listed.
         * filters: blogId, termIds (any), seriesId, authorSubject, restricted, limit, offset
         */
        listPublished({ blogId = null, termIds = null, seriesId = null, authorSubject = null, restricted = false, limit = 20, offset = 0, order = 'recent' } = {}) {
            const where = ["p.state = 'published'"];
            const args = [];
            if (restricted) where.push("p.visibility IN ('public','members','private')");
            else where.push("p.visibility = 'public'");
            if (blogId) { where.push('p.blog_id = ?'); args.push(blogId); }
            if (seriesId) { where.push('p.series_id = ?'); args.push(seriesId); }
            if (authorSubject) { where.push('p.author_subject = ?'); args.push(authorSubject); }
            if (termIds) {
                if (!termIds.length) return { total: 0, posts: [] };
                where.push(`p.id IN (SELECT entity_id FROM blog_term_links WHERE term_id IN (${termIds.map(() => '?').join(',')}))`);
                args.push(...termIds);
            }
            where.push("EXISTS (SELECT 1 FROM blogs b WHERE b.id = p.blog_id AND b.status = 'active')");
            const w = where.join(' AND ');
            const total = db.prepare(`SELECT COUNT(*) AS n FROM blog_posts p WHERE ${w}`).get(...args).n;
            const orderBy = order === 'series' ? 'COALESCE(p.series_position, 1e9), p.first_published_at, p.id' : 'p.published_at DESC, p.id DESC';
            const posts = db.prepare(`SELECT p.* FROM blog_posts p WHERE ${w} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...args, limit, offset);
            return { total, posts };
        },

        /** Every non-deleted post of a blog, for its members' dashboard (authors: their own). */
        listForDashboard(blog, viewer) {
            const role = access.effectiveRole(store, viewer, blog);
            if (!role && !access.isStaff(viewer)) return [];
            const own = role === 'author' ? ' AND author_subject = ?' : '';
            const args = role === 'author' ? [blog.id, viewer.subject] : [blog.id];
            return db.prepare(`SELECT * FROM blog_posts WHERE blog_id = ? AND state <> 'deleted'${own} ORDER BY updated_at DESC LIMIT 500`).all(...args);
        },

        head: (post) => store.revisions.head(post.id),
        revision: (post, n) => store.revisions.get(post.id, n),
        revisions: (post, opts) => store.revisions.list(post.id, opts),
        diff: (post, from, to, mode) => store.revisions.diff(post.id, from, to, { mode: mode === 'word' ? 'word' : 'line' }),
        pendingJobs: (post) => store.scheduler.jobs(post.id).filter((j) => j.status === 'pending' || j.status === 'running'),
        attachments: (post) => store.attachments.list(post.id),
        citations: (post, rev) => (rev ? store.citations.forRevision(post.id, rev) : []),

        // ── Writes ──────────────────────────────────────────

        /** A new draft (revision 1). Returns { post, revision }. */
        create(viewer, blog, input = {}, { traceparent } = {}) {
            const subject = actingSubject(viewer);
            if (!access.canWrite(store, viewer, blog, 'create')) throw new ApiError(403, 'blog.forbidden', 'You cannot write on this blog');
            const t = title(input.title);
            const content = body(input.body);
            const vis = visibilityOf(blog, input.visibility, input.entitlementKey ?? input.entitlement_key);
            const rec = authorshipFor(viewer, input, null);
            return store.tx(() => {
                const now = store.now();
                const id = newPostId(now);
                const slug = slugFor(blog, input.slug || t);
                store.redirects.release(publication.postPath(blog, { slug }));   // a live post owns its path
                const ser = seriesOf(blog, input, { series_id: null, series_position: null });
                q.insert.run({
                    id, blog_id: blog.id, slug, ...vis, author_subject: subject, ...ser,
                    allow_comments: input.allowComments === undefined && input.allow_comments === undefined ? 1 : (truthy(input.allowComments ?? input.allow_comments) ? 1 : 0),
                    noindex: truthy(input.noindex) ? 1 : 0, now,
                });
                const { revision } = store.revisions.create({
                    entityId: id, expectedRevision: 0, content, fields: { title: t, summary: summary(input.summary) },
                    meta: { authorship: rec }, author: authorLabel(viewer), message: input.message || 'First draft',
                });
                attachCitations({ id }, revision.number, input.citations);
                const post = q.byId.get(id);
                setTerms(blog, post, input);
                outbox.emit({
                    event_type: 'blog.post.created', actor: actorRef(viewer), visibility: 'internal', priority: 'low',
                    subject: { type: 'post', id, revision: revision.number },
                    payload: { blog: { id: blog.id, handle: blog.handle }, state: 'draft', visibility: post.visibility, authorship: rec.mode, ...(rec.workflow ? { workflow: rec.workflow } : {}) },
                }, { traceparent });
                return { post: q.byId.get(id), revision };
            });
        },

        /**
         * Edit: content (title/body/summary) becomes a new revision (expectedRevision required, 412
         * on conflict); slug, visibility, taxonomy, series and flags change the post row. A slug
         * change leaves a 301 from the old path.
         */
        update(viewer, post, input = {}, { traceparent } = {}) {
            actingSubject(viewer);
            const blog = blogOf(post);
            if (!access.canWrite(store, viewer, blog, 'edit', post)) throw new ApiError(403, 'post.forbidden', 'You cannot edit this post');
            if (post.state === 'deleted') throw new ApiError(404, 'post.not_found', 'No such post');
            return store.tx(() => {
                const before = publication.snapshot(blog, post);
                const head = store.revisions.head(post.id);
                let revision = head;
                let created = false;
                const contentChange = input.title !== undefined || input.body !== undefined || input.summary !== undefined;
                if (contentChange) {
                    const expected = input.expectedRevision ?? input.expected_revision;
                    if (expected == null || expected === '') throw new ApiError(428, 'revision.expected_required', 'Send expectedRevision (the revision you edited) so concurrent edits are not lost');
                    const fields = {
                        title: input.title !== undefined ? title(input.title) : head.fields.title,
                        summary: input.summary !== undefined ? summary(input.summary) : (head.fields.summary || null),
                    };
                    const rec = authorshipFor(viewer, input, publication.authorshipOf(head));
                    const out = store.revisions.create({
                        entityId: post.id, expectedRevision: parseInt(expected, 10), content: input.body !== undefined ? body(input.body) : head.content,
                        fields, meta: { authorship: rec }, author: authorLabel(viewer), message: input.message || null,
                    });
                    revision = out.revision;
                    created = out.created;
                    if (created) {
                        // An edit that does not send citations keeps the ones it had (the /write editor does not
                        // resend them); sending a list, even an empty one, replaces them.
                        if (input.citations !== undefined) attachCitations(post, revision.number, input.citations);
                        else store.citations.carryForward({ entityId: post.id, fromRevision: head.number, toRevision: revision.number, attachedBy: viewer.subject });
                    }
                }
                const sets = {};
                if (input.slug !== undefined && input.slug !== '' && input.slug !== post.slug) {
                    const slug = slugFor(blog, input.slug, post.id);
                    if (slug !== post.slug) {
                        store.redirects.recordMove(post.id, publication.postPath(blog, post), publication.postPath(blog, { ...post, slug }), { reason: 'slug_changed' });
                        sets.slug = slug;
                    }
                }
                if (input.visibility !== undefined || input.entitlementKey !== undefined || input.entitlement_key !== undefined) {
                    Object.assign(sets, visibilityOf(blog, input.visibility ?? post.visibility, input.entitlementKey ?? input.entitlement_key ?? post.entitlement_key));
                }
                Object.assign(sets, seriesOf(blog, input, { series_id: post.series_id, series_position: post.series_position }));
                if (input.allowComments !== undefined || input.allow_comments !== undefined) sets.allow_comments = truthy(input.allowComments ?? input.allow_comments) ? 1 : 0;
                if (input.noindex !== undefined) sets.noindex = truthy(input.noindex) ? 1 : 0;
                const keys = Object.keys(sets);
                db.prepare(`UPDATE blog_posts SET ${keys.map((k) => `${k} = @${k}`).concat('updated_at = @now').join(', ')} WHERE id = @id`)
                    .run({ ...sets, now: store.now(), id: post.id });
                setTerms(blog, post, input);
                const { post: after } = publication.afterChange(before, post.id, { actor: viewer, traceparent });
                return { post: after, revision, created };
            });
        },

        /** The idempotent effect: revision N is the published one. Returns { changed, post }. */
        applyPublish(postId, revisionNumber, actor, { traceparent } = {}) {
            return store.tx(() => {
                const post = q.byId.get(postId);
                if (!post || post.state === 'deleted') throw new ApiError(409, 'post.deleted', 'The post was deleted');
                const rev = revisionNumber ? store.revisions.get(post.id, revisionNumber) : store.revisions.head(post.id);
                if (!rev) throw new ApiError(404, 'revision.not_found', `No revision ${revisionNumber} of this post`);
                if (post.state === 'published' && post.published_revision === rev.number) return { changed: false, post };
                const ok = authorship.canPublish(publication.authorshipOf(rev) || { mode: 'human' }, publication.reviewOf(post, rev));
                if (!ok.ok) throw new ApiError(409, 'post.review_required', `Revision ${rev.number} is AI-generated and needs a person's review before it can be published (${ok.reason})`);
                const before = publication.snapshot(blogOf(post), post);
                const now = store.now();
                db.prepare(`UPDATE blog_posts SET state = 'published', published_revision = ?, first_published_at = COALESCE(first_published_at, ?),
                            published_at = ?, updated_at = ? WHERE id = ?`).run(rev.number, now, now, now, post.id);
                const out = publication.afterChange(before, post.id, { actor, traceparent });
                return { changed: true, post: out.post };
            });
        },

        applyUnpublish(postId, actor, { traceparent } = {}) {
            return store.tx(() => {
                const post = q.byId.get(postId);
                if (!post || post.state === 'deleted') throw new ApiError(409, 'post.deleted', 'The post was deleted');
                if (post.state !== 'published') return { changed: false, post };
                const before = publication.snapshot(blogOf(post), post);
                db.prepare("UPDATE blog_posts SET state = 'unpublished', updated_at = ? WHERE id = ?").run(store.now(), post.id);
                return { changed: true, post: publication.afterChange(before, post.id, { actor, traceparent }).post };
            });
        },

        publish(viewer, post, { revision } = {}, ctx = {}) {
            actingSubject(viewer);
            if (!access.canWrite(store, viewer, blogOf(post), 'publish', post)) throw new ApiError(403, 'post.forbidden', 'You cannot publish this post');
            const n = revision == null || revision === '' ? null : parseInt(revision, 10);
            return store.tx(() => {
                store.scheduler.cancelPending(post.id, 'publish');
                return api.applyPublish(post.id, n, viewer, ctx);
            });
        },

        unpublish(viewer, post, ctx = {}) {
            actingSubject(viewer);
            if (!access.canWrite(store, viewer, blogOf(post), 'unpublish', post)) throw new ApiError(403, 'post.forbidden', 'You cannot unpublish this post');
            return store.tx(() => {
                store.scheduler.cancelPending(post.id);
                const cur = q.byId.get(post.id);
                if (cur.state === 'scheduled') {
                    db.prepare("UPDATE blog_posts SET state = 'draft', updated_at = ? WHERE id = ?").run(store.now(), post.id);
                    return { changed: true, post: q.byId.get(post.id) };
                }
                return api.applyUnpublish(post.id, viewer, ctx);
            });
        },

        /**
         * Schedule a publish (of revision N, default the head) or an unpublish at a future time.
         * Idempotent: the same (post, action, time, revision) is one job.
         */
        schedule(viewer, post, { at, revision, action = 'publish' } = {}) {
            actingSubject(viewer);
            const blog = blogOf(post);
            if (!access.canWrite(store, viewer, blog, action === 'unpublish' ? 'unpublish' : 'publish', post)) throw new ApiError(403, 'post.forbidden', 'You cannot schedule this post');
            if (!['publish', 'unpublish'].includes(action)) throw new ApiError(422, 'schedule.invalid_action', 'action is publish or unpublish');
            const t = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
            if (!Number.isFinite(t)) throw new ApiError(422, 'schedule.invalid_time', 'at must be an ISO 8601 time');
            if (t <= store.now()) throw new ApiError(422, 'schedule.in_past', 'Scheduled time must be in the future');
            const rev = action === 'publish' ? (revision ? store.revisions.get(post.id, parseInt(revision, 10)) : store.revisions.head(post.id)) : null;
            if (action === 'publish') {
                if (!rev) throw new ApiError(404, 'revision.not_found', 'No such revision');
                const ok = authorship.canPublish(publication.authorshipOf(rev) || { mode: 'human' }, publication.reviewOf(post, rev));
                if (!ok.ok) throw new ApiError(409, 'post.review_required', `Revision ${rev.number} needs a person's review before it can be scheduled (${ok.reason})`);
            }
            return store.tx(() => {
                const { job, created } = store.scheduler.schedule({ entityId: post.id, action, runAt: t, revision: rev ? rev.number : null });
                const cur = q.byId.get(post.id);
                if (action === 'publish' && (cur.state === 'draft' || cur.state === 'unpublished')) {
                    db.prepare("UPDATE blog_posts SET state = 'scheduled', updated_at = ? WHERE id = ?").run(store.now(), post.id);
                }
                return { job, created, post: q.byId.get(post.id) };
            });
        },

        cancelSchedule(viewer, post) {
            actingSubject(viewer);
            if (!access.canWrite(store, viewer, blogOf(post), 'publish', post)) throw new ApiError(403, 'post.forbidden', 'You cannot change this post');
            return store.tx(() => {
                const n = store.scheduler.cancelPending(post.id);
                const cur = q.byId.get(post.id);
                if (cur.state === 'scheduled') db.prepare("UPDATE blog_posts SET state = 'draft', updated_at = ? WHERE id = ?").run(store.now(), post.id);
                return { cancelled: n, post: q.byId.get(post.id) };
            });
        },

        /**
         * Worker step: claim and run due jobs. A failed job (after its retries) emits
         * blog.schedule.failed and returns a scheduled post to draft.
         */
        async runScheduled(worker) {
            const summary = await store.scheduler.runDue({
                worker,
                handler: (job) => (job.action === 'publish'
                    ? api.applyPublish(job.entityId, job.revision, null).changed
                    : api.applyUnpublish(job.entityId, null).changed),
            });
            for (const job of summary.failed) {
                store.tx(() => {
                    const post = q.byId.get(job.entityId);
                    if (post && post.state === 'scheduled') db.prepare("UPDATE blog_posts SET state = 'draft', updated_at = ? WHERE id = ?").run(store.now(), post.id);
                    outbox.emit({
                        event_type: 'blog.schedule.failed', actor: { type: 'service', id: 'blog' }, visibility: 'internal', priority: 'important',
                        subject: { type: 'post', id: job.entityId, ...(job.revision ? { revision: job.revision } : {}) },
                        payload: { job_id: job.id, action: job.action, revision: job.revision, run_at: job.runAt, attempts: job.attempts, error: job.lastError, blog_id: post ? post.blog_id : null },
                    });
                });
                log.warn(`[Blog] scheduled ${job.action} of ${job.entityId} failed: ${job.lastError}`);
            }
            return summary;
        },

        /** Soft delete: readers get 410, Search a tombstone, revisions are kept. */
        remove(viewer, post, ctx = {}) {
            actingSubject(viewer);
            const blog = blogOf(post);
            if (!access.canWrite(store, viewer, blog, 'delete', post)) throw new ApiError(403, 'post.forbidden', 'You cannot delete this post');
            return store.tx(() => {
                store.scheduler.cancelPending(post.id);
                const before = publication.snapshot(blog, q.byId.get(post.id));
                const now = store.now();
                db.prepare("UPDATE blog_posts SET state = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, post.id);
                return publication.afterChange(before, post.id, { actor: viewer, ...ctx });
            });
        },

        /** Revert = a new revision copying revision N (content, fields and its authorship). */
        revert(viewer, post, { toRevision, expectedRevision } = {}) {
            actingSubject(viewer);
            if (!access.canWrite(store, viewer, blogOf(post), 'edit', post)) throw new ApiError(403, 'post.forbidden', 'You cannot edit this post');
            const target = store.revisions.get(post.id, parseInt(toRevision, 10));
            if (!target) throw new ApiError(404, 'revision.not_found', `No revision ${toRevision}`);
            return store.tx(() => {
                const { revision } = store.revisions.revert({
                    entityId: post.id, toRevision: target.number, expectedRevision: parseInt(expectedRevision, 10),
                    author: authorLabel(viewer), meta: { authorship: publication.authorshipOf(target) },
                });
                store.citations.carryForward({ entityId: post.id, fromRevision: target.number, toRevision: revision.number, attachedBy: viewer.subject });
                db.prepare('UPDATE blog_posts SET updated_at = ? WHERE id = ?').run(store.now(), post.id);
                return { revision, post: q.byId.get(post.id) };
            });
        },

        /** A person's review of one revision (what lets an AI draft be published and indexed). */
        review(viewer, post, { revision, decision, note } = {}, ctx = {}) {
            if (!viewer || viewer.kind !== 'user' || !viewer.subject) throw new ApiError(403, 'review.person_required', 'Only a signed-in person can review a revision');
            const blog = blogOf(post);
            if (!access.canWrite(store, viewer, blog, 'publish', post)) throw new ApiError(403, 'post.forbidden', 'You cannot review this post');
            const n = parseInt(revision, 10);
            if (!store.revisions.get(post.id, n)) throw new ApiError(404, 'revision.not_found', `No revision ${revision}`);
            return store.tx(() => {
                const before = publication.snapshot(blog, post);
                const row = store.reviews.record({ entityId: post.id, revision: n, reviewer: viewer.subject, decision, note });
                publication.afterChange(before, post.id, { actor: viewer, ...ctx });
                return row;
            });
        },

        attach(viewer, post, { mediaId, role = 'inline', alt = null, caption = null, position = 0 } = {}) {
            actingSubject(viewer);
            if (!access.canWrite(store, viewer, blogOf(post), 'edit', post)) throw new ApiError(403, 'post.forbidden', 'You cannot edit this post');
            const id = String(mediaId || '').trim();
            if (!isMediaId(id) || !id.startsWith('med_')) throw new ApiError(422, 'media.invalid_id', 'Attach an OpenVibe.Media object id (med_…)');
            if (!MEDIA_ROLES.includes(role)) throw new ApiError(422, 'media.invalid_role', `role must be one of ${MEDIA_ROLES.join(', ')}`);
            const pos = parseInt(position, 10);
            return store.attachments.attach({ entityId: post.id, mediaId: id, role, alt: alt || null, caption: caption || null, position: Number.isInteger(pos) ? pos : 0 });
        },

        detach(viewer, post, attachmentId) {
            actingSubject(viewer);
            if (!access.canWrite(store, viewer, blogOf(post), 'edit', post)) throw new ApiError(403, 'post.forbidden', 'You cannot edit this post');
            return store.attachments.detach(post.id, attachmentId);
        },
    };
    return api;
}

module.exports = { createPosts, VISIBILITIES, MEDIA_ROLES, listOf, truthy };
