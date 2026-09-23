'use strict';
/**
 * Background work in the Blog process (openvibe-shared has no job runner; this is two timers):
 *
 *   scheduled publication   every BLOG_SCHEDULE_INTERVAL_MS: claim due jobs (leased, so two
 *                           processes never run the same job at once) and apply them; the effect
 *                           is idempotent, so a job re-run after a crash changes nothing
 *   media verification      every BLOG_MEDIA_VERIFY_INTERVAL_MS: ask OpenVibe.Media whether the
 *                           objects attached to published posts still exist; gone → the explicit
 *                           broken-asset state; an outage changes nothing (check_failed)
 */
function createWorker({ config, store, posts, media, outbox, log = console }) {
    let scheduleTimer = null;
    let mediaTimer = null;
    let running = false;

    async function scheduleTick() {
        if (running) return null;
        running = true;
        try {
            const summary = await posts.runScheduled(config.worker.id);
            if (summary.done.length || summary.failed.length) outbox.kick();
            return summary;
        } catch (err) {
            log.error('[Blog] schedule tick failed:', err.message);
            return null;
        } finally { running = false; }
    }

    /** Verify the attachments of published posts (at most `limit` posts per run). */
    async function verifyMedia({ limit = 200 } = {}) {
        if (!media.enabled) return [];
        const ids = store.db.prepare(`SELECT DISTINCT a.entity_id AS id FROM blog_post_attachments a JOIN blog_posts p ON p.id = a.entity_id
                                      WHERE p.state = 'published' ORDER BY COALESCE(a.checked_at, 0) LIMIT ?`).all(limit).map((r) => r.id);
        const out = [];
        for (const id of ids) {
            const results = await store.attachments.verify(id, { resolve: media.resolve });
            out.push({ post: id, results });
        }
        return out;
    }

    return {
        scheduleTick,
        verifyMedia,
        start() {
            if (!config.worker.enabled) return;
            scheduleTimer = setInterval(scheduleTick, config.worker.intervalMs);
            scheduleTimer.unref();
            if (media.enabled) {
                mediaTimer = setInterval(() => verifyMedia().catch((err) => log.warn('[Blog] media verification failed:', err.message)), config.media.verifyIntervalMs);
                mediaTimer.unref();
            }
            setTimeout(scheduleTick, 1000).unref();
        },
        stop() { clearInterval(scheduleTimer); clearInterval(mediaTimer); },
    };
}

module.exports = { createWorker };
