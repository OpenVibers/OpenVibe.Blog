'use strict';

/**
 * Public, server-rendered routes — useful without JavaScript:
 *
 *   GET /                              the official blog           GET /@:handle           a member's blog
 *   GET /@:handle/:slug                a post (…/:slug.json: the same post as data)
 *   POST /@:handle/:slug/comments      comment (Community thread) as the signed-in member
 *   GET /@:handle/tags/:tag            GET /@:handle/categories/:category
 *   GET /@:handle/series/:series       GET /@:handle/authors/:who
 *   GET /tags/:tag, /authors/:who      the same across every blog
 *
 * Caching (the rule that keeps private content out of shared caches):
 *   - every HTML/JSON page varies on Cookie and Authorization;
 *   - only a PUBLIC, PUBLISHED post, or a list of public posts, rendered for an ANONYMOUS visitor is
 *     `public, max-age=60`; everything else — signed-in views, drafts, previews, unlisted,
 *     members/VIP and private posts, refusals, 404/410 — is `private, no-store` + X-Robots-Tag.
 */
const showcase = require('openvibe-shared/showcase');
const express = require('express');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const seo = require('openvibe-publishing/seo');
const ssr = require('openvibe-publishing/ssr');
const authorship = require('openvibe-publishing/authorship');
const cache = require('openvibe-shared/cache-policy');
const { renderPage } = require('../render/layout');
const pages = require('../render/pages');
const { csrfToken, checkCsrf } = require('../auth/forms');

const PER_PAGE = 15;

