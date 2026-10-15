'use strict';
/**
 * The AI desks on openvibe.blog (server/desks/desks.js):
 *
 *   GET  /desks                          every desk, its latest post and feed
 *   GET  /desks/:desk                    a desk's posts (20 a page)
 *   GET  /desks/:desk/feed.xml|atom.xml  its feed (RSS 2.0, Atom); satire titles start "[Satire]"
 *   GET  /desks/:desk/:slug              one post (…/:slug.json: the same post as data)
 *   POST /desks/:desk/:slug/hide|show    staff (Network admins): take a post down or put it back
 *
 * Every page is noindex (AI text no person reviewed) and, for an anonymous visitor, publicly cacheable for a minute.
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const ssr = require('openvibe-publishing/ssr');
const cache = require('openvibe-shared/cache-policy');
const { renderPage } = require('../render/layout');
const pages = require('../render/pages');
const { csrfToken, checkCsrf } = require('../auth/forms');
const catalog = require('./catalog');
const render = require('./render');

const PER_PAGE = 20;
const NOINDEX = { indexable: false, listable: true, robots: 'noindex, follow', codes: ['ai_generated_unreviewed'] };

function createDeskRoutes(ctx) {
    const { config, store, desks, viewers } = ctx;
    const router = express.Router();
    router.use('/desks', viewers.middleware({ services: false }));
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    const abs = (p) => `${config.baseUrl}${p}`;
    const isStaff = (req) => Boolean(req.viewer && req.viewer.staff);

    function decision(path) {
        return seo.evaluate({ state: 'draft', visibility: 'public', canonicalUrl: seo.canonicalUrl(config.baseUrl, path, { query: ['page'] }), wordCount: 0, noindex: true },
            { policy: { minWords: 0 }, now: store.now() });
    }

    function send(req, res, status, page, { cacheable = true } = {}) {
        res.vary('Cookie');
        res.vary('Authorization');
        const anon = req.viewer.kind === 'anonymous';
        res.set('Cache-Control', cache.htmlHeaders(cacheable && anon && status === 200 ? { maxAge: 60 } : { private: true }));
        res.set('X-Robots-Tag', 'noindex, follow');
        res.status(status).type('html').send(renderPage({ ...page, decision: page.decision || decision(req.path), viewer: req.viewer, config, path: req.originalUrl }));
    }

    function notFound(req, res) {
        send(req, res, 404, { title: 'Not found', body: pages.message({ heading: 'Not found', text: 'There is no desk post at this address.', action: { href: '/desks', label: 'All AI desks' } }) }, { cacheable: false });
    }

    const deskOf = (req) => catalog.byKey(req.params.desk);
    const feedsOf = (desk) => [
        { type: 'application/rss+xml', href: `/desks/${desk.key}/feed.xml`, title: `${desk.title} (RSS)` },
        { type: 'application/atom+xml', href: `/desks/${desk.key}/atom.xml`, title: `${desk.title} (Atom)` },
    ];

    router.get('/desks', wrap(async (req, res) => {
        send(req, res, 200, {
            title: 'AI desks',
            description: 'Niche blogs written by AI from the data OpenVibe.Sources collects, and a satire column. Labelled, cited, never indexed.',
            canonical: abs('/desks'),
            body: render.index({ latest: await desks.latest() }),
        });
    }));

    async function feed(req, res, kind) {
        const desk = deskOf(req);
        if (!desk) return notFound(req, res);
        const { posts } = await desks.list(desk.key, { limit: 20 });
        const items = posts.map((p) => ({
            id: `tag:openvibe.blog,2026:desk/${p.id}`,
            url: abs(`/desks/${desk.key}/${p.slug}`),
            title: desk.satire ? `[Satire] ${p.title}` : p.title,
            summary: p.dek || null,
            contentHtml: render.articleBody(desk, p),
            published: new Date(p.published_at).toISOString(),
            authors: [{ name: desk.satire ? `${desk.title} (satire, written by AI)` : `${desk.title} (written by AI)` }],
            tags: desk.satire ? ['satire', ...(p.body.tags || [])] : [desk.key],
            decision: NOINDEX,
        }));
        const link = abs(`/desks/${desk.key}`);
        const feedUrl = abs(`/desks/${desk.key}/${kind === 'rss' ? 'feed.xml' : 'atom.xml'}`);
        res.set('Cache-Control', cache.htmlHeaders({ maxAge: 300 }));
        res.set('X-Robots-Tag', 'noindex, follow');
        const description = `${desk.about} Written by AI on OpenVibe.Blog.`;
        if (kind === 'rss') return res.type('application/rss+xml').send(seo.rssFeed({ title: `${desk.title} · OpenVibe.Blog`, link, description, feedUrl, language: 'en' }, items));
        return res.type('application/atom+xml').send(seo.atomFeed({ title: `${desk.title} · OpenVibe.Blog`, link, feedUrl, id: `tag:openvibe.blog,2026:desk/${desk.key}`, subtitle: description, ...(items.length ? {} : { updated: new Date(store.now()).toISOString() }) }, items));
    }
    router.get('/desks/:desk/feed.xml', wrap(async (req, res) => await feed(req, res, 'rss')));
    router.get('/desks/:desk/atom.xml', wrap(async (req, res) => await feed(req, res, 'atom')));

    router.get('/desks/:desk', wrap(async (req, res) => {
        const desk = deskOf(req);
        if (!desk) return notFound(req, res);
        const n = parseInt(req.query.page, 10);
        const page = Number.isInteger(n) && n > 0 ? Math.min(n, 10000) : 1;
        const staff = isStaff(req);
        const { total, posts } = await desks.list(desk.key, { limit: PER_PAGE, offset: (page - 1) * PER_PAGE, staff });
        const path = `/desks/${desk.key}`;
        const pager = ssr.paginate({ page, perPage: PER_PAGE, total, href: (p) => (p === 1 ? path : `${path}?page=${p}`) });
        if (pager.outOfRange && total) return notFound(req, res);
        send(req, res, 200, {
            title: desk.title, description: desk.about, canonical: abs(pager.page === 1 ? path : `${path}?page=${pager.page}`),
            feeds: feedsOf(desk), prev: pager.prev ? pager.prev.href : null, next: pager.next ? pager.next.href : null,
            body: render.deskPage({ desk, posts, pager, staff }),
        }, { cacheable: !staff });
    }));

    async function postOf(req) {
        const desk = deskOf(req);
        if (!desk) return {};
        const post = await desks.bySlug(desk.key, req.params.slug);
        if (!post || !(post.status === 'published' || (post.status === 'hidden' && isStaff(req)))) return { desk };
        return { desk, post };
    }

    const jsonView = (desk, p) => ({
        id: p.id, desk: desk.key, desk_title: desk.title, satire: Boolean(desk.satire), slug: p.slug, url: abs(`/desks/${desk.key}/${p.slug}`),
        title: p.title, dek: p.dek, published_at: new Date(p.published_at).toISOString(),
        period: desk.satire ? null : { from: new Date(p.period_from).toISOString(), to: new Date(p.period_to).toISOString() },
        authorship: { mode: 'ai', reviewed: false, workflow: desk.satire ? 'blog.write_satire' : 'blog.write_digest', run_id: p.run_id, model: p.model },
        ...(desk.satire ? { body_markdown: p.body.markdown, tags: p.body.tags || [] } : { sections: p.body.sections, gaps: p.body.gaps || [], sources: p.sources }),
    });

    router.get('/desks/:desk/:slug.json', wrap(async (req, res) => {
        const { desk, post } = await postOf(req);
        if (!post || post.status !== 'published') return res.status(404).json({ code: 'desk.not_found', detail: 'No desk post at this address' });
        res.set('Cache-Control', cache.htmlHeaders({ maxAge: 60 }));
        res.set('X-Robots-Tag', 'noindex');
        res.set('Access-Control-Allow-Origin', '*');
        res.json({ post: jsonView(desk, post) });
    }));

    router.get('/desks/:desk/:slug', wrap(async (req, res) => {
        const { desk, post } = await postOf(req);
        if (!post) return notFound(req, res);
        const staff = isStaff(req);
        send(req, res, 200, {
            title: desk.satire ? `${post.title} (satire)` : post.title,
            description: desk.satire ? `Satire, written by AI: ${post.dek || desk.about}` : (post.dek || desk.about),
            canonical: abs(`/desks/${desk.key}/${post.slug}`),
            type: 'article', feeds: feedsOf(desk),
            published: new Date(post.published_at).toISOString(),
            body: render.postPage({ desk, post, staff, csrf: staff ? csrfToken(config, req.viewer) : '' }),
        }, { cacheable: !staff && post.status === 'published' });
    }));

    for (const action of ['hide', 'show']) {
        router.post(`/desks/:desk/:slug/${action}`, express.urlencoded({ extended: false, limit: '8kb' }), wrap(async (req, res) => {
            if (!isStaff(req)) return send(req, res, 403, { title: 'Staff only', body: pages.message({ heading: 'Staff only', text: 'Only OpenVibe staff can hide or show a desk post.' }) }, { cacheable: false });
            if (!checkCsrf(config, req.viewer, req.body && req.body._csrf)) return send(req, res, 403, { title: 'Form expired', body: pages.message({ heading: 'Form expired', text: 'Reload the page and try again.' }) }, { cacheable: false });
            const { desk, post } = await postOf(req);
            if (!post) return notFound(req, res);
            await desks.setHidden(post, action === 'hide', { by: req.viewer.subject, reason: req.body.reason });
            res.redirect(303, `/desks/${desk.key}/${post.slug}`);
        }));
    }

    return router;
}

module.exports = { createDeskRoutes };
