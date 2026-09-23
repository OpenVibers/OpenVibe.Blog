'use strict';

/**
 * The editor: plain HTML forms that work without JavaScript. Every form posts to the same origin
 * with the per-session form token (_csrf); sign-in is Network SSO.
 */
const ssr = require('openvibe-publishing/ssr');
const { time } = require('./pages');

const { html: h, raw } = ssr;

const STATE_LABEL = { draft: 'Draft', scheduled: 'Scheduled', published: 'Published', unpublished: 'Unpublished' };
const csrfField = (csrf) => h`<input type="hidden" name="_csrf" value="${csrf}">`;

function flash(msg) {
    if (!msg) return '';
    return h`<p class="notice ${msg.kind === 'error' ? 'error' : ''}" role="${msg.kind === 'error' ? 'alert' : 'status'}">${msg.text}</p>`;
}

function home({ viewer, blogs, csrf, suggestedHandle, message }) {
    const own = blogs.find((b) => b.kind === 'member' && b.role === 'owner');
    return String(h`<h1>Write</h1>
${flash(message)}
${blogs.length ? h`<h2>Your blogs</h2><ul class="blog-list">${blogs.map((b) => h`<li><a href="/write/@${b.handle}">${b.title}</a> <span class="meta">@${b.handle} · ${b.role}</span></li>`)}</ul>` : ''}
${own ? '' : h`<section class="card"><h2>Start your blog</h2>
<p>Your blog lives at <code>/@handle</code> on openvibe.blog and belongs to your OpenVibe account.</p>
<form method="post" action="/write/start">${csrfField(csrf)}
<label for="handle">Handle</label><input id="handle" name="handle" value="${suggestedHandle || ''}" pattern="[a-z0-9][a-z0-9_-]{1,39}" required>
<label for="title">Blog title</label><input id="title" name="title" maxlength="120" value="${suggestedHandle ? `@${suggestedHandle}` : ''}">
<button type="submit">Start my blog</button></form></section>`}
<p class="meta">Signed in as ${viewer.user && (viewer.user.display_name || viewer.user.username) ? (viewer.user.display_name || viewer.user.username) : viewer.subject}.</p>`);
}

function blogDashboard({ blog, posts, heads, role, csrf, message, publicUrl }) {
    return String(h`<p><a href="/write">← All your blogs</a></p>
<h1>${blog.title}</h1>
<p class="meta">@${blog.handle} · your role: ${role} · <a href="${publicUrl}">View the blog</a>${role === 'owner' ? h` · <a href="/write/@${blog.handle}/settings">Settings</a>` : ''}</p>
${flash(message)}
<p><a class="button" href="/write/@${blog.handle}/new">New post</a></p>
${posts.length ? h`<table class="posts"><thead><tr><th>Title</th><th>State</th><th>Visibility</th><th>Updated</th></tr></thead><tbody>
${posts.map((p) => h`<tr><td><a href="/write/posts/${p.id}">${(heads.get(p.id) || {}).title || p.slug}</a></td><td>${STATE_LABEL[p.state] || p.state}</td><td>${p.visibility}</td><td>${time(p.updated_at)}</td></tr>`)}
</tbody></table>` : h`<p class="empty">No posts yet.</p>`}`);
}

function select(name, options, current) {
    return h`<select id="${name}" name="${name}">${options.map(([v, label]) => (v === current ? h`<option value="${v}" selected>${label}</option>` : h`<option value="${v}">${label}</option>`))}</select>`;
}

/** New post and edit form (the same fields). */
function postForm({ blog, post, head, terms, series, csrf, message, action }) {
    const f = head ? head.fields : {};
    const vis = post ? post.visibility : 'public';
    return String(h`${flash(message)}
<form method="post" action="${action}" class="post-form">${csrfField(csrf)}
${head ? h`<input type="hidden" name="expectedRevision" value="${head.number}">` : ''}
<label for="title">Title</label><input id="title" name="title" maxlength="200" required value="${f.title || ''}">
<label for="summary">Summary <span class="meta">(optional, shown in lists and feeds)</span></label><input id="summary" name="summary" maxlength="500" value="${f.summary || ''}">
<label for="body">Text <span class="meta">(Markdown; a line <code>[[media:med_…]]</code> places an attached Media object)</span></label>
<textarea id="body" name="body" rows="22">${head ? head.content : ''}</textarea>
${post ? h`<label for="slug">URL slug</label><input id="slug" name="slug" value="${post.slug}" pattern="[a-z0-9][a-z0-9-]{0,79}"><p class="meta">Changing it keeps the old address working (301).</p>` : ''}
<label for="tags">Tags <span class="meta">(comma-separated)</span></label><input id="tags" name="tags" value="${(terms.tags || []).join(', ')}">
<label for="categories">Categories <span class="meta">(comma-separated; "Parent > Child" nests)</span></label><input id="categories" name="categories" value="${(terms.categories || []).join(', ')}">
<label for="series">Series <span class="meta">(title; empty for none)</span></label><input id="series" name="series" value="${series ? series.title : ''}">
<label for="seriesPosition">Part number in the series</label><input id="seriesPosition" name="seriesPosition" type="number" min="1" value="${post && post.series_position ? post.series_position : ''}">
<label for="visibility">Who can read it</label>
${select('visibility', [['public', 'Public'], ['unlisted', 'Unlisted (link only; never listed, fed or indexed)'], ['members', 'Members only (VIP entitlement)'], ['private', 'Private (this blog’s members)']], vis)}
<label for="entitlementKey">Entitlement key for members-only posts</label><input id="entitlementKey" name="entitlementKey" value="${post && post.entitlement_key ? post.entitlement_key : `blog:${blog.handle}:members`}">
<p class="meta">Members-only posts are readable by this blog’s members and staff. Other readers need the entitlement; no entitlement service is connected yet, so nobody else is admitted.</p>
<label><input type="checkbox" name="allowComments" value="1"${raw(!post || post.allow_comments ? ' checked' : '')}> Comments (public posts only, hosted by OpenVibe.Community)</label>
<label><input type="checkbox" name="noindex" value="1"${raw(post && post.noindex ? ' checked' : '')}> Ask search engines not to index it</label>
<input type="hidden" name="allowComments" value="0">
<label for="message">Revision note <span class="meta">(optional)</span></label><input id="message" name="message" maxlength="200">
<button type="submit">${post ? 'Save revision' : 'Save draft'}</button>
</form>`);
}

