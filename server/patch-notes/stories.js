'use strict';
/**
 * Patch notes v2, steps 4–6: commits become stories (devblog §3.2).
 *
 * The unit is a workstream, not a commit. Entries cluster by intent first (text.intentOf), then by an explicit
 * `Workstream:` trailer, then by a package they share; a gap of more than 72 hours starts a new cluster. Each
 * cluster is classified (feature | fix | chore | internal) and ranked by player impact — how many sites it reaches,
 * how many commits carry it, and how central the page is — not by how many lines the diff had. A 2,000-line
 * dependency bump is not a story; it is Under the hood.
 *
 * build(entries) → {
 *   stories:      user-visible workstreams, most impactful first (each with entries, sites, score)
 *   also:         user-visible entries outside the top stories (one line each in the post)
 *   chores:       lockfiles, package versions and docs (one Under the hood paragraph)
 *   internal:     no user-visible surface (not written about; in the full list)
 * }
 * The four workstreams the 29–30 October batch is known by have fixed headlines; every other one gets a headline
 * from its first subject, because a headline nobody recognises is worse than a plain one.
 */
const { normaliseSubject, intentOf, siteLabel } = require('./text');

const WINDOW_MS = 72 * 3600 * 1000;
const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty'];

/** 23 → "twenty-three" (counts in headlines read better as words than as digits). */
function words(n) {
    if (n < 20) return NUMBERS[n];
    if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${NUMBERS[n % 10]}` : ''}`;
    return String(n);
}
const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);

/** How central and how visible a workstream is (ranking is player impact, never line count). */
const WEIGHT = { 'sign-in': 30, 'phone-home': 25, touch: 20, orbit: 35, comfort: 10, mcp: 8, outbox: 5, docs: 0, chore: 0, other: 4 };
const HEADLINES = {
    'sign-in': (n) => `One sign-in, ${words(n)} ${plural(n, 'site')}`,
    touch: '44px, or it doesn\'t count',
    'phone-home': 'Homes that scroll sideways',
    orbit: 'The orbit stays put',
    comfort: 'Comfort settings that follow you',
    mcp: 'The design system, now as tools',
};

function headlineFor(key, entries) {
    const sites = new Set(entries.map((e) => e.service)).size;
    // "Wider than a phone" is a fit fix, not a sideways row: say which one this round is.
    if (key === 'phone-home' && entries.every((e) => /wider than a phone/i.test(String(e.subject)))) return 'Homes that fit a phone';
    const h = HEADLINES[key];
    if (typeof h === 'function') return h(sites);
    if (h) return h;
    const first = normaliseSubject(entries[0]);
    const short = first.length > 64 ? `${first.slice(0, 61).replace(/[,;:\s]+$/, '')}…` : first;
    return short.charAt(0).toUpperCase() + short.slice(1);
}

/** A commit subject that is only housekeeping: a version, a lockfile, docs, tests, CI, a merge. */
function isChoreKind(kind) { return kind === 'chore'; }

/**
 * One story per intent (or explicit Workstream trailer), split when its entries are more than 72 hours apart.
 * `entries` carry service, repo, sha, subject, body?, files?, deployed_at.
 */
function cluster(entries) {
    const sorted = [...entries]
        .map((e) => ({ ...e, _at: Date.parse(e.deployed_at || e.committed_at || 0) || 0 }))
        .sort((a, b) => a._at - b._at);
    const groups = new Map();
    for (const e of sorted) {
        const { intent: key, kind } = intentOf(e);
        if (!groups.has(key)) groups.set(key, { key, kind, entries: [], lastAt: 0 });
        const g = groups.get(key);
        // A workstream is one intent within 72 hours; a later commit of the same words is a new round.
        if (g.entries.length && e._at - g.lastAt > WINDOW_MS) {
            let n = 2;
            while (groups.has(`${key}#${n}`)) n++;
            groups.set(`${key}#${n}`, { key, kind, entries: [e], lastAt: e._at });
            continue;
        }
        g.entries.push(e); g.lastAt = e._at;
    }
    return [...groups.values()];
}

