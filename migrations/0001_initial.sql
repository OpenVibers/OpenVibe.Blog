-- phase: expand
-- OpenVibe.Blog on PostgreSQL (ADR-035, roadmap WS-X2): the charter tables and the changelog as they were on SQLite,
-- typed for PostgreSQL (epoch milliseconds stay bigint, ISO text times stay text, 0/1 flags stay integer, so the API is
-- unchanged), the openvibe-publishing stores, the three charter views, and the openvibe-sdk outbox. Identifier
-- columns sort like SQLite (COLLATE "C"). Generated once on 2026-09-28; never edited after it runs.

CREATE TABLE blogs (
    id            text COLLATE "C" PRIMARY KEY,
    kind          text NOT NULL CHECK (kind IN ('official','member')),
    handle        text COLLATE "C" NOT NULL UNIQUE,
    owner_subject text COLLATE "C",
    title         text NOT NULL,
    description   text,
    theme         text NOT NULL DEFAULT 'vibe',
    language      text NOT NULL DEFAULT 'en',
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL
);
CREATE UNIQUE INDEX blogs_owner ON blogs (owner_subject) WHERE kind = 'member';

CREATE TABLE blog_memberships (
    blog_id     text COLLATE "C" NOT NULL REFERENCES blogs(id),
    subject     text COLLATE "C" NOT NULL,
    role        text NOT NULL CHECK (role IN ('owner','editor','author')),
    added_by    text,
    created_at  bigint NOT NULL,
    updated_at  bigint NOT NULL,
    PRIMARY KEY (blog_id, subject)
);
CREATE INDEX blog_memberships_subject ON blog_memberships (subject);

CREATE TABLE blog_series (
    id          text COLLATE "C" PRIMARY KEY,
    blog_id     text COLLATE "C" NOT NULL REFERENCES blogs(id),
    slug        text COLLATE "C" NOT NULL,
    title       text NOT NULL,
    description text,
    created_at  bigint NOT NULL,
    updated_at  bigint NOT NULL,
    UNIQUE (blog_id, slug)
);

CREATE TABLE blog_posts (
    id                  text COLLATE "C" PRIMARY KEY,
    blog_id             text COLLATE "C" NOT NULL REFERENCES blogs(id),
    slug                text COLLATE "C" NOT NULL,
    state               text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','scheduled','published','unpublished','deleted')),
    visibility          text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','unlisted','members','private')),
    entitlement_key     text,
    author_subject      text COLLATE "C" NOT NULL,
    series_id           text COLLATE "C" REFERENCES blog_series(id),
    series_position     integer,
    published_revision  integer,
    first_published_at  bigint,
    published_at        bigint,
    allow_comments      integer NOT NULL DEFAULT 1,
    noindex             integer NOT NULL DEFAULT 0,
    created_at          bigint NOT NULL,
    updated_at          bigint NOT NULL,
    deleted_at          bigint,
    CHECK (visibility <> 'members' OR entitlement_key IS NOT NULL)
);
CREATE UNIQUE INDEX blog_posts_slug ON blog_posts (blog_id, slug) WHERE state <> 'deleted';
CREATE INDEX blog_posts_listing ON blog_posts (blog_id, state, visibility, published_at);
CREATE INDEX blog_posts_published ON blog_posts (published_at DESC, id) WHERE state = 'published';
CREATE INDEX blog_posts_author ON blog_posts (author_subject, state);
CREATE INDEX blog_posts_series ON blog_posts (series_id, series_position);

CREATE TABLE blog_feed_settings (
    blog_id       text COLLATE "C" PRIMARY KEY REFERENCES blogs(id),
    rss           integer NOT NULL DEFAULT 1,
    atom          integer NOT NULL DEFAULT 1,
    json          integer NOT NULL DEFAULT 1,
    item_count    integer NOT NULL DEFAULT 20 CHECK (item_count BETWEEN 1 AND 50),
    full_content  integer NOT NULL DEFAULT 1,
    updated_at    bigint NOT NULL
);

