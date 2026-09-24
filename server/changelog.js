'use strict';
/**
 * The network changelog and its patch notes (every OpenVibe site, one feed, published on the blog).
 *
 * Collect (every CHANGELOG_INTERVAL_MS): OpenVibe.Network's registry names each service's GitHub
 * repository (GET /api/v1/registry/services) and the release it runs now (GET
 * /api/v1/registry/releases, from each service's /release.json). When a service's release changes,
 * GitHub's compare API (base = the release seen last, head = the new one) gives the commits that
 * shipped and the size of the change. Each commit becomes a changelog entry (service, sha, subject,
 * committed_at, deployed_at); a release whose change is large (CHANGELOG_MAJOR_LINES lines, or a
 * library version bump like "1.7.0: …", or "[major]" in a message) marks its entries major. A service
 * seen for the first time only records its release, unless CHANGELOG_SINCE backfills from a date.
 *
 * Publish: pending entries (not yet in a post) become one "Patch notes" post on the blog
 * (CHANGELOG_BLOG, default the official blog) when there are CHANGELOG_BATCH_SIZE of them, or when a
 * major release is pending and deploys have been quiet for CHANGELOG_QUIET_MS (a burst of deploys
 * becomes one post), or when the oldest has waited CHANGELOG_MAX_AGE_MS; never sooner than
 * CHANGELOG_MIN_GAP_MS after the last post unless twice the batch is waiting. The post is the commit
 * messages people wrote, grouped by site with links to each commit and the highlights first:
 * authorship "imported" (from GitHub), published at once by the blog's first configured owner, so it
 * reaches feeds, Search and Community Pulse like any post. With OpenVibe.AI configured and
 * CHANGELOG_AI_DRAFT on, an AI-written dev-blog version is also filed as a draft for a person to
 * review (AI text is never published unreviewed).
 *
 * Read: GET /api/v1/changelog?service=&limit= (public, CORS *) is what every site's "recently
 * shipped" shows, with the latest patch notes post to link to.
 */
const crypto = require('crypto');

const GITHUB = 'https://api.github.com';
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

function ensureSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS changelog_state (
            service    TEXT PRIMARY KEY,
            release    TEXT NOT NULL,
            head       TEXT,
            checked_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS changelog_entries (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            service      TEXT NOT NULL,
            repo         TEXT NOT NULL,
            sha          TEXT NOT NULL,
            subject      TEXT NOT NULL,
            committed_at TEXT,
            deployed_at  TEXT NOT NULL,
            release      TEXT NOT NULL,
            release_lines INTEGER NOT NULL DEFAULT 0,
            major        INTEGER NOT NULL DEFAULT 0,
            post_id      TEXT,
            UNIQUE (service, sha)
        );
        CREATE INDEX IF NOT EXISTS idx_changelog_pending ON changelog_entries(post_id, deployed_at);
        CREATE TABLE IF NOT EXISTS changelog_posts (
            post_id     TEXT PRIMARY KEY,
            blog_id     TEXT NOT NULL,
            entries     INTEGER NOT NULL,
            from_at     TEXT,
            to_at       TEXT,
            reason      TEXT NOT NULL,
            ai_draft_id TEXT,
            created_at  INTEGER NOT NULL
        );
    `);
}

/** The first line of a commit message, cut at a word near `n` characters. */
function subjectOf(message, n = 240) {
    const first = String(message || '').split('\n')[0].trim();
    if (first.length <= n) return first;
    const cut = first.slice(0, n);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 40)).replace(/[,;:(\s]+$/, '')}…`;
}
const isVersionBump = (subject) => /^\d+\.\d+\.\d+\b/.test(subject);
const isNoise = (subject) => /^Merge (branch|pull request|remote)/i.test(subject);