/**
 * The module a commit belongs to, when it names one: `openvibe-sdk/sso`, `server/auth/sso.js` and
 * "sign-in" are the same workstream. Kept narrow on purpose — `public/css/app.css` is shared by most
 * sites and would merge unrelated stories.
 */
function packageKey(entry) {
    const subject = String(entry.subject || '');
    if (/\bopenvibe-sdk\/sso\b/i.test(subject) || /\bsign[- ]?in\b|\bsso\b|\boauth\b/i.test(subject)) return 'sso';
    for (const f of Array.isArray(entry.files) ? entry.files : []) {
        if (/(?:^|\/)server\/auth\/sso\.[cm]?js$/.test(f) || /openvibe-sdk\/sso/i.test(f)) return 'sso';
    }
    return null;
}

/** Two rounds of the same module merge; the groups' entries keep their order. */
function mergeByPackage(groups) {
    const out = [];
    for (const g of groups) {
        if (g.kind === 'chore') { out.push(g); continue; }
        const keys = new Set(g.entries.map(packageKey).filter(Boolean));
        if (!keys.size) { out.push(g); continue; }
        const hit = out.find((x) => x.kind !== 'chore' && x.entries.some((e) => keys.has(packageKey(e))));
        if (hit) { hit.entries.push(...g.entries); hit.lastAt = Math.max(hit.lastAt, g.lastAt); } else out.push(g);
    }
    return out;
}

/** A shared package pulls two commits of different intents together only when both are chores. */
function mergeSharedChores(groups) {
    const chores = groups.filter((g) => isChoreKind(g.kind));
    if (chores.length < 2) return groups;
    const rest = groups.filter((g) => !isChoreKind(g.kind));
    const all = chores.flatMap((g) => g.entries);
    return [...rest, { key: 'chore', kind: 'chore', entries: all, lastAt: Math.max(...all.map((e) => Date.parse(e.deployed_at) || 0)) }];
}

function scoreOf(group) {
    const sites = new Set(group.entries.map((e) => e.service)).size;
    const weight = WEIGHT[group.key] == null ? WEIGHT.other : WEIGHT[group.key];
    return sites * 10 + group.entries.length * 2 + weight + (group.kind === 'fix' ? 5 : 0);
}

/**
 * The whole batch as a story map. `maxStories` caps the H2s; every user-visible entry outside them becomes an
 * "Also shipped" line, so nothing with a user-facing surface disappears.
 */
function build(entries, { maxStories = 6 } = {}) {
    const groups = mergeSharedChores(mergeByPackage(cluster(entries)));
    const stories = [];
    const chores = [];
    const internal = [];
    for (const g of groups) {
        if (g.kind === 'chore') { chores.push(g); continue; }
        if (g.kind === 'internal' || g.key === 'outbox') { internal.push(g); continue; }
        stories.push(g);
    }
    for (const s of stories) {
        s.sites = [...new Set(s.entries.map((e) => e.service))].sort();
        s.score = scoreOf(s);
        s.title = headlineFor(s.key, s.entries);
    }
    stories.sort((a, b) => b.score - a.score || b.sites.length - a.sites.length || a.key.localeCompare(b.key));
    const top = stories.slice(0, maxStories);
    const also = stories.slice(maxStories).flatMap((s) => s.entries);
    return { stories: top, also, chores: chores.flatMap((g) => g.entries), internal: internal.flatMap((g) => g.entries), groups };
}

/** The site names of a story, as a sentence: "Play, Search and Coupons". */
function sitesSentence(entries) {
    const names = [...new Set(entries.map((e) => siteLabel(e)))]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    const shown = names.length > 12 ? [...names.slice(0, 12), `${names.length - 12} more`] : names;
    if (shown.length <= 1) return shown[0] || '';
    return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

module.exports = { build, cluster, words, plural, sitesSentence, headlineFor, WEIGHT, WINDOW_MS };
