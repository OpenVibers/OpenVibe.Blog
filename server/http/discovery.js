'use strict';

/**
 * Crawl and machine-readability artifacts (roadmap §32.4/§32.5):
 *
 *   GET /robots.txt             sitemap location + explicit automated-consumer policy
 *   GET /llms.txt               orientation for language models (what the site is, entry points)
 *   GET /llms-full.txt          the same header plus an excerpt of every indexable post (never the body)
 *   GET /sitemap.xml            sitemap index over the two sections below
 *   GET /sitemaps/posts.xml     published, public, INDEXABLE posts only (the gate decides), lastmod
 *                               = the published revision's real time
 *   GET /sitemaps/blogs.xml     blog front pages and series pages that have indexable posts
 *
 * Built from the database on every request, never from the viewer: drafts, scheduled, unlisted,
 * members/VIP, private, unpublished, deleted and noindex posts can never appear.
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const ssr = require('openvibe-publishing/ssr');
const sharedSeo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { SITE_SUMMARY } = require('../render/layout');

function createDiscoveryRoutes({ config, store, blogs, publication, reading }) {
    const router = express.Router();
    const { db } = store;
    const abs = (p) => seo.canonicalUrl(config.baseUrl, p);

    const publicPosts = async () => await db.prepare(`SELECT p.* FROM blog_posts p JOIN blogs b ON b.id = p.blog_id
                                          WHERE p.state = 'published' AND p.visibility = 'public' AND b.status = 'active'
                                          ORDER BY p.published_at DESC LIMIT 50000`).all();

    async function postEntries() {
        // Revisions and reviews in one query each, and each blog once, whatever the number of posts
        // (no per-post N+1: the gate's review lookup is batched, not one round-trip per post).
        const rows = await publicPosts();
        const refs = rows.map((p) => ({ entityId: p.id, revision: p.published_revision }));
        const [revs, reviews] = await Promise.all([store.revisions.getMany(refs), store.reviews.latestMany(refs)]);
        const blogById = new Map();
        for (const id of new Set(rows.map((p) => p.blog_id))) blogById.set(id, await blogs.get(id));
        return await Promise.all(rows.map(async (post, i) => {
            const blog = blogById.get(post.blog_id);
            return { post, blog, rev: revs[i], decision: await publication.decide(blog, post, revs[i], { review: reviews[i] }) };
        }));
    }

    const xml = (res, body) => res.type('application/xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 300 })).send(body);

    router.get('/robots.txt', (_req, res) => {
        const body = [
            '# openvibe.blog automated-consumer policy: search engines and AI crawlers are welcome to read',
            '# public posts, feeds and sitemaps. Drafts, the editor, sign-in and the API are not for crawling.',
            '# Pages decide their own indexability (meta robots / X-Robots-Tag); a Disallow is not a noindex.',
            sharedSeo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: ['/write', '/auth/', '/api/'] }),
        ].join('\n');
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(body);
    });

    router.get('/llms.txt', async (_req, res) => {
        const official = await blogs.official();
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sharedSeo.llmsTxt({
            name: 'OpenVibe.Blog',
            summary: SITE_SUMMARY,
            details: 'Only public, published posts are listed, fed or mapped. Every post page has a machine-readable twin at <post URL>.json with the same content, its revision, authorship (human, AI-assisted or AI-generated, and whether a person reviewed it), sources and indexability reasons. AI-generated drafts are never published or indexed before a person reviews them.',
            sections: [
                { title: 'Start here', links: [
                    { title: official ? official.title : 'The OpenVibe blog', url: abs('/'), note: 'official announcements and release notes' },
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                ] },
                { title: 'Feeds', links: [
                    { title: 'RSS', url: abs('/feed.xml') }, { title: 'Atom', url: abs('/atom.xml') }, { title: 'JSON Feed', url: abs('/feed.json') },
                    { title: 'Member blogs', url: abs('/sitemaps/blogs.xml'), note: 'each member blog has /@handle/feed.xml, /@handle/atom.xml and /@handle/feed.json' },
                ] },
                { title: 'Data', links: [{ title: 'Post JSON', url: abs('/'), note: 'append .json to any post URL (/@handle/slug.json)' }] },
            ],
        }));
    });

    router.get('/llms-full.txt', async (_req, res) => {
        // Only public, published, indexable posts (the sitemap's gate), each as its summary — or a
        // clipped excerpt when the author wrote no summary. Full post bodies are never included.
        const posts = (await postEntries()).filter((e) => e.decision.indexable).map((e) => ({
            title: e.post.title,
            url: publication.postUrl(e.blog, e.post),
            text: e.rev.fields.summary || ssr.markdownToText(e.rev.content || '', 160),
        }));
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sharedSeo.llmsFull({
            site: 'OpenVibe.Blog',
            summary: SITE_SUMMARY,
            base: config.baseUrl,
            maxBytes: 512 * 1024,
            sections: [{ title: 'Posts', pages: posts }],
        }));
    });

    router.get('/sitemap.xml', async (_req, res) => {
        const entries = (await postEntries()).filter((e) => e.decision.indexable);
        const newest = entries.length ? entries.map((e) => e.rev.createdAt).sort().pop() : null;
        xml(res, seo.sitemapIndex([
            { loc: abs('/sitemaps/posts.xml'), ...(newest ? { lastmod: newest } : {}) },
            { loc: abs('/sitemaps/blogs.xml'), ...(newest ? { lastmod: newest } : {}) },
        ]));
    });

    router.get('/sitemaps/posts.xml', async (_req, res) => {
        const out = seo.sitemap((await postEntries()).map((e) => ({ loc: publication.postUrl(e.blog, e.post), lastmod: e.rev.createdAt, decision: e.decision })));
        xml(res, out.files[0]);
    });

    router.get('/sitemaps/blogs.xml', async (_req, res) => {
        const byBlog = new Map();
        const bySeries = new Map();
        for (const e of await postEntries()) {
            if (!e.decision.indexable) continue;
            const t = e.rev.createdAt;
            if (!byBlog.has(e.blog.id) || byBlog.get(e.blog.id).lastmod < t) byBlog.set(e.blog.id, { blog: e.blog, lastmod: t });
            if (e.post.series_id && (!bySeries.has(e.post.series_id) || bySeries.get(e.post.series_id).lastmod < t)) bySeries.set(e.post.series_id, { blog: e.blog, lastmod: t });
        }
        const listing = (path) => seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: abs(path), wordCount: 0 }, { policy: { minWords: 0 }, now: store.now() });
        const entries = [];
        for (const { blog, lastmod } of byBlog.values()) {
            const path = publication.blogPath(blog);
            entries.push({ loc: abs(path), lastmod, decision: listing(path) });
        }
        for (const [id, { blog, lastmod }] of bySeries) {
            const s = await blogs.seriesById(id);
            if (!s) continue;
            const path = reading.urls.series(blog, s);
            entries.push({ loc: abs(path), lastmod, decision: listing(path) });
        }
        xml(res, seo.sitemap(entries).files[0]);
    });

    return router;
}

module.exports = { createDiscoveryRoutes };