function createPublicRoutes(ctx) {
    const { config, store, blogs, posts, publication, reading, people, community, media, access, entitlements, viewers, limits } = ctx;
    const router = express.Router();
    router.use(viewers.middleware({ services: false }));

    // ── Helpers ─────────────────────────────────────────────

    function cacheHeaders(res, { cacheable, robots }) {
        res.vary('Cookie');
        res.vary('Authorization');
        if (cacheable) res.set('Cache-Control', cache.htmlHeaders({ maxAge: 60 }));
        else res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (robots && robots !== 'index, follow') res.set('X-Robots-Tag', robots);
    }

    function send(req, res, status, page, { cacheable = false } = {}) {
        cacheHeaders(res, { cacheable: cacheable && req.viewer.kind === 'anonymous' && status === 200, robots: page.decision.robots });
        res.status(status).type('html').send(renderPage({ ...page, viewer: req.viewer, config, path: req.originalUrl }));
    }

    /** A decision for a page that is not a post (collections, messages). */
    function pageDecision(path, { indexable = true, empty = false, query = [] } = {}) {
        return seo.evaluate({
            state: indexable ? 'published' : 'draft', visibility: indexable ? 'public' : 'private',
            canonicalUrl: seo.canonicalUrl(config.baseUrl, path, { query }), wordCount: 0, noindex: empty,
        }, { policy: { minWords: 0 }, now: store.now() });
    }

    function messagePage(req, res, status, heading, text, action) {
        send(req, res, status, { title: heading, decision: pageDecision(req.path, { indexable: false }), body: pages.message({ heading, text, action }) });
    }
    const notFound = (req, res) => messagePage(req, res, 404, 'Not found', 'There is nothing at this address.', { href: '/', label: 'The OpenVibe blog' });

    const isMember = async (blog, viewer) => Boolean(await access.effectiveRole(store, viewer, blog)) || access.isStaff(viewer);

    function pageNumber(req) {
        const n = parseInt(req.query.page, 10);
        return Number.isInteger(n) && n > 0 ? n : 1;
    }

    async function activeBlog(req) {
        const blog = await blogs.byHandle(req.params.handle);
        if (!blog) return null;
        if (blog.status !== 'active' && !access.isStaff(req.viewer)) return null;
        return blog;
    }

    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

    // ── Blog front pages ────────────────────────────────────

    /** The product's own words above the official blog's posts: only features Blog has today. */
    function blogShowcase() {
        return showcase.hero({
            eyebrow: 'OpenVibe.Blog',
            title: 'Write on', accent: 'OpenVibe',
            lede: 'A blog of your own with drafts, scheduling, feeds and comments. Sign in once with your OpenVibe account; anyone can read without one.',
            actions: [{ label: 'Start writing', href: '/write', primary: true }, { label: 'Read the OpenVibe blog', href: '#posts' }],
        }) + showcase.features({
            title: 'What your blog gets',
            items: [
                { icon: 'ov:blog', title: 'Drafts and revisions', text: 'Every save is a revision you can go back to; publish when it is ready.' },
                { icon: 'ov:history', title: 'Scheduling', text: 'Pick the minute a post goes live.' },
                { icon: 'ov:news', title: 'Feeds', text: 'RSS, Atom and JSON Feed for every blog, series and category.' },
                { icon: 'ov:community', title: 'Comments', text: 'Threads on OpenVibe.Community, moderated by you.' },
                { icon: 'ov:theme', title: 'Your theme', text: 'Pick a theme preset and your blog wears it.' },
                { icon: 'ov:vip', title: 'Members-only posts', text: 'Your OpenVibe.VIP members read the whole post; everyone else sees a teaser.' },
            ],
        }) + '<div id="posts"></div>';
    }

    async function blogFront(req, res, blog, { home = false } = {}) {
        const page = pageNumber(req);
        const restricted = await isMember(blog, req.viewer);
        const path = publication.blogPath(blog);
        const { total, posts: rows } = await posts.listPublished({ blogId: blog.id, restricted, limit: PER_PAGE, offset: (page - 1) * PER_PAGE });
        const pager = ssr.paginate({ page, perPage: PER_PAGE, total, href: (p) => (p === 1 ? path : `${path}?page=${p}`) });
        if (pager.outOfRange && total) return notFound(req, res);
        const items = await reading.listItems(rows);
        const canonical = seo.canonicalUrl(config.baseUrl, pager.page === 1 ? path : `${path}?page=${pager.page}`, { query: ['page'] });
        const feeds = await reading.feedsOf(blog);
        // Series and categories are named when a draft or restricted post uses them: list only those
        // holding a post this viewer may see in the list, so their names never leak ahead of a post.
        const shows = async (filter) => (await posts.listPublished({ ...filter, blogId: blog.id, restricted, limit: 1 })).total > 0;
        const prune = async (nodes) => {
            const out = [];
            for (const n of nodes) {
                const children = await prune(n.children || []);
                if (children.length || await shows({ termIds: [n.id] })) out.push({ ...n, children });
            }
            return out;
        };
        const seriesShown = [];
        for (const sr of await blogs.series(blog)) if (await shows({ seriesId: sr.id })) seriesShown.push(sr);
        send(req, res, 200, {
            title: blog.title,
            description: blog.description,
            decision: pageDecision(canonical, { empty: total === 0, query: ['page'] }),
            canonical,
            feeds,
            theme: { slug: blog.theme, vars: blogs.themeVars(blog) },
            lang: blog.language,
            prev: pager.prev ? pager.prev.href : null,
            next: pager.next ? pager.next.href : null,
            jsonLd: [blog.kind === 'official'
                ? { '@context': 'https://schema.org', '@type': 'Blog', '@id': `${publication.abs(path)}#blog`, name: blog.title, url: publication.abs(path), description: blog.description || undefined, publisher: { '@type': 'Organization', name: 'OpenVibe', url: 'https://openvibe.network' } }
                : { '@context': 'https://schema.org', '@type': 'Blog', '@id': `${publication.abs(path)}#blog`, name: blog.title, url: publication.abs(path), description: blog.description || undefined }],
            // The network's blog home opens with what OpenVibe.Blog is for (openvibe-shared/showcase), then the posts.
            ...(home && pager.page === 1 ? { styles: [showcase.STYLESHEET] } : {}),
            body: (home && pager.page === 1 ? blogShowcase() : '') + pages.blogIndex({
                blog, blogUrl: `/@${blog.handle}`, items, pager, feeds,
                series: seriesShown, categories: await prune(await reading.categoriesTree(blog)),
                canWrite: await access.canWrite(store, req.viewer, blog, 'create'),
            }) + (home && pager.page === 1 ? frame.shipped({ service: 'blog', title: 'Recently shipped on OpenVibe.Blog' }) : ''),
        }, { cacheable: !restricted });
    }

    router.get('/', wrap(async (req, res) => await blogFront(req, res, await blogs.official(), { home: true })));

    // What shipped on OpenVibe.Blog: the shared update log (openvibe-shared shipped.js, fed by the
    // network changelog this service keeps), like every OpenVibe site's /updates.
    router.get('/updates', wrap(async (req, res) => send(req, res, 200, {
        title: 'What shipped on OpenVibe.Blog',
        description: 'Every change deployed to OpenVibe.Blog, newest first, with the Patch notes that gather them.',
        decision: pageDecision('/updates'),
        canonical: seo.canonicalUrl(config.baseUrl, '/updates'),
        body: frame.updatesBody({ service: 'blog', siteName: 'OpenVibe.Blog' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`,
    }, { cacheable: true })));

    router.get('/@:handle', wrap(async (req, res) => {
        const blog = await activeBlog(req);
        if (!blog) return notFound(req, res);
        if (blog.kind === 'official') return res.redirect(301, '/');
        return await blogFront(req, res, blog);
    }));

    // ── Feeds (public posts only, never viewer-dependent) ───

    async function feed(req, res, blog, kind) {
        const s = await blogs.feedSettings(blog);
        if (!s[kind]) return notFound(req, res);
        const items = await reading.feedItems(blog, { limit: s.item_count, fullContent: Boolean(s.full_content) });
        const link = publication.abs(publication.blogPath(blog));
        const feedUrl = publication.abs(reading.urls.feed(blog, kind));
        res.set('Cache-Control', cache.htmlHeaders({ maxAge: 300 }));
        res.vary('Accept-Encoding');
        if (kind === 'rss') return res.type('application/rss+xml').send(seo.rssFeed({ title: blog.title, link, description: blog.description || blog.title, feedUrl, language: blog.language }, items));
        if (kind === 'json') return res.type('application/feed+json').send(JSON.stringify(seo.jsonFeed({ title: blog.title, link, feedUrl, description: blog.description || undefined, language: blog.language }, items)));
        const listed = items.filter((i) => i.decision.listable);
        const updated = listed.length ? null : new Date(blog.updated_at).toISOString();
        return res.type('application/atom+xml').send(seo.atomFeed({ title: blog.title, link, feedUrl, id: `tag:openvibe.blog,2026:blog/${blog.id}`, subtitle: blog.description || undefined, ...(updated ? { updated } : {}) }, items));
    }
    const FEEDS = { 'feed.xml': 'rss', 'atom.xml': 'atom', 'feed.json': 'json' };
    for (const [file, kind] of Object.entries(FEEDS)) {
        router.get(`/${file}`, wrap(async (req, res) => await feed(req, res, await blogs.official(), kind)));
        router.get(`/@:handle/${file}`, wrap(async (req, res) => {
            const blog = await activeBlog(req);
            if (!blog) return notFound(req, res);
            if (blog.kind === 'official') return res.redirect(301, `/${file}`);
            return await feed(req, res, blog, kind);
        }));
    }

    // ── Collections ─────────────────────────────────────────

    async function collection(req, res, { blog, heading, intro, crumbs, path, filter, order, empty, hideEmpty = false }) {
        const page = pageNumber(req);
        const restricted = blog ? await isMember(blog, req.viewer) : false;
        const { total, posts: rows } = await posts.listPublished({ ...filter, blogId: blog ? blog.id : null, restricted, limit: PER_PAGE, offset: (page - 1) * PER_PAGE, order });
        // A series or category named only by drafts or posts this viewer cannot see does not exist for them.
        if (hideEmpty && !total) return notFound(req, res);
        const pager = ssr.paginate({ page, perPage: PER_PAGE, total, href: (p) => (p === 1 ? path : `${path}?page=${p}`) });
        if (pager.outOfRange && total) return notFound(req, res);
        const items = await reading.listItems(rows, { perBlogLinks: Boolean(blog) });
        const canonical = seo.canonicalUrl(config.baseUrl, pager.page === 1 ? path : `${path}?page=${pager.page}`, { query: ['page'] });
        send(req, res, 200, {
            title: heading, description: intro, canonical,
            decision: pageDecision(canonical, { empty: total === 0, query: ['page'] }),
            theme: blog ? { slug: blog.theme, vars: blogs.themeVars(blog) } : null,
            prev: pager.prev ? pager.prev.href : null, next: pager.next ? pager.next.href : null,
            jsonLd: [seo.structuredData.breadcrumbs(crumbs.map((c) => ({ name: c.name, url: c.url ? publication.abs(c.url) : canonical })))],
            body: pages.collection({ heading, intro, breadcrumbs: crumbs, items, pager, empty }),
        }, { cacheable: !restricted });
    }

    const blogCrumb = (blog) => ({ name: blog.title, url: publication.blogPath(blog) });

    router.get('/@:handle/tags/:tag', wrap(async (req, res) => {
        const blog = await activeBlog(req);
        const tag = blog && await store.taxonomy.bySlug('tag', req.params.tag);
        if (!tag) return notFound(req, res);
        return await collection(req, res, { blog, heading: `#${tag.name}`, intro: `Posts tagged ${tag.name} on ${blog.title}.`, path: reading.urls.tag(tag, blog),
            crumbs: [blogCrumb(blog), { name: `#${tag.name}` }], filter: { termIds: [tag.id] }, empty: 'No public posts with this tag yet.' });
    }));

    router.get('/tags/:tag', wrap(async (req, res) => {
        const tag = await store.taxonomy.bySlug('tag', req.params.tag);
        if (!tag) return notFound(req, res);
        return await collection(req, res, { blog: null, heading: `#${tag.name}`, intro: `Posts tagged ${tag.name} across every blog on openvibe.blog.`, path: reading.urls.tag(tag),
            crumbs: [{ name: 'OpenVibe.Blog', url: '/' }, { name: `#${tag.name}` }], filter: { termIds: [tag.id] }, empty: 'No public posts with this tag yet.' });
    }));

    router.get('/@:handle/categories/:category', wrap(async (req, res) => {
        const blog = await activeBlog(req);
        const term = blog && await store.taxonomy.bySlug(blogs.categoryVocabulary(blog), req.params.category);
        if (!term) return notFound(req, res);
        const trail = await store.taxonomy.ancestors(term.id);
        const ids = [term.id, ...(await store.taxonomy.descendants(term.id)).map((t) => t.id)];
        return await collection(req, res, { blog, heading: term.name, intro: `Posts in ${trail.map((t) => t.name).join(' › ')}.`, path: reading.urls.category(blog, term),
            crumbs: [blogCrumb(blog), ...trail.map((t, i) => (i === trail.length - 1 ? { name: t.name } : { name: t.name, url: reading.urls.category(blog, t) }))],
            filter: { termIds: ids }, empty: 'No public posts in this category yet.', hideEmpty: true });
    }));

    router.get('/@:handle/series/:series', wrap(async (req, res) => {
        const blog = await activeBlog(req);
        const series = blog && await blogs.seriesBySlug(blog, req.params.series);
        if (!series) return notFound(req, res);
        return await collection(req, res, { blog, heading: series.title, intro: series.description || `A series on ${blog.title}.`, path: reading.urls.series(blog, series),
            crumbs: [blogCrumb(blog), { name: series.title }], filter: { seriesId: series.id }, order: 'series', empty: 'No public parts of this series yet.', hideEmpty: true });
    }));

    async function personFor(who) {
        if (/^usr_/.test(who)) return await people.one(who);
        return await people.byUsername(who);
    }

    router.get('/@:handle/authors/:who', wrap(async (req, res) => {
        const blog = await activeBlog(req);
        const person = blog && await personFor(req.params.who);
        if (!person || !await blogs.membership(blog, person.subject) && !(await posts.listPublished({ blogId: blog.id, authorSubject: person.subject, limit: 1 })).total) return notFound(req, res);
        return await collection(req, res, { blog, heading: person.name, intro: `Posts by ${person.name} on ${blog.title}.`, path: reading.urls.author(person, blog),
            crumbs: [blogCrumb(blog), { name: person.name }], filter: { authorSubject: person.subject }, empty: 'No public posts by this author yet.' });
    }));

    router.get('/authors/:who', wrap(async (req, res) => {
        const person = await personFor(req.params.who);
        if (!person) return notFound(req, res);
        return await collection(req, res, { blog: null, heading: person.name, intro: `Posts by ${person.name} across openvibe.blog.`, path: reading.urls.author(person),
            crumbs: [{ name: 'OpenVibe.Blog', url: '/' }, { name: person.name }], filter: { authorSubject: person.subject }, empty: 'No public posts by this author yet.' });
    }));

    // ── Posts ───────────────────────────────────────────────

    async function commentsFor(req, blog, post, rev) {
        if (!post.allow_comments) return { state: 'disabled' };
        if (post.visibility !== 'public' || post.state !== 'published') return { state: 'restricted' };
        if (!community.enabled) return { state: 'off' };
        try {
            const threadId = await community.threadFor(post, rev.fields.title, req.ov);
            if (!threadId) return { state: 'off' };
            const data = await community.readThread(threadId, { after: req.query.comments_after, ctx: req.ov });
            return { state: 'ok', thread: data.thread, comments: data.comments || [], nextCursor: data.next_cursor, communityUrl: community.publicUrl };
        } catch (err) {
            console.warn(`[Blog] comments for ${post.id} unavailable: ${err.message}`);
            return { state: 'unavailable' };
        }
    }

    async function seriesView(blog, post) {
        const series = await blogs.seriesById(post.series_id);
        if (!series) return null;
        const { posts: rows } = await posts.listPublished({ blogId: blog.id, seriesId: series.id, limit: 50, order: 'series' });
        const revs = await store.revisions.getMany(rows.map((p) => ({ entityId: p.id, revision: p.published_revision })));
        return {
            title: series.title, url: reading.urls.series(blog, series), position: post.series_position,
            items: rows.map((p, i) => ({ title: (revs[i] || { fields: {} }).fields.title, url: publication.postPath(blog, p), current: p.id === post.id })),
        };
    }

    /** Render one post (also used by the editor's preview with a chosen revision). */
    async function renderPost(req, res, { blog, post, rev, preview = false, status = 200 }) {
        const decision = preview ? await publication.decide(blog, post, rev, { state: 'draft' }) : await publication.decide(blog, post, rev);
        const person = await people.one(post.author_subject);
        const { tags, categories } = await reading.termsView(post, blog);
        const attachments = await store.attachments.list(post.id);
        const citations = await store.citations.forRevision(post.id, rev.number);
        const rec = publication.authorshipOf(rev);
        const review = await publication.reviewOf(post, rev);
        const path = publication.postPath(blog, post);
        const firstCategory = categories[0];
        const crumbs = [blogCrumb(blog), ...(firstCategory ? (await store.taxonomy.ancestors(firstCategory.id)).map((t) => ({ name: t.name, url: reading.urls.category(blog, t) })) : []), { name: rev.fields.title }];
        const comments = preview ? null : await commentsFor(req, blog, post, rev);
        const cacheable = !preview && post.state === 'published' && post.visibility === 'public';
        const csrf = req.viewer.kind === 'user' ? csrfToken(config, req.viewer) : '';
        send(req, res, status, {
            title: rev.fields.title,
            description: rev.fields.summary || ssr.markdownToText(rev.content, 160),
            decision,
            canonical: publication.postUrl(blog, post),
            type: 'article',
            author: person.known ? person.name : undefined,
            image: (attachments.find((a) => a.role === 'cover' && !a.broken) || null) && media.urlFor(attachments.find((a) => a.role === 'cover' && !a.broken).mediaId),
            published: post.first_published_at ? new Date(post.first_published_at).toISOString() : null,
            modified: post.published_revision ? rev.createdAt : null,
            feeds: await reading.feedsOf(blog),
            theme: { slug: blog.theme, vars: blogs.themeVars(blog) },
            lang: blog.language,
            jsonLd: preview ? [] : [reading.postJsonLd({ blog, post, rev, person, tags, citations, attachments }), seo.structuredData.breadcrumbs(crumbs.map((c) => ({ name: c.name, url: c.url ? publication.abs(c.url) : publication.postUrl(blog, post) })))],
            body: pages.postPage({
                blog, blogUrl: publication.blogPath(blog), post, rev,
                author: { name: person.name, url: reading.urls.author(person, blog) },
                tags, categories, series: await seriesView(blog, post), attachments, citations,
                disclosure: rec ? authorship.disclosure(rec, review) : null,
                decisionNote: preview ? `preview · ${decision.robots}` : null,
                comments, canEdit: await access.canWrite(store, req.viewer, blog, 'edit', post),
                urlFor: media.urlFor, breadcrumbs: crumbs, jsonUrl: `${path}.json`,
                postPath: path, csrf, signedIn: req.viewer.kind === 'user' && Boolean(req.viewer.subject),
                loginUrl: `/auth/login?next=${encodeURIComponent(path)}`,
            }),
        }, { cacheable });
    }

    /**
     * 403 for a members-only post the reader may not read: the teaser (title, the author's summary)
     * and a join link to the owner's plans on OpenVibe.VIP — never the text. Private, no-store, noindex.
     */
    async function membersOnly(req, res, blog, post, decision) {
        const teaser = await reading.teaser(blog, post, { reason: decision.vip || null });
        if (req.path.endsWith('.json')) {
            cacheHeaders(res, { cacheable: false, robots: 'noindex, nofollow' });
            return res.status(403).json({ code: 'post.members_only', detail: 'Members only', teaser });
        }
        const signedIn = req.viewer.kind === 'user' && Boolean(req.viewer.subject);
        send(req, res, 403, {
            title: teaser.title ? `${teaser.title} (members only)` : 'Members only',
            description: teaser.summary || undefined,
            decision: pageDecision(req.path, { indexable: false }),
            body: pages.membersTeaser({ teaser, signedIn, loginUrl: `/auth/login?next=${encodeURIComponent(req.originalUrl)}`, unavailable: decision.vip === 'vip_unavailable' || decision.vip === 'entitlement_unknown' }),
        });
    }

    /** Resolve /@handle/:slug to a readable post, or answer (301 / 404 / 403 / 410) and return null. */
    async function resolvePost(req, res, blog, slug) {
        const post = await posts.bySlug(blog, slug);
        if (!post) {
            const path = `/@${blog.handle}/${slug}`;
            const r = await store.redirects.resolve(path, {
                currentPath: async (id) => { const p = await posts.get(id); return p && p.state !== 'deleted' ? publication.postPath(await blogs.get(p.blog_id), p) : null; },
            });
            if (r && r.status === 301) {
                const target = await posts.get(r.entityId);
                const decision = await access.canReadPost(store, req.viewer, await blogs.get(target.blog_id), target, entitlements);
                if (decision.allowed) {
                    cacheHeaders(res, { cacheable: target.state === 'published' && target.visibility === 'public' && req.viewer.kind === 'anonymous' });
                    res.redirect(301, r.location + (req.path.endsWith('.json') ? '.json' : ''));
                    return null;
                }
            }
            if ((r && r.status === 410) || await posts.deletedBySlug(blog, slug)) {
                messagePage(req, res, 410, 'Gone', 'This post was deleted.', { href: publication.blogPath(blog), label: `More from ${blog.title}` });
                return null;
            }
            notFound(req, res);
            return null;
        }
        const decision = await access.canReadPost(store, req.viewer, blog, post, entitlements);
        if (!decision.allowed) {
            if (decision.status === 403) await membersOnly(req, res, blog, post, decision);
            else notFound(req, res);
            return null;
        }
        return post;
    }

    router.get('/@:handle/:slug', wrap(async (req, res) => {
        const blog = await activeBlog(req);
        if (!blog) return notFound(req, res);
        const asJson = req.params.slug.endsWith('.json');
        const slug = asJson ? req.params.slug.slice(0, -5) : req.params.slug;
        const post = await resolvePost(req, res, blog, slug);
        if (!post) return;
        // Readers see the published revision; members looking at an unpublished post see its head.
        const rev = post.state === 'published' ? await store.revisions.get(post.id, post.published_revision) : await store.revisions.head(post.id);
        if (asJson) {
            const decision = await publication.decide(blog, post, rev);
            cacheHeaders(res, { cacheable: post.state === 'published' && post.visibility === 'public' && req.viewer.kind === 'anonymous', robots: decision.robots });
            return res.json(await reading.postJson({ blog, post, rev, person: await people.one(post.author_subject), decision }));
        }
        return await renderPost(req, res, { blog, post, rev });
    }));

    // Per-actor limit (http/actor-limits.js) before the form is read: the comment goes to Community in
    // the person's name.
    router.post('/@:handle/:slug/comments', limits.budget('blog.comment.create'), express.urlencoded({ extended: false, limit: '32kb' }), wrap(async (req, res) => {
        const blog = await activeBlog(req);
        const post = blog && await posts.bySlug(blog, req.params.slug);
        if (!post || post.state !== 'published' || post.visibility !== 'public') return notFound(req, res);
        if (req.viewer.kind !== 'user' || !req.viewer.subject) return res.redirect(303, `/auth/login?next=${encodeURIComponent(publication.postPath(blog, post))}`);
        if (!checkCsrf(config, req.viewer, req.body && req.body._csrf)) return messagePage(req, res, 403, 'Form expired', 'Reload the page and try again.');
        if (!post.allow_comments || !community.enabled) return messagePage(req, res, 409, 'Comments are off', 'This post does not take comments.');
        const message = String((req.body && req.body.message) || '').trim();
        if (!message) return res.redirect(303, `${publication.postPath(blog, post)}#comments`);
        try {
            const rev = await store.revisions.get(post.id, post.published_revision);
            const threadId = await community.threadFor(post, rev && rev.fields.title, req.ov);
            await community.comment(threadId, req.viewer.subject, { message }, req.ov);
        } catch (err) {
            return messagePage(req, res, err.status === 429 ? 429 : 502, 'Comment not posted', `OpenVibe.Community did not accept the comment: ${err.message}`);
        }
        return res.redirect(303, `${publication.postPath(blog, post)}#comments`);
    }));

    return { router, renderPost, notFound, messagePage, pageDecision, send };
}

module.exports = { createPublicRoutes, PER_PAGE };
