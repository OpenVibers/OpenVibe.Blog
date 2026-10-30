'use strict';
/**
 * The review gate (devblog §3.6, §3.8): a Patch notes post is only ever a draft until a person approves it.
 *
 * evaluate() runs the checks on the draft and returns what the reviewer sees: the story map, the blocking issues,
 * the warnings, and a checklist. Hard gates block publishing — a banned phrase (unless the editor overrode it with
 * a reason), a looks word, an unresolved [TODO], a broken link, an attached image without alt text, AI-only text
 * without a person's approval, or no approval at all. Warnings do not block: a title with a count, a section with
 * no screenshot, a commit subject in the story.
 *
 * Links are checked for shape always; the HTTP check runs when the caller gives verifyLinks (the editor does; a
 * draft made inside the worker does not, so a GitHub hiccup never stops the draft from being filed).
 */
const { scan } = require('./slop');
const { hasLooks, isExplicit } = require('./no-looks');

const H2 = /^##\s+(.+)$/gm;
const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const TODO = /\[(TODO|FIXME|TBD)[^\]]*\]/i;
const countWords = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const storyPart = (body) => String(body || '').split(/<details/i)[0];
const withoutDetails = (body) => String(body || '').replace(/<details[\s\S]*?<\/details>/gi, ' ');

function headingsOf(body) {
    const out = [];
    H2.lastIndex = 0;
    let m;
    while ((m = H2.exec(String(body || '')))) out.push(m[1].trim());
    return out;
}

