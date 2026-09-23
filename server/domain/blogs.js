'use strict';

/**
 * Blogs, memberships, series, feed settings and themes.
 *
 * - The official blog (handle 'openvibe', served at /) exists from the first boot; its owners are
 *   the Network subjects named in BLOG_OFFICIAL_OWNERS, and Network admins act as its owners.
 * - Every member gets a blog on first use (ensureMemberBlog): owner = the member's Network subject,
 *   handle = their Network username when it is free and valid. One member blog per subject.
 * - Themes are a small set of openvibe-shared token presets; there is no site-local theme engine.
 */
const { ids } = require('openvibe-contracts');
const { BUILTIN_THEMES } = require('openvibe-shared/builtin-themes');
const { slugify } = require('openvibe-publishing/taxonomy');
const { ApiError } = require('../http/errors');

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
// Paths the site uses, and names that would impersonate the network.
const RESERVED = new Set(['openvibe', 'official', 'admin', 'staff', 'api', 'auth', 'write', 'tags', 'authors', 'series',
    'categories', 'feed', 'feeds', 'sitemap', 'sitemaps', 'robots', 'llms', 'release', 'metrics', 'assets', 'css', 'js',
    'network', 'blog', 'blogs', 'help', 'support', 'security', 'terms', 'privacy', 'dmca', 'new', 'settings', 'me']);

// The presets a blog may choose: a readable handful from openvibe-shared's built-in themes.
const THEME_PRESETS = ['vibe', 'paper', 'slate', 'sand', 'nord', 'high-contrast'];
const THEMES = Object.fromEntries(BUILTIN_THEMES.filter((t) => THEME_PRESETS.includes(t.id)).map((t) => [t.id, t]));
const ROLES = ['owner', 'editor', 'author'];

const newBlogId = (now) => `blg_${ids.ulid(now)}`;
const newSeriesId = (now) => `ser_${ids.ulid(now)}`;

function validHandle(h) { return typeof h === 'string' && HANDLE_RE.test(h) && !RESERVED.has(h); }