function createChangelog({ config, store, blogs, posts, aiDrafts = null, fetchImpl = globalThis.fetch, log = console }) {
    const c = config.changelog;
    const db = store.db;
    ensureSchema(db);
    const nowMs = () => store.now();
    const stats = { runs: 0, entries: 0, posts: 0, lastError: null, lastRunAt: null };

    const q = {
        state: db.prepare('SELECT * FROM changelog_state WHERE service = ?'),
        putState: db.prepare(`INSERT INTO changelog_state (service, release, head, checked_at) VALUES (@service, @release, @head, @at)
            ON CONFLICT(service) DO UPDATE SET release = excluded.release, head = excluded.head, checked_at = excluded.checked_at`),
        insert: db.prepare(`INSERT OR IGNORE INTO changelog_entries (service, repo, sha, subject, committed_at, deployed_at, release, release_lines, major)
            VALUES (@service, @repo, @sha, @subject, @committed_at, @deployed_at, @release, @release_lines, @major)`),
        pending: db.prepare('SELECT * FROM changelog_entries WHERE post_id IS NULL ORDER BY deployed_at, committed_at, id'),
        mark: db.prepare('UPDATE changelog_entries SET post_id = ? WHERE id = ? AND post_id IS NULL'),
        lastPost: db.prepare('SELECT * FROM changelog_posts ORDER BY created_at DESC LIMIT 1'),
        putPost: db.prepare(`INSERT INTO changelog_posts (post_id, blog_id, entries, from_at, to_at, reason, ai_draft_id, created_at)
            VALUES (@post_id, @blog_id, @entries, @from_at, @to_at, @reason, @ai_draft_id, @created_at)`),
    };

    async function getJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
        const res = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw Object.assign(new Error(`${url.replace(/\?.*$/, '')} answered ${res.status}`), { status: res.status });
        return res.json();
    }
    const gh = (path) => getJson(`${GITHUB}${path}`, { headers: {
        Accept: 'application/vnd.github+json', 'User-Agent': 'OpenVibe.Blog changelog (+https://openvibe.blog)',
        ...(c.githubToken ? { Authorization: `Bearer ${c.githubToken}` } : {}),
    } });

    /** [{ id, name, repo, origin, release, releasedAt }] for services that run a release and name a repository. */
    async function registry() {
        const base = String(c.networkUrl).replace(/\/+$/, '');
        const [svc, rel] = await Promise.all([getJson(`${base}/api/v1/registry/services`), getJson(`${base}/api/v1/registry/releases`)]);
        const services = new Map((svc.services || svc || []).map((s) => [s.id, s]));
        const out = [];
        for (const r of rel.releases || rel || []) {
            const s = services.get(r.id);
            if (!s || !s.repository || !/^[0-9a-f]{7,40}$/.test(String(r.release || ''))) continue;
            if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.repository)) continue;
            out.push({ id: r.id, name: s.name || r.id, repo: s.repository, origin: s.publicOrigin || null, release: r.release, releasedAt: r.released_at || null });
        }
        return out;
    }

    function addEntries(svc, commits, { releaseLines = 0, major = false } = {}) {
        const deployedAt = svc.releasedAt || new Date(nowMs()).toISOString();
        let n = 0;
        for (const cm of commits) {
            const subject = subjectOf(cm.commit && cm.commit.message);
            if (!subject || isNoise(subject)) continue;
            const flagged = major || isVersionBump(subject) || /\[major\]/i.test((cm.commit && cm.commit.message) || '');
            n += q.insert.run({
                service: svc.id, repo: svc.repo, sha: cm.sha, subject, committed_at: (cm.commit && cm.commit.author && cm.commit.author.date) || null,
                deployed_at: deployedAt, release: svc.release, release_lines: releaseLines, major: flagged ? 1 : 0,
            }).changes;
        }
        return n;
    }

    async function collectOne(svc) {
        const st = q.state.get(svc.id);
        if (st && st.release === svc.release) return 0;
        if (!st) {
            let n = 0;
            if (c.since) {
                const list = await gh(`/repos/${svc.repo}/commits?sha=${svc.release}&since=${encodeURIComponent(c.since)}&per_page=100`);
                n = addEntries(svc, (Array.isArray(list) ? list : []).slice().reverse());
            }
            q.putState.run({ service: svc.id, release: svc.release, head: null, at: nowMs() });
            return n;
        }
        const cmp = await gh(`/repos/${svc.repo}/compare/${st.head || st.release}...${svc.release}`);
        const commits = Array.isArray(cmp.commits) ? cmp.commits : [];
        const lines = (Array.isArray(cmp.files) ? cmp.files : []).reduce((a, f) => a + (Number(f.additions) || 0) + (Number(f.deletions) || 0), 0);
        const n = cmp.status === 'behind' ? 0 : addEntries(svc, commits, { releaseLines: lines, major: lines >= c.majorLines });
        const head = commits.length ? commits[commits.length - 1].sha : st.head;
        q.putState.run({ service: svc.id, release: svc.release, head, at: nowMs() });
        return n;
    }

    async function collect() {
        let added = 0;
        for (const svc of await registry()) {
            try { added += await collectOne(svc); } catch (err) {
                stats.lastError = `${svc.id}: ${err.message}`;
                if (err.status === 403 || err.status === 429) break;     // GitHub's rate limit: try again next run
            }
        }
        stats.entries += added;
        return added;
    }

    /** { due, reason } for the pending entries. */
    function due(list, at = nowMs()) {
        if (!list.length) return { due: false, reason: 'nothing pending' };
        const last = q.lastPost.get();
        const sinceLast = last ? at - last.created_at : Infinity;
        const newest = Math.max(...list.map((e) => Date.parse(e.deployed_at) || 0));
        const oldest = Math.min(...list.map((e) => Date.parse(e.deployed_at) || at));
        if (list.length >= c.batchSize * 2) return { due: true, reason: 'batch' };
        if (sinceLast < c.minGapMs) return { due: false, reason: 'too soon after the last post' };
        if (list.length >= c.batchSize) return { due: true, reason: 'batch' };
        if (list.some((e) => e.major) && at - newest >= c.quietMs) return { due: true, reason: 'major' };
        if (list.length >= 5 && at - oldest >= c.maxAgeMs) return { due: true, reason: 'age' };
        return { due: false, reason: 'waiting' };
    }

    function render(list, services) {
        const byService = new Map();
        for (const e of list) { if (!byService.has(e.service)) byService.set(e.service, []); byService.get(e.service).push(e); }
        const order = [...byService.keys()].sort((a, b) => byService.get(b).length - byService.get(a).length || a.localeCompare(b));
        const name = (id) => (services.get(id) && services.get(id).name) || id;
        const link = (e) => `[\`${e.sha.slice(0, 7)}\`](https://github.com/${e.repo}/commit/${e.sha})`;
        // A highlight per major release: its most descriptive (longest) commit subject.
        const majors = new Map();
        for (const e of list) if (e.major) { const k = `${e.service}@${e.release}`; if (!majors.has(k) || e.subject.length > majors.get(k).subject.length) majors.set(k, e); }
        const highlights = [...majors.values()].slice(0, 8);
        const day = (iso) => new Date(iso).toISOString().slice(0, 10);
        const from = day(list[0].deployed_at);
        const to = day(list[list.length - 1].deployed_at);
        const sites = order.map(name);
        const lead = highlights[0] ? clean(highlights[0].subject.split(/[:.;(]/)[0], 70) : null;
        const title = lead && lead.length >= 12 ? `Patch notes: ${lead}` : `Patch notes: ${list.length} changes across ${order.length} ${order.length === 1 ? 'site' : 'sites'}`;
        const summary = clean(`What shipped on OpenVibe ${from === to ? `on ${from}` : `from ${from} to ${to}`}: ${list.length} ${list.length === 1 ? 'change' : 'changes'} to ${sites.slice(0, 6).join(', ')}${sites.length > 6 ? ` and ${sites.length - 6} more` : ''}.`, 400);
        const out = [`${summary} Every line below is a commit message from the OpenVibers repositories, linked to the change itself.`, ''];
        if (highlights.length) {
            out.push('## Highlights', '');
            for (const e of highlights) out.push(`- **${name(e.service)}:** ${e.subject} (${link(e)})`);
            out.push('');
        }
        for (const id of order) {
            const svc = services.get(id);
            out.push(`## ${name(id)}`, '');
            if (svc && svc.origin) out.push(`[${svc.origin.replace(/^https?:\/\//, '')}](${svc.origin}) · [repository](https://github.com/${svc.repo})`, '');
            for (const e of byService.get(id)) out.push(`- ${e.subject} (${link(e)})`);
            out.push('');
        }
        out.push('---', '', 'Patch notes are put together automatically when enough changes have shipped, or when a large feature lands. See every site\'s own updates page for the live list.');
        return { title, summary, body: out.join('\n'), from: list[0].deployed_at, to: list[list.length - 1].deployed_at, tags: ['patch-notes', ...order.slice(0, 10)] };
    }

    async function publish(list, reason) {
        const blog = blogs.byHandle(c.blogHandle) || (c.blogHandle === config.official.handle ? blogs.ensureOfficial() : null);
        const owner = config.official.owners.find((s) => /^usr_/.test(s));
        if (!blog || !owner) { stats.lastError = !blog ? `no blog @${c.blogHandle}` : 'BLOG_OFFICIAL_OWNERS names no owner to publish as'; return null; }
        const services = new Map((await registry().catch(() => [])).map((s) => [s.id, s]));
        for (const e of list) if (!services.has(e.service)) services.set(e.service, { id: e.service, name: e.service, repo: e.repo, origin: null });
        const doc = render(list, services);
        const viewer = { kind: 'user', subject: owner, staff: false };
        const { post } = posts.create(viewer, blog, {
            title: doc.title, summary: doc.summary, body: doc.body, tags: doc.tags.filter((t) => t.length <= 50).slice(0, 20), series: 'Patch notes',
            authorship: { mode: 'imported', importedFrom: { label: 'Commit messages from the OpenVibers repositories on GitHub', originalAuthor: 'OpenVibers' } },
            message: `Patch notes from ${list.length} commits (${reason})`,
        });
        posts.publish(viewer, posts.get ? posts.get(post.id) || post : post);
        let aiDraftId = null;
        if (c.aiDraft && aiDrafts && aiDrafts.enabled) {
            try {
                const brief = list.map((e) => `- [${e.service}] ${e.subject}`).join('\n').slice(0, 3900);
                const d = await aiDrafts.draft(viewer, blog, { topic: `Dev blog: ${doc.title.replace(/^Patch notes: /, '')}`, brief: `Write a friendly developer-blog post about what just shipped on OpenVibe, for its community. Only use these changes:\n${brief}`, tone: 'plain, warm, specific', audience: 'OpenVibe members and contributors' });
                aiDraftId = d.post.id;
            } catch (err) { log.warn && log.warn(`[changelog] AI dev-blog draft not made: ${err.message}`); }
        }
        store.tx(() => {
            for (const e of list) q.mark.run(post.id, e.id);
            q.putPost.run({ post_id: post.id, blog_id: blog.id, entries: list.length, from_at: doc.from, to_at: doc.to, reason, ai_draft_id: aiDraftId, created_at: nowMs() });
        });
        stats.posts++;
        log.log && log.log(`[changelog] published ${post.id} (${list.length} entries, ${reason})`);
        return { post, aiDraftId };
    }

    async function tick() {
        stats.runs++; stats.lastRunAt = new Date(nowMs()).toISOString();
        try {
            await collect();
            const list = q.pending.all();
            const d = due(list);
            if (d.due) return await publish(list.slice(0, c.batchSize * 3), d.reason);
            return null;
        } catch (err) { stats.lastError = err.message; log.warn && log.warn(`[changelog] ${err.message}`); return null; }
    }

    let timer = null;
    function start() {
        if (!c.enabled || timer) return;
        const first = setTimeout(() => { tick().catch(() => {}); }, c.firstDelayMs);
        if (first.unref) first.unref();
        timer = setInterval(() => { tick().catch(() => {}); }, c.intervalMs);
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }

    /** The public feed: newest first. */
    function entries({ service = null, limit = 20 } = {}) {
        const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
        const rows = service
            ? db.prepare('SELECT * FROM changelog_entries WHERE service = ? ORDER BY deployed_at DESC, id DESC LIMIT ?').all(String(service), n)
            : db.prepare('SELECT * FROM changelog_entries ORDER BY deployed_at DESC, id DESC LIMIT ?').all(n);
        return rows.map((e) => ({
            service: e.service, sha: e.sha, short: e.sha.slice(0, 7), subject: e.subject, committed_at: e.committed_at, deployed_at: e.deployed_at,
            major: Boolean(e.major), url: `https://github.com/${e.repo}/commit/${e.sha}`, post_id: e.post_id || null,
        }));
    }
    function latestPost() { return q.lastPost.get() || null; }

    return { tick, collect, due, render, publish, start, stop, entries, latestPost, stats: () => ({ enabled: c.enabled, ...stats, pending: q.pending.all().length }) };
}

/** A stable id for a batch (tests). */
function batchKey(list) { return crypto.createHash('sha256').update(list.map((e) => `${e.service}:${e.sha}`).join(',')).digest('hex').slice(0, 16); }

module.exports = { createChangelog, subjectOf, ensureSchema, batchKey };
