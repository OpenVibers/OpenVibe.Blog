'use strict';
/**
 * The home page (the first page of the official blog at /): what OpenVibe.Blog is for, then real content only. The
 * official blog's newest posts, the week's changes across the network, the AI desks' latest posts, topics, members'
 * posts, how a blog works, questions and the ways around the site. A section with nothing to show is left out.
 */
const ssr = require('openvibe-publishing/ssr');
const showcase = require('openvibe-shared/showcase');
const catalog = require('../desks/catalog');

const { html: h, raw } = ssr;
const dateLabel = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
const time = (v) => raw(ssr.timeTag(v == null ? null : new Date(v).toISOString(), { label: dateLabel(v) || undefined }));
const num = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

// A changelog service id as people know the site ("media-hub" is OpenVibe.Video's server, "openre" is OpenRestream).
const SITE_NAMES = { ai: 'OpenVibe.AI', 'media-hub': 'OpenVibe.MediaHub', openre: 'OpenRestream', vip: 'OpenVibe.VIP', sdk: 'OpenVibe.SDK' };
const siteName = (id) => SITE_NAMES[id] || `OpenVibe.${String(id).charAt(0).toUpperCase()}${String(id).slice(1)}`;

// The questions the home answers, on the page and as FAQPage (exactly what is shown).
const FAQ = [
    { q: 'Who can start a blog?', a: 'Anyone with an OpenVibe account. Sign in, pick your blog\'s name and start writing; reading needs no account at all.' },
    { q: 'Can other people write on my blog?', a: 'Yes. Add editors, who can publish anyone\'s posts, and authors, who write their own. You stay the owner.' },
    { q: 'Can AI help me write?', a: 'Ask for a draft from a topic and it arrives as a draft marked as written by AI, with its sources attached. It stays out of search engines until you review it.' },
    { q: 'Can I write for my members only?', a: 'Yes. Your OpenVibe.VIP members read the whole post; everyone else sees a teaser.' },
    { q: 'What are the AI desks?', a: 'Digests that OpenVibe.AI writes from the news, recalls, deals, hosting plans and releases OpenVibe.Sources collects, plus one satire column. Every digest links the items it was written from, says it was written by AI, and is kept out of search engines.' },
    { q: 'Where do the patch notes come from?', a: 'Every change deployed to an OpenVibe site is logged from its repository, and a Patch notes post rounds them up once enough have shipped.' },
];

function statsPanel(stats) {
    const tiles = [
        stats.posts ? ['Posts published', stats.posts] : null,
        stats.deskPosts ? ['AI desk posts', stats.deskPosts] : null,
        stats.weekChanges ? ['Changes shipped this week', stats.weekChanges] : null,
        stats.weekSites ? ['Sites changed this week', stats.weekSites] : null,
    ].filter(Boolean);
    if (!tiles.length) return '';
    return String(h`<div class="bh-panel"><h2 class="bh-panel-h">On the blog</h2><dl class="bh-stats">${tiles.map(([k, v]) => h`<div><dt>${k}</dt><dd>${num(v)}</dd></div>`)}</dl></div>`);
}

function postCard(item) {
    const { post, rev, url, author, tags, badge } = item;
    const summary = rev.fields.summary || ssr.markdownToText(rev.content, 220);
    return h`<li class="bh-card"><h3><a href="${url}">${rev.fields.title}</a>${badge ? h` <span class="badge">${badge}</span>` : ''}</h3>
<p class="meta">${time(post.published_at)}${author ? h` · ${author.name}` : ''}</p>${summary ? h`<p class="bh-sum">${summary}</p>` : ''}
${tags && tags.length ? h`<p class="tags">${tags.slice(0, 4).map((t) => h`<a href="${t.url}">#${t.name}</a> `)}</p>` : ''}</li>`;
}

/**
 * o: blog, items (the official blog's first page), pager, feeds, stats, week ([{ service, changes }]), latestDesks
 * (Map desk → post), tags ([{ slug, name, posts }]), series ([{ title, url, posts }]), memberItems, signedIn
 */
