'use strict';
/**
 * Scheduled publication is idempotent across worker restarts: a worker that applies the publish
 * and dies before recording the job as done leaves the lease to expire; after a restart on the same
 * database the job re-runs, changes nothing and emits nothing twice. Scheduling twice is one job.
 * A job that cannot succeed ends in blog.schedule.failed and the post returns to draft.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const LONG = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
const MIN = 60 * 1000;

(async () => {
    const t = await boot();
    const ann = t.network.addUser('ann');
    await t.get('/api/v1/blogs', { as: ann, json: {} });
    const mk = async (title) => (await t.get('/api/v1/blogs/ann/posts', { as: ann, json: { title, body: LONG } })).json().post;
    const at = () => new Date(t.clock.now() + 10 * MIN).toISOString();

    const p1 = await mk('Scheduled one');

    await check('scheduling is idempotent: the same post, time and revision is one job', async () => {
        const when = at();
        const a = await t.get(`/api/v1/posts/${p1.id}/schedule`, { as: ann, json: { at: when } });
        assert.strictEqual(a.status, 201, a.text);
        const b = await t.get(`/api/v1/posts/${p1.id}/schedule`, { as: ann, json: { at: when } });
        assert.strictEqual(b.json().created, false);
        assert.strictEqual(b.json().job.id, a.json().job.id);
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM blog_schedules WHERE post_id = ?').get(p1.id).n, 1, 'charter view blog_schedules');
        assert.strictEqual(b.json().post.state, 'scheduled');
        assert.strictEqual((await t.get('/@ann/scheduled-one')).status, 404, 'not public before its time');
        assert.doesNotMatch((await t.get('/@ann/feed.xml')).text, /Scheduled one/);
    });

    await check('nothing runs before its time', async () => {
        const s = await t.ctx.worker.scheduleTick();
        assert.strictEqual(s.done.length, 0);
    });

    await check('a worker dies after publishing and before completing; after a restart the job re-runs once, harmlessly', async () => {
        t.clock.advance(11 * MIN);
        // Worker A: claim the job and apply its effect, then "crash" (no complete()).
        const [job] = t.ctx.store.scheduler.claim({ worker: 'worker-A' });
        assert.ok(job, 'claimed');
        t.ctx.posts.applyPublish(job.entityId, job.revision, null);
        assert.strictEqual(t.events('blog.post.published').length, 1);
        const idxBefore = t.events('blog.index_document.upserted').length;
        assert.strictEqual(idxBefore, 1);

        await t.restart();   // same database file, new process state
        // The lease (60 s) has not expired yet: nobody may take it.
        let s = await t.ctx.worker.scheduleTick();
        assert.strictEqual(s.done.length, 0);
        t.clock.advance(2 * MIN);
        s = await t.ctx.worker.scheduleTick();
        assert.strictEqual(s.done.length, 1, 'the job re-ran after the lease expired');
        assert.strictEqual(s.done[0].result, false, 'the effect changed nothing the second time');
        assert.strictEqual(t.events('blog.post.published').length, 1, 'exactly one published event');
        assert.strictEqual(t.events('blog.index_document.upserted').length, 1, 'exactly one Search upsert');
        const page = await t.get('/@ann/scheduled-one');
        assert.strictEqual(page.status, 200);
        s = await t.ctx.worker.scheduleTick();
        assert.strictEqual(s.done.length + s.failed.length, 0, 'done jobs never run again');
    });

    await check('a normal scheduled publish through the worker', async () => {
        const p2 = await mk('Scheduled two');
        await t.get(`/api/v1/posts/${p2.id}/schedule`, { as: ann, json: { at: at() } });
        t.clock.advance(11 * MIN);
        const s = await t.ctx.worker.scheduleTick();
        assert.strictEqual(s.done.length, 1);
        assert.strictEqual(t.ctx.posts.get(p2.id).state, 'published');
        assert.match((await t.get('/@ann/feed.xml')).text, /Scheduled two/);
    });

    await check('publishing by hand cancels the pending schedule', async () => {
        const p3 = await mk('Scheduled three');
        await t.get(`/api/v1/posts/${p3.id}/schedule`, { as: ann, json: { at: at() } });
        await t.get(`/api/v1/posts/${p3.id}/publish`, { as: ann, json: {} });
        const jobs = t.ctx.store.scheduler.jobs(p3.id);
        assert.deepStrictEqual(jobs.map((j) => j.status), ['cancelled']);
    });

    await check('a job that cannot succeed fails after its retries: blog.schedule.failed, back to draft', async () => {
        const p4 = await mk('Doomed');
        await t.get(`/api/v1/posts/${p4.id}/schedule`, { as: ann, json: { at: at() } });
        // The revision disappears from under it: simulate a purge (audited erasure) of the post's revisions.
        t.ctx.store.revisions.purgeEntity(p4.id, { reason: 'test', purgedBy: 'test' });
        t.clock.advance(11 * MIN);
        for (let i = 0; i < 4; i++) { await t.ctx.worker.scheduleTick(); t.clock.advance(5 * MIN); }
        const failed = t.events('blog.schedule.failed');
        assert.strictEqual(failed.length, 1, JSON.stringify(t.ctx.store.scheduler.jobs(p4.id)));
        assert.strictEqual(failed[0].subject.id, p4.id);
        assert.match(failed[0].payload.error, /revision/i);
        assert.strictEqual(t.ctx.posts.get(p4.id).state, 'draft');
        const ready = (await t.get('/api/ready')).json();
        assert.ok(ready.degraded.includes('scheduler'), 'readiness reports the failed job');
    });

    await check('a time in the past is refused', async () => {
        const p5 = await mk('Too late');
        const r = await t.get(`/api/v1/posts/${p5.id}/schedule`, { as: ann, json: { at: new Date(t.clock.now() - MIN).toISOString() } });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.json().code, 'schedule.in_past');
    });

    await t.close();
    done();
})();
