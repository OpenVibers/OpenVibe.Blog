-- phase: expand
-- OpenVibe.Blog's AI desks (server/desks/): digests written by OpenVibe.AI from the items OpenVibe.Sources fetched, and
-- the "Is This Real?" satire desk. A desk post is not a blog post: it never enters blog_posts (whose AI text waits for
-- a person's review), it is labelled as AI-written on every surface and it is never indexed.
--
-- blog_ingest_cursor   openvibe-publishing/ingest change cursors, one per Sources category the desks read
-- blog_desk_items      the Sources items the desks may cite (title, link, summary, fields), kept 21 days
-- blog_desk_posts      one post per desk and period: writing, published, hidden (by staff) or failed (retried)

CREATE TABLE IF NOT EXISTS blog_ingest_cursor (
    name       text COLLATE "C" NOT NULL,
    cursor     bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (name)
);

CREATE TABLE blog_desk_items (
    item_id      text COLLATE "C" PRIMARY KEY,
    source_key   text COLLATE "C" NOT NULL,
    title        text,
    url          text,
    summary      text,
    published_at text,
    fields       jsonb NOT NULL DEFAULT '{}'::jsonb,
    revision     integer NOT NULL DEFAULT 1,
    -- When the item appeared or last changed: Sources' first_seen_at for a new item, the time Blog saw a new revision.
    changed_at   bigint NOT NULL,
    updated_at   bigint NOT NULL
);
CREATE INDEX blog_desk_items_changed ON blog_desk_items (source_key, changed_at);

CREATE TABLE blog_desk_posts (
    id            text COLLATE "C" PRIMARY KEY,
    desk          text COLLATE "C" NOT NULL,
    slug          text COLLATE "C" NOT NULL,
    status        text NOT NULL CHECK (status IN ('writing','published','hidden','failed')),
    title         text,
    dek           text,
    -- digest: { sections: [{ heading, body, cites: [n] }], gaps: [] }; satire: { markdown, tags, topic, angle }
    body          jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- the items the AI was given, in order (a citation n is sources[n]): [{ item_id, source_key, title, url, published_at }]
    sources       jsonb NOT NULL DEFAULT '[]'::jsonb,
    period_from   bigint NOT NULL,
    period_to     bigint NOT NULL,
    run_id        text,
    model         text,
    synthetic     boolean NOT NULL DEFAULT false,
    attempts      integer NOT NULL DEFAULT 0,
    error         text,
    hidden_by     text,
    hidden_reason text,
    created_at    bigint NOT NULL,
    published_at  bigint,
    updated_at    bigint NOT NULL,
    UNIQUE (desk, slug),
    UNIQUE (desk, period_from)
);
CREATE INDEX blog_desk_posts_listing ON blog_desk_posts (desk, status, published_at DESC);