function gateSummary(decision) {
    if (!decision) return '';
    if (decision.indexable) return h`<p class="meta">Search engines: indexable (${decision.robots}).</p>`;
    return h`<p class="meta">Search engines: <strong>${decision.robots}</strong> — ${decision.reasons.map((r) => `${r.code}${r.detail ? ` (${r.detail})` : ''}`).join('; ')}.</p>`;
}

function editPage(o) {
    const { blog, post, head, published, decision, jobs, attachments, csrf, disclosure, needsReview, publicUrl, canDelete } = o;
    return String(h`<p><a href="/write/@${blog.handle}">← ${blog.title}</a></p>
<h1>${head.fields.title}</h1>
<p class="meta">${STATE_LABEL[post.state] || post.state} · ${post.visibility} · revision ${head.number}${published ? h` · readers see revision ${published.number}` : ''} · <a href="/write/posts/${post.id}/revisions">History</a> · <a href="/write/posts/${post.id}/preview">Preview</a>${post.state === 'published' ? h` · <a href="${publicUrl}">View</a>` : ''}</p>
${disclosure ? h`<p class="disclosure" role="note"><strong>${disclosure.short}.</strong> ${disclosure.long}</p>` : ''}
${raw(gateSummary(decision))}
${needsReview ? h`<section class="card"><h2>Review needed</h2><p>Revision ${head.number} is AI-generated. A person must review it before it can be published or indexed.</p>
<form method="post" action="/write/posts/${post.id}/review">${csrfField(csrf)}<input type="hidden" name="revision" value="${head.number}">
<label for="note">Note</label><input id="note" name="note" maxlength="500">
<button name="decision" value="approved" type="submit">Approve revision ${head.number}</button> <button name="decision" value="rejected" type="submit">Reject</button></form></section>` : ''}
<section class="card actions"><h2>Publish</h2>
<form method="post" action="/write/posts/${post.id}/publish">${csrfField(csrf)}<input type="hidden" name="revision" value="${head.number}"><button type="submit">Publish revision ${head.number} now</button></form>
<form method="post" action="/write/posts/${post.id}/schedule">${csrfField(csrf)}<input type="hidden" name="revision" value="${head.number}">
<label for="at">Publish revision ${head.number} at (UTC)</label><input id="at" name="at" type="datetime-local" required><button type="submit">Schedule</button></form>
${jobs.length ? h`<p class="meta">Scheduled: ${jobs.map((j) => h`${j.action} of revision ${j.revision || '-'} at ${j.runAt} (${j.status}) `)}</p>
<form method="post" action="/write/posts/${post.id}/unschedule">${csrfField(csrf)}<button type="submit">Cancel schedule</button></form>` : ''}
${post.state === 'published' || post.state === 'scheduled' ? h`<form method="post" action="/write/posts/${post.id}/unpublish">${csrfField(csrf)}<button type="submit">Unpublish</button></form>` : ''}
${canDelete ? h`<form method="post" action="/write/posts/${post.id}/delete">${csrfField(csrf)}<label><input type="checkbox" name="confirm" value="1" required> I want to delete this post</label><button type="submit" class="danger">Delete</button></form>` : ''}
</section>
<section class="card"><h2>Media</h2>
${attachments.length ? h`<ul>${attachments.map((a) => h`<li><code>${a.mediaId}</code> · ${a.role}${a.broken ? h` · <strong>unavailable (${a.brokenReason})</strong>` : h` · ${a.state}`}${a.alt ? h` · alt: ${a.alt}` : ''}
<form method="post" action="/write/posts/${post.id}/media/${a.id}/remove" class="inline">${csrfField(csrf)}<button type="submit">Remove</button></form></li>`)}</ul>` : h`<p class="empty">No media attached.</p>`}
<form method="post" action="/write/posts/${post.id}/media">${csrfField(csrf)}
<label for="mediaId">OpenVibe.Media object id</label><input id="mediaId" name="mediaId" placeholder="med_…" required pattern="med_[0-9A-HJKMNP-TV-Z]{26}">
<label for="role">Role</label>${select('role', [['inline', 'Inline'], ['cover', 'Cover'], ['gallery', 'Gallery']], 'inline')}
<label for="alt">Alt text</label><input id="alt" name="alt" maxlength="1000">
<label for="caption">Caption</label><input id="caption" name="caption" maxlength="2000">
<button type="submit">Attach</button></form></section>
<h2>Edit</h2>
${raw(o.form)}`);
}

