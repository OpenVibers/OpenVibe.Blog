'use strict';

/**
 * The editor as plain HTML forms (no JavaScript needed). Signed-in members only (Network SSO);
 * every POST carries the form token. Every response is private, no-store and noindex.
 *
 *   GET  /write                              your blogs; start your blog
 *   POST /write/start                        create your member blog (first use)
 *   GET  /write/@:handle                     the blog's posts (drafts included)
 *   GET  /write/@:handle/new, POST …/new     a new draft
 *   GET  /write/posts/:id, POST …            edit (a new revision; 412 when someone saved first)
 *   POST /write/posts/:id/{publish,schedule,unschedule,unpublish,delete,review,revert}
 *   POST /write/posts/:id/media, …/media/:aid/remove
 *   GET  /write/posts/:id/revisions          history and diffs     GET /write/posts/:id/preview
 *   GET|POST /write/@:handle/settings        title, theme, feeds   POST /write/@:handle/members[/remove]
 */
const express = require('express');
const { ids } = require('openvibe-contracts');
const authorship = require('openvibe-publishing/authorship');
const { escapeHtml: esc } = require('openvibe-publishing/ssr');
const { renderPage } = require('../render/layout');
const editor = require('../render/editor');
const { csrfToken, checkCsrf } = require('../auth/forms');
const { asApiError } = require('./errors');

/** Checkbox + hidden fallback arrive as ['1','0']; a text field repeated keeps its last value. */
const one = (v) => (Array.isArray(v) ? (v.includes('1') ? '1' : v[v.length - 1]) : v);

function formInput(body) {
    const b = {};
    for (const [k, v] of Object.entries(body || {})) b[k] = one(v);
    return b;
}

