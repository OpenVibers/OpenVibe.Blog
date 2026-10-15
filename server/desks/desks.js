'use strict';
/**
 * OpenVibe.Blog's AI desks (the owner's April ask: "AI-generated niche blogs backed by large source datasets" and "a
 * satirical/parody type blog"). They sit beside the blogs, not in them: a desk post is written by OpenVibe.AI, labelled
 * as such on every surface, never indexed, and never a blog_posts row (whose AI text waits for a person's review).
 *
 *   pull()      Sources' change feed for each category the desks read (openvibe-publishing/ingest, cursor per
 *               category): items of a desk's sources are kept in blog_desk_items (21 days); a removed item is
 *               dropped, so a post written later can never cite it.
 *   compose()   for each desk whose latest period is over (catalog.js: every, hour) and has no post yet: the newest
 *               items that appeared or changed in the period go to blog.write_digest; a section the AI did not
 *               cite is left out (and said so), a run with no cited section makes no post. The satire desk asks
 *               blog.write_satire for one invented post a day. A failure is retried (three attempts, 30 minutes apart).
 *   tick()      pull, compose, prune: every BLOG_DESKS_INTERVAL_MS where the worker runs.
 *
 * Staff (Network admins) may hide a desk post and show it again; nothing else edits one.
 */
const crypto = require('crypto');
const ingest = require('openvibe-publishing/ingest');
const { serviceAuth } = require('openvibe-contracts');
const { createAiClient } = require('openvibe-publishing/ai');
const catalog = require('./catalog');

const DAY = 86_400_000;
const HOUR = 3_600_000;
const KEEP_ITEMS_MS = 21 * DAY;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 30 * 60_000;

const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const num = (v) => (v == null ? null : Number(v));
const slugify = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/, '');
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const newId = () => `dsk_${crypto.randomBytes(10).toString('hex')}`;

// Source numbers the AI was told not to write into its text: "(Source 3)", "(Sources 1, 2)", "[4]". The page links them.
const SOURCE_REFS = /\s*(?:\((?:sources?|items?)\s*[\d\s,&and-]+\)|\[\d+(?:\s*,\s*\d+)*\])/gi;
const prose = (v, n) => String(v == null ? '' : v).replace(SOURCE_REFS, '').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const citesOf = (list, n) => [...new Set((Array.isArray(list) ? list : []).filter((x) => Number.isInteger(x) && x >= 0 && x < n))].sort((a, b) => a - b);

/** The AI's headline, or the desk's own when the AI named the format ("… digest", "snapshot") instead of the news. */
function headline(title, fallback) {
    const t = clean(title, 200).replace(/\s*[([](?:[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]+ \d{4}|\d{4}-\d{2}-\d{2})[)\]]\s*$/, '');
    return t && !/\b(digest|desk|snapshots?|round-?ups?)\b/i.test(t) ? t : fallback;
}

/** The latest period of a desk that is over (and past its writing hour) at `now`: { from, to }. */
function duePeriod(desk, now) {
    const d = new Date(now);
    const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const hour = (desk.hour || 0) * HOUR;
    if (desk.every === 'week') {
        const monday = today - ((d.getUTCDay() + 6) % 7) * DAY;
        const to = now >= monday + hour ? monday : monday - 7 * DAY;
        return { from: to - 7 * DAY, to };
    }
    const to = now >= today + hour ? today : today - DAY;
    return { from: to - DAY, to };
}

/** "Wednesday 14 October 2026" or "the week of 5 to 11 October 2026". */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function periodLabel(desk, { from, to }) {
    const dm = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
    const year = (ms) => new Date(ms).getUTCFullYear();
    if (desk.every === 'week') return `the week of ${dm(from)} to ${dm(to - DAY)} ${year(to - DAY)}`;
    return `${WEEKDAYS[new Date(from).getUTCDay()]} ${dm(from)} ${year(from)}`;
}

/** What the AI reads about one item: its summary and the fields Sources stored, and whether it is new or changed. */
function snippetOf(it) {
    const lines = [];
    if (it.summary) lines.push(clean(it.summary, 1200));
    const fields = parse(it.fields, {});
    const kv = Object.entries(fields).filter(([, v]) => v !== null && v !== '').slice(0, 20).map(([k, v]) => `${k}: ${clean(v, 120)}`);
    if (kv.length) lines.push(kv.join('; '));
    lines.push(Number(it.revision) > 1 ? `Changed at the source (revision ${it.revision}).` : 'New at the source.');
    return lines.join('\n').slice(0, 3000);
}