-- Display cache of Network names for subjects (from sign-in claims or identity.subject.resolve).
CREATE TABLE subject_projections (
    subject       text COLLATE "C" PRIMARY KEY,
    username      text,
    display_name  text,
    avatar_url    text,
    refreshed_at  bigint NOT NULL
);
CREATE INDEX subject_projections_username ON subject_projections (username);

-- The network changelog (server/changelog.js): deployed commits of every service, batched into Patch notes posts.
CREATE TABLE changelog_state (
    service    text COLLATE "C" PRIMARY KEY,
    release    text NOT NULL,
    head       text,
    checked_at bigint NOT NULL
);
CREATE TABLE changelog_entries (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    service       text COLLATE "C" NOT NULL,
    repo          text NOT NULL,
    sha           text COLLATE "C" NOT NULL,
    subject       text NOT NULL,
    committed_at  text,
    deployed_at   text COLLATE "C" NOT NULL,
    release       text NOT NULL,
    release_lines integer NOT NULL DEFAULT 0,
    major         integer NOT NULL DEFAULT 0,
    post_id       text,
    author        text,
    UNIQUE (service, sha)
);
CREATE INDEX idx_changelog_pending ON changelog_entries (post_id, deployed_at);
CREATE INDEX idx_changelog_service ON changelog_entries (service, deployed_at);
CREATE INDEX idx_changelog_feed ON changelog_entries (deployed_at DESC, id DESC);
CREATE TABLE changelog_posts (
    post_id     text COLLATE "C" PRIMARY KEY,
    blog_id     text NOT NULL,
    entries     integer NOT NULL,
    from_at     text,
    to_at       text,
    reason      text NOT NULL,
    ai_draft_id text,
    created_at  bigint NOT NULL
);
CREATE TABLE changelog_history (
    service     text COLLATE "C" PRIMARY KEY,
    imported    integer NOT NULL,
    imported_at bigint NOT NULL
);

-- openvibe-publishing/revisions (prefix blog_post)
CREATE TABLE IF NOT EXISTS blog_post_revisions (
    id            text PRIMARY KEY,
    entity_id     text COLLATE "C" NOT NULL,
    number        integer NOT NULL CHECK (number >= 1),
    parent_id     text,
    parent_number integer,
    kind          text NOT NULL CHECK (kind IN ('edit','revert','import')),
    reverted_to   integer,
    content       text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}',
    meta          jsonb NOT NULL DEFAULT '{}',
    content_hash  text NOT NULL,
    author        text,
    message       text,
    created_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS blog_post_revisions_entity_num ON blog_post_revisions (entity_id, number);
CREATE TABLE IF NOT EXISTS blog_post_drafts (
    entity_id     text COLLATE "C" NOT NULL,
    owner         text COLLATE "C" NOT NULL,
    base_revision integer NOT NULL,
    content       text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}',
    meta          jsonb NOT NULL DEFAULT '{}',
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL,
    PRIMARY KEY (entity_id, owner)
);
CREATE INDEX IF NOT EXISTS blog_post_drafts_updated ON blog_post_drafts (entity_id, updated_at DESC, owner);
CREATE TABLE IF NOT EXISTS blog_post_revision_purges (
    entity_id   text COLLATE "C" PRIMARY KEY,
    reason      text NOT NULL,
    purged_by   text,
    purged_at   bigint NOT NULL
);
CREATE OR REPLACE FUNCTION blog_post_revisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'blog_post_revisions rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM blog_post_revision_purges WHERE entity_id = OLD.entity_id) THEN
        RAISE EXCEPTION 'blog_post_revisions rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER blog_post_revisions_no_update BEFORE UPDATE ON blog_post_revisions FOR EACH ROW EXECUTE FUNCTION blog_post_revisions_guard();