function linksOf(body) {
    const out = [];
    LINK.lastIndex = 0;
    let m;
    while ((m = LINK.exec(String(body || '')))) out.push({ text: m[1], url: m[2] });
    for (const m of String(body || '').matchAll(/(?<![("])\bhttps?:\/\/[^\s)<]+/g)) out.push({ text: '', url: m[0] });
    return out;
}

function whatsNextBullets(body) {
    const m = String(body || '').match(/^##\s+What's next\s*([\s\S]*?)(?=^##\s|(?![\s\S]))/im);
    if (!m) return [];
    return m[1].split('\n').filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '').trim());
}

/**
 * checkDraft:
 *   title, dek, body, tags, captions, attachments [{role, alt}], entries (the commits), storyMap,
 *   review ({decision, reviewer}), authorship ({mode, workflow} or null), override ({reason, phrases}),
 *   verifyLinks ((url) => Promise<boolean>) optional.
 */
async function evaluate(draft) {
    const { title = '', dek = '', body = '', tags = [], captions = [], attachments = [], entries = [], storyMap = [], review = null, authorship: rec = null, override = null, verifyLinks = null } = draft;
    const blocking = [];
    const warnings = [];
    const checklist = [];
    const add = (list, code, message, extra = {}) => list.push({ code, message, ...extra });

    // ── slop and looks ──
    const slop = scan({ title, dek, body, tags, captions });
    const forgiven = new Set(((override && override.phrases) || []).map((p) => String(p).toLowerCase()));
    for (const b of slop.blocking) {
        if (forgiven.has(b.phrase)) warnings.push({ code: 'slop.overridden', where: b.where, message: `Overridden by the editor: "${b.phrase}".`, detail: override && override.reason });
        else blocking.push(b);
    }
    warnings.push(...slop.warnings);
    // The full list holds exact commit subjects (a "token cap" is not a hat); the story is what describes people.
    const looksText = [title, dek, withoutDetails(body), ...tags, ...captions].join('\n');
    if (hasLooks(looksText)) add(blocking, 'looks.person', 'The text describes a person (looks, body, clothing, hair, age or a guessed gender). Public AI text never does. Say "the person" or "the streamer", or remove the sentence.');
    if (isExplicit(title, dek, body)) add(blocking, 'looks.explicit', 'The text describes sexual content. It cannot be published.');
    checklist.push({ code: 'voice', label: 'The voice card is followed; no banned phrases; no looks language', ok: !blocking.some((b) => /^(slop|looks)\./.test(b.code)), detail: blocking.filter((b) => /^(slop|looks)\./.test(b.code)).length ? `${blocking.filter((b) => /^(slop|looks)\./.test(b.code)).length} blocking` : 'clean' });

    // ── unresolved placeholders ──
    if (TODO.test(body) || TODO.test(title) || TODO.test(dek)) add(blocking, 'draft.todo', 'An unresolved [TODO] is still in the draft.');

    // ── links ──
    const links = linksOf(body);
    const badShape = links.filter((l) => !/^https?:\/\//i.test(l.url) && !l.url.startsWith('#'));
    for (const l of badShape) add(blocking, 'link.invalid', `"${l.text || l.url}" is not an absolute http(s) link.`, { url: l.url });
    let broken = [];
    if (typeof verifyLinks === 'function') {
        for (const l of links.filter((x) => /^https?:\/\//i.test(x.url))) {
            try { if (!await verifyLinks(l.url)) broken.push(l.url); } catch { broken.push(l.url); }
        }
        for (const url of broken) add(blocking, 'link.broken', `The link does not resolve: ${url}`, { url });
    }
    checklist.push({ code: 'links', label: 'Every link resolves', ok: badShape.length === 0 && broken.length === 0, detail: badShape.length || broken.length ? `${badShape.length + broken.length} problem${badShape.length + broken.length === 1 ? '' : 's'}` : (typeof verifyLinks === 'function' ? 'checked' : 'shape checked; HTTP check runs in the editor') });

    // ── images and alt text ──
    const images = attachments.filter((a) => a && a.role && a.role !== 'reference');
    const noAlt = images.filter((a) => !String(a.alt || '').trim());
    for (const a of noAlt) add(blocking, 'media.alt_required', `The attached image ${a.mediaId || ''} has no alt text.`);
    const headed = headingsOf(body).filter((h) => !/^(the short version|under the hood|what's next|thanks|the full list)$/i.test(h));
    const hasImage = images.length > 0 || /!\[[^\]]*\]\([^)]*\)/.test(body);
    const reasons = (body.match(/^No (?:screenshot|image):.+/gim) || []).length;
    checklist.push({ code: 'screenshots', label: 'Every section has a screenshot, or a line saying why not', ok: hasImage || reasons >= headed.length, detail: hasImage ? `${images.length} attached` : 'no image yet (the capture pass is a later stage); a "No screenshot: …" line covers a section' });
    if (!hasImage) warnings.push({ code: 'media.none', message: 'No screenshot. The biggest visible change should have one (§3.3 is a later stage).' });

    // ── title and dek ──
    const tw = countWords(title);
    if (tw < 5 || tw > 9) warnings.push({ code: 'title.length', message: `The title is ${tw} words; 5–9 reads best.`, detail: title });
    if (/^patch notes?\s*:/i.test(title)) warnings.push({ code: 'title.prefix', message: 'The series already says Patch notes; drop the prefix.' });
    if (/\b\d+\b/.test(title) || /\b(changes|sites|commits)\b/i.test(title)) warnings.push({ code: 'title.count', message: 'The title counts something. Say what the reader gets instead.', detail: title });
    const dw = countWords(dek);
    if (dek && (dw < 20 || dw > 35)) warnings.push({ code: 'dek.length', message: `The dek is ${dw} words; 20–35 is one sentence for the feed.`, detail: dek });
    checklist.push({ code: 'title', label: 'The title and dek match the biggest change', ok: tw >= 5 && tw <= 9 && dw >= 20 && dw <= 35 && !/^patch notes?\s*:/i.test(title), detail: `${tw}-word title, ${dw}-word dek` });

    // ── structure ──
    for (const h of headingsOf(body)) {
        if (/\bOpenVibe\.[A-Za-z]+\b/.test(h)) warnings.push({ code: 'heading.repo', message: `"${h}" is a repository name. Name the player-facing thing.`, detail: h });
    }
    const story = storyPart(body);
    const leaked = entries.filter((e) => e.subject && e.subject.length >= 18 && story.toLowerCase().includes(String(e.subject).toLowerCase()));
    for (const e of leaked) warnings.push({ code: 'story.commit_subject', message: 'A commit subject appears in the story; it belongs in the full list.', detail: e.subject });
    if (/^##\s+(lockfiles?|version pins?|dependencies)\b/im.test(story)) warnings.push({ code: 'heading.chore', message: 'A chore is a heading. Chores go under "Under the hood".' });

    // ── what's next ──
    if (/^##\s+What's next\s*$/im.test(body)) {
        const bullets = whatsNextBullets(body);
        const sourced = bullets.filter((b) => /https?:\/\//.test(b)).length;
        checklist.push({ code: 'next', label: "What's next names a real PR, plan line or feed entry", ok: bullets.length > 0 && sourced === bullets.length, detail: `${sourced} of ${bullets.length} linked` });
        if (bullets.length && sourced < bullets.length) warnings.push({ code: 'next.unlinked', message: "An item in What's next has no link to its PR, plan line or feed entry." });
        if (bullets.length > 3) warnings.push({ code: 'next.too_many', message: "What's next has more than three items." });
    }
    checklist.push({ code: 'evidence', label: 'Every claim traces to a commit, PR or source', ok: entries.length > 0, detail: `${entries.length} commit${entries.length === 1 ? '' : 's'} in the full list; ${storyMap.length} workstream${storyMap.length === 1 ? '' : 's'}` });

    // ── authorship and review ──
    const mode = rec && rec.mode;
    const approved = Boolean(review && review.decision === 'approved' && /^usr_/.test(String(review.reviewer || '')));
    checklist.push({ code: 'disclosure', label: 'The AI disclosure matches how the post was made', ok: mode !== 'ai' || Boolean(rec.workflow && rec.workflow.runId), detail: mode ? `${mode}${rec.workflow ? ` (${rec.workflow.id})` : ''}` : 'unknown' });
    if (mode === 'ai' && !approved) add(blocking, 'review.ai_required', 'The text is AI-generated and no person has approved this revision yet.');
    if (!approved) add(blocking, 'review.required', 'A Patch notes post needs a named person to approve the revision before it can be published.');
    checklist.push({ code: 'review', label: 'A named human reviewer approved it', ok: approved, detail: approved ? `${review.reviewer}${review.note ? `: ${review.note}` : ''}` : 'not yet' });

    return { blocking, warnings, checklist };
}

/** The publish gate: blocking issues already overridden? Only slop phrases may be. */
function mayPublish(result) {
    return !result.blocking.length;
}

module.exports = { evaluate, mayPublish, headingsOf, linksOf, whatsNextBullets };
