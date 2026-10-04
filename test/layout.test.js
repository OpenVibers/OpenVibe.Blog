'use strict';
/**
 * The page shell (server/render/layout.js): the document is openvibe-publishing/layout's
 * (openvibe-shared/shell page()): one title, the canonical and robots from the gate's decision, the
 * JSON-LD, the feeds, the blog stylesheet, the Frame (navbar mount, noscript navigation, the
 * server-rendered footer and its init), and a blog's theme preset on its content surface only.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { renderPage } = require('../server/render/layout');

const LONG = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
const count = (html, re) => (html.match(re) || []).length;
const split = (html) => ({ head: html.slice(0, html.indexOf('</head>')), body: html.slice(html.indexOf('</head>')) });

(async () => {
    const t = await boot();
    const eve = t.network.addUser('eve', { display_name: 'Eve' });
    const csrf = t.csrf(eve);

    await check('a page needs the gate decision: there is no default that makes it indexable', async () => {
        assert.throws(() => renderPage({ title: 'x', body: '', config: { baseUrl: 'https://openvibe.blog' } }), TypeError);
    });

    await check('a published post: head and frame from openvibe-publishing/layout, robots from the decision', async () => {
        await t.get('/write', { as: eve });
        let r = await t.get('/write/start', { as: eve, form: { _csrf: csrf, handle: 'eve', title: 'Eve notes' } });
        assert.strictEqual(r.status, 303, r.text);
        r = await t.get('/write/@eve/settings', { as: eve, form: { _csrf: csrf, title: 'Eve notes', description: 'Field notes', language: 'en', theme: 'paper', rss: '1', atom: '1', json: '1', itemCount: '10', fullContent: '1' } });
        assert.strictEqual(r.status, 303, r.text);
        r = await t.get('/write/@eve/new', { as: eve, form: { _csrf: csrf, title: 'Shell notes', body: `# Heading\n\n${LONG}`, summary: 'A summary', visibility: 'public', allowComments: '1' } });
        assert.strictEqual(r.status, 303, r.text);
        const id = (r.headers.get('location').match(/(pst_[0-9A-Z]+)/) || [])[1];
        r = await t.get(`/write/posts/${id}/publish`, { as: eve, form: { _csrf: csrf, revision: '1' } });
        assert.strictEqual(r.status, 303, r.text);

        r = await t.get('/@eve/shell-notes');
        assert.strictEqual(r.status, 200, r.text);
        const { head, body } = split(r.text);
        assert.strictEqual(count(r.text, /<title>/g), 1, 'exactly one <title>');
        assert.ok(head.includes('<title>Shell notes · OpenVibe.Blog</title>'), 'the composed title');
        assert.ok(head.includes('<link rel="canonical" href="https://openvibe.blog/@eve/shell-notes">'), 'the canonical');
        assert.strictEqual(count(head, /<meta name="robots"/g), 1, 'one robots meta');
        assert.ok(head.includes('<meta name="robots" content="index, follow">'), 'robots from the decision');
        assert.ok(count(head, /<script type="application\/ld\+json">/g) >= 1, 'JSON-LD');
        assert.ok(head.includes('<meta property="article:published_time"'), 'article published time');
        assert.ok(head.includes('<link rel="alternate" type="application/atom+xml" href="/@eve/atom.xml" title="Eve notes (Atom)">'), 'Atom feed link');
        assert.ok(head.includes('<link rel="alternate" type="application/feed+json" href="/@eve/feed.json" title="Eve notes (JSON Feed)">'), 'JSON feed link');
        assert.ok(/<link rel="stylesheet" href="\/css\/blog\.css\?v=[0-9a-f]+">/.test(head), 'the blog stylesheet');
        assert.ok(/<meta name="ov-boost" content="blog@[^"]+">/.test(head), 'the boost marker');
        assert.ok(body.includes('<div id="navbar-mount"></div>'), 'the navbar mount');
        assert.ok(body.includes('<nav aria-label="Site"'), 'the noscript navigation');
        assert.ok(body.includes('id="ov-footer"'), 'the server-rendered footer');
        assert.ok(body.includes('OpenVibeFooter.init(window.__OV_PAGE.footer)'), 'the footer is initialised');
        assert.ok(/<main id="main" class="page blog-surface" style="--[^"]+" data-blog-theme="paper">/.test(body), 'the theme preset stays on the content surface');
        assert.strictEqual(count(r.text, /<main\b/g), 1, 'one <main>');
    });

    await check('the editor stays noindex; the home page keeps its feeds, the Blog JSON-LD and the AI summary', async () => {
        const { head } = split((await t.get('/write', { as: eve })).text);
        assert.strictEqual(count(head, /<title>/g), 1);
        assert.ok(/<meta name="robots" content="noindex[^"]*">/.test(head), 'the editor is noindex');
        const home = split((await t.get('/')).text).head;
        assert.strictEqual(count(home, /<title>/g), 1);
        assert.ok(home.includes('<link rel="canonical" href="https://openvibe.blog/">'));
        // The home carries the Blog JSON-LD and, since llms-full.txt, the site summary's WebPage JSON-LD.
        assert.deepStrictEqual([...home.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1])['@type']), ['Blog', 'WebPage']);
        assert.match(home, /<meta name="ai-summary" content="[^"]+">/, 'the AI summary head');
        assert.ok(home.includes('<link rel="alternate" type="application/atom+xml" href="/atom.xml" title="The OpenVibe blog (Atom)">'));
        assert.ok(home.includes('<link rel="alternate" type="application/feed+json" href="/feed.json" title="The OpenVibe blog (JSON Feed)">'));
        assert.ok(/<link rel="stylesheet" href="\/shared\/showcase\.css\?v=[0-9a-f]+">/.test(home), 'the showcase kit stylesheet on the home');
    });

    await t.close();
    done();
})();
