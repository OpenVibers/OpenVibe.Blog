'use strict';

/**
 * Blog → OpenVibe.Events through the openvibe-sdk transactional outbox (ADR-004).
 *
 *   blog.post.created                    a post (draft) exists
 *   blog.post.published|updated|unpublished|deleted
 *                                        publication changes (openvibe-publishing/index-hooks
 *                                        publicationEvent: canonical URL, state, indexability; public
 *                                        only for public, listable posts)
 *   blog.schedule.failed                 a scheduled publish/unpublish gave up after its retries
 *   blog.moderation.action               staff unpublished or deleted a post only their staff powers
 *                                        allowed (common.moderation-action@1, ADR-022), for Network's
 *                                        moderation audit log
 *   blog.index_document.upserted|deleted the OpenVibe.Search document or tombstone (index-hooks
 *                                        indexEvent), consumed by Search's '*.index_document.*'
 *                                        subscription
 *
 * emit() runs inside the SQLite transaction that makes the change, so an event exists if and only
 * if its change committed. The relay publishes with Blog's service token (events.event.publish,
 * audience openvibe.events) only when EVENTS_URL and OV_OAUTH_CLIENT_SECRET are set; otherwise
 * rows wait in event_outbox and /api/ready reports the relay as off.
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createOutbox } = require('openvibe-sdk/events');

function createBlogOutbox({ db, config, fetchImpl, now, log = console }) {
    const enabled = Boolean(config.events.url && config.oauth.clientSecret);
    const clientOpts = { baseUrls: { events: config.events.url || 'http://127.0.0.1:4300' }, retries: 0 };
    if (fetchImpl) clientOpts.fetch = fetchImpl;
    if (enabled) {
        clientOpts.tokenProvider = createServiceTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
            scope: { 'openvibe.events': 'events.event.publish' }, ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
    } else {
        clientOpts.getToken = async () => { throw new Error('events relay disabled (EVENTS_URL / OV_OAUTH_CLIENT_SECRET unset)'); };
    }
    const events = createEventsClient(createClient(clientOpts), { source: 'blog' });
    let lastError = null;
    const outbox = createOutbox(db, {
        events,
        intervalMs: config.events.intervalMs,
        now,
        onError: (err) => {
            const msg = err && err.message;
            if (msg !== lastError) log.warn('[Blog] event publish failed (will retry):', msg);
            lastError = msg;
        },
    });
    outbox.ensureSchema();

    /** Inside the caller's transaction. Returns the complete envelope (with its event_id). */
    function emit(envelope, { traceparent } = {}) {
        return outbox.enqueue(envelope, { traceparent });
    }

    /**
     * blog.moderation.action, inside the caller's transaction. actorSubject: the staff member;
     * target: { type, id, owner_subject? }. Never the content.
     */
    function moderationAction({ action, target, actorSubject, reason = null, details = {} }, { traceparent } = {}) {
        const t = { type: target.type, id: String(target.id).slice(0, 200), owner_subject: target.owner_subject || null };
        return emit({
            event_type: 'blog.moderation.action',
            actor: actorSubject ? { type: 'user', id: actorSubject } : { type: 'service', id: 'blog' },
            subject: { type: 'moderation_action', id: `${t.type}:${t.id}`.slice(0, 200) },
            visibility: 'internal',
            payload: { action, target: t, actor_subject: actorSubject || null, reason: reason ? String(reason).slice(0, 500) : null, details: details || {} },
        }, { traceparent });
    }

    return {
        emit,
        moderationAction,
        outbox,
        enabled,
        start() { if (enabled) outbox.start(); },
        stop: () => outbox.stop(),
        kick() { if (enabled) outbox.kick(); },
        status: () => ({ enabled, pending: outbox.pending(), rejected: outbox.rejected(), last_error: lastError }),
    };
}

module.exports = { createBlogOutbox };