function createBlogs({ store, config }) {
    const { db } = store;
    const q = {
        byId: db.prepare('SELECT * FROM blogs WHERE id = ?'),
        byHandle: db.prepare('SELECT * FROM blogs WHERE handle = ?'),
        byOwner: db.prepare("SELECT * FROM blogs WHERE owner_subject = ? AND kind = 'member'"),
        official: db.prepare("SELECT * FROM blogs WHERE kind = 'official'"),
        insert: db.prepare(`INSERT INTO blogs (id, kind, handle, owner_subject, title, description, theme, language, created_at, updated_at)
                            VALUES (@id, @kind, @handle, @owner_subject, @title, @description, @theme, @language, @now, @now)`),
        feedDefaults: db.prepare('INSERT OR IGNORE INTO blog_feed_settings (blog_id, updated_at) VALUES (?, ?)'),
        member: db.prepare('SELECT * FROM blog_memberships WHERE blog_id = ? AND subject = ?'),
        members: db.prepare('SELECT * FROM blog_memberships WHERE blog_id = ? ORDER BY CASE role WHEN \'owner\' THEN 0 WHEN \'editor\' THEN 1 ELSE 2 END, created_at'),
        putMember: db.prepare(`INSERT INTO blog_memberships (blog_id, subject, role, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                               ON CONFLICT (blog_id, subject) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`),
        dropMember: db.prepare('DELETE FROM blog_memberships WHERE blog_id = ? AND subject = ?'),
        ownerCount: db.prepare("SELECT COUNT(*) AS n FROM blog_memberships WHERE blog_id = ? AND role = 'owner'"),
        blogsOf: db.prepare(`SELECT b.*, m.role FROM blog_memberships m JOIN blogs b ON b.id = m.blog_id WHERE m.subject = ? ORDER BY b.kind DESC, b.created_at`),
        feed: db.prepare('SELECT * FROM blog_feed_settings WHERE blog_id = ?'),
        series: db.prepare('SELECT * FROM blog_series WHERE blog_id = ? ORDER BY title'),
        seriesBySlug: db.prepare('SELECT * FROM blog_series WHERE blog_id = ? AND slug = ?'),
        seriesById: db.prepare('SELECT * FROM blog_series WHERE id = ?'),
    };

    function create({ kind, handle, owner, title, description = null, theme = 'vibe', language = 'en' }) {
        const now = store.now();
        const row = { id: newBlogId(now), kind, handle, owner_subject: owner || null, title, description, theme, language, now };
        q.insert.run(row);
        q.feedDefaults.run(row.id, now);
        if (owner) q.putMember.run(row.id, owner, 'owner', owner, now, now);
        return q.byId.get(row.id);
    }

    const api = {
        THEMES, THEME_PRESETS, ROLES, validHandle,

        get: (id) => q.byId.get(id) || null,
        byHandle: (handle) => q.byHandle.get(String(handle || '').toLowerCase()) || null,
        ownedBy: (subject) => (subject ? q.byOwner.get(subject) || null : null),
        blogsOf: (subject) => (subject ? q.blogsOf.all(subject) : []),

        /** The official blog, created on first boot; config owners become owner memberships. */
        ensureOfficial() {
            return store.tx(() => {
                let blog = q.official.get();
                if (!blog) {
                    blog = create({ kind: 'official', handle: config.official.handle, owner: null, title: config.official.title, description: config.official.description });
                }
                const now = store.now();
                for (const s of config.official.owners) {
                    if (!ids.isSubjectId('user', s)) { console.warn(`[Blog] BLOG_OFFICIAL_OWNERS: ignoring "${s}" (not a usr_ subject)`); continue; }
                    if (!q.member.get(blog.id, s)) q.putMember.run(blog.id, s, 'owner', 'config', now, now);
                }
                return blog;
            });
        },

        official: () => q.official.get() || null,

        /**
         * The member's own blog, created on first use. Handle: the requested one, else the Network
         * username. A taken or reserved handle is a 409 the member resolves by choosing another.
         */
        ensureMemberBlog({ subject, username, handle, title, description } = {}) {
            if (!ids.isSubjectId('user', subject)) throw new ApiError(403, 'subject.required', 'Only a signed-in member (usr_ subject) can own a blog');
            return store.tx(() => {
                const existing = q.byOwner.get(subject);
                if (existing) return { blog: existing, created: false };
                const h = String(handle || username || '').toLowerCase();
                if (!validHandle(h)) throw new ApiError(422, 'blog.invalid_handle', `"${h}" cannot be a blog handle (2–40 of a–z, 0–9, _ and -, not a reserved word)`);
                if (q.byHandle.get(h)) throw new ApiError(409, 'blog.handle_taken', `@${h} is taken; choose another handle`);
                const blog = create({ kind: 'member', handle: h, owner: subject, title: String(title || `@${h}`).slice(0, 120), description: description ? String(description).slice(0, 500) : null });
                return { blog, created: true };
            });
        },

        update(blog, { title, description, language } = {}) {
            const sets = [];
            const vals = [];
            if (title != null) { const t = String(title).trim().slice(0, 120); if (!t) throw new ApiError(422, 'blog.invalid_title', 'A blog needs a title'); sets.push('title = ?'); vals.push(t); }
            if (description != null) { sets.push('description = ?'); vals.push(String(description).trim().slice(0, 500) || null); }
            if (language != null) {
                if (!/^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(String(language))) throw new ApiError(422, 'blog.invalid_language', 'language must be a BCP 47 tag, e.g. en or pt-BR');
                sets.push('language = ?'); vals.push(String(language));
            }
            if (!sets.length) return blog;
            db.prepare(`UPDATE blogs SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, store.now(), blog.id);
            return q.byId.get(blog.id);
        },

        setTheme(blog, theme) {
            if (!THEMES[theme]) throw new ApiError(422, 'blog.invalid_theme', `theme must be one of ${THEME_PRESETS.join(', ')}`);
            db.prepare('UPDATE blogs SET theme = ?, updated_at = ? WHERE id = ?').run(theme, store.now(), blog.id);
            return q.byId.get(blog.id);
        },

        /** CSS custom properties of the blog's preset, for its content surface. */
        themeVars(blog) { return (THEMES[blog.theme] || THEMES.vibe).variables; },

        feedSettings(blog) { return q.feed.get(blog.id) || { blog_id: blog.id, rss: 1, atom: 1, json: 1, item_count: 20, full_content: 1 }; },

        setFeedSettings(blog, { rss, atom, json, itemCount, fullContent } = {}) {
            const cur = api.feedSettings(blog);
            const b = (v, d) => (v == null ? d : (v === true || v === 1 || v === '1' || v === 'on' || v === 'true') ? 1 : 0);
            const n = itemCount == null ? cur.item_count : parseInt(itemCount, 10);
            if (!Number.isInteger(n) || n < 1 || n > 50) throw new ApiError(422, 'feed.invalid_item_count', 'item count must be between 1 and 50');
            db.prepare(`INSERT INTO blog_feed_settings (blog_id, rss, atom, json, item_count, full_content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT (blog_id) DO UPDATE SET rss = excluded.rss, atom = excluded.atom, json = excluded.json,
                        item_count = excluded.item_count, full_content = excluded.full_content, updated_at = excluded.updated_at`)
                .run(blog.id, b(rss, cur.rss), b(atom, cur.atom), b(json, cur.json), n, b(fullContent, cur.full_content), store.now());
            return api.feedSettings(blog);
        },

        members: (blog) => q.members.all(blog.id),
        membership: (blog, subject) => q.member.get(blog.id, subject) || null,

        setMember(blog, subject, role, addedBy) {
            if (!ids.isSubjectId('user', subject)) throw new ApiError(422, 'member.invalid_subject', 'members are Network user subjects (usr_…)');
            if (!ROLES.includes(role)) throw new ApiError(422, 'member.invalid_role', `role must be one of ${ROLES.join(', ')}`);
            return store.tx(() => {
                const cur = q.member.get(blog.id, subject);
                if (cur && cur.role === 'owner' && role !== 'owner' && q.ownerCount.get(blog.id).n <= 1 && blog.kind === 'member') {
                    throw new ApiError(409, 'member.last_owner', 'A blog keeps at least one owner');
                }
                const now = store.now();
                q.putMember.run(blog.id, subject, role, addedBy || null, now, now);
                return q.member.get(blog.id, subject);
            });
        },

        removeMember(blog, subject) {
            return store.tx(() => {
                const cur = q.member.get(blog.id, subject);
                if (!cur) return false;
                if (cur.role === 'owner' && q.ownerCount.get(blog.id).n <= 1 && blog.kind === 'member') throw new ApiError(409, 'member.last_owner', 'A blog keeps at least one owner');
                q.dropMember.run(blog.id, subject);
                return true;
            });
        },

        series: (blog) => q.series.all(blog.id),
        seriesBySlug: (blog, slug) => q.seriesBySlug.get(blog.id, slug) || null,
        seriesById: (id) => (id ? q.seriesById.get(id) || null : null),

        /** Get-or-create a series by title. */
        ensureSeries(blog, title, description = null) {
            const t = String(title || '').trim().slice(0, 120);
            if (!t) throw new ApiError(422, 'series.invalid_title', 'A series needs a title');
            const slug = slugify(t);
            return store.tx(() => {
                const cur = q.seriesBySlug.get(blog.id, slug);
                if (cur) return cur;
                const now = store.now();
                const id = newSeriesId(now);
                db.prepare('INSERT INTO blog_series (id, blog_id, slug, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                    .run(id, blog.id, slug, t, description, now, now);
                return q.seriesById.get(id);
            });
        },

        /** The taxonomy vocabulary that holds this blog's categories (tags are network-wide). */
        categoryVocabulary: (blog) => `category_${blog.id.slice(4).toLowerCase()}`,
    };
    return api;
}

module.exports = { createBlogs, THEME_PRESETS, RESERVED, HANDLE_RE, validHandle };