function revisionsPage({ post, head, revisions, diff, from, to, csrf }) {
    return String(h`<p><a href="/write/posts/${post.id}">← Back to the post</a></p>
<h1>History of “${head.fields.title}”</h1>
<form method="get" action="/write/posts/${post.id}/revisions" class="inline">
<label>Compare <input name="from" type="number" min="1" value="${from || ''}"></label> <label>with <input name="to" type="number" min="1" value="${to || ''}"></label> <button type="submit">Diff</button></form>
${diff ? h`<section><h2>Revision ${diff.from} → ${diff.to}</h2>${diff.fields.length ? h`<ul>${diff.fields.map((d) => h`<li>${d.field}: “${d.from}” → “${d.to}”</li>`)}</ul>` : ''}${raw(ssr.diffHtml(diff.content))}</section>` : ''}
<ol class="revisions" reversed>${revisions.map((r) => h`<li><strong>Revision ${r.number}</strong> · ${r.kind}${r.revertedTo ? h` of ${r.revertedTo}` : ''} · ${time(Date.parse(r.createdAt))} · ${(r.meta && r.meta.authorship && r.meta.authorship.mode) || 'human'}${r.message ? h` · ${r.message}` : ''}
${r.number !== head.number ? h`<form method="post" action="/write/posts/${post.id}/revert" class="inline">${csrfField(csrf)}<input type="hidden" name="toRevision" value="${r.number}"><input type="hidden" name="expectedRevision" value="${head.number}"><button type="submit">Restore as a new revision</button></form>` : ''}</li>`)}</ol>`);
}

function settingsPage({ blog, feed, members, people, themes, csrf, message }) {
    return String(h`<p><a href="/write/@${blog.handle}">← ${blog.title}</a></p>
<h1>Settings</h1>
${flash(message)}
<form method="post" action="/write/@${blog.handle}/settings" class="card">${csrfField(csrf)}
<h2>Blog</h2>
<label for="title">Title</label><input id="title" name="title" maxlength="120" value="${blog.title}" required>
<label for="description">Description</label><input id="description" name="description" maxlength="500" value="${blog.description || ''}">
<label for="language">Language (BCP 47)</label><input id="language" name="language" value="${blog.language}">
<h2>Theme</h2>
${select('theme', themes.map((t) => [t.id, `${t.name} (${t.mode})`]), blog.theme)}
<h2>Feeds</h2>
<label><input type="checkbox" name="rss" value="1"${raw(feed.rss ? ' checked' : '')}> RSS</label>
<label><input type="checkbox" name="atom" value="1"${raw(feed.atom ? ' checked' : '')}> Atom</label>
<label><input type="checkbox" name="json" value="1"${raw(feed.json ? ' checked' : '')}> JSON Feed</label>
<label for="itemCount">Items per feed</label><input id="itemCount" name="itemCount" type="number" min="1" max="50" value="${feed.item_count}">
<label><input type="checkbox" name="fullContent" value="1"${raw(feed.full_content ? ' checked' : '')}> Full text in feeds (otherwise summaries)</label>
<button type="submit">Save settings</button></form>
<section class="card"><h2>Members</h2>
<ul>${members.map((m) => { const p = people.get(m.subject); return h`<li>${p ? p.name : m.subject} <span class="meta">${p && p.username ? `@${p.username}` : m.subject}</span> · ${m.role}
${m.role !== 'owner' || blog.kind === 'official' ? h`<form method="post" action="/write/@${blog.handle}/members/remove" class="inline">${csrfField(csrf)}<input type="hidden" name="subject" value="${m.subject}"><button type="submit">Remove</button></form>` : ''}</li>`; })}</ul>
<form method="post" action="/write/@${blog.handle}/members">${csrfField(csrf)}
<label for="member">Username (someone who has signed in to OpenVibe.Blog) or subject id (usr_…)</label><input id="member" name="member" required>
<label for="role">Role</label>${select('role', [['author', 'Author (own posts)'], ['editor', 'Editor (all posts)'], ['owner', 'Owner']], 'author')}
<button type="submit">Add member</button></form></section>`);
}

module.exports = { home, blogDashboard, postForm, editPage, revisionsPage, settingsPage, gateSummary };
