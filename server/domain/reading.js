'use strict';

/**
 * Read models shared by the pages, the JSON representations, the feeds and the sitemaps: URLs for
 * every collection, list items with their authors and tags, feed items, and the category tree.
 * Nothing here decides access — callers pass rows they may show.
 */
const seo = require('openvibe-publishing/seo');
const ssr = require('openvibe-publishing/ssr');
const authorship = require('openvibe-publishing/authorship');
const { renderBody } = require('../render/pages');

function createReading({ store, blogs, posts: postsApi, publication, people, media }) {
    const { db } = store;

    const blogPath = (blog) => publication.blogPath(blog);
    const base = (blog) => `/@${blog.handle}`;
    const urls = {
        blog: blogPath,
        tag: (tag, blog = null) => (blog ? `${base(blog)}/tags/${tag.slug}` : `/tags/${tag.slug}`),
        category: (blog, term) => `${base(blog)}/categories/${term.slug}`,
        series: (blog, s) => `${base(blog)}/series/${s.slug}`,
        author: (person, blog = null) => `${blog ? base(blog) : ''}/authors/${encodeURIComponent(person.username || person.subject)}`,
        feed: (blog, kind) => `${blog.kind === 'official' ? '' : base(blog)}/${{ rss: 'feed.xml', atom: 'atom.xml', json: 'feed.json' }[kind]}`,
    };

    function feedsOf(blog) {
        const s = blogs.feedSettings(blog);
        const out = [];
        if (s.rss) out.push({ type: 'rss', href: urls.feed(blog, 'rss'), title: `${blog.title} (RSS)`, label: 'RSS', mime: 'application/rss+xml' });
        if (s.atom) out.push({ type: 'atom', href: urls.feed(blog, 'atom'), title: `${blog.title} (Atom)`, label: 'Atom', mime: 'application/atom+xml' });
        if (s.json) out.push({ type: 'json', href: urls.feed(blog, 'json'), title: `${blog.title} (JSON Feed)`, label: 'JSON Feed', mime: 'application/feed+json' });
        return out;
    }

    function termsView(post, blog, { networkTags = false } = {}) {
        const terms = store.taxonomy.termsFor(post.id);
        return {
            tags: terms.filter((t) => t.vocabulary === 'tag').map((t) => ({ ...t, url: urls.tag(t, networkTags ? null : blog) })),
            categories: terms.filter((t) => t.vocabulary !== 'tag').map((t) => ({ ...t, url: urls.category(blog, t) })),
        };
    }

    /** List items for rows of published posts (possibly from several blogs). */
    async function listItems(rows, { perBlogLinks = true } = {}) {
        const who = await people.many(rows.map((p) => p.author_subject));
        return rows.map((post) => {
            const blog = blogs.get(post.blog_id);
            const rev = store.revisions.get(post.id, post.published_revision);
            const person = who.get(post.author_subject);
            const { tags } = termsView(post, blog, { networkTags: !perBlogLinks });
            return {
                post, rev, blog,
                url: publication.postPath(blog, post),
                author: person ? { name: person.name, url: urls.author(person, blog) } : null,
                tags,
                badge: { members: 'Members only', private: 'Private' }[post.visibility] || null,
            };
        }).filter((it) => it.rev);
    }

    function categoriesTree(blog) {
        return store.taxonomy.tree(blogs.categoryVocabulary(blog));
    }

    /** Feed items (openvibe-publishing/seo feed builders skip anything the gate does not list). */
    async function feedItems(blog, { limit, fullContent }) {
        const { posts: rows } = postsApi.listPublished({ blogId: blog.id, limit, restricted: false });
        const who = await people.many(rows.map((p) => p.author_subject));
        return rows.map((post) => {
            const rev = store.revisions.get(post.id, post.published_revision);
            if (!rev) return null;
            const decision = publication.decide(blog, post, rev);
            const person = who.get(post.author_subject);
            const atts = store.attachments.list(post.id);
            const cover = atts.find((a) => a.role === 'cover' && !a.broken);
            const rel = blog.kind === 'official' ? 'noopener' : 'nofollow ugc noopener';
            return {
                id: publication.feedId(post),
                url: publication.postUrl(blog, post),
                title: rev.fields.title,
                summary: rev.fields.summary || ssr.markdownToText(rev.content, 300),
                contentHtml: fullContent ? renderBody(rev.content, atts, { urlFor: media.urlFor, rel }) : null,
                published: post.first_published_at,
                updated: rev.createdAt,
                decision,
                authors: person && person.known ? [{ name: person.name, url: publication.abs(urls.author(person, blog)) }] : [],
                tags: termsView(post, blog).tags.map((t) => t.name),
                image: cover ? media.urlFor(cover.mediaId) : null,
            };
        }).filter(Boolean);
    }

    /** The machine-readable representation of a post (same content as the page). */
    function postJson({ blog, post, rev, person, decision }) {
        const rec = publication.authorshipOf(rev);
        const review = publication.reviewOf(post, rev);
        const { tags, categories } = termsView(post, blog);
        const series = blogs.seriesById(post.series_id);
        return {
            id: post.id,
            url: publication.postUrl(blog, post),
            blog: { id: blog.id, handle: blog.handle, title: blog.title, url: publication.abs(blogPath(blog)) },
            title: rev.fields.title,
            summary: rev.fields.summary || null,
            body_markdown: rev.content,
            revision: rev.number,
            state: post.state,
            visibility: post.visibility,
            published_at: post.first_published_at ? new Date(post.first_published_at).toISOString() : null,
            revised_at: rev.createdAt,
            author: person ? { subject: post.author_subject, name: person.known ? person.name : null, username: person.username } : null,
            authorship: rec ? { mode: rec.mode, workflow: rec.workflow || null, reviewed: authorship.isReviewed(rec, review), disclosure: authorship.disclosure(rec, review) } : null,
            tags: tags.map((t) => t.name),
            categories: categories.map((c) => c.name),
            series: series ? { title: series.title, url: publication.abs(urls.series(blog, series)), position: post.series_position } : null,
            media: store.attachments.list(post.id).map((a) => ({ media_id: a.mediaId, role: a.role, alt: a.alt, caption: a.caption, state: a.state, broken_reason: a.brokenReason, url: a.broken ? null : media.urlFor(a.mediaId) })),
            citations: store.citations.forRevision(post.id, rev.number).map((c) => ({ url: c.url, title: c.title, source_item_id: c.sourceItemId, retrieved_at: c.retrievedAt, quote: c.quote ? c.quote.text : null })),
            indexability: { indexable: decision.indexable, robots: decision.robots, reasons: decision.codes },
        };
    }

    /** BlogPosting JSON-LD from real fields only (missing → omitted). */
    function postJsonLd({ blog, post, rev, person, tags, citations, attachments }) {
        const url = publication.postUrl(blog, post);
        const cover = attachments.find((a) => a.role === 'cover' && !a.broken);
        return seo.structuredData.article({
            type: 'BlogPosting',
            headline: rev.fields.title,
            url,
            description: rev.fields.summary || ssr.markdownToText(rev.content, 200),
            datePublished: post.first_published_at || null,
            dateModified: post.published_revision ? rev.createdAt : null,
            authors: person && person.known ? [{ name: person.name, url: publication.abs(urls.author(person, blog)) }] : [],
            publisher: blog.kind === 'official' ? { name: 'OpenVibe', url: 'https://openvibe.network' } : null,
            image: cover ? media.urlFor(cover.mediaId) : null,
            keywords: tags.map((t) => t.name),
            inLanguage: blog.language,
            citations: citations.filter((c) => c.url).map((c) => ({ url: c.url, title: c.title })),
            wordCount: ssr.wordCount(ssr.markdownToText(rev.content)),
        });
    }

    return { urls, feedsOf, termsView, listItems, categoriesTree, feedItems, postJson, postJsonLd, db };
}

module.exports = { createReading };