CREATE OR REPLACE TRIGGER blog_post_revisions_no_delete BEFORE DELETE ON blog_post_revisions FOR EACH ROW EXECUTE FUNCTION blog_post_revisions_guard();

-- openvibe-publishing/citations (prefix blog_post)
CREATE TABLE IF NOT EXISTS blog_post_citations (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id      text COLLATE "C" NOT NULL,
    revision       integer NOT NULL CHECK (revision >= 1),
    anchor         text,
    source_item_id text COLLATE "C",
    url            text,
    title          text,
    retrieved_at   timestamptz,
    quote_text     text,
    quote_start    integer,
    quote_end      integer,
    license_note   text,
    carried_from   bigint REFERENCES blog_post_citations(id),
    attached_by    text,
    attached_at    bigint NOT NULL,
    CHECK (source_item_id IS NOT NULL OR url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS blog_post_citations_rev ON blog_post_citations (entity_id, revision, id);
CREATE INDEX IF NOT EXISTS blog_post_citations_source ON blog_post_citations (source_item_id, entity_id, revision, id) WHERE source_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS blog_post_citations_carried ON blog_post_citations (carried_from) WHERE carried_from IS NOT NULL;
CREATE TABLE IF NOT EXISTS blog_post_citation_purges (
    entity_id text COLLATE "C" PRIMARY KEY,
    reason    text NOT NULL,
    purged_by text,
    purged_at bigint NOT NULL
);
CREATE OR REPLACE FUNCTION blog_post_citations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'blog_post_citations rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM blog_post_citation_purges WHERE entity_id = OLD.entity_id) THEN
        RAISE EXCEPTION 'blog_post_citations rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER blog_post_citations_no_update BEFORE UPDATE ON blog_post_citations FOR EACH ROW EXECUTE FUNCTION blog_post_citations_guard();
CREATE OR REPLACE TRIGGER blog_post_citations_no_delete BEFORE DELETE ON blog_post_citations FOR EACH ROW EXECUTE FUNCTION blog_post_citations_guard();

-- openvibe-publishing/taxonomy (prefix blog)
CREATE TABLE IF NOT EXISTS blog_terms (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vocabulary  text NOT NULL,
    slug        text NOT NULL,
    name        text NOT NULL,
    parent_id   bigint REFERENCES blog_terms(id),
    description text,
    created_at  bigint NOT NULL,
    UNIQUE (vocabulary, slug)
);
CREATE INDEX IF NOT EXISTS blog_terms_parent ON blog_terms (parent_id, name);
CREATE INDEX IF NOT EXISTS blog_terms_vocab ON blog_terms (vocabulary, name);
CREATE TABLE IF NOT EXISTS blog_term_links (
    entity_id   text COLLATE "C" NOT NULL,
    term_id     bigint NOT NULL REFERENCES blog_terms(id),
    position    integer NOT NULL DEFAULT 0,
    created_at  bigint NOT NULL,
    PRIMARY KEY (entity_id, term_id)
);
CREATE INDEX IF NOT EXISTS blog_term_links_term ON blog_term_links (term_id, entity_id);

-- openvibe-publishing/schedule (prefix blog)
CREATE TABLE IF NOT EXISTS blog_schedule_jobs (
    id          text COLLATE "C" PRIMARY KEY,
    idem_key    text NOT NULL UNIQUE,
    entity_id   text COLLATE "C" NOT NULL,
    action      text NOT NULL CHECK (action IN ('publish','unpublish')),
    revision    integer,
    run_at      bigint NOT NULL,
    status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
    attempts    integer NOT NULL DEFAULT 0,
    lease_owner text,
    lease_until bigint,
    last_error  text,
    result      jsonb,
    created_at  bigint NOT NULL,
    updated_at  bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS blog_schedule_jobs_due ON blog_schedule_jobs (run_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS blog_schedule_jobs_lease ON blog_schedule_jobs (lease_until) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS blog_schedule_jobs_entity ON blog_schedule_jobs (entity_id, run_at, id);

-- openvibe-publishing/media (prefix blog_post)
CREATE TABLE IF NOT EXISTS blog_post_attachments (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id     text COLLATE "C" NOT NULL,
    revision      integer,
    media_id      text COLLATE "C" NOT NULL,
    role          text NOT NULL DEFAULT 'inline',
    variant       text,
    alt           text,
    caption       text,
    position      integer NOT NULL DEFAULT 0,
    state         text NOT NULL DEFAULT 'unverified' CHECK (state IN ('unverified','available','broken')),
    broken_reason text CHECK (broken_reason IS NULL OR broken_reason IN ('not_found','deleted','forbidden')),
    checked_at    bigint,
    created_at    bigint NOT NULL,
    CHECK ((state = 'broken') = (broken_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS blog_post_attachments_entity ON blog_post_attachments (entity_id, position, id);
CREATE INDEX IF NOT EXISTS blog_post_attachments_media ON blog_post_attachments (media_id, entity_id);

-- openvibe-publishing/discussion (prefix blog_post)
CREATE TABLE IF NOT EXISTS blog_post_discussion_refs (
    entity_id   text COLLATE "C" PRIMARY KEY,
    thread_id   text NOT NULL,
    ref         jsonb NOT NULL,
    resolved_at bigint NOT NULL
);

-- openvibe-publishing/authorship (prefix blog_post)
CREATE TABLE IF NOT EXISTS blog_post_reviews (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id   text COLLATE "C" NOT NULL,
    revision    integer NOT NULL,
    reviewer    text NOT NULL,
    decision    text NOT NULL CHECK (decision IN ('approved','rejected')),
    note        text,
    reviewed_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS blog_post_reviews_rev ON blog_post_reviews (entity_id, revision, id);
CREATE INDEX IF NOT EXISTS blog_post_reviews_entity ON blog_post_reviews (entity_id, id);
CREATE OR REPLACE FUNCTION blog_post_reviews_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'blog_post_reviews rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER blog_post_reviews_no_update BEFORE UPDATE ON blog_post_reviews FOR EACH ROW EXECUTE FUNCTION blog_post_reviews_guard();

-- openvibe-publishing/seo (prefix blog)
CREATE TABLE IF NOT EXISTS blog_redirects (
    from_path  text COLLATE "C" PRIMARY KEY,
    entity_id  text COLLATE "C" NOT NULL,
    reason     text,
    created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS blog_redirects_entity ON blog_redirects (entity_id, created_at, from_path);

-- openvibe-publishing/index-hooks (prefix blog)
CREATE TABLE IF NOT EXISTS blog_index_revisions (
    owner      text COLLATE "C" NOT NULL,
    type       text COLLATE "C" NOT NULL,
    id         text COLLATE "C" NOT NULL,
    revision   integer NOT NULL,
    hash       text NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (owner, type, id)
);


-- Charter names over the package tables: the package tables are the only truth.
CREATE VIEW blog_taxonomy AS
    SELECT t.id, CASE WHEN t.vocabulary = 'tag' THEN 'tag' ELSE 'category' END AS kind,
           b.id AS blog_id, t.vocabulary, t.slug, t.name, t.parent_id, t.description, t.created_at
      FROM blog_terms t
      LEFT JOIN blogs b ON t.vocabulary = 'category_' || lower(substr(b.id, 5));
CREATE VIEW blog_post_terms AS
    SELECT l.entity_id AS post_id, l.term_id, t.vocabulary, l.position, l.created_at
      FROM blog_term_links l JOIN blog_terms t ON t.id = l.term_id;
CREATE VIEW blog_schedules AS
    SELECT id, idem_key, entity_id AS post_id, action, revision, run_at, status, attempts,
           lease_owner, lease_until, last_error, result, created_at, updated_at
      FROM blog_schedule_jobs;

-- openvibe-sdk/events PostgreSQL outbox
CREATE TABLE IF NOT EXISTS event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;
