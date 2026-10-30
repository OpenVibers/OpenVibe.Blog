'use strict';
/**
 * Patch notes v2, step 7 and §3.1: the post template, written from the story map.
 *
 * compose() writes the deterministic draft: title (5–9 words, no counts), dek (one sentence for the feed), the
 * short version (three player outcomes), one H2 per top workstream with what changed, why and how to see it,
 * Under the hood for chores, What's next from open PRs (at most three, each linked), and the full list in a
 * collapsible block — the only place commit subjects appear. When OpenVibe.AI is configured, the same material
 * goes to blog.draft_post as numbered sources plus the voice card and the two newest published posts, and the
 * answer replaces the story prose; the tail (list, next, sign-off) stays deterministic. Either way the result is
 * a DRAFT: this module never publishes.
 */
const { siteLabel } = require('./text');
const { sitesSentence, words } = require('./stories');

const AUDIT = { homes: 42, targets: 2386, under: 2348, sitesUnder: 40, shared: 1628, source: 'research-2026-10-29/tap-targets.md' };

const SIGNAL = {
    'sign-in': 'Sign-in lands',
    touch: 'taps grow',
    'phone-home': 'homes fit a phone',
    orbit: 'the orbit stays put',
    comfort: 'comfort follows you',
    mcp: 'the design system opens up',
};
// The order a post leads with: the account flow first, then the phone work. Rank still picks the top stories.
const LEAD = { 'sign-in': 0, touch: 1, 'phone-home': 2, orbit: 3, comfort: 4, mcp: 5 };
const forPost = (stories) => [...stories].sort((a, b) => (LEAD[baseKey(a.key)] == null ? 9 : LEAD[baseKey(a.key)]) - (LEAD[baseKey(b.key)] == null ? 9 : LEAD[baseKey(b.key)]));
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const sentence = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const baseKey = (key) => String(key || '').split('#')[0];

function titleFor(stories) {
    const signals = forPost(stories).slice(0, 3).map((s) => SIGNAL[baseKey(s.key)]).filter(Boolean);
    if (signals.length >= 3) return cap(`${signals[0]}, ${signals[1]}, and ${signals[2]}`);
    if (signals.length === 2) return cap(`${signals[0]} and ${signals[1]}`);
    if (signals.length === 1) return cap(signals[0]);
    return stories[0] ? stories[0].title : 'What changed this round';
}

