'use strict';

/**
 * Blog's own SQLite database: created on boot, idempotently. Nothing here is shared with another
 * service; the publishing packages create their tables inside this database with Blog's prefixes.
 *
 * The ten charter tables (roadmap §15.13):
 *
 *   blogs                  Blog-owned   official + member blogs, owner = Network subject
 *   blog_memberships       Blog-owned   owner | editor | author per blog
 *   blog_posts             Blog-owned   publication state: slug, state, visibility, published revision
 *   blog_post_revisions    package      openvibe-publishing/revisions, prefix blog_post (immutable)
 *   blog_series            Blog-owned   ordered series per blog
 *   blog_taxonomy          view         over blog_terms (openvibe-publishing/taxonomy, prefix blog)
 *   blog_post_terms        view         over blog_term_links (same package)
 *   blog_schedules         view         over blog_schedule_jobs (openvibe-publishing/schedule, prefix blog)
 *   blog_redirects         package      openvibe-publishing/seo redirect store, prefix blog
 *   blog_feed_settings     Blog-owned   which feeds a blog offers, item count, full text or summary
 *
 * The three views keep the charter's names readable (`SELECT * FROM blog_schedules`) without a
 * second copy of the package's state: the package tables are the only truth.
 *
 * Also here: the package's companions (blog_post_drafts, blog_post_revision_purges,
 * blog_post_citations, blog_post_attachments, blog_post_reviews, blog_post_discussion_refs,
 * blog_index_revisions), the SDK's event_outbox, and subject_projections (a display cache of
 * Network names, never authority).
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createRevisionStore } = require('openvibe-publishing/revisions');
const { createCitationStore } = require('openvibe-publishing/citations');
const { createTaxonomy } = require('openvibe-publishing/taxonomy');
const { createScheduler } = require('openvibe-publishing/schedule');
const { createAttachmentStore } = require('openvibe-publishing/media');
const { createDiscussionRefs } = require('openvibe-publishing/discussion');
const { createReviewLog } = require('openvibe-publishing/authorship');
const { createRedirectStore } = require('openvibe-publishing/seo');
const { createIndexSequencer } = require('openvibe-publishing/index-hooks');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS blogs (
    id            TEXT PRIMARY KEY,                     -- blg_<ULID>
    kind          TEXT NOT NULL CHECK (kind IN ('official','member')),
    handle        TEXT NOT NULL UNIQUE,                 -- /@handle; the official blog is 'openvibe' and served at /
    owner_subject TEXT,                                 -- usr_… (NULL for the official blog: its owners are memberships)
    title         TEXT NOT NULL,
    description   TEXT,
    theme         TEXT NOT NULL DEFAULT 'vibe',         -- an openvibe-shared theme preset slug
    language      TEXT NOT NULL DEFAULT 'en',
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS blogs_owner ON blogs (owner_subject) WHERE kind = 'member';

CREATE TABLE IF NOT EXISTS blog_memberships (
    blog_id     TEXT NOT NULL REFERENCES blogs(id),
    subject     TEXT NOT NULL,                          -- usr_…
    role        TEXT NOT NULL CHECK (role IN ('owner','editor','author')),
    added_by    TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (blog_id, subject)
);
CREATE INDEX IF NOT EXISTS blog_memberships_subject ON blog_memberships (subject);

CREATE TABLE IF NOT EXISTS blog_series (
    id          TEXT PRIMARY KEY,                       -- ser_<ULID>
    blog_id     TEXT NOT NULL REFERENCES blogs(id),
    slug        TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (blog_id, slug)
);

CREATE TABLE IF NOT EXISTS blog_posts (
    id                  TEXT PRIMARY KEY,               -- pst_<ULID>
    blog_id             TEXT NOT NULL REFERENCES blogs(id),
    slug                TEXT NOT NULL,
    state               TEXT NOT NULL DEFAULT 'draft'
                        CHECK (state IN ('draft','scheduled','published','unpublished','deleted')),
    visibility          TEXT NOT NULL DEFAULT 'public'
                        CHECK (visibility IN ('public','unlisted','members','private')),
    entitlement_key     TEXT,                           -- members (VIP) posts: the entitlement that may read it
    author_subject      TEXT NOT NULL,                  -- usr_… accountable for the post
    series_id           TEXT REFERENCES blog_series(id),
    series_position     INTEGER,
    published_revision  INTEGER,                        -- which revision readers see (NULL: never published)
    first_published_at  INTEGER,
    published_at        INTEGER,                        -- the latest publication of published_revision
    allow_comments      INTEGER NOT NULL DEFAULT 1,
    noindex             INTEGER NOT NULL DEFAULT 0,     -- the author asked search engines not to index it
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    deleted_at          INTEGER,
    CHECK (visibility <> 'members' OR entitlement_key IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS blog_posts_slug ON blog_posts (blog_id, slug) WHERE state <> 'deleted';
CREATE INDEX IF NOT EXISTS blog_posts_listing ON blog_posts (blog_id, state, visibility, published_at);
CREATE INDEX IF NOT EXISTS blog_posts_author ON blog_posts (author_subject, state);
CREATE INDEX IF NOT EXISTS blog_posts_series ON blog_posts (series_id, series_position);

CREATE TABLE IF NOT EXISTS blog_feed_settings (
    blog_id       TEXT PRIMARY KEY REFERENCES blogs(id),
    rss           INTEGER NOT NULL DEFAULT 1,
    atom          INTEGER NOT NULL DEFAULT 1,
    json          INTEGER NOT NULL DEFAULT 1,
    item_count    INTEGER NOT NULL DEFAULT 20 CHECK (item_count BETWEEN 1 AND 50),
    full_content  INTEGER NOT NULL DEFAULT 1,
    updated_at    INTEGER NOT NULL
);

-- Display cache of Network names for subjects (from sign-in claims or identity.subject.resolve).
CREATE TABLE IF NOT EXISTS subject_projections (
    subject       TEXT PRIMARY KEY,
    username      TEXT,
    display_name  TEXT,
    avatar_url    TEXT,
    refreshed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subject_projections_username ON subject_projections (username);
`;

// Charter names over the package tables (created after the stores, which create the tables).
const VIEWS = `
CREATE VIEW IF NOT EXISTS blog_taxonomy AS
    SELECT t.id, CASE WHEN t.vocabulary = 'tag' THEN 'tag' ELSE 'category' END AS kind,
           b.id AS blog_id, t.vocabulary, t.slug, t.name, t.parent_id, t.description, t.created_at
      FROM blog_terms t
      LEFT JOIN blogs b ON t.vocabulary = 'category_' || lower(substr(b.id, 5));
CREATE VIEW IF NOT EXISTS blog_post_terms AS
    SELECT l.entity_id AS post_id, l.term_id, t.vocabulary, l.position, l.created_at
      FROM blog_term_links l JOIN blog_terms t ON t.id = l.term_id;
CREATE VIEW IF NOT EXISTS blog_schedules AS
    SELECT id, idem_key, entity_id AS post_id, action, revision, run_at, status, attempts,
           lease_owner, lease_until, last_error, result, created_at, updated_at
      FROM blog_schedule_jobs;
`;

/**
 * Open (or create) the database and every store on it.
 * opts.now — injectable clock (epoch ms) shared by the stores, so tests and replays are deterministic.
 */
