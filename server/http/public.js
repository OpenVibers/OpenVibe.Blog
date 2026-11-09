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
const cache = require('openvibe-shared/cache-policy');
const { renderPage, SITE_SUMMARY } = require('../render/layout');
const pages = require('../render/pages');
const blockRender = require('../render/blocks');
const homePage = require('../render/home');
// The short home (the owner's rule, 2026-10-30): pick blocks and folds.
const { foldBlock } = require('../render/short');
const { createHome } = require('../domain/home');

// The home's own words in search results and share cards (the official blog's later pages keep the blog's).
const HOME_TITLE = 'OpenVibe.Blog: start a blog, read what OpenVibe ships';
const HOME_DESCRIPTION = 'Start a blog with drafts, scheduling, feeds and comments on your OpenVibe account. Read OpenVibe\'s patch notes and AI digests of the news.';
const { csrfToken, checkCsrf } = require('../auth/forms');

const PER_PAGE = 15;

function createPublicRoutes(ctx) {
    const { config, store, blogs, posts, publication, reading, people, community, media, access, entitlements, viewers, limits, desks, sharing } = ctx;
    const changelog = ctx.changelog || null;
    const homeData = ctx.home || createHome({ store });
    const router = express.Router();
    router.use(viewers.middleware({ services: false }));

    // ── Helpers ─────────────────────────────────────────────

    function cacheHeaders(res, { cacheable, robots }) {
        res.vary('Cookie');
        res.vary('Authorization');
        res.vary('Accept');
        if (cacheable) res.set('Cache-Control', cache.htmlHeaders({ maxAge: 60 }));
        else res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (robots && robots !== 'index, follow') res.set('X-Robots-Tag', robots);
    }

    function send(req, res, status, page, { cacheable = false } = {}) {
        cacheHeaders(res, { cacheable: cacheable && req.viewer.kind === 'anonymous' && status === 200, robots: page.decision.robots });
        // The public pages with a Markdown twin (server/agent-pages.js) name it in the head and in the Link header.
        const canonical = page.canonical || `${config.baseUrl}${req.path}`;
        const hasTwin = status === 200 && require('../agent-pages').TWIN_PATH_RE.test(req.path);
        const head = hasTwin ? require('openvibe-shared/agent-layer').linkHeaderTags(canonical, `${config.baseUrl}/llms.txt`) : null;
        if (head) res.set('Link', head.header);
        res.status(status).type('html').send(renderPage({ ...page, viewer: req.viewer, config, path: req.originalUrl, head: head ? head.head : '' }));
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

    // The highest page a listing will query: a pathological ?page= must never reach LIMIT's OFFSET.
    const MAX_PAGE = 10000;

    function pageNumber(req) {
        const n = parseInt(req.query.page, 10);
        return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_PAGE) : 1;
    }

    async function activeBlog(req) {
        const blog = await blogs.byHandle(req.params.handle);
        if (!blog) return null;
        if (blog.status !== 'active' && !access.isStaff(req.viewer)) return null;
        return blog;
    }

    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

    // ── Blog front pages ────────────────────────────────────

    /**
     * The index's rows: the official blog's posts as the tabs and the name filter narrow them. The tabs
     * are categories (Devblog, Daily, Community, Guides); a tab whose category does not exist yet is
     * empty, not hidden — every tab is a real, crawlable link.
     */
    async function indexData(req, blog, base, { network = false, service = null } = {}) {
        const page = pageNumber(req);
        const scope = network ? { restricted: false } : await access.listingScope(store, req.viewer, blog);
        const wanted = String(req.query.tab || 'latest').toLowerCase();
        const tab = homePage.INDEX_TABS.find((t) => t.id === wanted) || homePage.INDEX_TABS[0];
        const q = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const term = tab.slug ? await store.taxonomy.bySlug(blogs.categoryVocabulary(blog), tab.slug) : null;
        // A tab names a category. Until that category has a post there is nothing to list: falling back to
        // the unfiltered index would show every post under a tab that promises one kind.
        const tabEmpty = !network && Boolean(tab.slug && !term);
        const filters = network ? { blogId: null, categorySlug: tab.slug || 'devblog', service } : { blogId: blog.id, ...(term ? { termIds: [term.id] } : {}) };
        let rows;
        let total;
        if (tabEmpty) {
            rows = [];
            total = 0;
        } else if (q) {
            // A name filter is over the titles people see: a bounded read, filtered in place. The index is
            // small by design (a blog's published posts), and the unfiltered listing keeps its SQL pager.
            const all = await posts.listPublished({ ...filters, ...scope, limit: 500 });
            const revs = await store.revisions.getMany(all.posts.map((p) => ({ entityId: p.id, revision: p.published_revision })));
            const needle = q.toLowerCase();
            const matched = all.posts.filter((p, i) => revs[i] && String((revs[i].fields || {}).title || '').toLowerCase().includes(needle));
            total = matched.length;
            rows = matched.slice((page - 1) * PER_PAGE, page * PER_PAGE);
        } else {
            ({ total, posts: rows } = await posts.listPublished({ ...filters, ...scope, limit: PER_PAGE, offset: (page - 1) * PER_PAGE }));
        }
        const pager = ssr.paginate({
            page, perPage: PER_PAGE, total,
            href: (p) => {
                const params = new URLSearchParams();
                if (p > 1) params.set('page', String(p));
                if (tab.id !== 'latest') params.set('tab', tab.id);
                if (q) params.set('q', q);
                const s = params.toString();
                return s ? `${base}?${s}` : base;
            },
        });
        return { page, tab, q, term, items: await reading.listItems(rows), pager, feeds: await reading.feedsOf(blog), scope };
    }

    // The network's home (the official blog's first page and /devblog): the newest post as a featured
    // hero, the tabs, the name filter and the archive as art cards, then everything else the home shows.
    async function homeIndex(req, res, blog) {
        const { tab, q, items, pager, feeds, scope } = await indexData(req, blog, '/');
        if (pager.outOfRange && pager.total) return notFound(req, res);
        const path = publication.blogPath(blog);
        const blogLd = { '@context': 'https://schema.org', '@type': 'Blog', '@id': `${publication.abs(path)}#blog`, name: blog.title, url: publication.abs(path), description: blog.description || undefined, publisher: { '@type': 'Organization', name: 'OpenVibe', url: 'https://openvibe.network' } };
        // Series are named only when they hold a post this viewer may see.
        const shows = async (filter) => (await posts.listPublished({ ...filter, blogId: blog.id, ...scope, limit: 1 })).total > 0;
        const seriesShown = [];
        for (const sr of await blogs.series(blog)) if (await shows({ seriesId: sr.id })) seriesShown.push(sr);
        const [stats, week, latestDesks, tags, memberRows, seriesCounts] = await Promise.all([
            homeData.stats(), homeData.weekChanges(10), desks ? desks.latest() : new Map(), homeData.topTags(24), homeData.memberPosts(6),
            Promise.all(seriesShown.map(async (sr) => ({ title: sr.title, url: `/@${blog.handle}/series/${encodeURIComponent(sr.slug)}`, posts: (await posts.listPublished({ blogId: blog.id, seriesId: sr.id, ...scope, limit: 1 })).total }))),
        ]);
        const memberItems = memberRows.length ? await reading.listItems(memberRows) : [];
        const canonical = seo.canonicalUrl(config.baseUrl, '/', { query: ['page', 'tab', 'q'] });
        return send(req, res, 200, {
            title: blog.title, fullTitle: HOME_TITLE, description: HOME_DESCRIPTION, summary: SITE_SUMMARY,
            decision: pageDecision(canonical, { empty: false, query: ['page', 'tab', 'q'] }),
            canonical, feeds, theme: { slug: blog.theme, vars: blogs.themeVars(blog) }, lang: blog.language,
            next: pager.next ? pager.next.href : null,
            jsonLd: [blogLd, ...homePage.homeJsonLd({ base: config.baseUrl.replace(/\/+$/, ''), items })],
            styles: [showcase.STYLESHEET], bodyClass: 'blog-home',
            body: homePage.homeBody({ blog, items, pager, feeds, stats, week, latestDesks, tags, series: seriesCounts, memberItems, signedIn: req.viewer.kind === 'user', index: { tab: tab.id, q, base: '/' } })
                // The shipped list is a part a reader rarely needs: a fold on a phone, the section it was where there is room.
                + foldBlock({ id: 'shipped', head: '<h2 id="bh-shipped-h">Recently shipped on OpenVibe.Blog</h2>', html: frame.shipped({ service: 'blog', title: 'Recently shipped on OpenVibe.Blog' }) }),
        }, { cacheable: !scope.restricted && !scope.restrictedAuthor });
    }

    async function blogFront(req, res, blog, { home = false } = {}) {
        const page = pageNumber(req);
        if (home && page === 1) return await homeIndex(req, res, blog);
        const scope = await access.listingScope(store, req.viewer, blog);
        const path = publication.blogPath(blog);
        const { total, posts: rows } = await posts.listPublished({ blogId: blog.id, ...scope, limit: PER_PAGE, offset: (page - 1) * PER_PAGE });
        const pager = ssr.paginate({ page, perPage: PER_PAGE, total, href: (p) => (p === 1 ? path : `${path}?page=${p}`) });
        if (pager.outOfRange && total) return notFound(req, res);
        const items = await reading.listItems(rows);
        const canonical = seo.canonicalUrl(config.baseUrl, pager.page === 1 ? path : `${path}?page=${pager.page}`, { query: ['page'] });
        const feeds = await reading.feedsOf(blog);
        // Series and categories are named when a draft or restricted post uses them: list only those
        // holding a post this viewer may see in the list, so their names never leak ahead of a post.
        const shows = async (filter) => (await posts.listPublished({ ...filter, blogId: blog.id, ...scope, limit: 1 })).total > 0;
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
        const blogLd = blog.kind === 'official'
            ? { '@context': 'https://schema.org', '@type': 'Blog', '@id': `${publication.abs(path)}#blog`, name: blog.title, url: publication.abs(path), description: blog.description || undefined, publisher: { '@type': 'Organization', name: 'OpenVibe', url: 'https://openvibe.network' } }
            : { '@context': 'https://schema.org', '@type': 'Blog', '@id': `${publication.abs(path)}#blog`, name: blog.title, url: publication.abs(path), description: blog.description || undefined };
        send(req, res, 200, {
            title: blog.title,
            description: blog.description,
            // The network blog's home carries the site summary an AI can read (ai-summary meta + WebPage JSON-LD).
            ...(home ? { summary: SITE_SUMMARY } : {}),
            decision: pageDecision(canonical, { empty: total === 0, query: ['page'] }),
            canonical,
            feeds,
            theme: { slug: blog.theme, vars: blogs.themeVars(blog) },
            lang: blog.language,
            prev: pager.prev ? pager.prev.href : null,
            next: pager.next ? pager.next.href : null,
            jsonLd: [blogLd],
            body: pages.blogIndex({
                blog, blogUrl: `/@${blog.handle}`, items, pager, feeds,
                series: seriesShown, categories: await prune(await reading.categoriesTree(blog)),
                canWrite: await access.canWrite(store, req.viewer, blog, 'create'),
            }),
        }, { cacheable: !scope.restricted && !scope.restrictedAuthor });
    }

    router.get('/', wrap(async (req, res) => await blogFront(req, res, await blogs.official(), { home: true })));

    // The devblog index on its own address: the same newest-first featured post, tabs, filter and art
    // cards the official blog's home shows, with nothing else. Every tab and every page is a real link.
    router.get(['/devblog', '/devblog/:service'], wrap(async (req, res) => {
        const blog = await blogs.official();
        const base = req.params.service ? `/devblog/${encodeURIComponent(req.params.service)}` : '/devblog';
        const { tab, q, items, pager } = await indexData(req, blog, base, { network: true, service: req.params.service || null });
        if (pager.outOfRange && pager.total) return notFound(req, res);
        const canonical = seo.canonicalUrl(config.baseUrl, base, { query: ['page', 'tab', 'q'] });
        const blogLd = { '@context': 'https://schema.org', '@type': 'Blog', '@id': `${publication.abs('/devblog')}#blog`, name: 'OpenVibe Devblog', url: publication.abs('/devblog'), publisher: { '@type': 'Organization', name: 'OpenVibe', url: 'https://openvibe.network' } };
        return send(req, res, 200, {
            title: 'Devblog',
            description: 'Named updates from the OpenVibe team: what changed, why we did it, and what it means for you.',
            decision: pageDecision(canonical, { empty: items.length === 0, query: ['page', 'tab', 'q'] }),
            canonical, feeds: await reading.feedsOf(blog), theme: { slug: blog.theme, vars: blogs.themeVars(blog) }, lang: blog.language,
            prev: pager.prev ? pager.prev.href : null, next: pager.next ? pager.next.href : null,
            jsonLd: [blogLd, ...homePage.homeJsonLd({ base: config.baseUrl.replace(/\/+$/, ''), items })],
            styles: [showcase.STYLESHEET], bodyClass: 'blog-devbog',
            body: `<div class="bh-devbog"><header class="bh-devbog-head"><h1>OpenVibe Devblog</h1><p class="lede">Named updates from the team: what changed, why we did it, and what it means for you.</p></header>${homePage.indexList({ base, tab: tab.id, q, items, pager })}</div>`,
        }, { cacheable: true });
    }));

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
        const scope = blog ? await access.listingScope(store, req.viewer, blog) : {};
        const { total, posts: rows } = await posts.listPublished({ ...filter, blogId: blog ? blog.id : null, ...scope, limit: PER_PAGE, offset: (page - 1) * PER_PAGE, order });
        // A series or category named only by drafts or posts this viewer cannot see does not exist for them.
        if (hideEmpty && !total) return notFound(req, res);
        const pager = ssr.paginate({ page, perPage: PER_PAGE, total, href: (p) => (p === 1 ? path : `${path}?page=${p}`) });
        if (pager.outOfRange && total) return notFound(req, res);
        const items = await reading.listItems(rows, { perBlogLinks: Boolean(blog) });
        const canonical = seo.canonicalUrl(config.baseUrl, pager.page === 1 ? path : `${path}?page=${pager.page}`, { query: ['page'] });
        // The meta description adds how many posts and the newest titles: "Posts tagged ai on The OpenVibe blog." alone
        // (37 characters) said the same of every tag, author and category page.
        const newest = items.slice(0, 2).map((it) => String((it.rev && it.rev.fields && it.rev.fields.title) || '').trim()).filter(Boolean).map((t) => `“${t}”`);
        const counted = total ? ` ${total} post${total === 1 ? '' : 's'}${newest.length ? `, newest ${newest.join(' and ')}` : ''}.` : '';
        const fullText = `${intro}${counted}`;
        const description = fullText.length <= 160 ? fullText : `${fullText.slice(0, 159).replace(/\s+\S*$/, '')}…`;
        send(req, res, 200, {
            title: heading, description, canonical,
            decision: pageDecision(canonical, { empty: total === 0, query: ['page'] }),
            theme: blog ? { slug: blog.theme, vars: blogs.themeVars(blog) } : null,
            prev: pager.prev ? pager.prev.href : null, next: pager.next ? pager.next.href : null,
            jsonLd: [seo.structuredData.breadcrumbs(crumbs.map((c) => ({ name: c.name, url: c.url ? publication.abs(c.url) : canonical })))],
            body: pages.collection({ heading, intro, breadcrumbs: crumbs, items, pager, empty }),
        }, { cacheable: !scope.restricted && !scope.restrictedAuthor });
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

    /**
     * The series around this post: its place in the whole series, the previous and next parts, and up to 11 parts
     * around it for the fold. Every part's row is read (they are small), but titles only for the parts shown.
     */
    async function seriesView(blog, post) {
        const series = await blogs.seriesById(post.series_id);
        if (!series) return null;
        const { posts: rows, total } = await posts.listPublished({ blogId: blog.id, seriesId: series.id, limit: 5000, order: 'series' });
        const at = rows.findIndex((p) => p.id === post.id);
        const from = at < 0 ? 0 : Math.max(0, Math.min(at - 5, rows.length - 11));
        const shown = rows.slice(from, from + 11);
        const near = [at > 0 ? rows[at - 1] : null, at >= 0 && at + 1 < rows.length ? rows[at + 1] : null];
        const want = [...shown, ...near.filter(Boolean)];
        const revs = await store.revisions.getMany(want.map((p) => ({ entityId: p.id, revision: p.published_revision })));
        const titleOf = new Map(want.map((p, i) => [p.id, (revs[i] || { fields: {} }).fields.title]));
        const part = (p) => (p ? { title: titleOf.get(p.id), url: publication.postPath(blog, p) } : null);
        return {
            title: series.title, url: reading.urls.series(blog, series),
            position: post.series_position || (at >= 0 ? at + 1 : null),
            total: Number(total) || rows.length, start: from + 1,
            prev: part(near[0]), next: part(near[1]),
            items: shown.map((p) => ({ title: titleOf.get(p.id), url: publication.postPath(blog, p), current: p.id === post.id })),
        };
    }

    /**
     * The patch notes of a window: the commits that shipped between two dates, grouped by site, each
     * commit linked. This is what a ":::patchnotes{from=… to=…}" block shows.
     */
    async function patchNotesFor(blog, post, from, to) {
        if (!changelog || !changelog.entries) return [];
        const slot = await store.db.prepare('SELECT service FROM blog_devblog_slots WHERE post_id = ?').get(post.id);
        const rows = await store.db.prepare(`SELECT * FROM changelog_entries WHERE deployed_at >= ? AND deployed_at < ? ${slot ? 'AND service = ?' : ''} ORDER BY deployed_at, id`).all(from || '1970-01-01', to ? new Date(Date.parse(to) + 86400000).toISOString().slice(0, 10) : '9999-01-01', ...(slot ? [slot.service] : []));
        const lo = from ? Date.parse(String(from) + 'T00:00:00Z') : null;
        const hi = to ? Date.parse(String(to) + 'T23:59:59Z') : null;
        const groups = new Map();
        for (const e of rows) {
            const at = Date.parse(e.deployed_at || e.committed_at || '');
            if (!Number.isFinite(at)) continue;
            if (lo !== null && at < lo) continue;
            if (hi !== null && at > hi) continue;
            if (!groups.has(e.service)) groups.set(e.service, []);
            groups.get(e.service).push({ sha: e.sha.slice(0, 7), url: `https://github.com/${e.repo}/commit/${e.sha}`, title: e.subject });
        }
        return [...groups.entries()].map(([site, commits]) => ({ site, commits }));
    }

    /** Render one post (also used by the editor's preview with a chosen revision). */
    async function renderPost(req, res, { blog, post, rev, preview = false, status = 200 }) {
        const decision = preview ? await publication.decide(blog, post, rev, { state: 'draft' }) : await publication.decide(blog, post, rev);
        const person = await people.one(post.author_subject);
        const { tags, categories } = await reading.termsView(post, blog);
        const attachments = await store.attachments.list(post.id);
        const citations = await store.citations.forRevision(post.id, rev.number);
        const rec = publication.authorshipOf(rev);
        const kinds = await publication.reviewsOf(post, rev);
        const path = publication.postPath(blog, post);
        const firstCategory = categories[0];
        const crumbs = [blogCrumb(blog), ...(firstCategory ? (await store.taxonomy.ancestors(firstCategory.id)).map((t) => ({ name: t.name, url: reading.urls.category(blog, t) })) : []), { name: rev.fields.title }];
        const comments = preview ? null : await commentsFor(req, blog, post, rev);
        const cacheable = !preview && post.state === 'published' && post.visibility === 'public';
        // The sections and the hero art of the body: the contents rail, the JSON-LD parts and the
        // picture a reader sees when the post is shared.
        const bodyTree = blockRender.bodyBlocks(rev.content);
        const bodySections = blockRender.sectionsOf(bodyTree);
        const bodyHero = blockRender.heroOf(bodyTree);
        const bodyHeroArt = bodyHero && bodyHero.attrs && typeof bodyHero.attrs.art === 'string' ? bodyHero.attrs.art : null;
        // Section bylines and folded patch notes resolve before the renderer runs (it renders
        // synchronously): one person lookup per subject, one change lookup per window, never a
        // promise left to be printed as "The OpenVibe team".
        const byPeople = new Map();
        for (const s of bodySections) {
            if (s.by && !byPeople.has(s.by)) byPeople.set(s.by, await people.one(s.by));
        }
        const windows = new Map();
        for (const w of blockRender.patchNoteWindows(bodyTree)) {
            const key = `${w.from || ''}..${w.to || ''}`;
            if (!windows.has(key)) windows.set(key, await patchNotesFor(blog, post, w.from, w.to));
        }
        const csrf = req.viewer.kind === 'user' ? csrfToken(config, req.viewer) : '';
        send(req, res, status, {
            title: rev.fields.title,
            bodyClass: 'post-page',
            description: rev.fields.summary || ssr.markdownToText(rev.content, 160),
            decision,
            canonical: publication.postUrl(blog, post),
            type: 'article',
            author: person.known ? person.name : undefined,
            image: bodyHeroArt ? media.urlFor(bodyHeroArt) : ((attachments.find((a) => a.role === 'cover' && !a.broken) || null) && media.urlFor(attachments.find((a) => a.role === 'cover' && !a.broken).mediaId)),
            published: post.first_published_at ? new Date(post.first_published_at).toISOString() : null,
            modified: post.published_revision ? rev.createdAt : null,
            feeds: await reading.feedsOf(blog),
            theme: { slug: blog.theme, vars: blogs.themeVars(blog) },
            lang: blog.language,
            jsonLd: preview ? [] : [reading.postJsonLd({ blog, post, rev, person, tags, citations, attachments, sections: bodySections, heroArt: bodyHeroArt }), seo.structuredData.breadcrumbs(crumbs.map((c) => ({ name: c.name, url: c.url ? publication.abs(c.url) : publication.postUrl(blog, post) })))],
            body: pages.postPage({
                blog, blogUrl: publication.blogPath(blog), post, rev,
                author: { name: person.name, url: reading.urls.author(person, blog) },
                tags, categories, series: await seriesView(blog, post), attachments, citations,
                disclosure: rec ? publication.disclosure(rec, kinds) : null,
                decisionNote: preview ? `preview · ${decision.robots}` : null,
                comments, canEdit: await access.canWrite(store, req.viewer, blog, 'edit', post),
                urlFor: media.urlFor, shareUrl: publication.postUrl(blog, post), breadcrumbs: crumbs, jsonUrl: `${path}.json`,
                postPath: path, csrf, signedIn: req.viewer.kind === 'user' && Boolean(req.viewer.subject),
                loginUrl: `/auth/login?next=${encodeURIComponent(path)}`,
                bodyOptions: {
                    urlFor: media.urlFor, rel: blog.kind === 'official' ? 'noopener' : 'nofollow ugc noopener',
                    reactions: await community.sectionReactions(post, req.ov),
                    reactionAction: path + '/react',
                    csrf, signedIn: req.viewer.kind === 'user' && Boolean(req.viewer.subject),
                    loginUrl: `/auth/login?next=${encodeURIComponent(path)}`,
                    path,
                    person: (subject) => {
                        const p = byPeople.get(subject);
                        return p && p.known ? { name: p.name, url: reading.urls.author(p, blog) } : null;
                    },
                    patchNotes: (from, to) => windows.get(`${from || ''}..${to || ''}`) || [],
                },
            }),
            styles: ['kit.css'],
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
                const decision = await access.canReadPost(store, req.viewer, await blogs.get(target.blog_id), target, entitlements, sharing);
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
        const decision = await access.canReadPost(store, req.viewer, blog, post, entitlements, sharing);
        if (!decision.allowed) {
            if (decision.status === 403) await membersOnly(req, res, blog, post, decision);
            else if (decision.reason === 'private' && sharing) {
                // The gate: the audience, never the title, text or pictures. "Ask for access" when signed in.
                const s = await sharing.shareOf(post.id).catch(() => null);
                if (s && s.audience === 'people') {
                    send(req, res, 404, {
                        title: 'A post on OpenVibe.Blog',
                        description: 'A post shared with specific people on OpenVibe.Blog.',
                        decision: pageDecision(req.path, { indexable: false }),
                        body: pages.sharedGate({ id: post.id, signedInAs: req.viewer && req.viewer.user && req.viewer.user.username ? req.viewer.user.username : null,
                            signInUrl: `/auth/login?next=${encodeURIComponent(req.originalUrl)}` }),
                    });
                    return null;
                }
            }
            notFound(req, res);
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

    // A reader's reaction to one section of a post (👍 or 👎). The form posts without script: it
    // lands here, the counts go to Community, and the reader is back on the page.
    router.post('/@:handle/:slug/react', express.urlencoded({ extended: false, limit: '4kb' }), wrap(async (req, res) => {
        const blog = await activeBlog(req);
        if (!blog) return notFound(req, res);
        const post = await posts.bySlug(blog, req.params.slug);
        if (!post || post.state !== 'published' || post.visibility !== 'public') return notFound(req, res);
        if (req.viewer.kind !== 'user' || !req.viewer.subject) return res.redirect(303, `/auth/login?next=${encodeURIComponent(publication.postPath(blog, post))}`);
        if (!checkCsrf(config, req.viewer, req.body && req.body._csrf)) return messagePage(req, res, 403, 'Form expired', 'Reload the page and try again.');
        const section = String((req.body && req.body.section) || '').trim();
        const value = String((req.body && req.body.reaction) || '').trim().toLowerCase() === 'up' ? 1 : -1;
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(section)) return messagePage(req, res, 400, 'Unknown section', 'That is not a section of this post.');
        try {
            await community.reactToSection(post, null, req.viewer.subject, section, value, req.ov);
        } catch (err) {
            return messagePage(req, res, err.status === 429 ? 429 : 502, 'Reaction not recorded', `OpenVibe.Community did not accept the reaction: ${err.message}`);
        }
        return res.redirect(303, `${publication.postPath(blog, post)}#${encodeURIComponent(section)}`);
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
