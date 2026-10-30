-- phase: expand
-- Patch notes v2 (server/patch-notes/): the stories a batch becomes, the checks a reviewer sees, and the card an
-- author account writes in.
--
-- blog_voice_cards        one card per author account ('official' is the account-wide seed, a usr_ row overrides it)
-- blog_patch_note_drafts  the story map and the checks of one Patch notes draft (post_id → blog_posts.id)
-- changelog_entries       + the commit body, the files it touched and its PR, read once and kept (the body is where
--                         the measurements are; the file list is how stories that share a package find each other)

CREATE TABLE IF NOT EXISTS blog_voice_cards (
    account    text COLLATE "C" PRIMARY KEY,
    card       jsonb NOT NULL,
    public     integer NOT NULL DEFAULT 0,
    updated_at bigint NOT NULL
);

INSERT INTO blog_voice_cards (account, card, public, updated_at)
VALUES (
    'official',
    jsonb_build_object(
        'text', 'We. Energetic and specific: we''re proud of this work and show it with the thing itself (a number, a before/after, what you can do now), never with adjectives. Short sentences. One dry joke at most, never in the first paragraph. One exclamation mark at most per section. Sign off: — the OpenVibe crew.',
        'name', 'OpenVibe official',
        'role', 'The network account',
        'pov', 'we',
        'audience', 'Members and contributors, not investors',
        'sentenceLength', 'Short. One idea per sentence.',
        'humour', 'Dry. One joke at most, never in the first paragraph.',
        'jargon', 'None in the story; exact names in the full list.',
        'never', jsonb_build_array('excited', 'thrilled', 'game-changing', 'seamless as filler'),
        'signoff', '— the OpenVibe crew'
    ),
    1,
    (extract(epoch FROM now()) * 1000)::bigint
)
ON CONFLICT (account) DO NOTHING;

CREATE TABLE IF NOT EXISTS blog_patch_note_drafts (
    post_id    text COLLATE "C" PRIMARY KEY,
    blog_id    text COLLATE "C" NOT NULL,
    stories    jsonb NOT NULL DEFAULT '[]'::jsonb,
    entries    jsonb NOT NULL DEFAULT '[]'::jsonb,
    checks     jsonb,
    voice_card jsonb,
    override   jsonb,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS blog_patch_note_drafts_updated ON blog_patch_note_drafts (updated_at DESC);

ALTER TABLE changelog_entries ADD COLUMN IF NOT EXISTS message_body text;
ALTER TABLE changelog_entries ADD COLUMN IF NOT EXISTS files jsonb;
ALTER TABLE changelog_entries ADD COLUMN IF NOT EXISTS pr_number integer;
