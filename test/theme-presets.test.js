'use strict';
/**
 * Blog theme presets on the content surface: `vibe`, the network's own default, pins no colours (a blog on it
 * follows the reader's OpenVibe theme, a season's colours included: the official blog's front page was the one
 * blue page among the network's homes in the 2026-10-27 visual pass); a preset a blog chose keeps its values.
 */
const assert = require('assert');
const { createBlogs, THEME_PRESETS } = require('../server/domain/blogs');

const stub = { prepare: () => ({ get: () => null, all: () => [], run: () => ({}) }) };
const blogs = createBlogs({ store: { db: stub }, config: {} });

assert.deepStrictEqual(blogs.themeVars({ theme: 'vibe' }), {}, 'vibe follows the network theme');
assert.deepStrictEqual(blogs.themeVars({ theme: null }), {}, 'no preset: the network theme');
assert.deepStrictEqual(blogs.themeVars({ theme: 'no-such-theme' }), {}, 'an unknown preset: the network theme');
for (const preset of THEME_PRESETS.filter((p) => p !== 'vibe')) {
    const vars = blogs.themeVars({ theme: preset });
    assert.ok(vars['--bg-primary'] && vars['--accent'], `${preset} keeps its own colours`);
}
console.log('theme presets: all checks passed');
