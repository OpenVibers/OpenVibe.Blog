'use strict';

/**
 * Publication mechanics shared by the routes, the worker and the seed:
 *   - canonical paths and URLs
 *   - the indexability gate (openvibe-publishing/seo) with Blog's editorial policy
 *   - the Search document and the publication events (openvibe-publishing/index-hooks), enqueued
 *     in the same transaction as the change through the SDK outbox
 *
 * Search receives ONLY published, public, listable posts. Everything else (drafts, scheduled,
 * unlisted, members/VIP, private, unpublished, deleted) is a tombstone, so a visibility change or
 * an unpublish removes the old copy; a post that was never indexed gets no tombstone.
 */
const seo = require('openvibe-publishing/seo');
const ssr = require('openvibe-publishing/ssr');
const hooks = require('openvibe-publishing/index-hooks');
const authorship = require('openvibe-publishing/authorship');

// Blog's editorial policy for the gate: sources are optional on a blog; a very short post is
// served and listed in feeds but not offered to search engines (reason "thin").
const POLICY = Object.freeze({ minWords: 80, requireSources: false });
const OWNER = 'blog';

/** Blog visibility → the gate's vocabulary (members = entitlement-gated). */
const GATE_VISIBILITY = { public: 'public', unlisted: 'unlisted', members: 'gated', private: 'private' };

