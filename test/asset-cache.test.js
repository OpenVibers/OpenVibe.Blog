'use strict';
/**
 * Static assets follow openvibe-shared/cache-policy: the current `?v=<assetVersion>` URL is immutable
 * for a year (the bytes cannot change under that URL), a wrong `?v=` or none is a short public window
 * with a long stale-while-revalidate (the URL may change at any moment).
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { assetVersion } = require('../server/render/layout');

const REL = 'css/blog.css';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATED = 'public, max-age=300, stale-while-revalidate=86400';

(async () => {
    const t = await boot();
    await check('the current ?v=<assetVersion> is immutable for a year', async () => {
        const r = await t.get(`/${REL}?v=${assetVersion(REL)}`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), IMMUTABLE);
    });
    await check('a wrong-but-hex ?v= is not content-addressed: short public window', async () => {
        const r = await t.get(`/${REL}?v=deadbeefdeadbeef`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), REVALIDATED);
    });
    await check('no ?v= is not content-addressed: short public window', async () => {
        const r = await t.get(`/${REL}`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), REVALIDATED);
    });
    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
