'use strict';

/**
 * What happens after a write has committed (never inside the transaction):
 *   - wake the outbox relay so events leave promptly;
 *   - keep the Community comment thread in step with the post: hidden when the post is deleted or
 *     stops being public, shown again when it is public again (best effort; needs
 *     community.comment.moderate). A thread is never created for a non-public post.
 */
function createEffects({ outbox, community }) {
    return {
        after(before, post, ctx) {
            outbox.kick();
            if (!post || !before) return;
            // Public = readable by everyone: published and public. Unpublishing hides the thread too.
            const wasPublic = before.visibility === 'public' && before.state === 'published';
            const isPublic = post.visibility === 'public' && post.state === 'published';
            if (wasPublic && !isPublic) community.setThreadVisibility(post, 'hidden', ctx).catch(() => {});
            else if (!wasPublic && isPublic) community.setThreadVisibility(post, 'public', ctx).catch(() => {});
        },
    };
}

module.exports = { createEffects };
