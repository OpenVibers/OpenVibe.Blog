'use strict';
/**
 * The proposals the lead releases in the next openvibe-contracts version are valid against the
 * released schemas, match what the code enforces, and do not collide with released ids.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { check, done } = require('./helpers/boot');
const { PROPOSED } = require('../server/auth/capabilities');

const DIR = path.join(__dirname, '..', 'docs', 'capabilities-proposal');

(async () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
    const caps = files.map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'service-manifest-proposal.json'), 'utf8'));

    await check('every capability proposal is a valid capabilities.capability@1 with 3+ segments, owned by blog', async () => {
        for (const c of caps) {
            const v = contracts.validate('capabilities.capability@1', c);
            assert.ok(v.valid, `${c.id}: ${JSON.stringify(v.errors)}`);
            assert.strictEqual(c.owner, 'blog');
            assert.ok(c.id.split('.').length >= 3);
            assert.strictEqual(`${c.id}.json`, files[caps.indexOf(c)]);
            assert.ok(!contracts.capabilities.get(c.id) || contracts.capabilities.get(c.id).owner === 'blog', `${c.id} collides with a released capability`);
        }
    });

    await check('the proposals are exactly the capabilities the code enforces', async () => {
        assert.deepStrictEqual(caps.map((c) => c.id).sort(), [...PROPOSED].sort());
        assert.deepStrictEqual([...manifest.capabilities].sort(), [...PROPOSED].sort());
    });

    await check('the service manifest proposal is a valid registry.service-manifest@1', async () => {
        const v = contracts.validate('registry.service-manifest@1', manifest);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(manifest.id, 'blog');
        for (const c of caps) for (const e of c.events) assert.ok(manifest.eventsProduced.includes(e), `${c.id} names ${e}, missing from eventsProduced`);
    });

    await check('every event type the code emits is declared', async () => {
        const src = ['server/domain/posts.js', 'server/domain/publication.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
        for (const m of src.matchAll(/event_type: '([a-z_.]+)'/g)) assert.ok(manifest.eventsProduced.includes(m[1]), m[1]);
    });

    done();
})();