function createEditorRoutes(ctx) {
    const { config, store, blogs, posts, publication, access, people, viewers, effects, publicRoutes } = ctx;
    const router = express.Router();
    const form = express.urlencoded({ extended: false, limit: '600kb' });
    router.use(viewers.middleware({ services: false }));
    router.use((req, res, next) => {
        res.set('Cache-Control', 'private, no-store');
        res.set('X-Robots-Tag', 'noindex, nofollow');
        res.vary('Cookie');
        if (req.viewer.kind !== 'user') {
            if (req.method === 'GET') return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
            return publicRoutes.messagePage(req, res, 401, 'Sign in first', 'Your session ended. Sign in and try again.', { href: `/auth/login?next=${encodeURIComponent('/write')}`, label: 'Sign in' });
        }
        if (!req.viewer.subject) return publicRoutes.messagePage(req, res, 403, 'Account not ready', 'Your OpenVibe sign-in did not include an account id. Sign out and in again.');
        next();
    });
    router.post('*', form, (req, res, next) => {
        if (!checkCsrf(config, req.viewer, req.body && one(req.body._csrf))) return publicRoutes.messagePage(req, res, 403, 'Form expired', 'Reload the page and submit it again.');
        next();
    });

    const wrap = (fn) => async (req, res, next) => {
        try { await fn(req, res, next); } catch (err) {
            const e = asApiError(err);
            if (!e) return next(err);
            const text = e.code === 'revision.conflict'
                ? `Someone saved revision ${e.extra && e.extra.current} while you were editing. Your text was not saved: open the post again, re-apply your change and save.`
                : e.message;
            publicRoutes.messagePage(req, res, e.status, 'That did not work', text, { href: req.get('referer') && /^\//.test(new URL(req.get('referer'), config.baseUrl).pathname) ? new URL(req.get('referer'), config.baseUrl).pathname : '/write', label: 'Back' });
        }
    };

    function page(req, res, title, body, status = 200) {
        const decision = publicRoutes.pageDecision(req.path, { indexable: false });
        res.status(status).type('html').send(renderPage({ title, body, decision, viewer: req.viewer, config, path: req.originalUrl, bodyClass: 'editor' }));
    }

    const csrf = (req) => csrfToken(config, req.viewer);
    const flashOf = (req) => (req.query.saved ? { kind: 'ok', text: String(req.query.saved).slice(0, 200) } : null);

    function blogFor(req) {
        const blog = blogs.byHandle(req.params.handle);
        if (!blog) return null;
        return access.effectiveRole(store, req.viewer, blog) || access.isStaff(req.viewer) ? blog : null;
    }

    function postFor(req) {
        const post = posts.get(req.params.id);
        if (!post || post.state === 'deleted') return null;
        const blog = posts.blogOf(post);
        if (!access.canWrite(store, req.viewer, blog, 'edit', post) && !access.isStaff(req.viewer)) return null;
        return { post, blog };
    }

    const notFound = (req, res) => publicRoutes.notFound(req, res);

    // ── Home, first use ─────────────────────────────────────

    router.get('/', wrap(async (req, res) => {
        const mine = blogs.blogsOf(req.viewer.subject);
        const official = blogs.official();
        if (access.isStaff(req.viewer) && !mine.some((b) => b.id === official.id)) mine.unshift({ ...official, role: 'owner (staff)' });
        page(req, res, 'Write', editor.home({ viewer: req.viewer, blogs: mine, csrf: csrf(req), suggestedHandle: req.viewer.user && req.viewer.user.username ? String(req.viewer.user.username).toLowerCase() : '', message: flashOf(req) }));
    }));

    router.post('/start', wrap(async (req, res) => {
        const b = formInput(req.body);
        const { blog } = blogs.ensureMemberBlog({ subject: req.viewer.subject, username: req.viewer.user && req.viewer.user.username, handle: b.handle, title: b.title });
        res.redirect(303, `/write/@${blog.handle}?saved=${encodeURIComponent('Your blog is ready.')}`);
    }));

    // ── A blog ──────────────────────────────────────────────

    router.get('/@:handle', wrap(async (req, res) => {
        const blog = blogFor(req);
        if (!blog) return notFound(req, res);
        const list = posts.listForDashboard(blog, req.viewer);
        const heads = new Map(list.map((p) => [p.id, (posts.head(p) || { fields: {} }).fields]));
        page(req, res, blog.title, editor.blogDashboard({ blog, posts: list, heads, role: access.effectiveRole(store, req.viewer, blog) || 'staff', csrf: csrf(req), message: flashOf(req), publicUrl: publication.blogPath(blog) }));
    }));

    router.get('/@:handle/new', wrap(async (req, res) => {
        const blog = blogFor(req);
        if (!blog || !access.canWrite(store, req.viewer, blog, 'create')) return notFound(req, res);
        page(req, res, 'New post', `<p><a href="/write/@${esc(blog.handle)}">← ${esc(blog.title)}</a></p><h1>New post</h1>${editor.postForm({ blog, post: null, head: null, terms: {}, series: null, csrf: csrf(req), action: `/write/@${blog.handle}/new` })}`);
    }));

    router.post('/@:handle/new', wrap(async (req, res) => {
        const blog = blogFor(req);
        if (!blog) return notFound(req, res);
        const { post } = posts.create(req.viewer, blog, formInput(req.body), { traceparent: req.ov && req.ov.traceparent });
        effects.after(null, post, req.ov);
        res.redirect(303, `/write/posts/${post.id}?saved=${encodeURIComponent('Draft saved (revision 1).')}`);
    }));

    router.get('/@:handle/settings', wrap(async (req, res) => {
        const blog = blogFor(req);
        if (!blog || !access.canWrite(store, req.viewer, blog, 'configure')) return notFound(req, res);
        const members = blogs.members(blog);
        const who = await people.many(members.map((m) => m.subject));
        page(req, res, 'Settings', editor.settingsPage({ blog, feed: blogs.feedSettings(blog), members, people: who, themes: Object.values(blogs.THEMES), csrf: csrf(req), message: flashOf(req) }));
    }));

    router.post('/@:handle/settings', wrap(async (req, res) => {
        const blog = blogFor(req);
        if (!blog || !access.canWrite(store, req.viewer, blog, 'configure')) return notFound(req, res);
        const b = formInput(req.body);
        store.tx(() => {
            const updated = blogs.update(blog, { title: b.title, description: b.description, language: b.language });
            if (b.theme) blogs.setTheme(updated, b.theme);
            blogs.setFeedSettings(updated, { rss: b.rss === '1', atom: b.atom === '1', json: b.json === '1', itemCount: b.itemCount, fullContent: b.fullContent === '1' });
        });
        res.redirect(303, `/write/@${blog.handle}/settings?saved=${encodeURIComponent('Settings saved.')}`);
    }));

    router.post('/@:handle/members', wrap(async (req, res) => {
        const blog = blogFor(req);
        if (!blog || !access.canWrite(store, req.viewer, blog, 'members')) return notFound(req, res);
        const b = formInput(req.body);
        const who = String(b.member || '').trim().replace(/^@/, '');
        const subject = ids.isSubjectId('user', who) ? who : (people.byUsername(who) || {}).subject;
        if (!subject) return publicRoutes.messagePage(req, res, 404, 'Member not found', `Nobody called "${who}" has signed in to OpenVibe.Blog yet. Ask them to sign in once, or add them by their usr_ subject id.`, { href: `/write/@${blog.handle}/settings`, label: 'Back' });
        blogs.setMember(blog, subject, b.role, req.viewer.subject);
        res.redirect(303, `/write/@${blog.handle}/settings?saved=${encodeURIComponent('Member saved.')}`);
    }));

    router.post('/@:handle/members/remove', wrap(async (req, res) => {
        const blog = blogFor(req);
        if (!blog || !access.canWrite(store, req.viewer, blog, 'members')) return notFound(req, res);
        blogs.removeMember(blog, formInput(req.body).subject);
        res.redirect(303, `/write/@${blog.handle}/settings?saved=${encodeURIComponent('Member removed.')}`);
    }));

    // ── A post ──────────────────────────────────────────────

    router.get('/posts/:id', wrap(async (req, res) => {
        const found = postFor(req);
        if (!found) return notFound(req, res);
        const { post, blog } = found;
        const head = posts.head(post);
        const published = post.published_revision ? posts.revision(post, post.published_revision) : null;
        const rec = publication.authorshipOf(head);
        const review = publication.reviewOf(post, head);
        const terms = publication.termsOf(post);
        const decision = publication.decide(blog, { ...post, state: 'published' }, head);
        const body = editor.editPage({
            blog, post, head, published, decision, jobs: posts.pendingJobs(post), attachments: posts.attachments(post), csrf: csrf(req),
            disclosure: rec ? authorship.disclosure(rec, review) : null,
            needsReview: rec ? !authorship.canPublish(rec, review).ok : false,
            publicUrl: publication.postPath(blog, post),
            canDelete: access.canWrite(store, req.viewer, blog, 'delete', post),
            form: editor.postForm({ blog, post, head, terms, series: blogs.seriesById(post.series_id), csrf: csrf(req), message: flashOf(req), action: `/write/posts/${post.id}` }),
        });
        page(req, res, `Edit: ${head.fields.title}`, body);
    }));

    router.post('/posts/:id', wrap(async (req, res) => {
        const found = postFor(req);
        if (!found) return notFound(req, res);
        const before = { ...found.post };
        const { post, revision, created } = posts.update(req.viewer, found.post, formInput(req.body), { traceparent: req.ov && req.ov.traceparent });
        effects.after(before, post, req.ov);
        res.redirect(303, `/write/posts/${post.id}?saved=${encodeURIComponent(created ? `Saved as revision ${revision.number}.` : 'Saved (the text did not change, so no new revision).')}`);
    }));

    const action = (name, fn, message) => router.post(`/posts/:id/${name}`, wrap(async (req, res) => {
        const found = postFor(req);
        if (!found && name !== 'unpublish' && name !== 'delete') return notFound(req, res);
        const post = found ? found.post : posts.get(req.params.id);
        if (!post || post.state === 'deleted') return notFound(req, res);
        const before = { ...post };
        const out = await fn(req, post, formInput(req.body));
        const after = posts.get(post.id);
        effects.after(before, after, req.ov);
        if (name === 'delete') return res.redirect(303, `/write/@${posts.blogOf(post).handle}?saved=${encodeURIComponent('Post deleted.')}`);
        res.redirect(303, `/write/posts/${post.id}?saved=${encodeURIComponent(typeof message === 'function' ? message(out) : message)}`);
    }));

    const tp = (req) => ({ traceparent: req.ov && req.ov.traceparent });
    action('publish', (req, post, b) => posts.publish(req.viewer, post, { revision: b.revision }, tp(req)), (out) => (out.changed ? 'Published.' : 'That revision was already published.'));
    action('schedule', (req, post, b) => {
        // <input type="datetime-local"> has no zone: the form says UTC, so it is read as UTC.
        const raw = String(b.at || '');
        const at = /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(raw) ? `${raw}:00Z` : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?$/.test(raw) ? `${raw}Z` : raw;
        return posts.schedule(req.viewer, post, { at, revision: b.revision, action: b.action || 'publish' });
    }, (out) => `Scheduled for ${out.job.runAt}.`);
    action('unschedule', (req, post) => posts.cancelSchedule(req.viewer, post), 'Schedule cancelled.');
    action('unpublish', (req, post) => posts.unpublish(req.viewer, post, tp(req)), 'Unpublished.');
    action('delete', (req, post, b) => {
        if (b.confirm !== '1') throw Object.assign(new Error('Tick the box to confirm the deletion.'), { name: 'PublishingError', status: 422, code: 'post.confirm_required' });
        return posts.remove(req.viewer, post, tp(req));
    }, 'Deleted.');
    action('review', (req, post, b) => posts.review(req.viewer, post, { revision: b.revision, decision: b.decision, note: b.note || null }, tp(req)), (out) => `Review recorded: ${out.decision}.`);
    action('revert', (req, post, b) => posts.revert(req.viewer, post, { toRevision: b.toRevision, expectedRevision: b.expectedRevision }), (out) => `Restored as revision ${out.revision.number}.`);
    action('media', (req, post, b) => posts.attach(req.viewer, post, { mediaId: b.mediaId, role: b.role, alt: b.alt, caption: b.caption }), 'Media attached.');
    router.post('/posts/:id/media/:aid/remove', wrap(async (req, res) => {
        const found = postFor(req);
        if (!found) return notFound(req, res);
        posts.detach(req.viewer, found.post, req.params.aid);
        res.redirect(303, `/write/posts/${found.post.id}?saved=${encodeURIComponent('Media removed.')}`);
    }));

    router.get('/posts/:id/revisions', wrap(async (req, res) => {
        const found = postFor(req);
        if (!found) return notFound(req, res);
        const { post } = found;
        const head = posts.head(post);
        const from = parseInt(req.query.from, 10);
        const to = parseInt(req.query.to, 10);
        const diff = Number.isInteger(from) && Number.isInteger(to) ? posts.diff(post, from, to, 'word') : null;
        page(req, res, 'History', editor.revisionsPage({ post, head, revisions: posts.revisions(post, { limit: 200 }), diff, from, to, csrf: csrf(req) }));
    }));

    router.get('/posts/:id/preview', wrap(async (req, res) => {
        const found = postFor(req);
        if (!found) return notFound(req, res);
        const n = parseInt(req.query.revision, 10);
        const rev = Number.isInteger(n) ? posts.revision(found.post, n) : posts.head(found.post);
        if (!rev) return notFound(req, res);
        return publicRoutes.renderPost(req, res, { blog: found.blog, post: found.post, rev, preview: true });
    }));

    return router;
}

module.exports = { createEditorRoutes, formInput };
