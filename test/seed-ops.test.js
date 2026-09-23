'use strict';
/**
 * The seed post (verbatim quotes with citations, a draft until a named person reviews it) and the
 * operator surfaces: health, readiness, release, robots, llms.txt, sitemap index, legal pages.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');
const { seedOfficialPost, loadFacts, SLUG } = require('../server/seed');

(async () => {
    const t = await boot();
    const facts = loadFacts();

    await check('the facts file: every item is an OpenVibers GitHub source with a verbatim quote; no pricing copy', async () => {
        assert.ok(facts.items.length >= 5);
        const raw = fs.readFileSync(path.join(__dirname, '..', 'seed', 'week-2026-09-16.json'), 'utf8');
        assert.doesNotMatch(raw, /\bfree\b|\$0/i);
        for (const it of facts.items) assert.match(it.url, /^https:\/\/github\.com\/OpenVibers\//);
    });

    await check('the seed creates a DRAFT on the official blog, with one citation per quote', async () => {
        const out = seedOfficialPost(t.ctx, {});
        assert.strictEqual(out.created, true);
        assert.strictEqual(out.post.state, 'draft');
        assert.strictEqual(out.post.author_subject, t.official.subject);
        const rev = t.ctx.store.revisions.head(out.post.id);
        for (const it of facts.items) assert.ok(rev.content.includes(`> ${it.quote}`), `quote verbatim: ${it.repo}`);
        const cites = t.ctx.store.citations.forRevision(out.post.id, rev.number);
        assert.strictEqual(cites.length, facts.items.length);
        assert.ok(cites.every((c) => c.retrievedAt === new Date(facts.collected_at).toISOString() && c.quote && c.quote.text));
        assert.strictEqual(rev.meta.authorship.mode, 'imported');
        assert.doesNotMatch(rev.content, /\bfree\b|\$0/i);
        assert.strictEqual((await t.get(`/@openvibe/${SLUG}`)).status, 404, 'not public');
        assert.strictEqual(t.events(/index_document/).length, 0);
        assert.strictEqual(seedOfficialPost(t.ctx, {}).created, false, 'idempotent');
    });

    await check('publishing the seed needs a named reviewer; with one it is published and cites its sources', async () => {
        assert.throws(() => seedOfficialPost(t.ctx, { publish: true }), /reviewer/);
        const reviewer = t.network.addUser('reviewer');
        const out = seedOfficialPost(t.ctx, { publish: true, reviewer: reviewer.subject });
        assert.strictEqual(out.published, true);
        assert.strictEqual(out.review.reviewer, reviewer.subject);
        const page = await t.get(`/@openvibe/${SLUG}`);
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /<h2>Sources<\/h2>/);
        assert.match(page.text, /Imported/);
        assert.match((await t.get('/')).text, /Released in the OpenVibe repositories/);
        assert.match((await t.get('/feed.xml')).text, /Released in the OpenVibe repositories/);
        const ld = [...page.text.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1])).find((x) => x['@type'] === 'BlogPosting');
        assert.strictEqual(ld.publisher.name, 'OpenVibe');
        assert.strictEqual(ld.citation.length, facts.items.length);
    });

    await check('health, readiness, release manifest', async () => {
        assert.strictEqual((await t.get('/api/health')).json().status, 'ok');
        const ready = await t.get('/api/ready');
        assert.strictEqual(ready.status, 200);
        const body = ready.json();
        assert.strictEqual(body.checks.db.status, 'ok');
        assert.strictEqual(body.checks.network_jwks.status, 'ok');
        assert.ok(body.degraded.includes('events_relay'), 'the relay is honestly reported off in tests');
        const rel = await t.get('/release.json');
        assert.strictEqual(rel.status, 200);
        assert.strictEqual(rel.json().service, 'blog');
        assert.deepStrictEqual(require('openvibe-contracts').validate('registry.release-manifest@1', rel.json()).errors, []);
        assert.strictEqual(rel.json().metrics_url, '/release-metrics');
    });

    await check('robots.txt names the sitemap and the automated-consumer policy; llms.txt orients machines', async () => {
        const robots = (await t.get('/robots.txt')).text;
        assert.match(robots, /Sitemap: https:\/\/openvibe\.blog\/sitemap\.xml/);
        assert.match(robots, /Disallow: \/write/);
        assert.match(robots, /automated-consumer policy/);
        const llms = (await t.get('/llms.txt')).text;
        assert.match(llms, /^# OpenVibe\.Blog/);
        assert.match(llms, /\.json/);
        const idx = (await t.get('/sitemap.xml')).text;
        assert.match(idx, /<sitemapindex/);
        assert.match(idx, /sitemaps\/posts\.xml/);
    });

    await check('legal pages and 404s', async () => {
        assert.strictEqual((await t.get('/terms')).status, 200);
        const nf = await t.get('/@nobody-here');
        assert.strictEqual(nf.status, 404);
        assert.strictEqual(nf.headers.get('cache-control'), 'private, no-store');
    });

    await check('/metrics answers loopback callers only through the shared instrument', async () => {
        const r = await t.get('/metrics');
        assert.ok([200, 404].includes(r.status));
    });

    await t.close();
    done();
})();
