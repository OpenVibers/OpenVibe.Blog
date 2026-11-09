'use strict';

/**
 * Blog's rendering of a body that is Markdown plus blocks (openvibe-publishing/blocks).
 *
 * The Markdown stays the source of truth: a revision keeps it, revisions diff it, and the editor
 * writes it. This module parses it into a block tree, resolves the Media ids it names and renders
 * the tree server-side — every block has a plain-HTML form, so a reader without JavaScript sees
 * the same thing a reader with it does.
 *
 * A post's images are its attachments: the renderer never guesses a URL and a Media object that is
 * gone renders as an explicit placeholder.
 */
const blocks = require('openvibe-publishing/blocks');
const ssr = require('openvibe-publishing/ssr');
const { escapeHtml: esc } = ssr;

// A post may fold a block away: <details><summary>…</summary>…</details>. The package's renderer
// escapes raw HTML on purpose, so Blog renders exactly this one shape itself — the summary as text,
// the inside as Markdown — and leaves every other tag to be escaped. Patch notes keep the full commit
// list there.
const DETAILS = /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
// A media line in the prose: [[media:med_…]] on its own line, the way a post names an attachment.
const MEDIA_LINE = /^[ \t]*\[\[media:(med_[0-9A-HJKMNP-TV-Z]{26})\]\][ \t]*$/m;

/** The prose of a body, with the folds Blog renders itself. */
function renderProse(text, opts) {
    const source = String(text || '');
    let out = '';
    let last = 0;
    DETAILS.lastIndex = 0;
    let m;
    while ((m = DETAILS.exec(source))) {
        out += ssr.renderMarkdown(source.slice(last, m.index), opts);
        out += '<details class="ov-details"><summary>' + esc(m[1].replace(/<[^>]*>/g, '').trim()) + '</summary>' + ssr.renderMarkdown(m[2], opts) + '</details>';
        last = m.index + m[0].length;
    }
    out += ssr.renderMarkdown(source.slice(last), opts);
    return out;
}

/** The sections of a tree: the blocks that carry an id (a section), with their heading. */
function sectionsOf(tree) {
    const out = [];
    const walk = (node) => {
        if (node.type === 'section' && node.attrs && typeof node.attrs.id === 'string') {
            const heading = firstHeading(node);
            out.push({ id: node.attrs.id, name: heading || node.attrs.id, by: node.attrs.by || null });
        }
        for (const child of node.children || []) walk(child);
    };
    walk(tree);
    return out;
}

/** The heading of a block: the first "## " line of its prose. */
function firstHeading(node) {
    for (const child of node.children || []) {
        if (child.type !== 'text') continue;
        const m = String(child.value || '').match(/^#{2,3}\s+(.+)$/m);
        if (m) return m[1].trim();
    }
    return null;
}

/** The hero of a tree: the first hero block, with its art. */
function heroOf(tree) {
    for (const child of tree.children || []) {
        if (child.type === 'hero') return child;
    }
    return null;
}

/**
 * Render a body.
 *
 *   renderBody(content, attachments, {
 *     urlFor,           (mediaId) → the delivery URL
 *     media,            (mediaId) → { width, height, alt, credit } | null   (what Media knows)
 *     rel,              the link rel of editorial text
 *     reactions,        { sectionId: { up, down } }   the counts
 *     reactionAction,   where the reaction form posts
 *     csrf, signedIn, loginUrl, path,
 *     person,           (subject) → { name, url }   (a section's byline)
 *     patchNotes,       (from, to) → [ { site, commits } ]   (the folded list)
 *     headingShift,     how far the Markdown headings move
 *   })
 */
function renderBody(content, attachments = [], options = {}) {
    const tree = blocks.parse(content);
    const byId = new Map((attachments || []).map((a) => [a.mediaId, a]));
    const used = new Set();
    const urlFor = options.urlFor || (() => null);

    const media = (mediaId) => {
        const att = byId.get(mediaId);
        if (!att) return null;
        used.add(att.id);
        if (att.broken || att.state === 'broken') return { broken: true };
        return {
            width: att.width || null,
            height: att.height || null,
            alt: att.alt || '',
            caption: att.caption || null,
            credit: att.credit || null,
        };
    };

    // A media line in the prose is an attachment of the post: the same figure the Markdown path drew.
    const renderText = (value, opts) => {
        const parts = String(value).split(new RegExp(MEDIA_LINE.source, 'm'));
        if (parts.length === 1) return renderProse(value, opts);
        let out = '';
        parts.forEach((part, i) => {
            if (i % 2 === 0) { out += renderProse(part, opts); return; }
            const att = byId.get(part);
            if (att) { used.add(att.id); out += figureOf(att); return; }
            out += '<figure class="ov-media ov-media-broken" data-media-id="' + esc(part) + '" data-state="not_attached">'
                + '<div class="ov-media-missing" role="img" aria-label="Media not attached">This media is not attached to the post.</div></figure>';
        });
        return out;
    };

    const figureOf = (att) => {
        if (att.broken || att.state === 'broken') {
            return '<figure class="ov-media ov-media-broken" data-media-id="' + esc(att.mediaId) + '" data-state="broken">'
                + '<div class="ov-media-missing" role="img" aria-label="This media is no longer available.">This media is no longer available.</div></figure>';
        }
        const url = urlFor(att.mediaId, att);
        if (!url) {
            return '<figure class="ov-media ov-media-broken" data-media-id="' + esc(att.mediaId) + '" data-state="unresolved">'
                + '<div class="ov-media-missing" role="img" aria-label="This media is no longer available.">This media is no longer available.</div></figure>';
        }
        const caption = att.caption ? '<figcaption>' + esc(att.caption) + '</figcaption>' : '';
        return '<figure class="ov-media" data-media-id="' + esc(att.mediaId) + '" data-state="' + esc(att.state || 'available') + '">'
            + '<img src="' + esc(url) + '" alt="' + esc(att.alt || '') + '" loading="lazy" decoding="async">'
            + caption + '</figure>';
    };

    const html = blocks.render(tree, {
        rel: options.rel,
        renderText,
        headingShift: options.headingShift,
        urlFor,
        media,
        person: options.person,
        patchNotes: options.patchNotes,
        reactions: options.reactions,
        reactionAction: options.reactionAction,
        csrf: options.csrf,
        signedIn: options.signedIn,
        loginUrl: options.loginUrl,
        path: options.path,
    });

    return { tree, html, sections: sectionsOf(tree), hero: heroOf(tree) };
}

/** The plain text of a body: what a feed, a search document and an AI reader get. */
function bodyText(content) {
    return blocks.toText(blocks.parse(content));
}

/** The blocks of a body, as the tree the API hands out next to the Markdown. */
function bodyBlocks(content) {
    return blocks.parse(content);
}

module.exports = { renderBody, bodyText, bodyBlocks, sectionsOf, firstHeading, heroOf, renderProse };