function createDesks({ config, store, fetchImpl = globalThis.fetch, log = console, now = () => store.now() }) {
    const db = store.db;
    const c = config.desks || {};
    const aiTokens = config.aiUrl && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.ai', scope: 'ai.run.create ai.run.read', fetchImpl,
    }) : null;
    const ai = createAiClient({ baseUrl: config.aiUrl, tokenClient: aiTokens, fetch: fetchImpl });
    const sourcesOn = Boolean(config.sources && config.sources.internalUrl && config.oauth.clientSecret);
    const cursor = ingest.createChangeCursor(db, { prefix: 'blog', now });
    const wanted = new Set(catalog.DESKS.flatMap((d) => d.sources));
    const categories = [...new Set(catalog.DESKS.flatMap((d) => d.categories))];
    const clients = new Map(categories.map((cat) => [cat, ingest.createSourcesClient({ config: { ...config, sources: { ...config.sources, category: cat } }, fetchImpl, now })]));
    const stats = { lastPullAt: null, lastComposeAt: null, lastError: null, written: 0 };

    // ── Items ───────────────────────────────────────────────

    async function applyItem(item, t) {
        if (!wanted.has(item.source_key)) return 'applied';
        if (item.removed) {
            await t.query('DELETE FROM blog_desk_items WHERE item_id = $1', [item.id]);
            return 'removed';
        }
        const at = now();
        const prev = await t.maybe('SELECT revision FROM blog_desk_items WHERE item_id = $1', [item.id]);
        const firstSeen = item.provenance && item.provenance.first_seen_at ? Date.parse(item.provenance.first_seen_at) : NaN;
        // New to Blog: dated when Sources first saw it (a first pull never presents old items as today's news).
        // A new revision of an item Blog already holds: dated now, when the change reached Blog.
        const changedAt = prev ? (Number(item.revision) > Number(prev.revision) ? at : null) : (Number.isFinite(firstSeen) ? firstSeen : at);
        await t.query(`INSERT INTO blog_desk_items (item_id, source_key, title, url, summary, published_at, fields, revision, changed_at, updated_at)
                       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
                       ON CONFLICT (item_id) DO UPDATE SET title = excluded.title, url = excluded.url, summary = excluded.summary,
                           published_at = excluded.published_at, fields = excluded.fields, revision = excluded.revision,
                           changed_at = COALESCE($11, blog_desk_items.changed_at), updated_at = excluded.updated_at`,
        [item.id, item.source_key, clean(item.title, 500) || null, item.canonical_url || null, item.summary ? String(item.summary).slice(0, 2000) : null,
            item.published_at || null, JSON.stringify(item.fields || {}), Number(item.revision) || 1, changedAt || at, at, changedAt]);
        return 'applied';
    }

    async function pull() {
        if (!sourcesOn) return { pulled: 0 };
        let pulled = 0;
        for (const [cat, source] of clients) {
            try {
                const r = await ingest.pullChanges({ db, cursor, source, name: `desks:${cat}`, apply: applyItem, maxPages: 25, pageSize: 200 });
                pulled += r.applied + r.removed;
            } catch (err) {
                stats.lastError = `pull ${cat}: ${err.message}`;
                log.warn(`[Blog] desks: pulling ${cat} from Sources failed:`, err.message);
            }
        }
        stats.lastPullAt = new Date(now()).toISOString();
        return { pulled };
    }

    // ── Posts ───────────────────────────────────────────────

    const shape = (r) => (r ? {
        ...r, body: parse(r.body, {}), sources: parse(r.sources, []),
        period_from: num(r.period_from), period_to: num(r.period_to), created_at: num(r.created_at), published_at: num(r.published_at), updated_at: num(r.updated_at),
    } : null);

    /** The row for a desk's period, created (status writing) or claimed for another attempt; null when there is nothing to do. */
    async function claim(desk, period, slug) {
        const at = now();
        const row = shape(await db.maybe('SELECT * FROM blog_desk_posts WHERE desk = $1 AND period_from = $2', [desk.key, period.from]));
        if (row) {
            if (row.status !== 'failed' || row.attempts >= MAX_ATTEMPTS || at - row.updated_at < RETRY_AFTER_MS) return null;
            const n = await db.exec(`UPDATE blog_desk_posts SET status = 'writing', attempts = attempts + 1, updated_at = $3
                                     WHERE id = $1 AND status = 'failed' AND attempts = $2`, [row.id, row.attempts, at]);
            return n ? { ...row, attempts: row.attempts + 1 } : null;
        }
        const id = newId();
        const n = await db.exec(`INSERT INTO blog_desk_posts (id, desk, slug, status, period_from, period_to, attempts, created_at, updated_at)
                                 VALUES ($1, $2, $3, 'writing', $4, $5, 1, $6, $6) ON CONFLICT DO NOTHING`, [id, desk.key, slug, period.from, period.to, at]);
        return n ? { id, desk: desk.key, slug, attempts: 1 } : null;
    }

    async function fail(row, err) {
        stats.lastError = `${row.desk}: ${err.message}`;
        log.warn(`[Blog] desks: ${row.desk} ${row.slug} (attempt ${row.attempts}) failed:`, err.message);
        await db.query("UPDATE blog_desk_posts SET status = 'failed', error = $2, updated_at = $3 WHERE id = $1", [row.id, clean(err.message, 300), now()]);
    }

    /** One digest: the period's items to blog.write_digest, cited sections only. */
    async function writeDigest(desk, period) {
        const items = await db.many(`SELECT * FROM blog_desk_items WHERE source_key = ANY($1::text[]) AND changed_at >= $2 AND changed_at < $3
                                     ORDER BY changed_at DESC, item_id LIMIT $4`, [desk.sources, period.from, period.to, desk.max || 40]);
        if (items.length < (desk.min || 1)) return null;
        const row = await claim(desk, period, ymd(period.from));
        if (!row) return null;
        try {
            const label = periodLabel(desk, period);
            const r = await ai.run('blog.write_digest', {
                desk: desk.title, about: desk.about, period: label,
                sources: items.map((it) => ({
                    source_type: 'sources.item', source_id: it.item_id,
                    ...(it.url ? { url: it.url } : {}), ...(it.title ? { title: clean(it.title, 500) } : {}),
                    ...(it.published_at ? { published_at: String(it.published_at).slice(0, 40) } : {}),
                    snippet: snippetOf(it),
                })),
            }, { target: { service: 'blog', type: 'desk', id: `${desk.key}:${ymd(period.from)}` }, idempotencyKey: `blog.desk:${desk.key}:${ymd(period.from)}:${row.attempts}` });
            const out = r.output || {};
            const gaps = (Array.isArray(out.gaps) ? out.gaps : []).map((g) => clean(g, 300)).filter(Boolean).slice(0, 20);
            const all = Array.isArray(out.sections) ? out.sections : [];
            // Each paragraph keeps its own citations (an older answer's section body counts as one paragraph); a
            // paragraph that cites nothing is left out and the post says so.
            let dropped = 0;
            const sections = all.map((s) => {
                const paras = (s && Array.isArray(s.paragraphs) ? s.paragraphs : (s && s.body ? [{ text: s.body, citations: s.citations }] : []))
                    .map((p) => ({ text: prose(p && p.text, 1500), cites: citesOf(p && p.citations, items.length) }));
                const kept = paras.filter((p) => p.text && p.cites.length);
                dropped += paras.length - kept.length;
                return { heading: clean(s && s.heading, 160), paragraphs: kept };
            }).filter((s) => s.paragraphs.length);
            if (dropped) gaps.push(`${dropped} paragraph(s) the AI wrote without citing an item were left out.`);
            if (!sections.length) throw new Error(`run ${r.runId} cited nothing, so no post was made`);
            const sources = items.map((it) => ({ item_id: it.item_id, source_key: it.source_key, title: it.title || null, url: it.url || null, published_at: it.published_at || null }));
            return await finish(row, r, { title: headline(out.title, `${desk.title}: ${label}`), dek: prose(out.dek, 400) || null, body: { sections, gaps }, sources });
        } catch (err) { await fail(row, err); return null; }
    }

    /** One satire post: the next question from the catalog to blog.write_satire. */
    async function writeSatire(desk, period) {
        const done = Number(await db.value("SELECT count(*) FROM blog_desk_posts WHERE desk = $1 AND status IN ('published','hidden')", [desk.key])) || 0;
        const row = await claim(desk, period, ymd(period.to));
        if (!row) return null;
        try {
            const q = catalog.questionFor(done);
            const r = await ai.run('blog.write_satire', { topic: q.topic, angle: q.angle }, {
                target: { service: 'blog', type: 'desk', id: `${desk.key}:${ymd(period.to)}` }, idempotencyKey: `blog.desk:${desk.key}:${ymd(period.to)}:${row.attempts}`,
            });
            const out = r.output || {};
            const markdown = String(out.body_markdown || '').trim().slice(0, 12000);
            if (!markdown) throw new Error(`run ${r.runId} wrote no text`);
            const title = clean(out.title, 200) || q.topic;
            const tags = (Array.isArray(out.tags) ? out.tags : []).map((t) => clean(t, 40).toLowerCase()).filter(Boolean).slice(0, 5);
            return await finish(row, r, { title, dek: clean(out.dek, 300) || null, body: { markdown, tags, topic: q.topic, angle: q.angle }, sources: [], slug: `${ymd(period.to)}-${slugify(title) || 'satire'}` });
        } catch (err) { await fail(row, err); return null; }
    }

    async function finish(row, r, { title, dek, body, sources, slug = null }) {
        const at = now();
        // The stub provider's synthetic text is kept for the record but never shown (hidden, with the reason).
        const synthetic = Boolean(r.synthetic);
        await db.query(`UPDATE blog_desk_posts SET status = $2, title = $3, dek = $4, body = $5::jsonb, sources = $6::jsonb, run_id = $7, model = $8,
                            synthetic = $9, error = NULL, published_at = $10, updated_at = $10, slug = COALESCE($11, slug),
                            hidden_by = $12, hidden_reason = $13 WHERE id = $1`,
        [row.id, synthetic ? 'hidden' : 'published', title, dek, JSON.stringify(body), JSON.stringify(sources), r.runId || null,
            (r.workflow && r.workflow.model) || null, synthetic, at, slug, synthetic ? 'system' : null, synthetic ? 'Written by the stub provider (synthetic text).' : null]);
        stats.written++;
        return shape(await db.maybe('SELECT * FROM blog_desk_posts WHERE id = $1', [row.id]));
    }

    async function compose() {
        if (!ai.enabled) return [];
        const out = [];
        const at = now();
        if (sourcesOn) {
            for (const desk of catalog.DESKS) {
                const p = await writeDigest(desk, duePeriod(desk, at));
                if (p) out.push(p);
            }
        }
        const p = await writeSatire(catalog.SATIRE, duePeriod(catalog.SATIRE, at));
        if (p) out.push(p);
        stats.lastComposeAt = new Date(at).toISOString();
        return out;
    }

    async function prune() {
        return await db.exec('DELETE FROM blog_desk_items WHERE changed_at < $1', [now() - KEEP_ITEMS_MS]);
    }

    let running = false;
    async function tick() {
        if (running) return null;
        running = true;
        try {
            const p = await pull();
            const written = await compose();
            await prune();
            return { ...p, written: written.length };
        } catch (err) {
            stats.lastError = err.message;
            log.warn('[Blog] desks tick failed:', err.message);
            return null;
        } finally { running = false; }
    }

    let timer = null;
    let first = null;

    return {
        enabled: Boolean(c.enabled && ai.enabled),
        stats,
        pull, compose, tick, prune,
        /** Published posts of a desk, newest first (staff also see hidden ones). */
        async list(deskKey, { limit = 20, offset = 0, staff = false } = {}) {
            const states = staff ? ['published', 'hidden'] : ['published'];
            const total = Number(await db.value('SELECT count(*) FROM blog_desk_posts WHERE desk = $1 AND status = ANY($2::text[])', [deskKey, states])) || 0;
            const rows = await db.many(`SELECT * FROM blog_desk_posts WHERE desk = $1 AND status = ANY($2::text[])
                                        ORDER BY period_from DESC LIMIT $3 OFFSET $4`, [deskKey, states, limit, offset]);
            return { total, posts: rows.map(shape) };
        },
        async latest() {
            const rows = await db.many(`SELECT DISTINCT ON (desk) * FROM blog_desk_posts WHERE status = 'published' ORDER BY desk, period_from DESC`);
            return new Map(rows.map((r) => [r.desk, shape(r)]));
        },
        async bySlug(deskKey, slug) {
            return shape(await db.maybe('SELECT * FROM blog_desk_posts WHERE desk = $1 AND slug = $2', [deskKey, String(slug)]));
        },
        /** Staff: hide a post (it leaves the desk and its feed) or show it again. */
        async setHidden(post, hidden, { by, reason = null }) {
            if (!post || (post.status !== 'published' && post.status !== 'hidden')) return false;
            await db.query('UPDATE blog_desk_posts SET status = $2, hidden_by = $3, hidden_reason = $4, updated_at = $5 WHERE id = $1',
                [post.id, hidden ? 'hidden' : 'published', hidden ? by : null, hidden ? clean(reason, 300) || null : null, now()]);
            return true;
        },
        start() {
            if (!this.enabled || timer) return;
            timer = setInterval(() => { tick(); }, c.intervalMs || 15 * 60_000);
            timer.unref();
            first = setTimeout(() => { tick(); }, 90_000);
            first.unref();
        },
        stop() { clearInterval(timer); clearTimeout(first); timer = null; },
    };
}

module.exports = { createDesks, duePeriod, periodLabel, snippetOf, slugify, headline, prose };
