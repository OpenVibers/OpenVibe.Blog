'use strict';

/**
 * Account export and deletion → Blog (ADR-033; openvibe-sdk/account-data). What Blog holds about a person:
 *
 *   their own, deleted       drafts, the display-name cache (subject_projections) and their blog memberships
 *   their member blog        every post in it is removed the way its owner would remove it (posts.remove, acting as
 *                            them: unpublished, out of Search and the feeds), then the blog is suspended, loses its
 *                            title, description and owner (the handle stays reserved)
 *   posts elsewhere          stay, made authorless: author_subject becomes 'deleted' (an official post a staff member
 *                            wrote stays published); added_by and purged_by become NULL; revisions and citations are
 *                            append-only, so only inside the erasure transaction (blog.account_erasure,
 *                            migrations/0002_account_erasure.sql) may a revision's author become NULL (and their id
 *                            leave meta.authorship.authors) or a citation's attached_by become NULL
 *   kept                     post reviews: a person's approval is what lets reviewed text stay published
 *                            (openvibe-publishing/authorship), counted as retained
 *
 * The changelog tables hold commit subjects and git authors, never an account; they are not touched.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const anonymize = { anonymize: {} };

const TABLES = [
    { table: 'blog_post_drafts', subject: 'owner', file: 'drafts.json', columns: ['entity_id', 'base_revision', 'content', 'fields', 'created_at', 'updated_at'] },
    { table: 'subject_projections', subject: 'subject', file: 'profile.json', order: 'subject' },
    { table: 'blog_memberships', subject: 'added_by', file: null, erase: anonymize },
    { table: 'blog_post_revision_purges', subject: 'purged_by', file: null, erase: anonymize },
    { table: 'blog_post_citation_purges', subject: 'purged_by', file: null, erase: anonymize },
    { table: 'blog_post_reviews', subject: 'reviewer', file: 'reviews.json', columns: ['entity_id', 'revision', 'decision', 'note', 'reviewed_at'], order: 'reviewed_at', erase: { keep: 'a person\'s approval is what lets reviewed text stay published' } },
];

async function extraExport(db, subject) {
    const files = [];
    const blogs = await db.many('SELECT id, kind, handle, title, description, theme, language, status, created_at FROM blogs WHERE owner_subject = $1', [subject]);
    if (blogs.length) files.push({ name: 'blogs.json', content: blogs });
    const memberships = await db.many('SELECT blog_id, role, created_at, updated_at FROM blog_memberships WHERE subject = $1 ORDER BY created_at DESC', [subject]);
    if (memberships.length) files.push({ name: 'memberships.json', content: memberships });
    const posts = await db.many(`SELECT id, blog_id, slug, state, visibility, series_id, published_revision, first_published_at, published_at, created_at, updated_at, deleted_at
        FROM blog_posts WHERE author_subject = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (posts.length) files.push({ name: 'posts.json', content: posts });
    const revisions = await db.many(`SELECT entity_id, number, kind, content, fields, message, created_at FROM blog_post_revisions
        WHERE author = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (revisions.length) files.push({ name: 'revisions.json', content: revisions });
    return files;
}

/** The account-data handle over Blog's database and posts (posts.remove for the person's own blog). */
function create({ db, posts, log = console } = {}) {
    async function extraErase(t, subjects, counts) {
        // Their member blog: each post removed as its owner would remove it (a savepoint in this transaction), while
        // their membership still says they own it; then the blog is suspended and loses what names them.
        const own = await t.many("SELECT id, owner_subject FROM blogs WHERE kind = 'member' AND owner_subject = ANY($1::text[])", [subjects]);
        for (const blog of own) {
            const viewer = { kind: 'user', subject: blog.owner_subject, staff: false };
            const live = await t.many("SELECT id FROM blog_posts WHERE blog_id = $1 AND state <> 'deleted' ORDER BY created_at", [blog.id]);
            for (const p of live) await posts.remove(viewer, await posts.get(p.id));
            counts.add(counts.erased, 'blog_posts', live.length);
        }
        counts.add(counts.retained, 'blogs', await t.exec(`UPDATE blogs SET status = 'suspended', owner_subject = NULL, title = 'Deleted blog', description = NULL, updated_at = $2
            WHERE kind = 'member' AND owner_subject = ANY($1::text[])`, [subjects, Date.now()]));
        counts.add(counts.erased, 'blog_memberships', await t.exec('DELETE FROM blog_memberships WHERE subject = ANY($1::text[])', [subjects]));
        counts.add(counts.retained, 'tombstones', await t.exec("UPDATE blog_posts SET author_subject = 'deleted' WHERE author_subject = ANY($1::text[])", [subjects]));
        // Only this transaction may take a person's id out of the append-only rows; the setting ends with it.
        await t.value("SELECT set_config('blog.account_erasure', 'on', true)");
        counts.add(counts.retained, 'tombstones', await t.exec('UPDATE blog_post_revisions SET author = NULL WHERE author = ANY($1::text[])', [subjects]));
        counts.add(counts.retained, 'tombstones', await t.exec(`UPDATE blog_post_revisions
            SET meta = jsonb_set(meta, '{authorship,authors}', COALESCE((SELECT jsonb_agg(a) FROM jsonb_array_elements(meta->'authorship'->'authors') a
                WHERE NOT ((a #>> '{}') = ANY($1::text[]))), '[]'::jsonb))
            WHERE jsonb_typeof(meta->'authorship'->'authors') = 'array' AND (meta->'authorship'->'authors') ?| $1::text[]`, [subjects]));
        counts.add(counts.retained, 'tombstones', await t.exec('UPDATE blog_post_citations SET attached_by = NULL WHERE attached_by = ANY($1::text[])', [subjects]));
        await t.value("SELECT set_config('blog.account_erasure', 'off', true)");
    }
    return createAccountData({
        db, service: 'blog', tables: TABLES, extraExport, extraErase, log,
        note: 'Your own blog\'s posts are deleted and the blog closed. Posts you wrote on other blogs stay without your name.',
    });
}

module.exports = { create, TABLES, TOPICS };
