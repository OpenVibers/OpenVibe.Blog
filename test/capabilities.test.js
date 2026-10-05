'use strict';
/**
 * The blog.* capabilities are released by openvibe-contracts, so the service guards delegate to the
 * library's grant rule rather than deciding a proposed id locally (the fallback that existed while
 * the ids were only proposals). These pin that: every guarded id is defined by the installed
 * contracts and by the blog service manifest, and checkCapability agrees with capabilities.check for
 * an exact grant, a prefix grant, no grant, and an id the contracts do not define.
 */
const assert = require('assert');
const { capabilities, services } = require('openvibe-contracts');
const { checkCapability, CAPABILITIES } = require('../server/auth/capabilities');
const { check, done } = require('./helpers/boot');

const GRANTED = { cap: ['blog.post.read'], sub: 'svc:openvibe.network' };

(async () => {
    await check('every guarded capability is defined by the installed contracts and the blog manifest', async () => {
        const manifest = services.get('blog');
        assert.ok(manifest, 'openvibe-contracts defines the blog service manifest');
        assert.deepStrictEqual([...manifest.capabilities].sort(), Object.values(CAPABILITIES).sort());
        for (const id of Object.values(CAPABILITIES)) {
            const cap = capabilities.get(id);
            assert.ok(cap, `${id} is defined by openvibe-contracts`);
            assert.strictEqual(cap.owner, 'blog', `${id} is owned by blog`);
        }
    });

    await check('checkCapability follows the contracts grant rule (exact, prefix, denied, unknown)', async () => {
        // An exact grant and a `prefix.*` grant the library's matching rule accepts.
        assert.deepStrictEqual(checkCapability(GRANTED, 'blog.post.read'), { allowed: true, code: null, reason: null });
        assert.deepStrictEqual(checkCapability({ cap: ['blog.*'] }, 'blog.post.read'), { allowed: true, code: null, reason: null });
        // A grant of a sibling capability, or no cap at all, is denied with the library's code.
        assert.strictEqual(checkCapability({ cap: ['blog.post.create'] }, 'blog.post.read').code, 'capability.denied');
        assert.strictEqual(checkCapability(null, 'blog.post.read').code, 'capability.denied');
        // An id the contracts do not define still answers capability.unknown — the guard delegates,
        // it never decides an unknown id on its own.
        assert.strictEqual(checkCapability({ cap: ['blog.*'] }, 'blog.not.a.capability').code, 'capability.unknown');
    });

    done();
})();
