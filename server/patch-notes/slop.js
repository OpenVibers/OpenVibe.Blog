'use strict';
/**
 * The slop check (devblog §3.7, §4.5): a deterministic copy editor, not an AI detector.
 *
 * A word is not banned because a model likes it; it is banned as filler ("seamless warping" is a feature name,
 * "a seamless experience" is slop). Blocking: a phrase from the list, and a looks word (no-looks). Warnings: the
 * structures that give generated prose away — "not only X, but also Y", "it's not just X, it's Y", a three-item
 * list in every paragraph, one length for every paragraph, an em dash every other sentence, a conclusion that
 * restates the intro.
 *
 * The full list under <details> is exempt (commit subjects are exact names), and so are code spans, fenced blocks
 * and URLs. Output is inline: the phrase, the line, an excerpt and a plain thing to say instead. No score — a score
 * invites gaming and is not a detection result.
 */

const AI_WORDS = ['delve', 'tapestry', 'testament', 'pivotal', 'seamless', 'leverage', 'robust', 'foster', 'underscore',
    'showcase', 'vibrant', 'crucial', 'multifaceted', 'landscape', 'realm', 'journey', 'nestled', 'boasts', 'align',
    'resonate', 'enhance', 'elevate', 'empower', 'unlock', 'game-changer', 'cutting-edge', 'revolutionary', 'transform',
    'transforms', 'transformed', 'transforming', 'game-changing'];
const AI_PHRASES = ['it\'s important to note', 'it is important to note', 'in today\'s fast-paced world', 'at the end of the day',
    'in conclusion', 'let\'s dive in', 'buckle up', 'stay tuned', 'more to come', 'we\'re excited to announce',
    'we are excited to announce', 'we\'ve been hard at work', 'we have been hard at work', 'we hear you',
    'you asked, we delivered', 'game on', 'chef\'s kiss', 'plot twist', 'spoiler alert'];
const OUR_JARGON = ['pin', 'pins', 'pin round', 'pin rounds', 'cqw', 'release lines', 'entry', 'entries', 'repo',
    'repos', 'PR #', 'fleet audit', 'workstream', 'workstreams', 'dogfood'];
const HYPE = ['major', 'huge', 'massive', 'incredible', 'amazing', 'delight', 'love', 'we\'re proud', 'we are proud'];
const STRUCTURE_WORDS = ['overall', 'in summary', 'to sum up', 'all in all', 'despite its challenges', 'challenges and legacy',
    'future outlook'];

/** Every blocked phrase, deduplicated and longest first (so "pin round" is found before "pin"). */
const BANNED = [...new Set([...AI_PHRASES, ...AI_WORDS, ...OUR_JARGON, ...HYPE, ...STRUCTURE_WORDS])]
    .filter((p) => p && p !== 'was v')
    .sort((a, b) => b.length - a.length);

