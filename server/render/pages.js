'use strict';

/**
 * Public pages (HTML bodies; layout.js wraps them). Everything a reader needs is in the HTML:
 * post text, media figures (or an explicit "media unavailable" placeholder), sources, tags,
 * series navigation, author links, feeds and the Community comment thread with a plain form.
 * Values are escaped by ssr.html unless wrapped in raw(); Markdown goes through the package's
 * safe renderer.
 */
const ssr = require('openvibe-publishing/ssr');
const { figureHtml } = require('openvibe-publishing/media');

const { html: h, raw, escapeHtml: esc } = ssr;
const MEDIA_LINE = /^[ \t]*\[\[media:(med_[0-9A-HJKMNP-TV-Z]{26})\]\][ \t]*$/m;
// A post may fold a block away: <details><summary>…</summary>…</details>. The package's renderer
// escapes raw HTML on purpose, so Blog renders exactly this one shape itself — the summary as text,
// the inside as Markdown — and leaves every other tag to be escaped. Patch notes keep the full commit
// list there.
const DETAILS = /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
function renderMarkdownWithDetails(source, opts) {
    const text = String(source || '');
    let out = '';
    let last = 0;
    DETAILS.lastIndex = 0;
    let m;
    while ((m = DETAILS.exec(text))) {
        out += ssr.renderMarkdown(text.slice(last, m.index), opts);
        out += `<details class="ov-details"><summary>${esc(m[1].replace(/<[^>]*>/g, '').trim())}</summary>${ssr.renderMarkdown(m[2], opts)}</details>`;
        last = m.index + m[0].length;
    }
    out += ssr.renderMarkdown(text.slice(last), opts);
    return out;
}

const dateLabel = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);

// ── The reading layout (owner ask 3, the blog outcomes: research-2026-10-30/market/outcomes/blog.md) ──
// A stated read time, and a contents list built from the post's own sections. Markdown's "##" renders as <h3> (the
// page's h1 is the title), so a post's sections are its top-level <h3>s; those inside a fold (<details>) get an id but
// stay out of the list, since a link into a closed fold lands on nothing.
const WORDS_PER_MINUTE = 265;
/** "≈ N min read" from the Markdown: rounded, never 0; code blocks, media lines and link targets are not read. */
function readMinutes(content) {
    const text = String(content || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\[\[media:[^\]]*\]\]/g, ' ')
        .replace(/\]\([^)]*\)/g, ' ')
        .replace(/<[^>]+>/g, ' ');
    const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
    return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}
