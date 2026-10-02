'use strict';

/**
 * /api/v1 — JSON for services (Network client-credentials tokens, audience openvibe.blog, one
 * capability per route, acting for the person in X-OV-Subject) and for browsers or apps with a
 * Network user JWT (judged by blog membership). Errors are problem+json.
 *
 *   GET    /blogs/:handle                         public
 *   POST   /blogs                                 blog.blog.create      get-or-create the acting member's blog
 *   PATCH  /blogs/:handle                         blog.blog.configure   title, description, language, feeds
 *   PUT    /blogs/:handle/theme                   blog.theme.set
 *   GET    /blogs/:handle/members                 blog.member.manage
 *   PUT    /blogs/:handle/members/:subject        blog.member.manage    { role }
 *   DELETE /blogs/:handle/members/:subject        blog.member.manage
 *   GET    /blogs/:handle/posts                   public list; ?all=1 drafts too (members; services: blog.post.read)
 *   POST   /blogs/:handle/posts                   blog.post.create      (X-OV-Origin: ai → an AI draft that needs review)
 *   GET    /blogs/:handle/feed                    blog.feed.read        the blog's JSON Feed (public posts only)
 *   GET    /posts/:id                             blog.post.read        (readers of published posts need nothing)
 *   PATCH  /posts/:id                             blog.post.update      content → new revision (expected_revision)
 *   POST   /posts/:id/publish                     blog.post.publish     { revision? }
 *   POST   /posts/:id/schedule                    blog.post.schedule    { at, revision?, action? }
 *   DELETE /posts/:id/schedule                    blog.post.schedule
 *   POST   /posts/:id/unpublish                   blog.post.unpublish
 *   DELETE /posts/:id                             blog.post.delete
 *   GET    /posts/:id/revisions[/:n], /posts/:id/diff?from&to&mode    blog.post.read
 *   POST   /posts/:id/revert                      blog.post.update      { to_revision, expected_revision }
 *   POST   /posts/:id/reviews                     people only           { revision, decision, note? }
 *   POST   /posts/:id/attachments                 blog.post.update      { media_id, role, alt, caption, position }
 *   DELETE /posts/:id/attachments/:aid            blog.post.update
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const seo = require('openvibe-publishing/seo');
const cache = require('openvibe-shared/cache-policy');
const { run, jsonBody, ApiError, privateNoStore } = require('./errors');
const { guard } = require('../auth/viewer');
const { checkCapability } = require('../auth/capabilities');

function cors(origins) {
    const allowed = new Set(origins);
    return (req, res, next) => {
        const origin = req.get('origin');
        if (origin && allowed.has(origin)) {
            res.set('Access-Control-Allow-Origin', origin);
            res.vary('Origin');
            res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, traceparent, X-OpenVibe-Request-Id');
            res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
            res.set('Access-Control-Expose-Headers', 'X-OpenVibe-Request-Id');
            res.set('Access-Control-Max-Age', '600');
        }
        if (req.method === 'OPTIONS') return res.status(204).end();
        next();
    };
}

function createApi(ctx) {
    const { config, store, blogs, posts, publication, reading, access, entitlements, viewers, effects, people, limits } = ctx;
    const router = express.Router();
    router.use(cors(config.apiCorsOrigins));
    router.use(viewers.middleware());
    // Per-actor limits (http/actor-limits.js), once req.viewer is resolved: every read takes the defaults
    // (not the changelog, which Network reads for every site from loopback); each write names its budget
    // after its capability guard and before its body is read.
    router.use(limits.reads('blog.read', { skip: (req) => req.path === '/changelog' }));
    const B = (name) => limits.budget(name);
    router.use((req, res, next) => { privateNoStore(res); res.set('X-Robots-Tag', 'noindex'); next(); });

    const tp = (req) => ({ traceparent: req.ov && req.ov.traceparent });

    async function mustBlog(req) {
        const blog = await blogs.byHandle(req.params.handle);
        if (!blog || (blog.status !== 'active' && !access.isStaff(req.viewer))) throw new ApiError(404, 'blog.not_found', 'No such blog');
        return blog;
    }
    const isMember = async (blog, viewer) => Boolean(await access.effectiveRole(store, viewer, blog)) || access.isStaff(viewer);

    async function blogDto(blog, { full = false } = {}) {
        const out = {
            id: blog.id, kind: blog.kind, handle: blog.handle, title: blog.title, description: blog.description,
            url: publication.abs(publication.blogPath(blog)), theme: blog.theme, language: blog.language,
            feeds: (await reading.feedsOf(blog)).map((f) => ({ type: f.type, url: publication.abs(f.href) })),
        };
        if (full) Object.assign(out, { status: blog.status, owner_subject: blog.owner_subject, feed_settings: await blogs.feedSettings(blog) });
        return out;
    }

    async function postDto(post, { full = false } = {}) {
        const blog = await posts.blogOf(post);
        const rev = full ? await posts.head(post) : await posts.revision(post, post.published_revision);
        const shown = post.published_revision ? await posts.revision(post, post.published_revision) : rev;
        const decision = shown ? await publication.decide(blog, post, shown) : null;
        const { tags, categories } = await publication.termsOf(post);
        const series = await blogs.seriesById(post.series_id);
        const out = {
            id: post.id, blog: { id: blog.id, handle: blog.handle }, slug: post.slug, url: publication.postUrl(blog, post),
            state: post.state, visibility: post.visibility, author_subject: post.author_subject,
            title: rev ? rev.fields.title : null, summary: rev ? rev.fields.summary || null : null,
            revision: rev ? rev.number : null, published_revision: post.published_revision,
            first_published_at: post.first_published_at ? new Date(post.first_published_at).toISOString() : null,
            published_at: post.published_at ? new Date(post.published_at).toISOString() : null,
            tags, categories, series: series ? { id: series.id, slug: series.slug, title: series.title, position: post.series_position } : null,
            allow_comments: Boolean(post.allow_comments), noindex: Boolean(post.noindex),
            indexability: decision ? { indexable: decision.indexable, robots: decision.robots, reasons: decision.reasons } : null,
        };
        if (full) {
            const rec = publication.authorshipOf(rev);
            Object.assign(out, {
                entitlement_key: post.entitlement_key, body: rev ? rev.content : null,
                authorship: rec, review: rev ? await publication.reviewOf(post, rev) : null,
                scheduled: await posts.pendingJobs(post), attachments: await posts.attachments(post),
                citations: rev ? await posts.citations(post, rev.number) : [],
            });
        }
        return out;
    }

    async function mustPost(req, cap) {
        const post = await posts.mustGet(req.params.id);
        return { post, blog: await posts.blogOf(post), cap };
    }

    async function after(before, postId, req) {
        await effects.after(before, await posts.get(postId), req.ov);
    }

    // ── Blogs ───────────────────────────────────────────────

    router.get('/blogs/:handle', run(async (req) => {
        const blog = await mustBlog(req);
        return { blog: await blogDto(blog, { full: await isMember(blog, req.viewer) }) };
    }));

    router.post('/blogs', guard('blog.blog.create'), B('blog.blog.create'), jsonBody, run(async (req) => {
        const b = req.body || {};
        const username = req.viewer.kind === 'user' && req.viewer.user ? req.viewer.user.username : null;
        const { blog, created } = await blogs.ensureMemberBlog({ subject: req.viewer.subject, username, handle: b.handle, title: b.title, description: b.description });
        return { blog: await blogDto(blog, { full: true }), created };
    }, (out) => (out.created ? 201 : 200)));

    router.patch('/blogs/:handle', guard('blog.blog.configure'), B('blog.blog.configure'), jsonBody, run(async (req) => {
        const blog = await mustBlog(req);
        if (!await access.canWrite(store, req.viewer, blog, 'configure')) throw new ApiError(403, 'blog.forbidden', 'Only an owner can configure this blog');
        const b = req.body || {};
        const updated = await store.tx(async () => {
            const u = await blogs.update(blog, { title: b.title, description: b.description, language: b.language });
            if (b.feeds) await blogs.setFeedSettings(u, { rss: b.feeds.rss, atom: b.feeds.atom, json: b.feeds.json, itemCount: b.feeds.item_count, fullContent: b.feeds.full_content });
            return await blogs.get(u.id);
        });
        return { blog: await blogDto(updated, { full: true }) };
    }));

    router.put('/blogs/:handle/theme', guard('blog.theme.set'), B('blog.blog.configure'), jsonBody, run(async (req) => {
        const blog = await mustBlog(req);
        if (!await access.canWrite(store, req.viewer, blog, 'configure')) throw new ApiError(403, 'blog.forbidden', 'Only an owner can change the theme');
        return { blog: await blogDto(await blogs.setTheme(blog, String((req.body || {}).theme || '')), { full: true }), themes: blogs.THEME_PRESETS };
    }));

    router.get('/blogs/:handle/members', guard('blog.member.manage'), run(async (req) => {
        const blog = await mustBlog(req);
        if (!await access.canWrite(store, req.viewer, blog, 'members')) throw new ApiError(403, 'blog.forbidden', 'Only an owner can see the members');
        const list = await blogs.members(blog);
        const who = await people.many(list.map((m) => m.subject));
        return { members: list.map((m) => ({ subject: m.subject, role: m.role, name: who.get(m.subject).known ? who.get(m.subject).name : null, username: who.get(m.subject).username })) };
    }));

    router.put('/blogs/:handle/members/:subject', guard('blog.member.manage'), B('blog.member.manage'), jsonBody, run(async (req) => {
        const blog = await mustBlog(req);
        if (!await access.canWrite(store, req.viewer, blog, 'members')) throw new ApiError(403, 'blog.forbidden', 'Only an owner can manage members');
        return { member: await blogs.setMember(blog, req.params.subject, (req.body || {}).role, req.viewer.subject) };
    }));

    router.delete('/blogs/:handle/members/:subject', guard('blog.member.manage'), B('blog.member.manage'), run(async (req) => {
        const blog = await mustBlog(req);
        if (!await access.canWrite(store, req.viewer, blog, 'members')) throw new ApiError(403, 'blog.forbidden', 'Only an owner can manage members');
        return { removed: await blogs.removeMember(blog, req.params.subject) };
    }));

    router.get('/blogs/:handle/posts', run(async (req) => {
        const blog = await mustBlog(req);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        if (req.query.all === '1') {
            if (req.viewer.kind === 'service' && !checkCapability(req.viewer.claims, 'blog.post.read').allowed) throw new ApiError(403, 'capability.denied', 'blog.post.read not granted');
            if (!await isMember(blog, req.viewer)) throw new ApiError(403, 'blog.forbidden', 'Only the blog’s members can list its drafts');
            return { posts: await Promise.all((await posts.listForDashboard(blog, req.viewer)).slice(offset, offset + limit).map(async (p) => await postDto(p, { full: false }))) };
        }
        const { total, posts: rows } = await posts.listPublished({ blogId: blog.id, restricted: await isMember(blog, req.viewer), limit, offset });
        return { total, posts: await Promise.all(rows.map(async (p) => await postDto(p))) };
    }));

    // The network changelog (server/changelog.js): what shipped on every OpenVibe site, newest first, and
    // the latest patch notes post. Public: every site's "recently shipped" reads it.
    router.get('/changelog', run(async (req, res) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=60');
        const service = /^[a-z][a-z0-9-]{1,39}$/.test(String(req.query.service || '')) ? String(req.query.service) : null;
        const postOf = async (row) => {
            const p = row && await posts.get(row.post_id);
            const blog = p ? await blogs.get(p.blog_id) : null;
            if (!p || !blog || p.state !== 'published') return null;
            return { id: p.id, title: (await posts.head(p) || { fields: {} }).fields.title || null, url: publication.abs(publication.postPath(blog, p)), published_at: p.published_at || null, entries: row.entries };
        };
        const page = await ctx.changelog.page({ service, limit: req.query.limit, before: req.query.before });
        const recent = (await Promise.all((await ctx.changelog.recentPosts(5)).map(postOf))).filter(Boolean);
        return {
            service, entries: page.entries, next: page.next, latest_post: recent[0] || null, posts: recent,
            ...(service ? {} : { sites: await ctx.changelog.sites() }),
        };
    }));

    // Draft with AI: OpenVibe.AI's blog.draft_post writes a draft (AI-authored, noindex until reviewed).
    router.post('/blogs/:handle/posts/ai-draft', guard('blog.post.create'), B('blog.post.ai_draft'), jsonBody, run(async (req) => {
        const blog = await mustBlog(req);
        if (!ctx.aiDrafts || !ctx.aiDrafts.enabled) throw new ApiError(503, 'ai.not_configured', 'Drafting with AI is not available on this blog right now');
        const { post, revision } = await ctx.aiDrafts.draft(req.viewer, blog, req.body || {}, tp(req));
        await after(null, post.id, req);
        return { post: await postDto(post, { full: true }), revision: revision.number };
    }, 201));

    router.post('/blogs/:handle/posts', guard('blog.post.create'), B('blog.post.create'), jsonBody, run(async (req) => {
        const blog = await mustBlog(req);
        const { post, revision } = await posts.create(req.viewer, blog, req.body || {}, tp(req));
        await after(null, post.id, req);
        return { post: await postDto(post, { full: true }), revision: revision.number };
    }, 201));

    router.get('/blogs/:handle/feed', guard('blog.feed.read'), run(async (req, res) => {
        const blog = await mustBlog(req);
        const s = await blogs.feedSettings(blog);
        const items = await reading.feedItems(blog, { limit: s.item_count, fullContent: Boolean(s.full_content) });
        res.set('Cache-Control', cache.htmlHeaders({ maxAge: 300 }));
        res.removeHeader('X-Robots-Tag');
        return seo.jsonFeed({ title: blog.title, link: publication.abs(publication.blogPath(blog)), feedUrl: publication.abs(reading.urls.feed(blog, 'json')), description: blog.description || undefined }, items);
    }));

    // ── Posts ───────────────────────────────────────────────

    router.get('/posts/:id', guard('blog.post.read'), run(async (req) => {
        const { post, blog } = await mustPost(req);
        if (await access.canWrite(store, req.viewer, blog, 'edit', post) || access.isStaff(req.viewer)) return { post: await postDto(post, { full: true }) };
        const d = await access.canReadPost(store, req.viewer, blog, post, entitlements);
        // Members only: the teaser (title, the author's summary) and the join link, never the body.
        if (!d.allowed && d.status === 403) throw new ApiError(403, 'post.members_only', 'Members only', { teaser: await reading.teaser(blog, post, { reason: d.vip || null }) });
        if (!d.allowed) throw new ApiError(d.status, 'post.not_found', 'No such post');
        return { post: await postDto(post) };
    }));

    const write = (method, path, capGuard, limit, fn, status = 200) => router[method](path, capGuard, limit, jsonBody, run(async (req) => {
        const { post } = await mustPost(req);
        const before = { ...post };
        const out = await fn(req, post, req.body || {});
        await after(before, post.id, req);
        return out;
    }, status));

    write('patch', '/posts/:id', guard('blog.post.update'), B('blog.post.update'), async (req, post, b) => {
        const input = { ...b, expectedRevision: b.expected_revision ?? b.expectedRevision };
        const out = await posts.update(req.viewer, post, input, tp(req));
        return { post: await postDto(out.post, { full: true }), revision: out.revision.number, created: out.created };
    });
    write('post', '/posts/:id/publish', guard('blog.post.publish'), B('blog.post.publish'), async (req, post, b) => {
        const out = await posts.publish(req.viewer, post, { revision: b.revision }, tp(req));
        return { post: await postDto(out.post, { full: true }), changed: out.changed };
    });
    write('post', '/posts/:id/schedule', guard('blog.post.schedule'), B('blog.post.publish'), async (req, post, b) => {
        const out = await posts.schedule(req.viewer, post, { at: b.at, revision: b.revision, action: b.action || 'publish' });
        return { job: out.job, created: out.created, post: await postDto(out.post, { full: true }) };
    }, 201);
    write('delete', '/posts/:id/schedule', guard('blog.post.schedule'), B('blog.post.publish'), async (req, post) => {
        const out = await posts.cancelSchedule(req.viewer, post);
        return { cancelled: out.cancelled, post: await postDto(out.post, { full: true }) };
    });
    write('post', '/posts/:id/unpublish', guard('blog.post.unpublish'), B('blog.post.publish'), async (req, post) => {
        const out = await posts.unpublish(req.viewer, post, tp(req));
        return { post: await postDto(out.post, { full: true }), changed: out.changed };
    });
    write('delete', '/posts/:id', guard('blog.post.delete'), B('blog.post.delete'), async (req, post) => {
        await posts.remove(req.viewer, post, tp(req));
        return { deleted: true, id: post.id };
    });
    write('post', '/posts/:id/revert', guard('blog.post.update'), B('blog.post.update'), async (req, post, b) => {
        const out = await posts.revert(req.viewer, post, { toRevision: b.to_revision ?? b.toRevision, expectedRevision: b.expected_revision ?? b.expectedRevision });
        return { revision: out.revision.number, post: await postDto(out.post, { full: true }) };
    }, 201);
    router.post('/posts/:id/reviews', B('blog.post.publish'), jsonBody, run(async (req) => {
        const { post } = await mustPost(req);
        const b = req.body || {};
        const review = await posts.review(req.viewer, post, { revision: b.revision, decision: b.decision, note: b.note }, tp(req));
        await after({ ...post }, post.id, req);
        return { review };
    }, 201));
    write('post', '/posts/:id/attachments', guard('blog.post.update'), B('blog.post.media'), async (req, post, b) => ({
        attachment: await posts.attach(req.viewer, post, { mediaId: b.media_id ?? b.mediaId, role: b.role, alt: b.alt, caption: b.caption, position: b.position }),
    }), 201);
    write('delete', '/posts/:id/attachments/:aid', guard('blog.post.update'), B('blog.post.media'), async (req, post) => ({ removed: await posts.detach(req.viewer, post, req.params.aid) }));

    async function readable(req) {
        const { post, blog } = await mustPost(req);
        if (!(await access.canWrite(store, req.viewer, blog, 'edit', post) || access.isStaff(req.viewer))) throw new ApiError(404, 'post.not_found', 'No such post');
        return post;
    }
    router.get('/posts/:id/revisions', guard('blog.post.read'), run(async (req) => {
        const post = await readable(req);
        return { revisions: (await posts.revisions(post, { limit: req.query.limit, before: req.query.before })).map(({ content, ...r }) => ({ ...r, length: content.length })) };
    }));
    router.get('/posts/:id/revisions/:n', guard('blog.post.read'), run(async (req) => {
        const post = await readable(req);
        const rev = await posts.revision(post, parseInt(req.params.n, 10));
        if (!rev) throw new ApiError(404, 'revision.not_found', 'No such revision');
        return { revision: rev, citations: await posts.citations(post, rev.number) };
    }));
    router.get('/posts/:id/diff', guard('blog.post.read'), B('blog.post.diff'), run(async (req) => {
        const post = await readable(req);
        return { diff: await posts.diff(post, parseInt(req.query.from, 10), parseInt(req.query.to, 10), req.query.mode) };
    }));

    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

module.exports = { createApi };
