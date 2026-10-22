'use strict';
/**
 * What the home page shows besides the official blog's own posts, all read from Blog's database and all public:
 *
 *   stats()            public posts and the blogs and writers behind them, AI desk posts, and the changes the
 *                      changelog logged across the network in the last seven days (and how many sites they touched)
 *   weekChanges(n)     those seven days' changes by site, most first
 *   topTags(n)         the tags on the most public posts
 *   memberPosts(n)     the newest public posts on members' blogs
 *
 * Only public, published posts on active blogs count, the rule the listings use (posts.listPublished): the home is cached
 * for everyone, so nothing here may depend on who is looking.
 */
const WEEK_MS = 7 * 24 * 3600 * 1000;
const PUBLIC_POST = "p.state = 'published' AND p.visibility = 'public' AND EXISTS (SELECT 1 FROM blogs b WHERE b.id = p.blog_id AND b.status = 'active')";

function createHome({ store }) {
    const db = store.db;
    const since = () => new Date(store.now() - WEEK_MS).toISOString();
    const q = {
        stats: db.prepare(`SELECT (SELECT COUNT(*) FROM blog_posts p WHERE ${PUBLIC_POST}) AS posts,
                                  (SELECT COUNT(DISTINCT p.blog_id) FROM blog_posts p WHERE ${PUBLIC_POST}) AS blogs,
                                  (SELECT COUNT(DISTINCT p.author_subject) FROM blog_posts p WHERE ${PUBLIC_POST}) AS writers,
                                  (SELECT COUNT(*) FROM blog_desk_posts WHERE status = 'published') AS desk_posts,
                                  (SELECT COUNT(*) FROM changelog_entries WHERE deployed_at >= ?) AS week_changes,
                                  (SELECT COUNT(DISTINCT service) FROM changelog_entries WHERE deployed_at >= ?) AS week_sites`),
        week: db.prepare('SELECT service, COUNT(*) AS n FROM changelog_entries WHERE deployed_at >= ? GROUP BY service ORDER BY n DESC, service LIMIT ?'),
        tags: db.prepare(`SELECT t.slug, t.name, COUNT(*) AS n FROM blog_term_links l JOIN blog_terms t ON t.id = l.term_id
                          JOIN blog_posts p ON p.id = l.entity_id WHERE t.vocabulary = 'tag' AND ${PUBLIC_POST}
                          GROUP BY t.slug, t.name ORDER BY n DESC, t.slug LIMIT ?`),
        memberPosts: db.prepare(`SELECT p.* FROM blog_posts p JOIN blogs mb ON mb.id = p.blog_id AND mb.kind = 'member'
                                 WHERE ${PUBLIC_POST} ORDER BY p.published_at DESC, p.id DESC LIMIT ?`),
    };
    const n = (v) => Number(v) || 0;
    return {
        async stats() {
            const t = since();
            const r = (await q.stats.get(t, t)) || {};
            return { posts: n(r.posts), blogs: n(r.blogs), writers: n(r.writers), deskPosts: n(r.desk_posts), weekChanges: n(r.week_changes), weekSites: n(r.week_sites) };
        },
        async weekChanges(limit = 10) {
            return (await q.week.all(since(), Math.min(50, Math.max(1, limit)))).map((r) => ({ service: r.service, changes: n(r.n) }));
        },
        async topTags(limit = 24) {
            return (await q.tags.all(Math.min(100, Math.max(1, limit)))).map((r) => ({ slug: r.slug, name: r.name, posts: n(r.n) }));
        },
        async memberPosts(limit = 6) {
            return await q.memberPosts.all(Math.min(50, Math.max(1, limit)));
        },
    };
}

module.exports = { createHome, WEEK_MS };
