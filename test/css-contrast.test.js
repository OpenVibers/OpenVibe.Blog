'use strict';
// Buttons (and .button links, the 404 page's "The OpenVibe blog") are --on-accent-strong on --accent-strong, which
// openvibe-shared derives at 4.5:1 or better in every theme; white on --accent read 3.67:1 (axe color-contrast,
// found by the browser check, OpenVibe.Host scripts/browser-check.js).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'blog.css'), 'utf8');
const rule = css.match(/button, \.button \{[^}]*\}/);
assert.ok(rule, 'the button rule');
assert.match(rule[0], /background: var\(--accent-strong, #1d4ed8\); color: var\(--on-accent-strong, #fff\);/);
console.log('css contrast: buttons use the 4.5:1 accent pair');