const RESERVED_IDS = new Set(['main', 'comments', 'contents', 'sources', 'series', 'top']);
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'" };
const decode = (t) => t.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (m) => ENTITIES[m]);
const slug = (t) => t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
/** The body with an id on every section heading, and the top-level sections for the contents list. */
function sectionsOf(bodyHtml) {
    const used = new Set(RESERVED_IDS);
    const sections = [];
    let depth = 0;
    const html = String(bodyHtml).replace(/<details\b[^>]*>|<\/details>|<h3>([\s\S]*?)<\/h3>/g, (m, inner) => {
        if (m.startsWith('<details')) { depth++; return m; }
        if (m === '</details>') { depth = Math.max(0, depth - 1); return m; }
        const text = decode(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
        const base = slug(text) || 'section';
        let id = base;
        for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
        used.add(id);
        if (depth === 0 && text) sections.push({ id, text });
        return `<h3 id="${id}">${inner}</h3>`;
    });
    return { html, sections };
}
/** The contents list: a fold under the title on phones, a rail beside the text on wide screens (CSS picks one). */
function contentsHtml(sections) {
    const list = h`<ol>${sections.map((x) => h`<li><a href="#${x.id}">${x.text}</a></li>`)}</ol>`;
    return String(h`<nav class="toc-rail" aria-labelledby="toc-rail-h"><h2 id="toc-rail-h">On this page</h2>${list}</nav>`);
}
function contentsFold(sections) {
    const list = h`<ol>${sections.map((x) => h`<li><a href="#${x.id}">${x.text}</a></li>`)}</ol>`;
    return String(h`<details class="toc-fold"><summary>On this page <span>${sections.length} sections</span></summary>${list}</details>`);
}
/** The series: one line under the title; the previous and next parts, and the parts around this one, after the text. */
function seriesLine(series) {
    const where = series.position && series.total ? `Part ${series.position} of ${series.total} in the series` : (series.position ? `Part ${series.position} of the series` : 'Part of the series');
    return String(h`<p class="series-line">${where} <a href="${series.url}">${series.title}</a></p>`);
}
function seriesFoot(series) {
    const step = (it, rel, label) => (it ? h`<a rel="${rel}" href="${it.url}"><small>${label}</small><span>${it.title}</span></a>` : '');
    const nav = series.prev || series.next ? h`<nav class="series-nav" aria-label="${`More in ${series.title}`}">${step(series.prev, 'prev', 'Previous')}${step(series.next, 'next', 'Next')}</nav>` : '';
    const items = series.items || [];
    const more = items.length > 1 ? h`<details class="series-more"><summary>More in ${series.title}${series.total ? h` <span>${series.total} parts</span>` : ''}</summary><ol start="${series.start || 1}">${items.map((x) => (x.current ? h`<li aria-current="page">${x.title}</li>` : h`<li><a href="${x.url}">${x.title}</a></li>`))}</ol><p><a href="${series.url}">${series.total ? `All ${series.total} parts` : 'The whole series'}</a></p></details>` : '';
    return String(h`${nav}${more}`);
}
const time = (v) => raw(ssr.timeTag(v == null ? null : new Date(v).toISOString(), { label: dateLabel(v) || undefined }));

/**
 * Markdown body with media: a line `[[media:med_…]]` places that attachment's <figure> there.
 * Inline attachments that the body does not place follow the text; covers and galleries are
 * rendered by the caller. A referenced id that is not attached renders an explicit notice.
 */
function renderBody(content, attachments, { urlFor, rel }) {
    const byId = new Map(attachments.map((a) => [a.mediaId, a]));
    const used = new Set();
    const parts = String(content || '').split(new RegExp(MEDIA_LINE.source, 'm'));
    let out = '';
    parts.forEach((part, i) => {
        if (i % 2 === 0) { out += renderMarkdownWithDetails(part, { rel }); return; }
        const att = byId.get(part);
        if (att) { used.add(att.id); out += figureHtml(att, { urlFor }); } else {
            out += `<figure class="ov-media ov-media-broken" data-media-id="${esc(part)}" data-state="not_attached"><div class="ov-media-missing" role="img" aria-label="Media not attached">This media is not attached to the post.</div></figure>`;
        }
    });
    for (const a of attachments) if (a.role === 'inline' && !used.has(a.id)) out += figureHtml(a, { urlFor });
    return out;
}

function postListItem(item) {
    const { post, rev, url, author, tags, badge } = item;
    return h`<li class="post-item">
<h2 class="post-item-title"><a href="${url}">${rev.fields.title}</a>${badge ? h` <span class="badge">${badge}</span>` : ''}</h2>
<p class="meta">${time(post.published_at)}${author ? h` · <a href="${author.url}">${author.name}</a>` : ''}</p>
<p class="summary">${rev.fields.summary || ssr.markdownToText(rev.content, 220)}</p>
${tags && tags.length ? h`<p class="tags">${tags.map((t) => h`<a href="${t.url}">#${t.name}</a> `)}</p>` : ''}
</li>`;
}

function postList(items, empty = 'Nothing published here yet.') {
    if (!items.length) return h`<p class="empty">${empty}</p>`;
    return h`<ol class="post-list">${items.map(postListItem)}</ol>`;
}

function feedLinksHtml(feeds) {
    if (!feeds.length) return '';
    return h`<p class="feeds">Follow: ${feeds.map((f) => h`<a href="${f.href}" type="${f.mime}">${f.label}</a> `)}</p>`;
}

/** A blog's front page (the network's home, the official blog's first page, is render/home.js). */
function blogIndex({ blog, blogUrl, items, pager, feeds, series, categories, canWrite }) {
    return String(h`<header class="blog-header">
<h1>${blog.title}</h1>
${blog.description ? h`<p class="lede">${blog.description}</p>` : ''}
${raw(feedLinksHtml(feeds))}
${canWrite ? h`<p><a class="button" href="/write/@${blog.handle}">Write on this blog</a></p>` : ''}
</header>
<section aria-label="Posts">${postList(items)}</section>
${raw(ssr.paginationHtml(pager))}
${series.length ? h`<section class="side"><h2>Series</h2><ul>${series.map((s) => h`<li><a href="${blogUrl}/series/${s.slug}">${s.title}</a></li>`)}</ul></section>` : ''}
${categories.length ? h`<section class="side"><h2>Categories</h2>${raw(categoryTree(categories, blogUrl))}</section>` : ''}`);
}

function categoryTree(nodes, blogUrl) {
    if (!nodes.length) return '';
    return `<ul>${nodes.map((n) => `<li><a href="${esc(`${blogUrl}/categories/${n.slug}`)}">${esc(n.name)}</a>${categoryTree(n.children || [], blogUrl)}</li>`).join('')}</ul>`;
}

/** Tag, category, series and author collections. */
function collection({ heading, intro, breadcrumbs, items, pager, feeds = [], empty }) {
    return String(h`${raw(ssr.breadcrumbsHtml(breadcrumbs || []))}
<header class="blog-header"><h1>${heading}</h1>${intro ? h`<p class="lede">${intro}</p>` : ''}${raw(feedLinksHtml(feeds))}</header>
<section aria-label="Posts">${postList(items, empty)}</section>
${raw(ssr.paginationHtml(pager))}`);
}

function commentsSection(c, { postPath, csrf, signedIn, loginUrl }) {
    const head = '<h2>Comments</h2>';
    if (c.state === 'disabled') return `<section id="comments" class="comments">${head}<p class="empty">Comments are off for this post.</p></section>`;
    if (c.state === 'restricted') return `<section id="comments" class="comments">${head}<p class="empty">Comments are available on public posts only.</p></section>`;
    if (c.state === 'off') return `<section id="comments" class="comments">${head}<p class="empty">Comments are not connected on this server.</p></section>`;
    if (c.state === 'unavailable') return `<section id="comments" class="comments">${head}<p class="notice" role="status">Comments could not be loaded from OpenVibe.Community right now. Reload later.</p></section>`;
    const one = (m) => h`<li class="comment" id="comment-${m.id}">
<p class="meta"><strong>${m.deleted ? '[deleted]' : (m.display_name || 'Anonymous')}</strong>${m.origin === 'ai' ? h` <span class="badge">AI</span>` : ''} · ${raw(ssr.timeTag(m.created_at, { label: dateLabel(m.created_at) }))}</p>
${m.deleted ? h`<p class="empty">This comment was deleted.</p>` : raw(`<p>${esc(m.message).replace(/\n/g, '<br>')}</p>`)}
${m.replies && m.replies.length ? h`<ol class="replies">${m.replies.map(one)}</ol>` : ''}
</li>`;
    const list = c.comments.length ? h`<ol class="comment-list">${c.comments.map(one)}</ol>` : h`<p class="empty">No comments yet.</p>`;
    const more = c.nextCursor ? h`<p><a href="${postPath}?comments_after=${c.nextCursor}#comments">More comments</a></p>` : '';
    const form = c.thread && c.thread.visibility === 'locked'
        ? h`<p class="empty">This thread is locked.</p>`
        : signedIn
            ? h`<form method="post" action="${postPath}/comments" class="comment-form">
<input type="hidden" name="_csrf" value="${csrf}">
<label for="comment-message">Add a comment</label>
<textarea id="comment-message" name="message" rows="4" maxlength="5000" required></textarea>
<button type="submit">Post comment</button>
</form>`
            : h`<p><a href="${loginUrl}">Sign in with OpenVibe</a> to comment.</p>`;
    return String(h`<section id="comments" class="comments">${raw(head)}
<p class="meta">Comments are hosted by <a href="${c.communityUrl}">OpenVibe.Community</a>.</p>
${list}${more}${form}</section>`);
}

/** One post. */
function postPage(o) {
    const { blog, blogUrl, post, rev, author, tags, categories, series, attachments, citations, disclosure, decisionNote, comments, canEdit, urlFor } = o;
    const rel = blog.kind === 'official' ? 'noopener' : 'nofollow ugc noopener';
    const cover = attachments.filter((a) => a.role === 'cover');
    const gallery = attachments.filter((a) => a.role === 'gallery');
    const badge = { members: 'Members only', private: 'Private', unlisted: 'Unlisted' }[post.visibility];
    const updated = rev.number > 1 && post.first_published_at && Date.parse(rev.createdAt) > post.first_published_at + 60000;
    const body = sectionsOf(renderBody(rev.content, attachments, { urlFor, rel }));
    const toc = body.sections.length >= 3 ? body.sections : null;
    const minutes = readMinutes(rev.content);
    return String(h`${raw(ssr.breadcrumbsHtml(o.breadcrumbs))}
<div class="post-wrap${toc ? ' has-toc' : ''}">
${raw(toc ? contentsHtml(toc) : '')}
<div class="post-main">
<article class="post" data-post-id="${post.id}" data-revision="${rev.number}">
<header>
<h1>${rev.fields.title}</h1>
<p class="byline">${author ? h`By <a href="${author.url}" rel="author">${author.name}</a> · ` : ''}${post.published_at ? h`${time(post.first_published_at || post.published_at)} · ` : ''}${updated ? h`updated ${time(Date.parse(rev.createdAt))} · ` : ''}<span class="read-time" title="At ${WORDS_PER_MINUTE} words a minute: a guide, not a promise">≈ ${minutes} min read</span>${badge ? h` <span class="badge">${badge}</span>` : ''}${post.state !== 'published' ? h` <span class="badge">${post.state}</span>` : ''}</p>
${series ? raw(seriesLine(series)) : ''}
${disclosure ? h`<p class="disclosure" role="note"><strong>${disclosure.short}.</strong> ${disclosure.long}</p>` : ''}
${raw(toc ? contentsFold(toc) : '')}
${raw(cover.map((a) => figureHtml(a, { urlFor })).join(''))}
</header>
<div class="post-body">${raw(body.html)}</div>
${raw(gallery.length ? `<div class="gallery">${gallery.map((a) => figureHtml(a, { urlFor })).join('')}</div>` : '')}
${citations.length ? h`<section class="sources"><h2>Sources</h2><ol>${citations.map((c) => h`<li>${c.url ? h`<a href="${c.url}" rel="noopener">${c.title || c.url}</a>` : (c.title || c.sourceItemId)}${c.quote && c.quote.text ? h` — “${c.quote.text}”` : ''}${c.retrievedAt ? h` (retrieved ${dateLabel(c.retrievedAt)})` : ''}</li>`)}</ol></section>` : ''}
${series ? raw(seriesFoot(series)) : ''}
<footer class="post-footer">
${tags.length ? h`<p class="tags">${tags.map((t) => h`<a href="${t.url}" rel="tag">#${t.name}</a> `)}</p>` : ''}
${categories.length ? h`<p class="categories">Filed under ${categories.map((c) => h`<a href="${c.url}">${c.name}</a> `)}</p>` : ''}
<p class="meta">Revision ${rev.number}${decisionNote ? h` · ${decisionNote}` : ''} · <a href="${o.jsonUrl}">JSON</a> · <a href="${blogUrl}">More from ${blog.title}</a>${canEdit ? h` · <a href="/write/posts/${post.id}">Edit</a>` : ''}</p>
</footer>
</article>
${raw(comments ? commentsSection(comments, o) : '')}
</div>
</div>`);
}

/** A members-only post for a reader without access: title, the author's summary, a join link — never the text. */
function membersTeaser({ teaser, signedIn, loginUrl, unavailable }) {
    const owner = teaser.owner && (teaser.owner.name || teaser.owner.username);
    return String(h`<article class="post teaser" data-post-id="${teaser.id}" data-members-only="1">
<header><h1>${teaser.title || 'Members-only post'}</h1><p class="byline"><span class="badge">Members only</span> · <a href="${teaser.blog.url}">${teaser.blog.title}</a></p></header>
${teaser.summary ? h`<p class="summary">${teaser.summary}</p>` : ''}
<section class="message">
<p>${owner ? h`This post is for members of ${owner} on OpenVibe.VIP.` : 'This post is for members of this blog.'}${unavailable ? ' Memberships could not be checked just now; try again in a moment.' : ''}</p>
${teaser.join_url ? h`<p><a class="button" href="${teaser.join_url}" rel="noopener">Join on OpenVibe.VIP</a></p>` : ''}
${signedIn ? '' : h`<p>Already a member? <a href="${loginUrl}">Sign in</a>.</p>`}
</section>
</article>`);
}

function message({ heading, text, action }) {
    return String(h`<section class="message"><h1>${heading}</h1><p>${text}</p>${action ? h`<p><a class="button" href="${action.href}">${action.label}</a></p>` : ''}</section>`);
}

module.exports = {
    readMinutes, sectionsOf, renderBody, renderMarkdownWithDetails, blogIndex, collection, postPage, membersTeaser, message, postList, categoryTree, time, dateLabel };