const REWRITES = {
    leverage: 'say what the thing does',
    delve: 'say what you looked at',
    seamless: 'say what did not break',
    robust: 'say what it survives',
    crucial: 'say what happens without it',
    enhance: 'say what is better',
    elevate: 'say what is higher',
    empower: 'say who can do what now',
    unlock: 'say what you can do now',
    showcase: 'show it',
    transform: 'say what changed',
    journey: 'say what happened',
    pivotal: 'say why it mattered',
    tapestry: 'say what it is made of',
    testament: 'say what proves it',
    vibrant: 'say what the colours or the people are',
    landscape: 'say what the field is',
    realm: 'say where it happens',
    nestled: 'say where it sits',
    boasts: 'say what it has',
    align: 'say what now matches',
    resonate: 'say who it reached',
    foster: 'say what it caused',
    underscore: 'say what it shows',
    multifaceted: 'say which parts',
    'it\'s important to note': 'delete it and say the thing',
    'at the end of the day': 'say what wins',
    'in conclusion': 'delete it; the last paragraph is the conclusion',
    'stay tuned': 'name the next thing and its date, or say nothing',
    'more to come': 'name the next thing, or say nothing',
    'we\'re excited to announce': 'announce it',
    'we hear you': 'say what changed because of them',
    'we\'re proud': 'show the work instead',
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BANNED_RE = new RegExp(`(?<![\\w-])(?:${BANNED.map(escapeRe).join('|')})(?![\\w-])`, 'gi');
const BANNED_SET = new Set(BANNED);

/**
 * The sections that quote someone else: the full list, "Also shipped" (commit subjects) and "What's next"
 * (PR titles). A product name in them ("Showcase S2", "a token cap") is not the writer's filler.
 */
function withoutSourced(text) {
    return String(text || '')
        .replace(/^##\s+Also shipped[\s\S]*?(?=^##\s|(?![\s\S]))/gim, ' ')
        .replace(/^##\s+What's next[\s\S]*?(?=^##\s|(?![\s\S]))/gim, ' ');
}

/** The prose of a Markdown body: sourced sections, fenced code, inline code, link URLs and HTML are not prose. */
function proseOf(body) {
    return withoutSourced(body)
        .replace(/<details[\s\S]*?<\/details>/gi, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`\n]*`/g, ' ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ');
}
function linesOf(text) {
    return String(text || '').split('\n');
}
const lineAt = (text, index) => String(text || '').slice(0, index).split('\n').length;

/** Phrases in one text: [{ phrase, line, excerpt, message }]. */
function phrasesIn(text) {
    const prose = proseOf(text);
    const out = [];
    BANNED_RE.lastIndex = 0;
    let m;
    while ((m = BANNED_RE.exec(prose))) {
        const phrase = m[0].toLowerCase();
        if (!BANNED_SET.has(phrase) && !BANNED_SET.has(phrase.replace(/\s+/g, ' '))) continue;
        const at = m.index;
        const line = lineAt(prose, at);
        const excerpt = prose.slice(Math.max(0, at - 40), Math.min(prose.length, at + phrase.length + 40)).replace(/\s+/g, ' ').trim();
        out.push({ phrase, line, excerpt, message: `This says "${phrase}". ${REWRITES[phrase] ? REWRITES[phrase].charAt(0).toUpperCase() + REWRITES[phrase].slice(1) : 'Say the thing itself.'}` });
    }
    return out;
}

const paragraphs = (prose) => prose.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p && !/^#{1,6}\s/.test(p) && !/^[-*]\s/.test(p));
const sentencesOf = (prose) => prose.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length > 2);
const stddev = (xs) => { if (!xs.length) return 0; const mean = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length); };
const wordsOf = (s) => s.split(/\s+/).filter(Boolean).length;

/** The structures, as warnings: [{ code, message, detail }]. */
function structuresIn(body) {
    const prose = proseOf(body);
    const out = [];
    const words = wordsOf(prose);
    if (/\bnot only\b[^.!?]{0,160}\bbut also\b/i.test(prose)) out.push({ code: 'structure.not_only', message: 'The "not only X, but also Y" shape is a tell. Say both things as two sentences.', detail: 'not only … but also' });
    if (/\bit(?:'| i)s not (?:just|only)\b[^.!?]{0,100}[,;]\s*it(?:'| i)s\b/i.test(prose)) out.push({ code: 'structure.not_just', message: 'The "it\'s not just X, it\'s Y" shape is a tell. Say what it is, then what else it is.', detail: 'it\'s not just X, it\'s Y' });
    for (const w of ['Despite its challenges', 'Challenges and Legacy', 'Future Outlook']) if (new RegExp(`\\b${w}\\b`, 'i').test(prose)) out.push({ code: 'structure.essay_cliche', message: `"${w}" is the shape of a generated essay, not a patch note.`, detail: w });
    const paras = paragraphs(prose);
    const emDashes = (prose.match(/—/g) || []).length;
    if (words >= 100 && emDashes > words / 100) out.push({ code: 'structure.em_dash', message: `${emDashes} em dashes in ${words} words. Use a full stop.`, detail: `${emDashes} dashes / ${words} words` });
    const boldParas = paras.filter((p) => (p.match(/\*\*[^*\n]+\*\*/g) || []).length > 1);
    if (boldParas.length) out.push({ code: 'structure.bold', message: `Bold on more than one phrase in ${boldParas.length} paragraph${boldParas.length === 1 ? '' : 's'}. Bold one thing, or nothing.`, detail: boldParas[0].slice(0, 80) });
    const lists = paras.filter((p) => /\b\w+(?:,\s*\w+){2},?\s+(?:and|or)\s+\w+/i.test(p) || (p.split('\n').filter((l) => /^\s*[-*]\s+/.test(l)).length === 3));
    if (paras.length >= 3 && lists.length / paras.length >= 0.6) out.push({ code: 'structure.three_item_lists', message: 'Almost every paragraph carries a three-item list. Vary the shape; a list is not a paragraph.', detail: `${lists.length} of ${paras.length} paragraphs` });
    const openers = new Map();
    for (const p of paras) {
        const opener = p.replace(/[*_`#>]/g, '').split(/\s+/).slice(0, 3).join(' ').toLowerCase();
        if (opener.split(' ').length === 3) openers.set(opener, (openers.get(opener) || 0) + 1);
    }
    for (const [opener, n] of openers) if (n >= 3) out.push({ code: 'structure.same_opener', message: `"${opener}" opens ${n} paragraphs. Start one of them differently.`, detail: opener });
    const sentences = sentencesOf(prose);
    if (sentences.length >= 8) {
        const sd = stddev(sentences.map(wordsOf));
        if (sd < 2.5) out.push({ code: 'structure.uniform_sentences', message: `Every sentence is about ${Math.round(sentences.map(wordsOf).reduce((a, b) => a + b, 0) / sentences.length)} words. Let one be short and one be longer.`, detail: `sd ${sd.toFixed(1)}` });
    }
    if (paras.length >= 4) {
        const lens = paras.map((p) => wordsOf(p.replace(/\n/g, ' ')));
        const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
        if (mean > 10 && (Math.max(...lens) - Math.min(...lens)) / mean <= 0.25) out.push({ code: 'structure.uniform_paragraphs', message: 'Every paragraph is the same length. A one-line paragraph is allowed.', detail: `mean ${Math.round(mean)} words` });
    }
    const last = paras[paras.length - 1] || '';
    const first = paras[0] || '';
    if (/^(in conclusion|in summary|overall|to sum up|all in all)\b/i.test(last)) out.push({ code: 'structure.restating_conclusion', message: 'The last paragraph announces a conclusion and restates the post. End on the last fact.', detail: last.slice(0, 80) });
    else if (paras.length >= 3 && first && last) {
        const stop = new Set('a an the and or but of to in on for with is are was were this that it its we our you your they their as at by from be been has have had not no so if then than more most all any'.split(' '));
        const nouns = (s) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) || []);
        const f = nouns(first); const l = nouns(last);
        if (f.size >= 6 && l.size >= 6 && [...f].filter((w) => l.has(w) && !stop.has(w)).length / Math.min(f.size, l.size) >= 0.6) out.push({ code: 'structure.restating_conclusion', message: 'The last paragraph repeats the first one. Cut it or end on a fact.', detail: last.slice(0, 80) });
    }
    return out;
}

/** Everything the slop check says about a post: blocking phrases and warning structures. */
function scan({ title = '', dek = '', body = '', tags = [], captions = [] } = {}) {
    const blocking = [];
    const texts = [['title', title], ['dek', dek], ['body', body], ...[...tags].map((t, i) => [`tag ${i + 1}`, String(t)]), ...[...captions].map((c, i) => [`caption ${i + 1}`, String(c)])];
    for (const [where, text] of texts) {
        for (const p of phrasesIn(text)) blocking.push({ code: 'slop.phrase', where, ...p });
    }
    const warnings = structuresIn(body).map((w) => ({ ...w, where: 'body' }));
    if (/\b(?:the|this|that|latest) shipped\b/i.test(proseOf(body))) warnings.push({ code: 'slop.shipped_noun', where: 'body', message: '"Shipped" is a verb here, not a noun. Say what shipped, or say it landed.' });
    if (tags.some((t) => /^(major|huge|amazing|incredible)$/i.test(String(t)))) warnings.push({ code: 'slop.tag', where: 'tags', message: 'A tag is not a mood ("major"). Name the thing it is about.' });
    return { blocking, warnings };
}

module.exports = { scan, phrasesIn, structuresIn, proseOf, withoutSourced, BANNED, REWRITES };
