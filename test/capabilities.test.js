'use strict';
/**
 * The blog.* capabilities are released by openvibe-contracts, so the service guards delegate to the
 * library's grant rule rather than deciding a proposed id locally. Since openvibe-contracts v0.338.0
 * every id this service guards is released — blog.review.ai_editor (the AI editor's review kind)
 * included — so nothing is decided locally any more. These pin that: every guarded id is defined by
 * the installed contracts and the blog service manifest; and checkCapability agrees with
 * capabilities.check for an exact grant, a prefix grant, no grant, and an id nobody defines.
 */
const assert = require('assert');
const { capabilities, services } = require('openvibe-contracts');
const { checkCapability, CAPABILITIES, PROPOSED } = require('../server/auth/capabilities');
const { check, done } = require('./helpers/boot');

const GRANTED = { cap: ['blog.post.read'], sub: 'svc:openvibe.network' };

(async () => {
    await check('every guarded capability is defined by the installed contracts and the blog manifest', async () => {
        const manifest = services.get('blog');
        assert.ok(manifest, 'openvibe-contracts defines the blog service manifest');
        const released = Object.values(CAPABILITIES).filter((id) => capabilities.get(id));
        assert.deepStrictEqual([...manifest.capabilities].sort(), released.sort());
        for (const id of Object.values(CAPABILITIES)) {
            const cap = capabilities.get(id);
            assert.ok(cap, `${id} is released by openvibe-contracts`);
            assert.strictEqual(cap.owner, 'blog', `${id} is owned by blog`);
        }
        // The AI editor's id is released since openvibe-contracts v0.338.0: no id is a local proposal any more.
        assert.strictEqual(PROPOSED.size, 0, 'no capability is waiting for a Contracts release');
    });

    await check('checkCapability follows the contracts grant rule (exact, prefix, denied, unknown)', async () => {
        // An exact grant and a `prefix.*` grant the library's matching rule accepts.
        assert.deepStrictEqual(checkCapability(GRANTED, 'blog.post.read'), { allowed: true, code: null, reason: null });
        assert.deepStrictEqual(checkCapability({ cap: ['blog.*'] }, 'blog.post.read'), { allowed: true, code: null, reason: null });
        // Every id is released, so the library's own rule decides it.
        assert.deepStrictEqual(checkCapability({ cap: ['blog.review.ai_editor'] }, 'blog.review.ai_editor'), { allowed: true, code: null, reason: null });
        assert.deepStrictEqual(checkCapability({ cap: ['blog.*'] }, 'blog.review.ai_editor'), { allowed: true, code: null, reason: null });
        assert.strictEqual(checkCapability({ cap: ['blog.post.publish'] }, 'blog.review.ai_editor').code, 'capability.denied');
        // A grant of a sibling capability, or no cap at all, is denied with the library's code.
        assert.strictEqual(checkCapability({ cap: ['blog.post.create'] }, 'blog.post.read').code, 'capability.denied');
        assert.strictEqual(checkCapability(null, 'blog.post.read').code, 'capability.denied');
        // An id nobody defines still answers capability.unknown — the guard only falls back for a proposal.
        assert.strictEqual(checkCapability({ cap: ['blog.*'] }, 'blog.not.a.capability').code, 'capability.unknown');
    });

    done();
})();
