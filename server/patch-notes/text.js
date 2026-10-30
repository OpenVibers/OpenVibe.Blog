'use strict';
/**
 * Patch notes v2, step 3: a commit subject becomes a workstream (devblog §3.2).
 *
 * normaliseSubject strips the site prefix the repository already tells us ("Play:", "MediaHub:", "Help:"), the PR
 * number and "(was vX)". intentOf maps the words people actually use onto one of the workstreams the network
 * knows (sign-in, touch, phone-home, orbit, comfort, MCP, outbox, docs, chore) — "sso", "sign-in" and "login" are
 * the same story. classify says what kind of change it is: feature, fix, chore (a lockfile, a package version, docs)
 * or internal (no user-visible surface). An explicit commit trailer wins over the words:
 *
 *   Workstream: sign-in
 *   Player-facing: yes
 *   Sites: design, codes, play
 */

const SITE_SUFFIX = '(?:Hub|Network|Restream|Vibe\\.[A-Za-z]+)';

/** The site's own name, from the service id or the repository ("OpenVibe.MediaHub" → "MediaHub"). */
function siteLabel(entry = {}) {
    const repo = String(entry.repo || '').split('/').pop() || '';
    if (repo) {
        const m = repo.match(/^OpenVibe\.(.+)$/);
        if (m) return m[1];
        if (repo === 'OpenRestream') return 'OpenRestream';
    }
    const service = String(entry.service || '');
    return service ? service.split(/[-_]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('') : '';
}

/** The subject without the site prefix, the PR number and "(was vX)". */
function normaliseSubject(entryOrSubject, entry = {}) {
    const raw = typeof entryOrSubject === 'string' ? entryOrSubject : String((entryOrSubject && entryOrSubject.subject) || '');
    const label = typeof entryOrSubject === 'string' ? (entry.repo || entry.service ? siteLabel(entry) : '') : siteLabel(entryOrSubject);
    let s = raw.replace(/\s+/g, ' ').trim();
    if (label) {
        const p = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        s = s.replace(new RegExp(`^\\s*${p}\\s*:\\s+`, 'i'), '');
        s = s.replace(new RegExp(`\\s*\\(${p}\\)\\s*$`, 'i'), '');
    }
    // An "OpenVibe.X: " or "X.y: " prefix is the site too.
    s = s.replace(new RegExp(`^\\s*OpenVibe\\.[A-Za-z]+\\s*:\\s+`), '');
    s = s.replace(/\s*\(#\d+\)\s*$/, '');
    s = s.replace(/\s*\((?:was\s+)?v?\d+\.\d+\.\d+\)\s*$/i, '');
    return s.replace(/\s+/g, ' ').trim();
}

const WORKSTREAM_TRAILER = /^\s*Workstream\s*:\s*(.+?)\s*$/im;
const PLAYER_TRAILER = /^\s*Player-facing\s*:\s*(yes|no)\s*$/im;

/** { intent, kind } for one entry. `intent` is the workstream key; `kind` is feature | fix | chore | internal. */
const INTENTS = [
    ['sign-in', /\b(sign[- ]?ins?|sso|oauth|auth(?:entication)?|log[- ]?in)\b/i, 'feature'],
    ['orbit', /\borbit\b/i, 'fix'],
    ['touch', /\b(touch[- ]?targets?|tap[- ]?targets?|44\s?px|fleet audit|thumb)\b/i, 'fix'],
    ['phone-home', /\b(home(?: page)? (?:on (?:phones?|touch screens?)|is wider than a phone)|wider than a phone|scroll(?:s|ing)? sideways|right-now columns|short lists|scores and ranked lists|examples scroll|tables and card lists|two newest recordings|sign-up perks|traps? a finger|finger drag|on phones?|on touch screens?)\b/i, 'fix'],
    ['comfort', /\b(comfort settings?|comfort display|your look)\b/i, 'feature'],
    ['mcp', /\bmcp\b/i, 'feature'],
    ['outbox', /\boutbox\b/i, 'internal'],
];
const DOCS = /\bin the docs\b|^docs?\b|documentation|readme/i;
const CHORE = /^openvibe-(?:shared|sdk|contracts|publishing)\s+v?\d|^(?:pin|bump)\b|\blockfiles?\b|package\.json|dependenc|^tidy the docs\b|^update the docs\b/i;

function intentOf(entry) {
    const body = String(entry.body || entry.message_body || '');
    const trailer = body.match(WORKSTREAM_TRAILER);
    if (trailer) {
        const slug = String(trailer[1]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
        const known = INTENTS.some(([key]) => key === slug) || ['docs', 'chore'].includes(slug) ? slug : `ws:${slug || 'workstream'}`;
        const face = /^\s*Player-facing\s*:\s*yes/im.test(body);
        return { intent: known, kind: face ? 'feature' : entry.major ? 'feature' : 'fix', explicit: true };
    }
    const subject = normaliseSubject(entry);
    if (DOCS.test(subject)) return { intent: 'docs', kind: 'chore' };
    for (const [key, re, kind] of INTENTS) if (re.test(subject)) return { intent: key, kind };
    if (CHORE.test(subject)) return { intent: 'chore', kind: 'chore' };
    if (entry.major) return { intent: 'other', kind: 'feature' };
    return { intent: 'other', kind: /^add\b|\bnew\b|\bnow\b|support/i.test(subject) ? 'feature' : 'fix' };
}

module.exports = { normaliseSubject, intentOf, siteLabel, INTENTS, WORKSTREAM_TRAILER, PLAYER_TRAILER };
