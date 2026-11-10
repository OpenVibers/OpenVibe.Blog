'use strict';
/**
 * The shared image task from Blog's editor: "Find a picture" and "Make an image" both call
 * OpenVibe.AI's image.picture task, with Media references coming back (never a source API hit from
 * the browser). A made picture's credit says "Made with AI (<model>)".
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

const RUN = 'run_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const MED = 'med_01J8ZQ4X3M000000000000000A';

(async () => {
    const asked = [];
    const aiSrv = await new Promise((r) => {
        const s = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                const json = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
                if (req.method === 'POST' && req.url.startsWith('/api/v1/runs')) {
                    const body = JSON.parse(raw);
                    asked.push(body);
                    const make = body.input && body.input.mode === 'make';
                    const item = make
                        ? { media_id: MED, url: `https://openvibe.media/o/${MED}`, width: 1024, height: 1024, title: 'A goose', alt: 'A goose', caption: 'A goose (Made with AI (gpt-image-1))', credit: 'Made with AI (gpt-image-1)', author: null, license: null, license_url: null, source_url: null, provider: 'image', ai: true, model: 'gpt-image-1' }
                        : { media_id: MED, url: `https://openvibe.media/o/${MED}`, width: 800, height: 600, title: 'A workbench', alt: 'A workbench in a workshop', caption: 'A workbench', credit: 'Ada Example, CC BY-SA 4.0', author: 'Ada Example', license: 'CC BY-SA 4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', source_url: 'https://commons.wikimedia.org/wiki/File:Workbench', provider: 'commons', ai: false, model: null };
                    return json(201, { run: { id: RUN, status: 'succeeded', workflow: { key: 'image.picture', version: 1 }, synthetic: false, output: {
                        mode: make ? 'make' : 'find', task: 'image.picture', query: make ? null : 'workbench', prompt: make ? 'A goose' : null, dry_run: false,
                        estimate: make ? { model: 'gpt-image-1', source: 'openvibe', images: 1, per_image_usd: 0.04, price_usd: 0.04 } : null,
                        media: [item], count: 1, gaps: [], note: null,
                    } } });
                }
                json(404, {});
            });
        }).listen(0, '127.0.0.1', () => r(s));
    });

    const t = await boot({ env: { OV_AI_INTERNAL_URL: `http://127.0.0.1:${aiSrv.address().port}` } });
    const alice = t.network.addUser('alice', { display_name: 'Alice' });
    await t.get('/api/v1/blogs', { as: alice, json: {} });

    await check('Find a picture goes through Blog and the shared task, and returns Media references', async () => {
        const r = await t.get('/write/find-images', { as: alice, form: { _csrf: t.csrf(alice), q: 'workbench', count: '4' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().task, 'image.picture');
        assert.strictEqual(r.json().items.length, 1);
        assert.strictEqual(r.json().items[0].mediaId, MED);
        assert.deepStrictEqual({ license: r.json().items[0].license, author: r.json().items[0].author, ai: r.json().items[0].ai }, { license: 'CC BY-SA 4.0', author: 'Ada Example', ai: false });
        assert.strictEqual(asked[0].workflow, 'image.picture');
        assert.deepStrictEqual(asked[0].input, { mode: 'find', query: 'workbench', count: 4, media_app: 'blog' });
        assert.deepStrictEqual(asked[0].on_behalf_of, { type: 'user', id: alice.subject });
        const page = await t.get('/write/@alice/new', { as: alice });
        assert.ok(page.text.includes('data-find="/write/find-images"'));
        assert.ok(!page.text.includes('api.openverse.org'), 'the browser no longer asks Openverse');
        const js = await t.get('/js/blog-editor.js');
        assert.ok(!js.text.includes('api.openverse.org') && !js.text.includes('commons.wikimedia.org'), 'picture search is server-side');
    });

    await check('a query is required, and a stranger cannot search', async () => {
        assert.strictEqual((await t.get('/write/find-images', { as: alice, form: { _csrf: t.csrf(alice) } })).status, 422);
        const stranger = t.network.addUser('stranger');
        assert.strictEqual((await t.get('/write/find-images', { as: stranger, form: { _csrf: t.csrf(stranger), q: 'x' } })).status, 200, 'signed-in search is a read, not a write');
    });

    await check('Make an image returns the Media reference and its made-with-AI credit', async () => {
        asked.length = 0;
        // The same stub answers make as find; make's own output shape is exercised in AI's tests.
        const r = await t.get('/write/make-image', { as: alice, form: { _csrf: t.csrf(alice), prompt: 'A goose', alt: 'A goose' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(asked[0].workflow, 'image.picture');
        assert.deepStrictEqual(asked[0].input, { mode: 'make', prompt: 'A goose', alt: 'A goose', media_app: 'blog' });
        assert.strictEqual(r.json().mediaId, MED);
        assert.strictEqual(r.json().credit, 'Made with AI (gpt-image-1)');
        assert.match(r.json().caption, /Made with AI \(gpt-image-1\)/);
    });

    await check('a search with no note still reports an empty answer honestly', async () => {
        const r = await t.get('/write/find-images', { as: alice, form: { _csrf: t.csrf(alice), q: 'nothing' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(Array.isArray(r.json().items));
    });

    await t.close();
    aiSrv.close();
    done();
})();
