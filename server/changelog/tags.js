'use strict';
/**
 * The network changelog's fixed vocabulary (plan §9): what kind of change an entry is and which
 * parts of the product it touched. One module owns both lists: the AI tagger, the backfill, the
 * API filters and the contract (blog.changelog-entry@2) all read them from here or repeat this
 * exact order.
 *
 * Housekeeping is decided without a model: library pins ("openvibe-shared v4.175.0 (was
 * v4.173.0)"), merges, and test-only, docs-only or CI-only commits are kind internal. Everything
 * else is offered to the blog.changelog.tag task, whose owner-chosen model answers kind, areas and
 * the plain words; the deterministic fallbacks here are what is stored until it answers.
 */

const KINDS = ['new', 'better', 'fixed', 'internal'];

/** The fixed areas, in the order the filters show them. `id` is what the API and contract carry. */
const AREAS = [
    { id: 'phone', label: 'Phone' },
    { id: 'chat', label: 'Chat' },
    { id: 'go-live', label: 'Go live' },
    { id: 'video', label: 'Video' },
    { id: 'menu', label: 'Menu' },
    { id: 'accessibility', label: 'Accessibility' },
    { id: 'speed', label: 'Speed' },
    { id: 'sign-in', label: 'Sign-in' },
    { id: 'wallet', label: 'Wallet' },
    { id: 'ai', label: 'AI' },
    { id: 'search', label: 'Search' },
    { id: 'files', label: 'Files' },
    { id: 'pictures', label: 'Pictures' },
    { id: 'games', label: 'Games' },
    { id: 'design', label: 'Design' },
    { id: 'developer', label: 'Developer' },
    { id: 'machines', label: 'Machines (Link)' },
    { id: 'money', label: 'Money' },
    { id: 'privacy', label: 'Privacy' },
    { id: 'moderation', label: 'Moderation' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'feed', label: 'Feed' },
    { id: 'wiki', label: 'Wiki' },
    { id: 'blog', label: 'Blog' },
    { id: 'community', label: 'Community' },
    { id: 'meme', label: 'Meme' },
    { id: 'shop', label: 'Shop' },
    { id: 'tools', label: 'Tools' },
    { id: 'exchange', label: 'Exchange' },
    { id: 'git', label: 'Git' },
];
const AREA_IDS = AREAS.map((a) => a.id);
const AREA_LABELS = new Map(AREAS.map((a) => [a.id, a.label]));

const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n).trim();
const isKind = (v) => KINDS.includes(v);
const isArea = (v) => AREA_IDS.includes(v);

/** The PR number a subject names in "(#714)"; null when it names none. */
function prOf(subject) {
    const m = /\(#(\d+)\)\s*$/.exec(String(subject || '').trim());
    return m ? Number(m[1]) : null;
}

/** Leading stage tags ("[A6]", "[stage 2]", "[C2]") and conventional prefixes are not the subject. */
function withoutStage(subject) {
    return String(subject || '')
        .replace(/^\s*(?:\[[^\]]{1,40}\]\s*)+/, '')
        .replace(/^\s*[A-Za-z][A-Za-z0-9._-]*\([^)]*\)!?:\s*/, '')   // feat(chat): / fix(menu)!:
        .replace(/^\s*(?:feat|fix|perf|refactor|style|docs?|test|tests|ci|build|chore|deps|revert)!?:\s*/i, '')
        .replace(/^\s*\d+\.\d+\.\d+:\s*/, '')                         // 0.376.0: the release subject
        .replace(/\s*\(#\d+\)\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** A subject in plain words: no PR number, no stage tag, no release-version prefix. */
function plainOf(subject, n = 240) {
    let s = withoutStage(subject);
    s = s.replace(/\s*\(#\d+\)\s*/g, ' ').replace(/\s*\[[^\]]{1,40}\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return clean(s, n) || clean(subject, n) || 'A change';
}

/** Library pins, merges and test/docs/CI-only work: internal without asking a model. */
function isHousekeeping(subject) {
    const s = String(subject || '').replace(/^\s*(?:\[[^\]]{1,40}\]\s*)+/, '').trim();
    return /^Merge (?:branch|pull request|remote|tag)\b/i.test(s)
        || /^Revert "?Merge\b/i.test(s)
        || /^openvibe-[a-z0-9-]+\s+v?\d+\.\d+\.\d+/i.test(s)
        || /^(?:Bump|Pin|Repin)\s+/i.test(s)
        || /^(?:Bump|Pin|Repin)\b.*\bopenvibe-/i.test(s)
        || /^\d+\.\d+\.\d+[:\s]/.test(s)
        || /^(?:test|tests|docs?|ci|build|chore|deps|dependencies|release|lint|format)(?:\([^)]*\))?!?:\s/i.test(s)
        || /^(?:Update|Refresh|Tidy|Normalise|Normalize)\s+(?:the\s+)?(?:deps|dependencies|lockfile|package-lock|docs?|tests?|changelog)\b/i.test(s)
        || /^(?:Add|Update|Fix)\s+(?:a\s+)?(?:test|tests|docs?)\s+(?:only|for)\b/i.test(s);
}

/** Clear subject verbs win before the model; leave ambiguous summaries for the AI tag task. */
function subjectKind(subject) {
    const s = plainOf(subject).replace(/^[^:]{1,24}:\s*/, '').trim();
    if (/^(?:add|introduce|create|launch|ship|enable|support)\b/i.test(s)) return 'new';
    if (/^(?:fix|repair|restore|prevent|stop|no longer\b)|\b(?:no longer|stays? whole|keeps? (?:the )?\w+ whole|stops? (?:being|…|\.\.\.))\b/i.test(s)) return 'fixed';
    return null;
}

function subjectAreas(subject) {
    const s = String(subject || '').toLowerCase();
    return AREA_IDS.filter((id) => new RegExp(`(^|[^a-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(s)).slice(0, 3);
}

/**
 * What is stored when an entry is first collected: plain words always, and kind internal for
 * housekeeping. `kind: null` means the AI task has not answered yet.
 */
function initial(subject) {
    const housekeeping = isHousekeeping(subject);
    return {
        plain: plainOf(subject),
        kind: housekeeping ? 'internal' : subjectKind(subject),
        areas: housekeeping ? [] : (subjectKind(subject) ? subjectAreas(subject) : []),
    };
}

/** A model's answer, made safe: a valid kind, 1–3 known areas (none for internal) and plain words. */
function normalizeTag(value) {
    if (!value || typeof value !== 'object') return null;
    const kind = isKind(value.kind) ? value.kind : null;
    if (!kind) return null;
    let areas = Array.isArray(value.areas) ? value.areas.filter(isArea) : [];
    areas = [...new Set(areas)].slice(0, 3);
    if (kind !== 'internal' && !areas.length) return null;
    const plain = plainOf(value.plain, 240);
    if (!plain) return null;
    return { kind, areas, plain };
}

/** The vocabulary as the API shows it (ids and their display labels). */
function vocabulary() {
    return { kinds: [...KINDS], areas: AREAS.map((a) => ({ ...a })) };
}

module.exports = { KINDS, AREAS, AREA_IDS, AREA_LABELS, vocabulary, isKind, isArea, prOf, plainOf, isHousekeeping, subjectKind, subjectAreas, initial, normalizeTag };
