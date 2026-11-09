-- phase: expand
-- The network changelog's tags (plan §9, owner items 61–62): every entry collected after this carries
-- plain words (the commit subject without its PR number or stage tag), a kind (new, better, fixed or
-- internal) and one to three areas from Blog's fixed list (server/changelog/tags.js).
--
-- Entries collected before this stay NULL in kind/plain and empty in areas; scripts/backfill-changelog-
-- tags.js tags them later. Housekeeping (library pins, merges, test-only and docs-only work) is written
-- kind internal at collection without a model; everything else stays NULL until blog.changelog.tag
-- answers. Nothing here is a constraint on the old rows, so the migration only widens the table.

ALTER TABLE changelog_entries ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE changelog_entries ADD COLUMN IF NOT EXISTS areas text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE changelog_entries ADD COLUMN IF NOT EXISTS plain text;
ALTER TABLE changelog_entries ADD COLUMN IF NOT EXISTS tagged_at bigint;
ALTER TABLE changelog_entries ADD COLUMN IF NOT EXISTS tagged_by text;

CREATE INDEX IF NOT EXISTS idx_changelog_kind ON changelog_entries (kind, deployed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_changelog_areas ON changelog_entries USING gin (areas);
