-- phase: expand
-- Separate weekly reservations: the daily Patch notes retain ownership of changelog entries.
CREATE TABLE IF NOT EXISTS blog_devblog_slots (
    service text NOT NULL,
    week_start text NOT NULL,
    blog_id text NOT NULL REFERENCES blogs(id),
    status text NOT NULL CHECK (status IN ('reserved', 'drafted', 'failed')),
    attempt integer NOT NULL DEFAULT 1,
    post_id text REFERENCES blog_posts(id),
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (service, week_start)
);
CREATE INDEX IF NOT EXISTS blog_devblog_slots_blog ON blog_devblog_slots(blog_id, created_at);