function homeBody(o) {
    const { blog, items, pager, feeds, stats, week = [], latestDesks = new Map(), tags = [], series = [], memberItems = [], signedIn = false } = o;
    const start = { label: signedIn ? 'Start writing' : 'Sign in and start writing', href: '/write', primary: true };
    const top = week.length ? week[0].changes : 0;
    const desks = catalog.ALL.map((d) => ({ desk: d, post: latestDesks.get(d.key) })).filter((x) => x.post);
    return String(h`${raw(showcase.hero({
        eyebrow: 'OpenVibe.Blog',
        title: 'Write on', accent: 'OpenVibe',
        lede: 'A blog of your own with drafts, scheduling, feeds and comments, on the OpenVibe account you already have. Anyone can read without one.',
        actions: [start, { label: 'Read the OpenVibe blog', href: '#posts' }, { label: 'AI desks', href: '/desks' }],
        aside: stats ? { html: statsPanel(stats) } : undefined,
    }))}
<section class="sc-sec bh-sec" id="posts" aria-labelledby="bh-posts-h"><h2 id="bh-posts-h">Latest from ${blog.title.replace(/^The /, 'the ')}</h2>
${blog.description ? h`<p class="sc-lede">${blog.description}</p>` : ''}
${feeds.length ? h`<p class="feeds">Follow: ${feeds.map((f) => h`<a href="${f.href}" type="${f.mime}">${f.label}</a> `)}</p>` : ''}
${items.length ? h`<ol class="bh-cards">${items.map(postCard)}</ol>${raw(ssr.paginationHtml(pager))}` : h`<p class="empty">Nothing published here yet.</p>`}</section>
${week.length ? h`<section class="sc-sec bh-sec" aria-labelledby="bh-week-h"><h2 id="bh-week-h">This week across OpenVibe</h2>
<p class="sc-lede">${plural(stats.weekChanges, 'change')} shipped to ${plural(stats.weekSites, 'site')} in the last seven days. Patch notes on this blog round them up.</p>
<ol class="bh-bars">${week.map((w) => h`<li><a href="https://openvibe.network/updates?site=${encodeURIComponent(w.service)}">${siteName(w.service)}</a><span class="bh-bar" aria-hidden="true"><span style="width:${String(Math.max(2, Math.round((w.changes / top) * 100)))}%"></span></span><span class="bh-n">${plural(w.changes, 'change')}</span></li>`)}</ol>
<p class="bh-more"><a href="https://openvibe.network/updates">Every change, as it ships</a>${series.length ? h` · <a href="${series[0].url}">${series[0].title}</a>` : ''}</p></section>` : ''}
${desks.length ? h`<section class="sc-sec bh-sec" aria-labelledby="bh-desks-h"><h2 id="bh-desks-h">From the AI desks</h2>
<p class="sc-lede">Daily and weekly digests of what public sources published, every item linked, plus a satire column. Written by AI and not reviewed by a person; kept out of search engines.</p>
<ul class="bh-desks">${desks.map(({ desk, post }) => h`<li><p class="bh-desk">${desk.title} <span class="badge">${desk.satire ? 'Satire' : 'AI'}</span></p><h3><a href="/desks/${desk.key}/${post.slug}">${post.title}</a></h3>${post.dek ? h`<p class="bh-sum">${post.dek}</p>` : ''}<p class="meta">${time(post.published_at)} · <a href="/desks/${desk.key}">More from this desk</a></p></li>`)}</ul>
<p class="bh-more"><a href="/desks">Every desk and its feed</a></p></section>` : ''}
${tags.length ? h`<section class="sc-sec bh-sec" aria-labelledby="bh-tags-h"><h2 id="bh-tags-h">Topics</h2><p class="sc-lede">Tags across every public post, with how many posts carry each.</p>
<ul class="bh-chips">${tags.map((t) => h`<li><a href="/tags/${encodeURIComponent(t.slug)}">#${t.name} <span>${num(t.posts)}</span></a></li>`)}</ul>
${series.length ? h`<p class="bh-more">Series: ${series.map((s, i) => h`${i ? ' · ' : ''}<a href="${s.url}">${s.title}</a> (${plural(s.posts, 'post')})`)}</p>` : ''}</section>` : ''}
${memberItems.length ? h`<section class="sc-sec bh-sec" aria-labelledby="bh-members-h"><h2 id="bh-members-h">From members' blogs</h2><ol class="bh-cards">${memberItems.map(postCard)}</ol></section>` : ''}
${raw(showcase.features({
        title: 'What your blog gets',
        items: [
            { icon: 'ov:blog', title: 'Drafts and revisions', text: 'Every save is a revision you can go back to; publish when it is ready.' },
            { icon: 'ov:history', title: 'Scheduling', text: 'Pick the minute a post goes live.' },
            { icon: 'ov:news', title: 'Feeds', text: 'RSS, Atom and JSON Feed for every blog, series and category.' },
            { icon: 'ov:community', title: 'Comments', text: 'Threads on OpenVibe.Community, moderated by you.' },
            { icon: 'ov:theme', title: 'Your theme', text: 'Pick a theme preset and your blog wears it.' },
            { icon: 'ov:vip', title: 'Members-only posts', text: 'Your OpenVibe.VIP members read the whole post; everyone else sees a teaser.' },
        ],
    }))}
${raw(showcase.steps({
        title: 'How it works',
        items: [
            { title: 'Sign in and name your blog', text: 'Your OpenVibe account is all it takes. Pick a title and the address your blog lives at.', href: '/write' },
            { title: 'Write, or start from an AI draft', text: 'Markdown, pictures from OpenVibe.Media, tags, categories and series. Every save is a revision.' },
            { title: 'Publish now or schedule it', text: 'Public, unlisted, for your VIP members or private, one post at a time.' },
            { title: 'Readers follow along', text: 'Feeds for the blog, each series and each category, and comments on OpenVibe.Community.' },
        ],
    }))}
<section class="sc-sec bh-sec bh-faq" aria-labelledby="bh-faq-h"><h2 id="bh-faq-h">Questions</h2>${FAQ.map((f) => h`<details><summary>${f.q}</summary><p>${f.a}</p></details>`)}</section>
<section class="sc-sec bh-sec" aria-labelledby="bh-links-h"><h2 id="bh-links-h">Find your way around</h2><ul class="bh-links">
<li><a href="/write"><b>Write</b><small>Your blog, its drafts and its settings.</small></a></li>
<li><a href="/desks"><b>AI desks</b><small>News, food safety, deals, hosting, crowdfunding, developer digests and satire.</small></a></li>
${series.length ? h`<li><a href="${series[0].url}"><b>${series[0].title}</b><small>Every change to OpenVibe, rounded up.</small></a></li>` : ''}
<li><a href="/feed.xml"><b>Feeds</b><small>RSS here; Atom and JSON Feed too.</small></a></li>
<li><a href="/updates"><b>What shipped</b><small>Every change to OpenVibe.Blog itself.</small></a></li>
<li><a href="https://openvibe.network/updates"><b>Network changelog</b><small>Every change to every OpenVibe site.</small></a></li>
</ul></section>
${raw(showcase.cta({ title: 'Start your blog today', text: 'Drafts, scheduling, feeds and comments come with it, and readers need no account.', actions: [start] }))}`);
}

/** Structured data for the home: the site, the newest posts as an ItemList, and the questions shown. */
function homeJsonLd({ base, items }) {
    const out = [{ '@context': 'https://schema.org', '@type': 'WebSite', name: 'OpenVibe.Blog', url: `${base}/` }];
    if (items.length) out.push({ '@context': 'https://schema.org', '@type': 'ItemList', name: 'Latest posts on OpenVibe.Blog', numberOfItems: items.length, itemListElement: items.map((x, i) => ({ '@type': 'ListItem', position: i + 1, name: x.rev.fields.title, url: `${base}${x.url}` })) });
    out.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
    return out;
}

module.exports = { homeBody, homeJsonLd, siteName, FAQ };
