'use strict';
/**
 * The shared update system on openvibe.blog: the home shows what shipped, /updates is the log, the
 * footer carries the "shipped" line and an Updates link, and the shared navbar (not a second account
 * bar) handles sign in and out, with Sign out ending this site's session.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    await check('the home shows the shipped block; /updates is the shared log', async () => {
        const home = await t.get('/');
        assert.strictEqual(home.status, 200);
        assert.ok(home.text.includes('data-ov-shipped="latest" data-service="blog" href="/updates"'));
        assert.ok(home.text.includes('data-ov-shipped="list" data-service="blog"'));
        const up = await t.get('/updates');
        assert.strictEqual(up.status, 200);
        assert.ok(up.text.includes('What shipped on OpenVibe.Blog') && up.text.includes('data-ov-shipped="log" data-service="blog"'));
        assert.ok(/\/shared\/shipped\.js\?v=[0-9a-f]{12}/.test(up.text), 'this site\'s own pinned shipped.js');
        assert.ok(up.text.includes('https://openvibe.network/updates?site=blog'), 'no-JavaScript fallback');
    });
    await check('one account UI: the shared navbar signs out through this site; the old bar is only for no-JS', async () => {
        const home = await t.get('/');
        assert.ok(home.text.includes('"logoutUrl":"/auth/logout?next={path}"'));
        assert.ok(/<noscript><div class="account-bar"/.test(home.text), 'the site account bar only without JavaScript');
        assert.ok(/\/shared\/footer\.js\?v=[0-9a-f]{12}/.test(home.text) && home.text.includes('"updates":"/updates"'));
        assert.ok(home.text.includes('href="/updates"'), 'the footer links the update log');
    });
    await t.close();
    done();
})();
