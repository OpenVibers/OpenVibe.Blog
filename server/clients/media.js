'use strict';

/**
 * OpenVibe.Media: attachments are Media object ids (med_…); the bytes stay in Media.
 *
 *   urlFor(mediaId)    the public delivery URL (GET /o/:id on the Media host)
 *   resolve(mediaId)   for openvibe-publishing/media verify(): asks Media's object API
 *                      (GET /api/v2/<app>/objects/:id, capability media.object.read for the
 *                      namespace BLOG_MEDIA_APP, audience openvibe.media) whether the object exists:
 *                        200 ready/uploading   → { exists: true }
 *                        200 lifecycle deleted → { exists: false, reason: 'deleted' }
 *                        410                   → { exists: false, reason: 'deleted' }
 *                        404                   → { exists: false, reason: 'not_found' }
 *                        anything else (401/403 grants, 5xx, timeouts) THROWS: an outage or a
 *                        missing grant is not evidence the object is gone (check_failed)
 *
 * Media does not publish a deletion event yet, so Blog's worker re-verifies the attachments of
 * published posts every BLOG_MEDIA_VERIFY_INTERVAL_MS; a broken attachment renders as an explicit
 * "media unavailable" placeholder, never as a silently missing image.
 */
const { serviceAuth } = require('openvibe-contracts');

/** The tenant the shots live in (plan L9): OpenVibe.Host stores them in its own Media tenant. */
const SHOTS_APP = 'host';

function createMedia({ config, fetchImpl = globalThis.fetch }) {
    const enabled = Boolean(config.oauth.clientSecret && config.media.internalUrl);
    const tokens = enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.media', scope: 'media.object.read', fetchImpl,
    }) : null;

    /** The tenant an object is asked for: Blog's own, or Host's (the shots, plan L9). */
    const shotsApp = () => (config.media.shotsApp || SHOTS_APP);

    /** The object in one tenant, or why it is not there. Anything else THROWS (check_failed). */
    async function resolveIn(app, mediaId) {
        const res = await fetchImpl(`${config.media.internalUrl}/api/v2/${encodeURIComponent(app)}/objects/${encodeURIComponent(mediaId)}`, {
            headers: { Accept: 'application/json', ...(await tokens.authHeaders()) },
            signal: AbortSignal.timeout(5000),
        });
        if (res.status === 404) return { exists: false, reason: 'not_found' };
        if (res.status === 410) return { exists: false, reason: 'deleted' };
        if (res.status === 401 && tokens.invalidate) tokens.invalidate();
        if (!res.ok) throw new Error(`Media answered ${res.status}`);
        const data = await res.json().catch(() => null);
        const obj = data && (data.object || data);
        if (obj && obj.lifecycle_status === 'deleted') return { exists: false, reason: 'deleted' };
        return { exists: true };
    }

    return {
        enabled,
        urlFor: (mediaId) => `${config.media.publicUrl}/o/${encodeURIComponent(mediaId)}`,

        async resolve(mediaId) {
            if (!tokens) throw new Error('Media verification is not configured');
            const own = await resolveIn(config.media.app, mediaId);
            if (own.exists || own.reason === 'deleted') return own;
            // The shots Host captured live in Host's own tenant (plan L9): look there too, and never
            // turn an outage or a missing grant into "the object is gone" (check_failed).
            const other = shotsApp();
            if (other && other !== config.media.app) {
                const there = await resolveIn(other, mediaId);
                if (there.exists || there.reason === 'deleted') return there;
            }
            return own;
        },

        /** The shots Host captured (plan L9): the index of the host tenant, newest first. */
        async listShots({ app = null, kind = 'screenshot', limit = 100 } = {}) {
            if (!tokens) throw new Error('Media verification is not configured');
            const tenant = app || shotsApp();
            const res = await fetchImpl(`${config.media.internalUrl}/api/v2/${encodeURIComponent(tenant)}/objects?kind=${encodeURIComponent(kind)}&limit=${limit}`, {
                headers: { Accept: 'application/json', ...(await tokens.authHeaders()) },
                signal: AbortSignal.timeout(8000),
            });
            if (res.status === 401 && tokens.invalidate) tokens.invalidate();
            if (!res.ok) throw new Error(`Media answered ${res.status}`);
            const data = await res.json().catch(() => null);
            return (data && data.objects) || [];
        },

        /** The bytes of one shot. */
        async download(mediaId, { app = null } = {}) {
            if (!tokens) throw new Error('Media verification is not configured');
            const tenant = app || shotsApp();
            const res = await fetchImpl(`${config.media.internalUrl}/api/v2/${encodeURIComponent(tenant)}/objects/${encodeURIComponent(mediaId)}/download`, {
                headers: { ...(await tokens.authHeaders()) },
                redirect: 'follow',
                signal: AbortSignal.timeout(30000),
            });
            if (!res.ok) throw new Error(`Media answered ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        },
    };
}

module.exports = { createMedia };