function dekFor(stories) {
    const top = forPost(stories).slice(0, 2);
    const parts = top.map((s) => {
        const sites = s.sites.length;
        switch (baseKey(s.key)) {
        case 'sign-in': return `${words(sites)} more ${sites === 1 ? 'site signs' : 'sites sign'} in through one module`;
        case 'touch': return `${words(sites)} more keep their targets at 44px on a phone for a thumb`;
        case 'phone-home': return `${words(sites)} home ${sites === 1 ? 'page no longer runs' : 'pages no longer run'} wider than the screen`;
        case 'orbit': return 'the orbit stays where it is';
        default: return lowerFirst(s.title);
        }
    });
    const text = parts.length === 2 ? `${parts[0]}, and ${parts[1]}` : parts[0] || 'The changes this round, with the numbers and the links.';
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function introFor(stories) {
    const names = forPost(stories).slice(0, 3).map((s) => (baseKey(s.key) === 'sign-in' ? 'sign-in' : baseKey(s.key) === 'phone-home' ? 'phone screens' : baseKey(s.key) === 'touch' ? 'thumbs' : lowerFirst(s.title)));
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    return `This round is ${list}. The short version, then the details.`;
}

function shortVersionFor(stories) {
    return forPost(stories).slice(0, 3).map((s) => {
        const sites = s.sites.length;
        switch (baseKey(s.key)) {
        case 'sign-in': return `Sign-in is one module on ${words(sites)} more ${sites === 1 ? 'site' : 'sites'}. A lost flow retries once by itself; if it still cannot, you get a Try again page.`;
        case 'touch': return `${words(sites).replace(/^./, (c) => c.toUpperCase())} more sites keep their targets at 44px on a phone: chips, FAQ rows, and the small links.`;
        case 'phone-home': return `${words(sites).replace(/^./, (c) => c.toUpperCase())} home ${sites === 1 ? 'page no longer runs' : 'pages no longer run'} wider than the phone screen.`;
        case 'orbit': return 'The orbit stays in place, and its labels stay clear of each other.';
        default: return `${s.title.replace(/\.$/, '')}.`;
        }
    });
}

function movedAndPinned(entries) {
    const pinned = entries.filter((e) => /^pin\b/i.test(String(e.subject || '').trim()));
    const moved = entries.length - pinned.length;
    return { moved, pinned: pinned.length };
}

/** The first sentences of a commit body that carry the reason or a measurement. */
function factsOf(entry, max = 2) {
    const lines = String(entry.body || entry.message_body || '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^[-*]\s/.test(l) && !/^(what this buys|the site's own copy|move the site's own copy)/i.test(l) && l.length > 40);
    return lines.slice(0, max).map(sentence);
}

function sectionFor(story, ctx) {
    const key = baseKey(story.key);
    const sites = sitesSentence(story.entries);
    const n = story.sites.length;
    if (key === 'sign-in') {
        const { moved, pinned } = movedAndPinned(story.entries);
        const how = [];
        if (moved) how.push(`${words(moved)} moved their copy onto the module`);
        if (pinned) how.push(`${words(pinned)} moved the module in without touching their code`);
        return [
            `Every site used to carry its own copy of the sign-in code. That meant one place to fix for each site when a flow expired, a secret was wrong, or a cookie changed. ${cap(how.join('; '))}: ${sites}.`,
            'A lost or expired flow, or a code the Network no longer accepts, starts the sign-in once more by itself. If it still cannot, you get a page with a Try again button instead of a dead end. A client the Network refuses is logged as a configuration error, and the site\'s health check answers 503, so a bad setup fails at deploy, not at your first visit.',
            'The old site cookie is read as the session, so moving the code did not sign anyone out.',
            `To see it, sign out and back in on any of these: ${sites}.`,
        ];
    }
    if (key === 'touch') {
        return [
            `The audit measures ${AUDIT.homes} product home pages at 390px: ${AUDIT.targets.toLocaleString('en-US')} targets, ${AUDIT.under.toLocaleString('en-US')} of them under 44px on ${AUDIT.sitesUnder} of the ${AUDIT.homes}. This round is the per-site groups on ${words(n)} more: ${sites}.`,
            'The text can stay small. The target cannot. On a phone, a chip, a FAQ row or a small link now takes a 44px touch when the word is narrower than that.',
            `The shared navbar and footer are the next pass; they accounted for ${AUDIT.shared.toLocaleString('en-US')} of the audit's targets.`,
            `To see it, open one of these on a phone and tap the smallest link: ${sites}.`,
        ];
    }
    if (key === 'phone-home') {
        return [
            `At 390px, ${words(n)} home ${n === 1 ? 'page was' : 'pages were'} wider than the screen. The right edge was cut off, or the page zoomed out to fit it. ${sites} now stay inside the width.`,
            'Each one fixed the page\'s width rule; the cards keep their size.',
            `To see it, open the home page at 390px and drag sideways: the page itself does not move.`,
        ];
    }
    if (key === 'orbit') {
        const facts = [...new Set(story.entries.flatMap((e) => factsOf(e)))].slice(0, 4);
        return [
            'The touch-target pass added `position: relative` to `.orb-node` on touch screens. The orbit places each node with `position: absolute`, so the link went inline, lost its 34px size, and every icon filled the orbit. On a phone the page was 857px wide.',
            'The fix keeps the absolute placement; the `::after` hit area already works. On phones the orbit grows to 340px, the inner ring is 27.5% of the card width, the outer ring is 46.5% with 26px icons, and the core mark is 52px. Labels no longer cross the core or the outer sites at 270px. Under 360px, the core drops its "one account" line.',
            ...(facts.length ? [facts.join(' ')] : []),
            'To see it, open the Network home on a phone: the rings turn, and the page does not grow.',
        ];
    }
    const facts = [...new Set(story.entries.flatMap((e) => factsOf(e, 1)))].slice(0, 3);
    return [
        `${story.title} landed on ${sites}.`,
        ...(facts.length ? facts : ['The change is live on those sites now.']),
        `To see it, open ${sites}.`,
    ];
}

function underTheHood(chores) {
    if (!chores.length) return '';
    const versions = new Map();
    let docs = 0;
    for (const e of chores) {
        const subject = String(e.subject || '');
        const v = subject.match(/openvibe-(shared|sdk|contracts|publishing)\s+(v\d+\.\d+\.\d+)/i);
        if (/in the docs|documentation|readme/i.test(subject)) { docs++; continue; }
        if (v) {
            const key = `openvibe-${v[1].toLowerCase()} ${v[2].toLowerCase()}`;
            versions.set(key, (versions.get(key) || 0) + 1);
        }
    }
    const parts = [...versions.entries()].map(([v, n]) => `${v} on ${n} ${n === 1 ? 'site' : 'sites'}`);
    if (docs) parts.push(`the sign-in SDK's docs on ${docs} ${docs === 1 ? 'site' : 'sites'}`);
    const what = parts.length ? parts.join(', ') : `${chores.length} housekeeping ${chores.length === 1 ? 'commit' : 'commits'}`;
    return `## Under the hood\n\nThe batch also carried ${what}. Lockfiles, version strings and docs only: no new user-facing change, so they get this paragraph instead of a heading each.\n`;
}

function labelForPull(p) {
    const m = String(p.title || '').match(/^([A-Za-z][A-Za-z .-]{1,24}):\s+(.+)$/);
    if (m) return { label: m[1].trim(), text: m[2].trim() };
    if (/sign.?in|sso/i.test(p.title)) return { label: 'Sign-in', text: String(p.title) };
    if (/phone|touch|drag|finger/i.test(p.title)) return { label: 'Phones', text: String(p.title) };
    return { label: 'Next', text: String(p.title) };
}

/** The open PRs worth naming: user-facing work, never a version bump, at most `max`. */
function nextItems(pulls = [], max = 3) {
    const pin = /^(?:openvibe-(?:shared|sdk|contracts|publishing)\s+v?\d|pin\b|bump\b)|openvibe-(?:shared|sdk|contracts|publishing)\s+v?\d+(?:\.\d+)*\s*\((?:was|from)\b/i;
    const seen = new Set();
    return pulls
        .filter((p) => p && p.url && /^https:\/\/github\.com\/OpenVibers\/[^/]+\/pull\/\d+$/.test(p.url))
        .filter((p) => !pin.test(String(p.title || '')))
        .filter((p) => { const k = String(p.title || '').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, max);
}

function whatsNext(pulls) {
    const items = nextItems(pulls);
    if (!items.length) return '';
    const lines = items.map((p) => {
        const { label, text } = labelForPull(p);
        const cleanText = text.replace(/^v?\d+\.\d+\.\d+:\s*/, '').replace(/\.$/, '');
        return `- **${label}, open PR:** ${cleanText} ([#${p.number}](${p.url})).`;
    });
    return `## What's next\n\n${lines.join('\n')}\n`;
}

function fullList(map, stories) {
    const link = (e) => `- [${sentence(e.subject)}](${e.url || `https://github.com/${e.repo}/commit/${e.sha}`})`;
    const bySite = (list) => [...list].sort((a, b) => siteLabel(a).localeCompare(siteLabel(b)) || String(a.subject).localeCompare(String(b.subject)));
    const out = ['## The full list', '', '<details>', '<summary>The commits behind these stories</summary>', ''];
    for (const s of stories) {
        out.push(`**${s.title}**`);
        out.push(...bySite(s.entries).map(link));
        out.push('');
    }
    if (map.also.length) {
        out.push('**Also shipped**');
        out.push(...bySite(map.also).map(link));
        out.push('');
    }
    if (map.internal.length) {
        out.push('**Internal**');
        out.push(...bySite(map.internal).map(link));
        out.push('');
    }
    if (map.chores.length) {
        out.push('**Under the hood**');
        out.push(...bySite(map.chores).map(link));
        out.push('');
    }
    out.push('</details>');
    return out.join('\n');
}

/** The whole post, deterministically. */
function compose({ map, voice, pulls = [] }) {
    const stories = map.stories;
    const signoff = (voice && voice.card && voice.card.signoff) || '— the OpenVibe crew';
    if (!stories.length) {
        const body = [underTheHood(map.chores), fullList(map, []), '', signoff].filter((x) => x != null).join('\n');
        return {
            title: 'The package versions moved', dek: 'Housekeeping only this round: package versions, lockfiles and docs, with no new user-facing change.',
            body: body.replace(/\n{3,}/g, '\n\n').trim(), tags: ['patch-notes'],
        };
    }
    const title = titleFor(stories);
    const dek = dekFor(stories);
    const body = [
        introFor(stories), '',
        '## The short version', '',
        ...shortVersionFor(stories).map((b) => `- ${b}`), '',
        ...forPost(stories).flatMap((s) => [`## ${s.title}`, '', ...sectionFor(s, {}), '']),
        underTheHood(map.chores),
        whatsNext(pulls),
        fullList(map, stories),
        '',
        (voice && voice.card && voice.card.signoff) || '— the OpenVibe crew',
    ].filter((line) => line !== null && line !== undefined).join('\n');
    return { title, dek, body: body.replace(/\n{3,}/g, '\n\n').trim(), tags: ['patch-notes', ...stories.map((s) => baseKey(s.key)).slice(0, 4)] };
}

/** The brief the AI gets: the template, the voice card and the story map (4,000 chars is the workflow's limit). */
function briefFor({ map, voice, blog }) {
    const storyLines = map.stories.map((s, i) => {
        const facts = [...new Set(s.entries.flatMap((e) => factsOf(e, 1)))].slice(0, 2).join(' ');
        return `${i + 1}. ${s.title} (${s.kind}); ${s.sites.length} sites: ${sitesSentence(s.entries)}.${facts ? ` Evidence: ${facts.slice(0, 220)}` : ''}`;
    });
    const text = [
        `Draft the Patch notes post for @${blog.handle}, in the voice card below. The numbered sources are the commits (source_type git.commit) and two recent posts in this voice (blog.post.sample). Use only them. Put anything you cannot support in gaps; invent nothing.`,
        '',
        'Template, exactly:',
        '- title: 5–9 words, the promise of this round. No counts, no versions, no "Patch notes:" prefix.',
        '- dek: one sentence, 20–35 words, the top two changes and who they are for.',
        '- body: a two-sentence intro; "## The short version" with 3 bullets, each a player outcome that stands alone; then one "## <what changed>" per workstream below, 2–6 sections, each saying what changed, why, and how to see it. No repository names, no commit subjects, no PR numbers, no "workstream", "pin", "fleet audit" or "shipped" as a noun in the story.',
        '- Do not write "Under the hood", "What\'s next", "Thanks" or "The full list": they are added after your text. Do not sign off.',
        '- No adjectives about the work. A number, a before/after, or what the reader can do now. One dry joke at most, never in the first paragraph.',
        '',
        'Workstreams this round:',
        ...storyLines,
        ...(map.chores.length ? [`Housekeeping (not a section; one line is enough if you mention it): ${sitesSentence(map.chores) || `${map.chores.length} commits`}.`] : []),
        '',
        voice.text ? `Voice card:\n${voice.text}` : '',
    ].join('\n');
    return text.slice(0, 4000);
}

/** Merge the AI's story prose with the deterministic tail; the full list is never the model's job. */
function mergeAi(aiBody, det, voice) {
    let body = String(aiBody || '').replace(/\r\n/g, '\n').trim();
    if (!body) return det.body;
    body = body.replace(/^#\s+.+\n+/, '');
    const cut = body.search(/^##\s+(Under the hood|What's next|Thanks|The full list)\s*$/im);
    if (cut >= 0) body = body.slice(0, cut).trim();
    body = body.replace(/^—\s*the OpenVibe crew\s*$/im, '').replace(/\n*—\s*the OpenVibe crew\s*$/i, '').trim();
    if (!/^##\s+The short version/im.test(body)) {
        body = `${body}\n\n${det.body.match(/## The short version[\s\S]*?(?=\n##\s)/)[0].trim()}`;
    }
    if (body.trim().startsWith('##')) {
        const intro = det.body.split('\n\n')[0];
        body = `${intro}\n\n${body}`;
    }
    const tail = det.body.slice(det.body.indexOf('## Under the hood') >= 0 ? det.body.indexOf('## Under the hood') : det.body.indexOf("## What's next") >= 0 ? det.body.indexOf("## What's next") : det.body.indexOf('## The full list'));
    return `${body}\n\n${tail}`.replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { compose, briefFor, mergeAi, titleFor, dekFor, sectionFor, nextItems, AUDIT };
