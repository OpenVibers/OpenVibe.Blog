'use strict';

/**
 * Capability checks for service tokens (audience openvibe.blog). The blog.* ids this service
 * introduces are defined by the installed openvibe-contracts, so a grant is decided by the library's
 * own matching rule (the exact id, or a `prefix.*` grant covering it). CAPABILITIES keeps the ids in
 * one place for the guards, the proposal documents and the tests.
 *
 * Browsers (Network user JWTs) are never judged by capabilities: they are judged by their blog
 * membership (domain/access.js). A service token is judged by its capability AND by the membership
 * of the person it acts for (X-OV-Subject).
 */
const { capabilities } = require('openvibe-contracts');

const CAPABILITIES = Object.freeze({
    BLOG_CREATE: 'blog.blog.create',        // the charter's blog.create, as a 3-segment id
    BLOG_CONFIGURE: 'blog.blog.configure',  // title, description, language, feed settings
    THEME_SET: 'blog.theme.set',
    MEMBER_MANAGE: 'blog.member.manage',
    POST_CREATE: 'blog.post.create',
    POST_READ: 'blog.post.read',
    POST_UPDATE: 'blog.post.update',
    POST_PUBLISH: 'blog.post.publish',
    POST_SCHEDULE: 'blog.post.schedule',
    POST_UNPUBLISH: 'blog.post.unpublish',
    POST_DELETE: 'blog.post.delete',
    REVIEW_AI_EDITOR: 'blog.review.ai_editor',
    FEED_READ: 'blog.feed.read',
});

// The ids above as a local fallback while openvibe-contracts does not define one yet (the same
// rule the library uses: the exact id, or a `prefix.*` grant covering it). An id the library knows
// always goes through the library, so the day a release lands nothing changes here.
const PROPOSED = new Set(Object.values(CAPABILITIES));

/** → { allowed, code, reason } like capabilities.check(). */
function checkCapability(claims, capabilityId) {
    if (!capabilities.get(capabilityId) && PROPOSED.has(capabilityId)) {
        return capabilities.grants(claims && claims.cap, capabilityId)
            ? { allowed: true, code: null, reason: null }
            : { allowed: false, code: 'capability.denied', reason: `${capabilityId} not granted` };
    }
    return capabilities.check(claims, capabilityId);
}

module.exports = { CAPABILITIES, PROPOSED, checkCapability };
