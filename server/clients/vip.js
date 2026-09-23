'use strict';

/**
 * OpenVibe.VIP — who may read a members-only post. Blog asks VIP's gated-resource policy
 * (POST /api/v1/policies/evaluate, capability vip.resource.policy.evaluate, a client-credentials
 * token for audience openvibe.vip) with:
 *
 *   resource  { service: 'blog', type: 'post', id: <post id> }
 *   owner     the blog's owner (blogs.owner_subject) — the creator whose members may read
 *   fallback  { requirement: 'member', binding: 'blog:gated_post' } — Blog's default gate: any active
 *             member of the owner, or, when the owner defines a perk bound to `blog gated_post`, a
 *             member whose plan version includes it. A rule the owner sets in VIP for the post wins.
 *
 * Answers go through createVipCache (server/vip/vip-client.js, vendored from OpenVibe.VIP): a "yes"
 * lives at most config.vip.ttlMs (never past the entitlement's expiry), a "no" denyTtlMs, a failure
 * unavailableTtlMs. Every failure is a refusal.
 */
const { serviceAuth } = require('openvibe-contracts');
const { createVipClient, createVipCache } = require('../vip/vip-client');

const FALLBACK = Object.freeze({ requirement: 'member', binding: 'blog:gated_post' });

function createVip({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const v = config.vip;
    const enabled = Boolean(config.oauth.clientSecret);
    const tokens = enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.vip', scope: 'vip.resource.policy.evaluate', fetchImpl,
    }) : null;
    const client = enabled ? createVipClient({ baseUrl: v.internalUrl, tokenClient: tokens, fetch: fetchImpl, timeoutMs: v.timeoutMs, log }) : null;
    const cache = client ? createVipCache({ vip: client, ttlMs: v.ttlMs, denyTtlMs: v.denyTtlMs, unavailableTtlMs: v.unavailableTtlMs, now }) : null;

    /** May `subject` read members-only `post` of `blog`? → { allow, reason } (never throws). */
    async function decide({ subject, blog, post }) {
        if (!cache) return { allow: false, reason: 'vip_not_configured' };
        if (!blog || !blog.owner_subject) return { allow: false, reason: 'no_owner' };
        if (!subject) return { allow: false, reason: 'not_signed_in' };
        try {
            const d = await cache.evaluate({ subject, resource: { service: 'blog', type: 'post', id: String(post.id) }, owner: blog.owner_subject, fallback: FALLBACK });
            return { allow: d.allow === true, reason: d.reason || (d.allow === true ? 'member' : 'denied') };
        } catch (err) {
            return { allow: false, reason: 'vip_unavailable', error: err.message };
        }
    }

    /** The page where a reader joins the owner's plans (their VIP handle, else their subject). */
    const joinUrl = (owner) => (owner && (owner.username || owner.subject) ? `${v.publicUrl}/${encodeURIComponent(owner.username || owner.subject)}` : v.publicUrl);

    return { enabled, client, cache, decide, joinUrl, FALLBACK };
}

module.exports = { createVip, FALLBACK };
