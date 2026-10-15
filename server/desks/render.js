'use strict';
/**
 * The AI desks' pages (layout.js wraps them): the desks, one desk's posts, one post. Every surface says the text is
 * AI-written and not reviewed by a person; the satire desk says, above the text, that it is made up.
 */
const ssr = require('openvibe-publishing/ssr');
const catalog = require('./catalog');
const { periodLabel } = require('./desks');

const { html: h, raw } = ssr;
const dateLabel = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
const time = (ms) => raw(ssr.timeTag(ms ? new Date(ms).toISOString() : null, { label: dateLabel(ms) || undefined }));
const every = (d) => (d.every === 'week' ? 'Every Monday, for the week before' : d.satire ? 'Every day' : 'Every morning, for the day before');

const AI_NOTE = 'Written by OpenVibe.AI and not reviewed by a person before it appears. Desk posts are not offered to search engines.';

function satireBanner() {
    return h`<p class="disclosure desk-satire" role="note"><strong>Satire.</strong> This is made up, written by AI for laughs. Nothing in it is true, real advice or real news, and the people, studies and institutes in it do not exist. Do not try anything in it.</p>`;
}

/** Markdown from the AI, with headings starting at h2 under the page's h1 (a stray "# " becomes "## "). */
function md(text, shift) {
    return raw(ssr.renderMarkdown(String(text || '').replace(/^# /gm, '## '), { rel: 'nofollow noopener', headingShift: shift }));
}

function index({ latest }) {
    const card = (d) => {
        const p = latest.get(d.key);
        return h`<li class="desk-card">
<h2><a href="/desks/${d.key}">${d.title}</a>${d.satire ? h` <span class="badge">Satire</span>` : ''}</h2>
<p>${d.about}</p>
<p class="meta">${every(d)}${p ? h` · Latest: <a href="/desks/${d.key}/${p.slug}">${p.title}</a> (${time(p.published_at)})` : ' · Nothing written yet'} · <a href="/desks/${d.key}/feed.xml" type="application/rss+xml">Feed</a></p>
</li>`;
    };
    return String(h`<header class="blog-header"><h1>AI desks</h1>
<p class="lede">Niche blogs written by AI from the data OpenVibe.Sources collects (government news, food recalls, deals, hosting plans, developer releases), and one satire column. Each digest links every item it was written from.</p></header>
<p class="disclosure" role="note"><strong>Written by AI.</strong> ${AI_NOTE} The people's blogs are elsewhere on <a href="/">OpenVibe.Blog</a>.</p>
<ul class="desk-list">${catalog.ALL.map(card)}</ul>`);
}

function deskPage({ desk, posts, pager, staff }) {
    const item = (p) => h`<li class="post-item">
<h2 class="post-item-title"><a href="/desks/${desk.key}/${p.slug}">${p.title}</a>${p.status === 'hidden' ? h` <span class="badge">Hidden</span>` : ''}</h2>
<p class="meta">${time(p.published_at)}${desk.satire ? '' : h` · ${periodLabel(desk, { from: p.period_from, to: p.period_to })}`} · ${desk.satire ? 'Satire, written by AI' : h`Written by AI from ${p.sources.length} items`}</p>
${p.dek ? h`<p class="summary">${p.dek}</p>` : ''}
</li>`;
    return String(h`${raw(ssr.breadcrumbsHtml([{ name: 'AI desks', url: '/desks' }, { name: desk.title }]))}
<header class="blog-header"><h1>${desk.title}</h1><p class="lede">${desk.about}</p>
<p class="feeds">${every(desk)} · Follow: <a href="/desks/${desk.key}/feed.xml" type="application/rss+xml">RSS</a> <a href="/desks/${desk.key}/atom.xml" type="application/atom+xml">Atom</a></p></header>
${desk.satire ? satireBanner() : h`<p class="disclosure" role="note"><strong>Written by AI.</strong> ${AI_NOTE}</p>`}
<section aria-label="Posts">${posts.length ? h`<ol class="post-list">${posts.map(item)}</ol>` : h`<p class="empty">Nothing written here yet. The first post appears after the desk's first ${desk.every === 'week' ? 'week' : 'day'} of items.</p>`}</section>
${raw(ssr.paginationHtml(pager))}
${staff ? h`<p class="meta">Staff see hidden posts here too.</p>` : ''}`);
}

/** The article body (also the feeds' content). */
function articleBody(desk, post) {
    if (desk.satire) {
        return String(h`${satireBanner()}
${post.dek ? h`<p class="lede">${post.dek}</p>` : ''}
<div class="post-body">${md(post.body.markdown, 0)}</div>
${post.body.tags && post.body.tags.length ? h`<p class="tags">${post.body.tags.map((t) => h`<span>#${t}</span> `)}</p>` : ''}`);
    }
    const cite = (n) => h`<a href="#src-${n + 1}">${n + 1}</a>`;
    return String(h`<p class="disclosure" role="note"><strong>AI-generated</strong> from ${post.sources.length} items OpenVibe.Sources fetched, by OpenVibe.AI's blog.write_digest${post.model ? ` (${post.model})` : ''}; not reviewed by a person. Check anything that matters against the linked item.</p>
${post.dek ? h`<p class="lede">${post.dek}</p>` : ''}
<div class="post-body">${post.body.sections.map((s) => h`<section class="desk-section">${s.heading ? h`<h2>${s.heading}</h2>` : ''}${md(s.body, 2)}<p class="desk-cites">From ${s.cites.map((n, i) => h`${i ? ', ' : ''}${cite(n)}`)}</p></section>`)}</div>
${post.body.gaps && post.body.gaps.length ? h`<details class="desk-gaps"><summary>What the AI could not tell from the items</summary><ul>${post.body.gaps.map((g) => h`<li>${g}</li>`)}</ul></details>` : ''}
<section class="sources"><h2>The items it was written from</h2><ol>${post.sources.map((s, i) => h`<li id="src-${i + 1}">${s.url ? h`<a href="${s.url}" rel="nofollow noopener">${s.title || s.url}</a>` : (s.title || s.item_id)} <span class="meta">(${s.source_key}${s.published_at ? h`, ${String(s.published_at).slice(0, 10)}` : ''})</span></li>`)}</ol></section>`);
}

function postPage({ desk, post, staff, csrf }) {
    return String(h`${raw(ssr.breadcrumbsHtml([{ name: 'AI desks', url: '/desks' }, { name: desk.title, url: `/desks/${desk.key}` }, { name: post.title }]))}
<article class="post desk-post" data-desk="${desk.key}" data-desk-post="${post.id}">
<header><h1>${post.title}</h1>
<p class="byline"><a href="/desks/${desk.key}">${desk.title}</a> · ${time(post.published_at)}${desk.satire ? '' : h` · ${periodLabel(desk, { from: post.period_from, to: post.period_to })}`} <span class="badge">${desk.satire ? 'Satire' : 'AI'}</span>${post.status === 'hidden' ? h` <span class="badge">Hidden</span>` : ''}</p></header>
${raw(articleBody(desk, post))}
<footer class="post-footer"><p class="meta">${post.run_id ? h`OpenVibe.AI run ${post.run_id} · ` : ''}<a href="/desks/${desk.key}/${post.slug}.json">JSON</a> · <a href="/desks/${desk.key}">More from ${desk.title}</a> · <a href="/desks">All AI desks</a></p>
${staff ? h`<form method="post" action="/desks/${desk.key}/${post.slug}/${post.status === 'hidden' ? 'show' : 'hide'}" class="desk-staff">
<input type="hidden" name="_csrf" value="${csrf}">
${post.status === 'hidden' ? (post.hidden_reason ? h`<p class="meta">Hidden: ${post.hidden_reason}</p>` : '') : h`<label for="desk-hide-reason">Why hide it (staff)</label><input id="desk-hide-reason" name="reason" maxlength="300">`}
<button type="submit">${post.status === 'hidden' ? 'Show it again' : 'Hide this post'}</button></form>` : ''}
</footer>
</article>`);
}

module.exports = { index, deskPage, postPage, articleBody, satireBanner };
