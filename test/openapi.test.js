'use strict';
/**
 * /openapi.json documents this service's API, and the document is the API: every route it lists is a
 * route the app mounts, and every /api/v1 route the app mounts is listed. The test walks the real
 * router stack (the same arrays server/http/api.js mounts) rather than trusting the table in
 * server/http/openapi.js, so a route added, renamed or removed without the document fails here.
 *
 *   node test/openapi.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { routes, MOUNT } = require('../server/http/openapi');

/** The path an app.use(...) layer mounts its router at, decoded from Express's compiled regexp. */
function mountOf(layer) {
    const source = String((layer.regexp && layer.regexp.source) || '');
    if (layer.regexp && layer.regexp.fast_slash) return '';
    const m = /^\^(.*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(source);
    assert.ok(m, `cannot read the mount path of a router layer (${source})`);
    return m[1].replace(/\\\//g, '/').replace(/\\\./g, '.');
}

/** ":param" as OpenAPI writes it, "{param}". */
const templated = (p) => String(p).replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');

/** Every "METHOD /path" the app answers, routers included. */
function mounted(app) {
    const out = new Set();
    const walk = (stack, prefix) => {
        for (const layer of stack) {
            if (layer.route) {
                for (const [method, on] of Object.entries(layer.route.methods)) {
                    if (!on || method === '_all') continue;
                    for (const p of [].concat(layer.route.path)) out.add(`${method.toUpperCase()} ${prefix}${templated(p)}`);
                }
            } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
                walk(layer.handle.stack, prefix + mountOf(layer));
            }
        }
    };
    assert.ok(app._router && app._router.stack, 'the app has a router');
    walk(app._router.stack, '');
    return out;
}

(async () => {
    const t = await boot();
    try {
        await check('/openapi.json is served as a cached JSON document', async () => {
            const r = await t.get('/openapi.json');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('content-type'), 'application/json; charset=utf-8');
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300');
            const doc = r.json();
            assert.strictEqual(doc.openapi, '3.1.0');
            assert.ok(doc.paths && typeof doc.paths === 'object');
            assert.ok(Object.keys(doc.paths).length > 0, 'paths is not empty');
            assert.strictEqual(doc.info.title, 'OpenVibe.Blog API');
            assert.deepStrictEqual(doc.servers, [{ url: 'https://openvibe.blog' }]);
        });

        await check('every documented route is mounted', async () => {
            const doc = (await t.get('/openapi.json')).json();
            const live = mounted(t.app);
            for (const key of Object.keys(doc.paths)) assert.ok(key.startsWith('/api/'), `${key} is outside /api`);
            for (const [p, item] of Object.entries(doc.paths)) {
                for (const [method, op] of Object.entries(item)) {
                    assert.ok(op.operationId, `${method.toUpperCase()} ${p} has an operationId`);
                    assert.ok(op.responses && Object.keys(op.responses).length, `${method.toUpperCase()} ${p} describes its responses`);
                    assert.ok(live.has(`${method.toUpperCase()} ${p}`), `${method.toUpperCase()} ${p} is documented but not mounted`);
                }
            }
        });

        await check('every mounted /api/v1 route is documented', async () => {
            const live = [...mounted(t.app)].filter((key) => key.split(' ')[1].startsWith(`${MOUNT}/`) && !key.endsWith(`${MOUNT}/openapi.json`)).sort();
            assert.deepStrictEqual(live, routes(), 'the document lists exactly the mounted /api/v1 routes');
        });

        await check('/api/v1/openapi.json redirects to it', async () => {
            const r = await t.get(`/api/v1/openapi.json`);
            assert.strictEqual(r.status, 308);
            assert.strictEqual(r.headers.get('location'), '/openapi.json');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
