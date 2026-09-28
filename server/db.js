'use strict';

/**
 * Blog's own PostgreSQL database (ADR-035, roadmap WS-X2): the schema is migrations/NNNN_*.sql, applied at boot. Nothing here is shared with another
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
 * blog_index_revisions), the SDK's PostgreSQL event_outbox, the changelog tables, and subject_projections (a display cache of
 * Network names, never authority).
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { createRevisionStore } = require('openvibe-publishing/revisions');
const { createCitationStore } = require('openvibe-publishing/citations');
const { createTaxonomy } = require('openvibe-publishing/taxonomy');
const { createScheduler } = require('openvibe-publishing/schedule');
const { createAttachmentStore } = require('openvibe-publishing/media');
const { createDiscussionRefs } = require('openvibe-publishing/discussion');
const { createReviewLog } = require('openvibe-publishing/authorship');
const { createRedirectStore } = require('openvibe-publishing/seo');
const { createIndexSequencer } = require('openvibe-publishing/index-hooks');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

/**
 * The serving handle (ADR-035): DATABASE_URL through PgBouncer; in development without it, an embedded PGlite
 * database in data/pglite. Migrations run first, as the owner (DATABASE_DIRECT_URL), or on the embedded handle.
 */
async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh blog)');
        log.warn(`[Blog] DATABASE_URL unset: embedded PGlite database in ${DEV_PGLITE} (development only, one process)`);
        fs.mkdirSync(DEV_PGLITE, { recursive: true });
        const db = createDb({ pglite: DEV_PGLITE, service: 'blog', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'blog-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'blog', registry, log });
}

/**
 * Every store on a migrated database handle. opts.now — injectable clock (epoch ms) shared by the stores, so tests
 * and replays are deterministic. store.tx(fn) is a transaction; inside it, plain db calls join it (ambient).
 */
function createStore(db, { now = () => Date.now(), leaseMs = 60000 } = {}) {
    const revisions = createRevisionStore(db, { prefix: 'blog_post', now });
    return {
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
        tx: async (fn) => await db.tx(() => fn()),
        close: () => db.close(),
    };
}

/** openDb + createStore. */
async function openStore(config, { now, leaseMs, log } = {}) {
    return createStore(await openDb(config, { log }), { now, leaseMs });
}

const CHARTER_TABLES = ['blogs', 'blog_memberships', 'blog_posts', 'blog_post_revisions', 'blog_series',
    'blog_taxonomy', 'blog_post_terms', 'blog_schedules', 'blog_redirects', 'blog_feed_settings'];

module.exports = { openDb, openStore, createStore, CHARTER_TABLES, MIGRATIONS };
