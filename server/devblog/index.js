'use strict';
const { build } = require('../patch-notes/stories');
const { intentOf } = require('../patch-notes/text');
const { createVoiceCards } = require('../patch-notes/voice');
const { ApiError } = require('../http/errors');
const blocks = require('openvibe-publishing/blocks');
const WEEK = 7 * 86400000;
const date = ms => new Date(ms).toISOString().slice(0, 10);
function weekOf(value) {
    const d = new Date(value); if (!Number.isFinite(+d)) throw new ApiError(422, 'devblog.date', 'Invalid week');
    d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return date(+d);
}
function meaningful(e) {
    const subject = String(e.subject || '');
    if (/^(?:test|docs?|ci|build|chore)(?:\([^)]*\))?[:\s]|^Merge\b|^openvibe-(?:shared|sdk|contracts|publishing)\s+v|^(?:pin|bump)\b|dependenc/i.test(subject)) return false;
    let files = e.files; if (typeof files === 'string') { try { files = JSON.parse(files); } catch { files = []; } }
    if (Array.isArray(files) && files.length && files.every(f => /(^|\/)(?:test|tests|docs|\.github)\/|\.(?:md|test\.js|spec\.js)$|(?:^|\/)package(?:-lock)?\.json$/.test(typeof f === 'string' ? f : f.filename || ''))) return false;
    return ['feature', 'fix'].includes(intentOf(e).kind);
}
function candidates(entries, { from, to }) {
    const groups = new Map();
    for (const e of entries) {
        if (!e.service || !e.deployed_at || e.deployed_at < from || e.deployed_at >= to) continue;
        const week = weekOf(e.deployed_at), key = `${e.service}:${week}`;
        if (!groups.has(key)) groups.set(key, { service: e.service, week, entries: [] });
        groups.get(key).entries.push(e);
    }
    return [...groups.values()].filter(g => g.entries.some(meaningful)).sort((a, b) => a.week.localeCompare(b.week) || a.service.localeCompare(b.service));
}
function createDevblog({ config, store, blogs, posts, access, aiDrafts, media, log = console }) {
    const db = store.db, voice = createVoiceCards({ store });
    async function blogFor(service) {
        const handle = (config.devblog.sites || {})[service] || config.changelog.blogHandle;
        return blogs.byHandle(handle);
    }
    async function authorize(viewer, blog, service) {
        if (!viewer?.subject) throw new ApiError(401, 'subject.required', 'Sign in to draft a devblog');
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(service)) throw new ApiError(422, 'devblog.site', 'Choose a site');
        const target = await blogFor(service);
        if (!target || target.id !== blog.id || await access.effectiveRole(store, viewer, blog) !== 'owner') throw new ApiError(403, 'devblog.owner_required', 'Only the owner of the site’s configured blog may draft its devblog');
    }
    async function draft(viewer, blog, { service, week = weekOf(store.now()), backfill = false, retry = false } = {}, opts = {}) {
        await authorize(viewer, blog, service);
        if (!aiDrafts.enabled) throw new ApiError(503, 'ai.not_configured', 'The devblog writer is not configured');
        const start = weekOf(week), end = date(Date.parse(start) + WEEK);
        if (Date.parse(start) > store.now()) throw new ApiError(422, 'devblog.future', 'The week has not started');
        const entries = await db.prepare('SELECT * FROM changelog_entries WHERE service = ? AND deployed_at >= ? AND deployed_at < ? ORDER BY deployed_at, id').all(service, start, end);
        const useful = entries.filter(meaningful);
        if (!useful.length) throw new ApiError(422, 'devblog.no_changes', 'No meaningful merged changes this week');
        if (entries.length > 200) throw new ApiError(422, 'devblog.too_many_changes', 'Split or review this unusually large week before drafting');
        const reservation = await store.tx(async () => {
            // Serializes live cadence decisions across processes as well as weekly INSERT races.
            await db.prepare('SELECT id FROM blogs WHERE id = ? FOR UPDATE').get(blog.id);
            const slot = await db.prepare('SELECT * FROM blog_devblog_slots WHERE service = ? AND week_start = ?').get(service, start);
            if (slot?.status === 'drafted') return { post: await posts.get(slot.post_id), created: false };
            if (slot?.status === 'failed' && !retry) throw new ApiError(409, 'devblog.failed', 'The previous attempt failed; an owner can retry it');
            if (slot?.status === 'reserved') throw new ApiError(409, 'devblog.running', 'This week’s draft is already being written');
            if (!backfill) {
                const recent = await db.prepare("SELECT 1 AS x FROM blog_devblog_slots WHERE service = ? AND status IN ('reserved', 'drafted') AND created_at > ?").get(service, store.now() - WEEK);
                if (recent) throw new ApiError(409, 'devblog.cadence', 'This site already has a devblog draft in the last seven days');
            }
            await db.prepare(`INSERT INTO blog_devblog_slots (service, week_start, blog_id, status, created_at, updated_at) VALUES (?, ?, ?, 'reserved', ?, ?)
                ON CONFLICT (service, week_start) DO UPDATE SET status = 'reserved', created_at = excluded.created_at, attempt = blog_devblog_slots.attempt + 1, updated_at = excluded.updated_at`).run(service, start, blog.id, store.now(), store.now());
            return { attempt: (slot?.attempt || 0) + 1 };
        });
        if (reservation.post) return reservation;
        try {
            const sources = entries.map(e => ({ source_type: 'git.commit', source_id: e.sha, url: `https://github.com/${e.repo}/commit/${e.sha}`, title: e.subject, author: e.author || 'The OpenVibe team', content: JSON.stringify({ subject: e.subject, body: e.message_body || '', files: e.files || [], pull_request: e.pr_number || null }).slice(0, 10000) }));
            const map = build(useful, { maxStories: 8 });
            const storyGroups = [...map.stories, ...map.also.map(e => ({ title: e.subject, entries: [e] }))].slice(0, 8);
            const stories = storyGroups.map(s => ({ title: s.title, sources: s.entries.map(e => entries.findIndex(x => x.sha === e.sha)), authors: [...new Set(s.entries.map(e => e.author || 'The OpenVibe team'))] }));
            const shots = media?.listShots ? await media.listShots().catch(() => []) : [];
            const screenshots = [];
            for (const shot of shots) {
                const m = shot.metadata || {};
                const source = entries.findIndex(e => m.service === service && m.release && (m.release === e.release || m.release === e.sha));
                if (source < 0 || !/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(shot.id)) continue;
                screenshots.push({ media_id: shot.id, source, alt: String(m.alt || `${service}: ${m.path || '/'} at ${m.viewport || 'desktop'} width`).slice(0, 300), caption: String(m.caption || `${service} ${m.path || '/'} after this release`).slice(0, 500) });
                if (screenshots.length === 24) break;
            }
            const result = await aiDrafts.devblog(viewer, blog, { site: service, from: start, to: date(Date.parse(end) - 1), sources, stories, screenshots, voice: JSON.stringify(await voice.get(blog.kind === 'official' ? 'official' : blog.id)).slice(0, 6000) }, { ...opts, idempotencyKey: `devblog:${service}:${start}:${reservation.attempt}` });
            const out = result.output;
            if (!out?.title || !out.summary || !out.blocks || !blocks.validate(out.blocks).ok || out.checks?.length) throw new ApiError(422, 'devblog.invalid', 'The writer returned an invalid draft');
            const allowed = new Set(screenshots.map(s => s.media_id));
            const figures = [];
            const visit = n => { if (n.type === 'figure') { if (!allowed.has(n.attrs?.src)) throw new ApiError(422, 'devblog.media', 'The draft named an unknown screenshot'); figures.push(n); } for (const c of n.children || []) visit(c); };
            visit(out.blocks);
            // Disclosure does not claim a person has reviewed the new draft.
            out.blocks.children.splice(1, 0, { type: 'text', value: `Written by our AI writer (${result.workflow.model || 'model recorded in the AI run'}) from the team’s commits.` });
            return await store.tx(async () => {
                const aiViewer = { kind: 'service', service: 'svc:ai', origin: 'ai', subject: viewer.subject };
                const made = await posts.create(aiViewer, blog, { title: out.title, summary: out.summary, blocks: out.blocks, categories: ['Devblog'], tags: ['devblog', service], series: `${service} devblog`, authorship: { workflow: result.workflow, stubProvider: result.synthetic }, citations: sources.map(s => ({ url: s.url, title: s.title })), message: `Devblog draft, ${service}, week ${start}` }, opts);
                for (const f of figures) await posts.attach(aiViewer, made.post, { mediaId: f.attrs.src, alt: f.attrs.alt, caption: f.attrs.caption });
                await db.prepare("UPDATE blog_devblog_slots SET status = 'drafted', post_id = ?, updated_at = ? WHERE service = ? AND week_start = ?").run(made.post.id, store.now(), service, start);
                return { ...made, created: true };
            });
        } catch (err) {
            await db.prepare("UPDATE blog_devblog_slots SET status = 'failed', updated_at = ? WHERE service = ? AND week_start = ? AND status = 'reserved'").run(store.now(), service, start);
            throw err;
        }
    }
    async function tick() {
        if (!config.devblog.enabled || !aiDrafts.enabled) return;
        const week = date(Date.parse(weekOf(store.now())) - WEEK);
        const sites = await db.prepare('SELECT DISTINCT service FROM changelog_entries WHERE deployed_at >= ?').all(week);
        for (const { service } of sites) {
            const blog = await blogFor(service); if (!blog) continue;
            const owner = await db.prepare("SELECT subject FROM blog_memberships WHERE blog_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1").get(blog.id);
            if (!owner) continue;
            try { await draft({ kind: 'user', subject: owner.subject }, blog, { service, week }); }
            catch (err) { if (![409, 422].includes(err.status)) log.warn(`[devblog] ${service}: ${err.code || 'draft failed'}`); }
        }
    }
    return { draft, tick, blogFor };
}
module.exports = { createDevblog, candidates, meaningful, weekOf, WEEK };
