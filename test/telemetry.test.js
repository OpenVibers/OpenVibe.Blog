'use strict';
/**
 * Request telemetry (openvibe-sdk/service, plan T1 step 10b): app.js builds one collector for service 'blog' and
 * mounts its middleware, index.js stops it first, and a route hit five times flushes as ONE aggregated
 * http.request sample labelled with the route template and status class. /metrics and static assets make none.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

(async () => {
    await check('app.js creates the blog collector and mounts its middleware; index.js stops it first', () => {
        const app = read('server/app.js');
        assert.match(app, /createHttpTelemetry\(\{[^}]*service: 'blog'/s);
        assert.match(app, /app\.use\(telemetry\.middleware\(\)\)/);
        assert.match(app, /ctx\.telemetry = telemetry/);
        const index = read('server/index.js');
        assert.match(index, /stop: \[\(\) => \{ clearInterval\(ctx\.telemetryTick\); return ctx\.telemetry\.stop\(\); \},/);
        // The collector has no timer of its own (openvibe-sdk 0.46): index.js flushes it every 15 s.
        assert.match(index, /ctx\.telemetryTick = setInterval\(\(\) => \{ ctx\.telemetry\.flush\(\)/);
    });

    const samples = [];
    const t = await boot({ telemetrySink: async (batch) => { samples.push(...batch); } });
    const requests = () => samples.filter((s) => s.operation === 'http.request');

    await check('five hits on one API route flush as one http.request sample: template, 2xx, count 5', async () => {
        await Promise.all([1, 2, 3, 4, 5].map(async () => assert.strictEqual((await t.get('/api/v1/changelog')).status, 200)));
        await t.ctx.telemetry.flush();
        const mine = requests().filter((s) => /^\/api\/v1\/changelog\b/.test(s.resource || '') && s.status === '2xx');
        assert.strictEqual(mine.length, 1, JSON.stringify(requests()));
        assert.strictEqual(mine[0].service, 'blog');
        assert.strictEqual(mine[0].resource, '/api/v1/changelog');
        assert.strictEqual(mine[0].extra.count, 5);
    });

    await check('/metrics and a static asset produce no sample', async () => {
        samples.length = 0;
        await t.get('/metrics');
        const css = await t.get('/css/blog.css');
        assert.strictEqual(css.status, 200);
        await t.ctx.telemetry.flush();
        assert.deepStrictEqual(requests(), []);
    });

    await check('the worker retention drops telemetry_samples rows older than 30 days and keeps newer ones', async () => {
        const db = t.ctx.store.db;
        const insert = (days) => db.query(`INSERT INTO telemetry_samples (at, service, operation) VALUES (now() - make_interval(days => $1), 'blog', 'http.request')`, [days]);
        await insert(45);
        await insert(1);
        assert.strictEqual(await t.ctx.worker.pruneSamples(), 1);
        const left = await db.query('SELECT count(*)::int AS n FROM telemetry_samples');
        assert.strictEqual(left.rows[0].n, 1);
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
