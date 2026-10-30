'use strict';
// The post page's reading layout (the blog outcomes in research-2026-10-30/market/outcomes/blog.md): a stated read time,
// ids on every section heading, a contents list of the top-level sections (none inside a fold), and the series as a
// line above the text with its previous, next and nearby parts after it.
const assert = require('assert');
const pages = require('../server/render/pages');

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

// ── Read time: 265 words a minute, rounded, never 0; code, media lines and link targets are not read ──
assert.strictEqual(pages.readMinutes(''), 1, 'never "0 min"');
assert.strictEqual(pages.readMinutes(words(265 * 7)), 7);
assert.strictEqual(pages.readMinutes(words(265 * 7 + 100)), 7, 'rounded');
assert.strictEqual(pages.readMinutes(`${words(530)}\n\n\`\`\`\n${words(5000)}\n\`\`\`\n`), 2, 'a code block is not read');
assert.strictEqual(pages.readMinutes(`${words(530)} [a link](https://example.com/${words(3000).replace(/ /g, '/')})`), 2, 'a link target is not read');

// ── Sections: ids, unique, never a page id; the contents list leaves out headings inside a fold ──
{
    const body = '<h3>Highlights</h3><p>x</p><h3>OpenVibe.Live</h3><h3>OpenVibe.Live</h3><h3>Comments</h3>'
        + '<details class="ov-details"><summary>All 80 commits</summary><h3>Inside</h3></details><h3>Café &amp; <em>bar</em></h3>';
    const out = pages.sectionsOf(body);
    assert.deepStrictEqual(out.sections.map((x) => x.id), ['highlights', 'openvibe-live', 'openvibe-live-2', 'comments-2', 'cafe-bar']);
    assert.deepStrictEqual(out.sections.map((x) => x.text), ['Highlights', 'OpenVibe.Live', 'OpenVibe.Live', 'Comments', 'Café & bar']);
    assert.ok(out.html.includes('<h3 id="inside">Inside</h3>'), 'a heading in a fold still gets an id');
    assert.ok(!out.sections.some((x) => x.id === 'inside'), 'but stays out of the contents list');
    assert.ok(out.html.includes('<h3 id="cafe-bar">Café &amp; <em>bar</em></h3>'), 'the heading keeps its markup');
}

// ── The page ──
const base = {
    blog: { kind: 'official', title: 'The OpenVibe blog' }, blogUrl: '/@openvibe', author: { name: 'Eve', url: '/@openvibe/authors/eve' },
    tags: [], categories: [], attachments: [], citations: [], disclosure: null, decisionNote: null, comments: null, canEdit: false,
    urlFor: () => '#', breadcrumbs: [], jsonUrl: '/x.json',
    post: { id: 'pst_1', visibility: 'public', state: 'published', published_at: 1761000000000, first_published_at: 1761000000000 },
};
{
    const long = `## One\n\n${words(300)}\n\n## Two\n\n${words(300)}\n\n## Three <x>\n\n${words(300)}\n`;
    const html = pages.postPage({ ...base, rev: { number: 1, fields: { title: 'A long post' }, content: long, createdAt: new Date(1761000000000).toISOString() },
        series: { title: 'Patch notes', url: '/@openvibe/series/patch-notes', position: 36, total: 118, start: 31,
            prev: { title: 'Part 35 <b>', url: '/p35' }, next: { title: 'Part 37', url: '/p37' },
            items: [{ title: 'Part 35 <b>', url: '/p35' }, { title: 'Part 36', url: '/p36', current: true }, { title: 'Part 37', url: '/p37' }] } });
    assert.ok(html.includes('<div class="post-wrap has-toc">'), 'three sections: a contents list');
    assert.ok(html.includes('<nav class="toc-rail" aria-labelledby="toc-rail-h">') && html.includes('<details class="toc-fold">'), 'the rail for wide screens, the fold for phones');
    assert.ok(/<a href="#three-x">Three &lt;x&gt;<\/a>|<a href="#three">Three<\/a>/.test(html), `section text is escaped in the list: ${(html.match(/toc-fold[\s\S]*?<\/details>/) || [''])[0].slice(0, 400)}`);
    assert.ok(html.includes('≈ 3 min read'));
    assert.ok(html.includes('Part 36 of 118 in the series <a href="/@openvibe/series/patch-notes">Patch notes</a>'), 'the series is one line, not 50 links');
    assert.ok(html.includes('<a rel="prev" href="/p35"><small>Previous</small><span>Part 35 &lt;b&gt;</span></a>') && html.includes('<a rel="next" href="/p37">'));
    assert.ok(html.includes('<ol start="31">') && html.includes('<li aria-current="page">Part 36</li>') && html.includes('All 118 parts'));
    assert.ok(html.indexOf('series-nav') > html.indexOf('post-body'), 'the neighbours come after the text');
}
{
    const short = pages.postPage({ ...base, series: null, rev: { number: 1, fields: { title: 'Short' }, content: '## Only one\n\nHi.', createdAt: new Date().toISOString() } });
    assert.ok(short.includes('<div class="post-wrap">') && !short.includes('toc-rail') && !short.includes('toc-fold'), 'fewer than three sections: no contents list');
    assert.ok(short.includes('≈ 1 min read') && !short.includes('series-line'));
}

console.log('reading layout: read time, section ids, the contents list and the series ok');