function createPublication({ store, config, outbox }) {
    const { db } = store;
    const blogById = db.prepare('SELECT * FROM blogs WHERE id = ?');
    const membersOf = db.prepare('SELECT subject FROM blog_memberships WHERE blog_id = ? ORDER BY subject');

    const blogPath = (blog) => (blog.kind === 'official' ? '/' : `/@${blog.handle}`);
    const postPath = (blog, post) => `/@${blog.handle}/${post.slug}`;
    const abs = (p) => seo.canonicalUrl(config.baseUrl, p);
    const postUrl = (blog, post) => abs(postPath(blog, post));
    const feedId = (post) => `tag:openvibe.blog,2026:post/${post.id}`;   // stable across slug changes

    function authorshipOf(rev) {
        return (rev && rev.meta && rev.meta.authorship) || null;
    }

    function reviewOf(post, rev) {
        return rev ? store.reviews.latest(post.id, rev.number) : null;
    }

    /** The gate's decision for a post at one revision (the published one by default). */
    function decide(blog, post, rev, { state } = {}) {
        const rec = authorshipOf(rev);
        const facts = {
            state: state || post.state,
            visibility: GATE_VISIBILITY[post.visibility],
            canonicalUrl: postUrl(blog, post),
            text: rev ? `${rev.fields.title || ''}\n${ssr.markdownToText(rev.content)}` : '',
            noindex: Boolean(post.noindex),
        };
        if (rec) Object.assign(facts, authorship.gateFacts(rec, reviewOf(post, rev)));
        return seo.evaluate(facts, { policy: POLICY, now: store.now() });
    }

    /** The revision readers see (published) or, for a never-published post, the head. */
    function visibleRevision(post) {
        return post.published_revision ? store.revisions.get(post.id, post.published_revision) : store.revisions.head(post.id);
    }

    function aclFor(blog, post) {
        const subjects = [...new Set([...membersOf.all(blog.id).map((r) => r.subject), post.author_subject])].filter((s) => /^usr_/.test(s));
        if (post.visibility === 'members') return { entitlements: [post.entitlement_key], subjects };
        if (post.visibility === 'private') return { subjects };
        return {};
    }

    function termsOf(post) {
        const terms = store.taxonomy.termsFor(post.id);
        return {
            tags: terms.filter((t) => t.vocabulary === 'tag').map((t) => t.name),
            categories: terms.filter((t) => t.vocabulary !== 'tag').map((t) => t.name),
        };
    }

    /**
     * The index document as it would describe this post (real visibility, for the product events),
     * or a tombstone when it is not published.
     */
    function documentFor(blog, post, { forSearch }) {
        const rev = post.published_revision ? store.revisions.get(post.id, post.published_revision) : null;
        const identity = { owner: OWNER, type: 'post', id: post.id, revision: 0 };
        if (!rev || post.state !== 'published') return { doc: hooks.tombstone(identity), decision: rev ? decide(blog, post, rev) : null };
        const decision = decide(blog, post, rev);
        if (forSearch && (post.visibility !== 'public' || !decision.listable)) return { doc: hooks.tombstone(identity), decision };
        const { tags, categories } = termsOf(post);
        const series = post.series_id ? db.prepare('SELECT slug FROM blog_series WHERE id = ?').get(post.series_id) : null;
        const rec = authorshipOf(rev);
        const acl = aclFor(blog, post);
        const doc = hooks.buildIndexDocument({
            ...identity,
            state: 'published',
            visibility: GATE_VISIBILITY[post.visibility],
            acl,
            includeUnlisted: !forSearch,
            canonicalUrl: postUrl(blog, post),
            title: rev.fields.title,
            summary: rev.fields.summary || ssr.markdownToText(rev.content, 300),
            body: ssr.markdownToText(rev.content),
            facets: { blog: blog.handle, tags, categories, ...(series ? { series: series.slug } : {}) },
            authorship: rec,
            citations: store.citations.forRevision(post.id, rev.number),
            decision,
            publishedAt: post.first_published_at,
            updatedAt: rev.createdAt,
            language: blog.language,
        });
        return { doc, decision };
    }

    /** Stamp and enqueue the Search document when it changed. Inside the caller's transaction. */
    function syncIndex(blog, post, { traceparent } = {}) {
        const { doc } = documentFor(blog, post, { forSearch: true });
        const prev = store.sequencer.current(OWNER, 'post', post.id);
        if (doc.deleted && prev == null) return null;          // never indexed: nothing to remove
        const stamped = store.sequencer.stamp(doc);
        if (prev != null && stamped.revision === prev) return null;   // unchanged: nothing to send
        return outbox.emit(hooks.indexEvent({ document: stamped, now: store.now() }), { traceparent });
    }

    /** Snapshot for actionFor(before, after). */
    function snapshot(blog, post) {
        return post ? { state: post.state, visibility: post.visibility, revision: post.published_revision, url: postUrl(blog, post) } : null;
    }

    /**
     * Emit the product event for a transition (blog.post.published|updated|unpublished|deleted),
     * and re-sync Search. Inside the caller's transaction, after the row changed.
     */
    function afterChange(before, postId, { actor, traceparent } = {}) {
        const post = db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(postId);
        const blog = blogById.get(post.blog_id);
        const after = snapshot(blog, post);
        let action = hooks.actionFor(before, after);
        if (!action && before && before.state === 'published' && after.state === 'published' && before.url !== after.url) action = 'updated';
        let event = null;
        if (action) {
            const { doc, decision } = documentFor(blog, post, { forSearch: false });
            event = outbox.emit(hooks.publicationEvent({
                product: OWNER, type: 'post', action, id: post.id, revision: post.published_revision || 0,
                actor: actorRef(actor), document: doc, decision, now: store.now(),
                extra: { blog: { id: blog.id, handle: blog.handle }, visibility: post.visibility },
            }), { traceparent });
        }
        syncIndex(blog, post, { traceparent });
        return { action, event, post, blog };
    }

    return {
        POLICY, OWNER, GATE_VISIBILITY,
        blogPath, postPath, postUrl, abs, feedId,
        decide, visibleRevision, documentFor, syncIndex, snapshot, afterChange, authorshipOf, reviewOf, termsOf,
    };
}

/** Event actor from a viewer (or 'svc:blog' for the worker). */
function actorRef(actor) {
    if (!actor) return { type: 'service', id: 'blog' };
    if (typeof actor === 'string') return hooks.subjectRef(actor);
    if (actor.kind === 'user' && actor.subject) return { type: 'user', id: actor.subject };
    if (actor.kind === 'service') {
        if (actor.subject && actor.origin !== 'ai') return { type: 'user', id: actor.subject };
        return { type: 'service', id: String(actor.service || '').replace(/^svc:/, '') || 'unknown' };
    }
    if (actor.type && actor.id) return { type: actor.type, id: actor.id };
    return { type: 'service', id: 'blog' };
}

module.exports = { createPublication, actorRef, POLICY, GATE_VISIBILITY };