function openStore(dbPath, { now = () => Date.now(), leaseMs = 60000 } = {}) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);

    const revisions = createRevisionStore(db, { prefix: 'blog_post', now });
    const store = {
        db,
        now,
        revisions,
        citations: createCitationStore(db, { prefix: 'blog_post', now, revisions }),
        taxonomy: createTaxonomy(db, { prefix: 'blog', now }),
        // Few attempts: a scheduled publish that cannot happen should say so soon (blog.schedule.failed).
        scheduler: createScheduler(db, { prefix: 'blog', now, leaseMs, maxAttempts: 3, backoffMs: [30000, 120000] }),
        attachments: createAttachmentStore(db, { prefix: 'blog_post', now }),
        discussion: createDiscussionRefs(db, { prefix: 'blog_post', now }),
        reviews: createReviewLog(db, { prefix: 'blog_post', now }),
        redirects: createRedirectStore(db, { prefix: 'blog', now }),
        sequencer: createIndexSequencer(db, { prefix: 'blog', now }),
        tx: (fn) => db.transaction(fn)(),
        close: () => db.close(),
    };
    db.exec(VIEWS);
    return store;
}

const CHARTER_TABLES = ['blogs', 'blog_memberships', 'blog_posts', 'blog_post_revisions', 'blog_series',
    'blog_taxonomy', 'blog_post_terms', 'blog_schedules', 'blog_redirects', 'blog_feed_settings'];

module.exports = { openStore, CHARTER_TABLES };
