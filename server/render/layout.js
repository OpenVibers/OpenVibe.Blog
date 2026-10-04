'use strict';

/**
 * Page shell. Every page is server-rendered through openvibe-publishing/layout (openvibe-shared/shell
 * page()) and is complete without JavaScript:
 *   - <head>: title, description, canonical and robots from the indexability gate's decision
 *     (there is no default that makes a page indexable), Open Graph/Twitter, JSON-LD, article
 *     times, prev/next, feed links, the shared app icon and critical canvas, the site stylesheet
 *     and the boost marker
 *   - the OpenVibe Frame: theme-loader, web runtime, navbar and footer from the Network
 *     (progressive), a <noscript> navigation bar and the server-rendered shared footer
 *   - a blog's theme preset applied to its content surface only (openvibe-shared tokens)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const layout = require('openvibe-publishing/layout');
const { escapeHtml: esc } = require('openvibe-publishing/ssr');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Blog';
// One site summary, shared by /llms.txt, /llms-full.txt and the home page's ai-summary.
const SITE_SUMMARY = 'The official OpenVibe blog and a blog for every OpenVibe member: server-rendered posts with feeds, sitemaps and a JSON representation of every post.';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

// The deployed release (app.js sets it from openvibe-shared/release): openvibe-shared/boost swaps a page in place only
// between pages of the same release, and does a normal load across a deploy.
let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

/** Inline CSS custom properties for a theme preset (values come from openvibe-shared, escaped anyway). */
function themeStyle(vars) {
    return Object.entries(vars || {})
        .filter(([k, v]) => /^--[a-z0-9-]+$/.test(k) && /^[#(),.%\w\s-]+$/.test(String(v)))
        .map(([k, v]) => `${k}:${v}`).join(';');
}

/**
 * o: title, description, decision (required), canonical, type ('website'|'article'), image,
 *    jsonLd [], feeds [{ type, href, title }], body (HTML), viewer, config, csrf,
 *    theme { slug, vars }, published, modified, author, prev, next, bodyClass, styles [openvibe-shared stylesheet names]
 */
function renderPage(o) {
    if (!o.decision) throw new TypeError('renderPage needs the gate decision');
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    const loginNext = encodeURIComponent(o.path || '/');
    const nav = {
        service: 'blog',
        apiBase: NETWORK_URL,
        links: [
            { label: 'Blog', href: '/' },
            { label: 'Write', href: '/write', icon: 'fa-pen' },
        ],
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${o.config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',           // filled from the current page (boost moves between pages)
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
        notificationsRealtime: true,             // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
    };
    const footer = { service: 'blog', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };
    const style = o.theme ? ` style="${esc(themeStyle(o.theme.vars))}" data-blog-theme="${esc(o.theme.slug)}"` : '';
    const account = signedIn
        ? `<a href="/write">Write</a> · <a href="/auth/logout?next=${loginNext}">Sign out</a>`
        : `<a href="/auth/login?next=${loginNext}">Sign in with OpenVibe</a>`;
    const html = layout.renderDocument({
        site: 'blog',
        siteName: SITE_NAME,
        lang: o.lang,
        title: o.title ? `${o.title} · ${SITE_NAME}` : SITE_NAME,
        description: o.description || 'The official OpenVibe blog and a blog for every member.',
        canonical: o.canonical,
        decision: o.decision,
        summary: o.summary,
        facts: o.facts,
        updated: o.updated,
        url: o.url,
        type: o.type || 'website',
        image: o.image,
        author: o.author,
        jsonLd: o.jsonLd,
        feeds: o.feeds,
        published: o.published,
        modified: o.modified,
        prev: o.prev,
        next: o.next,
        navbar: nav,
        footer,
        navLinks: [{ label: 'Blog', href: '/' }, { label: 'Write', href: '/write' }],
        home: '/',
        css: asset('css/blog.css'),
        styles: o.styles,
        release: RELEASE,
        account,
        body: o.body,
        mainClass: 'page blog-surface',
        bodyClass: o.bodyClass,
    });
    // A blog's theme preset applies to its content surface only: the custom properties and the preset's
    // slug stay on <main> (the layout writes that tag before any page body, so the first match is it).
    return style ? html.replace('<main id="main" class="page blog-surface">', () => `<main id="main" class="page blog-surface"${style}>`) : html;
}

module.exports = { renderPage, asset, assetVersion, themeStyle, setRelease, SITE_NAME, SITE_SUMMARY, NETWORK_URL };
