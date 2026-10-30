'use strict';
/**
 * A voice card per author account (devblog §3.4). The card belongs to the account, not the post: the official
 * card is the seed ('official'), a person's card is their `usr_` row, and a patch notes draft uses the official
 * card unless a developer claims a section with their own. It is short enough to read in 30 seconds and specific
 * enough to change a sentence; the AI prompt gets it verbatim plus two samples of the same account's writing.
 *
 *   get(account) → { account, card, public, updated_at }
 *   set(account, input) → the stored card (text ≤ 1200 chars; the known fields only)
 *   prompt(card) → the block the drafting prompt includes
 */
const OFFICIAL_TEXT = 'We. Energetic and specific: we\'re proud of this work and show it with the thing itself (a number, a before/after, what you can do now), never with adjectives. Short sentences. One dry joke at most, never in the first paragraph. One exclamation mark at most per section. Sign off: — the OpenVibe crew.';

const FIELDS = ['name', 'role', 'pov', 'audience', 'sentenceLength', 'humour', 'jargon', 'never', 'signoff', 'text'];
const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

function seedCard() {
    return {
        text: OFFICIAL_TEXT,
        name: 'OpenVibe official',
        role: 'The network account',
        pov: 'we',
        audience: 'Members and contributors, not investors',
        sentenceLength: 'Short. One idea per sentence.',
        humour: 'Dry. One joke at most, never in the first paragraph.',
        jargon: 'None in the story; exact names in the full list.',
        never: ['excited', 'thrilled', 'game-changing', 'seamless as filler'],
        signoff: '— the OpenVibe crew',
    };
}

/** Keep the known fields, strings clipped, `never` a short list of short phrases. */
function normaliseCard(input = {}) {
    const out = {};
    for (const f of FIELDS) {
        if (input[f] === undefined) continue;
        if (f === 'never') {
            out.never = (Array.isArray(input.never) ? input.never : String(input.never || '').split(','))
                .map((x) => clean(x, 60)).filter(Boolean).slice(0, 12);
        } else out[f] = clean(input[f], f === 'text' ? 1200 : 300);
    }
    return out;
}

function createVoiceCards({ store }) {
    const { db } = store;
    const q = {
        get: db.prepare('SELECT * FROM blog_voice_cards WHERE account = ?'),
        put: db.prepare(`INSERT INTO blog_voice_cards (account, card, public, updated_at) VALUES (@account, @card, @public, @at)
            ON CONFLICT (account) DO UPDATE SET card = excluded.card, public = excluded.public, updated_at = excluded.updated_at`),
        list: db.prepare('SELECT * FROM blog_voice_cards ORDER BY account'),
    };

    async function get(account = 'official') {
        const key = /^usr_/.test(String(account)) ? String(account) : 'official';
        const row = await q.get.get(key);
        if (row) return { account: row.account, card: typeof row.card === 'string' ? JSON.parse(row.card) : row.card, public: Boolean(row.public), updated_at: Number(row.updated_at) };
        const official = key === 'official' ? null : await q.get.get('official');
        const card = official ? (typeof official.card === 'string' ? JSON.parse(official.card) : official.card) : seedCard();
        return { account: key, card, public: false, updated_at: 0 };
    }
    const official = () => get('official');

    /** Store a person's card (the official seed is not overwritten by a member). */
    async function set(account, input = {}) {
        const key = /^usr_/.test(String(account)) ? String(account) : 'official';
        const current = await get(key);
        const card = { ...current.card, ...normaliseCard(input) };
        if (key === 'official') card.text = clean(input.text, 1200) || OFFICIAL_TEXT;
        if (!card.signoff) card.signoff = current.card.signoff || '— the OpenVibe crew';
        await q.put.run({ account: key, card: JSON.stringify(card), public: input.public === true || input.public === '1' ? 1 : (current.public ? 1 : 0), at: store.now() });
        return await get(key);
    }

    /** The prompt block: the card as written, field by field. */
    function prompt(entry) {
        const card = (entry && entry.card) || seedCard();
        const lines = [
            `Voice card${card.name ? ` — ${card.name}` : ''}${card.role ? ` (${card.role})` : ''}:`,
            card.text ? `"${card.text}"` : null,
            card.pov ? `Point of view: ${card.pov}.` : null,
            card.audience ? `Audience: ${card.audience}.` : null,
            card.sentenceLength ? `Sentences: ${card.sentenceLength}` : null,
            card.humour ? `Humour: ${card.humour}` : null,
            card.jargon ? `Jargon: ${card.jargon}` : null,
            card.never && card.never.length ? `Never: ${card.never.join(', ')}.` : null,
            card.signoff ? `Sign off exactly: ${card.signoff}` : null,
        ].filter(Boolean);
        return lines.join('\n');
    }

    return { get, official, set, prompt, seedCard, OFFICIAL_TEXT, list: async () => await q.list.all() };
}

module.exports = { createVoiceCards, seedCard, normaliseCard, OFFICIAL_TEXT };
