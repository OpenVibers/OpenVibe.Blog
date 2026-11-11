-- phase: expand
-- Sharing defaults (VISIBILITY-EVERYWHERE-DESIGN-2026-11-06 rules 1-2): a person's default audience for
-- the posts they write, and the setting "Apply to all my existing posts" next to it. Expand only.
-- Specific people is a per-post choice (it needs a list), so it is not a default here.
CREATE TABLE IF NOT EXISTS share_defaults (
    owner_subject text NOT NULL,
    kind text NOT NULL,
    audience text NOT NULL CHECK (audience IN ('public','unlisted','private')),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (owner_subject, kind)
);
