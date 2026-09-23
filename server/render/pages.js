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

const dateLabel = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
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
        if (i % 2 === 0) { out += ssr.renderMarkdown(part, { rel }); return; }
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

/** A blog's front page. */
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
    return String(h`${raw(ssr.breadcrumbsHtml(o.breadcrumbs))}
<article class="post" data-post-id="${post.id}" data-revision="${rev.number}">
<header>
<h1>${rev.fields.title}</h1>
<p class="byline">${author ? h`By <a href="${author.url}" rel="author">${author.name}</a>` : ''}${post.published_at ? h` · ${time(post.first_published_at || post.published_at)}` : ''}${updated ? h` · updated ${time(Date.parse(rev.createdAt))}` : ''}${badge ? h` <span class="badge">${badge}</span>` : ''}${post.state !== 'published' ? h` <span class="badge">${post.state}</span>` : ''}</p>
${disclosure ? h`<p class="disclosure" role="note"><strong>${disclosure.short}.</strong> ${disclosure.long}</p>` : ''}
${series ? h`<nav class="series" aria-label="Series"><p>Part ${series.position || '?'} of the series <a href="${series.url}">${series.title}</a></p><ol>${series.items.map((s) => (s.current ? h`<li aria-current="page">${s.title}</li>` : h`<li><a href="${s.url}">${s.title}</a></li>`))}</ol></nav>` : ''}
${raw(cover.map((a) => figureHtml(a, { urlFor })).join(''))}
</header>
<div class="post-body">${raw(renderBody(rev.content, attachments, { urlFor, rel }))}</div>
${raw(gallery.length ? `<div class="gallery">${gallery.map((a) => figureHtml(a, { urlFor })).join('')}</div>` : '')}
${citations.length ? h`<section class="sources"><h2>Sources</h2><ol>${citations.map((c) => h`<li>${c.url ? h`<a href="${c.url}" rel="noopener">${c.title || c.url}</a>` : (c.title || c.sourceItemId)}${c.quote && c.quote.text ? h` — “${c.quote.text}”` : ''}${c.retrievedAt ? h` (retrieved ${dateLabel(c.retrievedAt)})` : ''}</li>`)}</ol></section>` : ''}
<footer class="post-footer">
${tags.length ? h`<p class="tags">${tags.map((t) => h`<a href="${t.url}" rel="tag">#${t.name}</a> `)}</p>` : ''}
${categories.length ? h`<p class="categories">Filed under ${categories.map((c) => h`<a href="${c.url}">${c.name}</a> `)}</p>` : ''}
<p class="meta">Revision ${rev.number}${decisionNote ? h` · ${decisionNote}` : ''} · <a href="${o.jsonUrl}">JSON</a> · <a href="${blogUrl}">More from ${blog.title}</a>${canEdit ? h` · <a href="/write/posts/${post.id}">Edit</a>` : ''}</p>
</footer>
</article>
${raw(comments ? commentsSection(comments, o) : '')}`);
}

function message({ heading, text, action }) {
    return String(h`<section class="message"><h1>${heading}</h1><p>${text}</p>${action ? h`<p><a class="button" href="${action.href}">${action.label}</a></p>` : ''}</section>`);
}

module.exports = { renderBody, blogIndex, collection, postPage, message, postList, categoryTree, time, dateLabel };
