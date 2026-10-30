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
 * Draft: pending entries (not yet in a draft) become one Patch notes DRAFT on the blog
 * (CHANGELOG_BLOG, default the official blog) when there are CHANGELOG_BATCH_SIZE of them, or when a
 * major release is pending and deploys have been quiet for CHANGELOG_QUIET_MS (a burst of deploys
 * becomes one draft), or when the oldest has waited CHANGELOG_MAX_AGE_MS; never sooner than
 * CHANGELOG_MIN_GAP_MS after the last draft unless twice the batch is waiting (devblog §3.6: the
 * pipeline never publishes). server/patch-notes/ turns the commits into workstreams and the §3.1
 * template, with OpenVibe.AI's prose when it is configured, and a person reviews the draft before it
 * can be published. The draft owns its entries; the public feed links them only once the post is live.
 *
 * Read: GET /api/v1/changelog?service=&limit= (public, CORS *) is what every site's "recently
 * shipped" shows, with the latest patch notes post to link to.
 */
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');

const GITHUB = 'https://api.github.com';
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/** The changelog tables are in migrations/0001_initial.sql (PostgreSQL, ADR-035); kept for callers of the old helper. */
async function ensureSchema() {}

/** The feed's page cursor: "<deployed_at>|<id>" of the last entry shown. */
function encodeCursor(e) { return Buffer.from(`${e.deployed_at}|${e.id}`).toString('base64url'); }
function decodeCursor(s) {
    try {
        const [at, id] = Buffer.from(String(s || ''), 'base64url').toString('utf8').split('|');
        return at && !Number.isNaN(Date.parse(at)) && /^\d+$/.test(id) ? { at, id: Number(id) } : null;
    } catch { return null; }
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

function createChangelog({ config, store, blogs, posts, patchNotes = null, fetchImpl = globalThis.fetch, log = console }) {
    const c = config.changelog;
    const db = store.db;
    const nowMs = () => store.now();
    const stats = { runs: 0, entries: 0, posts: 0, drafts: 0, lastError: null, lastRunAt: null };

    const q = {
        state: db.prepare('SELECT * FROM changelog_state WHERE service = ?'),
        putState: db.prepare(`INSERT INTO changelog_state (service, release, head, checked_at) VALUES (@service, @release, @head, @at)
            ON CONFLICT(service) DO UPDATE SET release = excluded.release, head = excluded.head, checked_at = excluded.checked_at`),
        insert: db.prepare(`INSERT INTO changelog_entries (service, repo, sha, subject, author, committed_at, deployed_at, release, release_lines, major, post_id)
            VALUES (@service, @repo, @sha, @subject, @author, @committed_at, @deployed_at, @release, @release_lines, @major, @post_id) ON CONFLICT (service, sha) DO NOTHING`),
        fillAuthor: db.prepare('UPDATE changelog_entries SET author = ? WHERE service = ? AND sha = ? AND author IS NULL'),
        history: db.prepare('SELECT * FROM changelog_history WHERE service = ?'),
        putHistory: db.prepare('INSERT INTO changelog_history (service, imported, imported_at) VALUES (?, ?, ?) ON CONFLICT (service) DO UPDATE SET imported = excluded.imported, imported_at = excluded.imported_at'),
        recentPosts: db.prepare('SELECT * FROM changelog_posts ORDER BY created_at DESC LIMIT ?'),
        sites: db.prepare(`SELECT service, COUNT(*) AS entries, MAX(deployed_at) AS latest_at FROM changelog_entries GROUP BY service ORDER BY latest_at DESC`),
        pending: db.prepare('SELECT * FROM changelog_entries WHERE post_id IS NULL ORDER BY deployed_at, committed_at, id'),
        mark: db.prepare('UPDATE changelog_entries SET post_id = ? WHERE id = ? AND post_id IS NULL'),
        enrich: db.prepare('UPDATE changelog_entries SET message_body = ?, files = ?, pr_number = ? WHERE service = ? AND sha = ?'),
        lastPost: db.prepare('SELECT * FROM changelog_posts ORDER BY created_at DESC LIMIT 1'),
        putPost: db.prepare(`INSERT INTO changelog_posts (post_id, blog_id, entries, from_at, to_at, reason, ai_draft_id, created_at)
            VALUES (@post_id, @blog_id, @entries, @from_at, @to_at, @reason, @ai_draft_id, @created_at)`),
    };

    async function getJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
        const res = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw Object.assign(new Error(`${url.replace(/\?.*$/, '')} answered ${res.status}`), { status: res.status });
        return res.json();
    }
    // The GitHub token: CHANGELOG_GITHUB_TOKEN, else the network's (admin → Settings → GitHub), asked of
    // Network with Blog's service token (network.integration.github.read) and kept ten minutes; else
    // anonymous (60 requests an hour, shared by the host).
    const TOKEN_TTL_MS = 10 * 60 * 1000;
    const networkTokens = !c.githubToken && config.oauth && config.oauth.clientSecret && config.networkInternalUrl
        ? serviceAuth.createTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
            audience: 'openvibe.network', scope: 'network.integration.github.read', fetchImpl })
        : null;
    let cachedToken = { value: null, until: 0, source: c.githubToken ? 'env' : 'none' };
    async function githubToken() {
        if (c.githubToken) return c.githubToken;
        if (!networkTokens) return null;
        if (nowMs() < cachedToken.until) return cachedToken.value;
        try {
            const res = await fetchImpl(`${config.networkInternalUrl}/internal/integrations/github-token`, { headers: { Accept: 'application/json', ...(await networkTokens.authHeaders()) }, signal: AbortSignal.timeout(10000) });
            const body = await res.json().catch(() => ({}));
            if (res.status === 401) networkTokens.invalidate();
            const value = res.ok && typeof body.token === 'string' && body.token ? body.token : null;
            cachedToken = { value, until: nowMs() + (res.ok || res.status === 404 ? TOKEN_TTL_MS : 60 * 1000), source: value ? 'network' : res.status === 404 ? 'none' : `network error ${res.status}` };
        } catch (err) {
            cachedToken = { value: null, until: nowMs() + 60 * 1000, source: `network unreachable: ${err.message}` };
        }
        return cachedToken.value;
    }
    const gh = async (path) => {
        const token = await githubToken();
        try {
            return await getJson(`${GITHUB}${path}`, { headers: {
                Accept: 'application/vnd.github+json', 'User-Agent': 'OpenVibe.Blog changelog (+https://openvibe.blog)',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            } });
        } catch (err) {
            // A revoked or replaced network token: ask again next time.
            if (err.status === 401 && token && !c.githubToken) cachedToken.until = 0;
            throw err;
        }
    };

    /** [{ id, name, repo, origin, release, releasedAt }] for services that run a release and name a repository. */
    async function registry() {
        const base = String(c.networkUrl).replace(/\/+$/, '');
        const [svc, rel] = await Promise.all([getJson(`${base}/api/v1/registry/services`), getJson(`${base}/api/v1/registry/releases`)]);
        const list = (x, key) => (Array.isArray(x) ? x : (x && (x[key] || x.services)) || []);
        const services = new Map(list(svc, 'services').map((s) => [s.id, s]));
        const out = [];
        for (const r of list(rel, 'releases')) {
            const s = services.get(r.id);
            if (!s || !s.repository || !/^[0-9a-f]{7,40}$/.test(String(r.release || ''))) continue;
            if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.repository)) continue;
            out.push({ id: r.id, name: s.name || r.id, repo: s.repository, origin: s.publicOrigin || null, release: r.release, releasedAt: r.released_at || null });
        }
        return out;
    }

    const authorOf = (cm) => clean((cm.commit && cm.commit.author && cm.commit.author.name) || (cm.author && cm.author.login) || '', 80) || null;

    // history: the commits a site shipped before the changelog watched it, so its updates page is not
    // empty on day one. They carry post_id 'history' (never pending, never in a patch notes post) and
    // their commit time stands in for the deploy time nobody recorded.
    async function addEntries(svc, commits, { releaseLines = 0, major = false, history = false } = {}) {
        const deployedAt = svc.releasedAt || new Date(nowMs()).toISOString();
        let n = 0;
        for (const cm of commits) {
            const subject = subjectOf(cm.commit && cm.commit.message);
            if (!subject || isNoise(subject)) continue;
            const flagged = major || isVersionBump(subject) || /\[major\]/i.test((cm.commit && cm.commit.message) || '');
            const committedAt = (cm.commit && cm.commit.author && cm.commit.author.date) || null;
            if (history && !committedAt) continue;
            const author = authorOf(cm);
            const added = (await q.insert.run({
                service: svc.id, repo: svc.repo, sha: cm.sha, subject, author, committed_at: committedAt,
                deployed_at: history ? new Date(committedAt).toISOString() : deployedAt, release: svc.release, release_lines: releaseLines, major: flagged ? 1 : 0,
                post_id: history ? 'history' : null,
            })).changes;
            if (!added && author) await q.fillAuthor.run(author, svc.id, cm.sha);
            n += added;
        }
        return n;
    }

    /** Once per service: its last c.history commits on the deployed release. */
    async function importHistory(svc) {
        if (!(c.history > 0) || await q.history.get(svc.id)) return 0;
        let list;
        try { list = await gh(`/repos/${svc.repo}/commits?sha=${svc.release}&per_page=${Math.min(c.history, 100)}`); } catch (err) {
            // A repository GitHub will not list (private, empty, gone) is not asked again; anything else is.
            if ([404, 409, 422].includes(err.status)) { await q.putHistory.run(svc.id, 0, nowMs()); return 0; }
            throw err;
        }
        const n = await addEntries(svc, Array.isArray(list) ? list : [], { history: true });
        await q.putHistory.run(svc.id, n, nowMs());
        return n;
    }

    async function collectOne(svc) {
        const st = await q.state.get(svc.id);
        if (st && st.release === svc.release) return 0;
        if (!st) {
            let n = 0;
            if (c.since) {
                const list = await gh(`/repos/${svc.repo}/commits?sha=${svc.release}&since=${encodeURIComponent(c.since)}&per_page=100`);
                n = await addEntries(svc, (Array.isArray(list) ? list : []).slice().reverse());
            }
            await q.putState.run({ service: svc.id, release: svc.release, head: null, at: nowMs() });
            return n;
        }
        const cmp = await gh(`/repos/${svc.repo}/compare/${st.head || st.release}...${svc.release}`);
        const commits = Array.isArray(cmp.commits) ? cmp.commits : [];
        const lines = (Array.isArray(cmp.files) ? cmp.files : []).reduce((a, f) => a + (Number(f.additions) || 0) + (Number(f.deletions) || 0), 0);
        const n = cmp.status === 'behind' ? 0 : await addEntries(svc, commits, { releaseLines: lines, major: lines >= c.majorLines });
        const head = commits.length ? commits[commits.length - 1].sha : st.head;
        await q.putState.run({ service: svc.id, release: svc.release, head, at: nowMs() });
        return n;
    }

    async function collect() {
        let added = 0;
        let histories = 0;
        for (const svc of await registry()) {
            try {
                added += await collectOne(svc);
                // A few history imports per run keep an unauthenticated GitHub budget intact.
                if (histories < 6 && !await q.history.get(svc.id)) { histories++; await importHistory(svc); }
            } catch (err) {
                stats.lastError = `${svc.id}: ${err.message}`;
                if (err.status === 403 || err.status === 429) break;     // GitHub's rate limit: try again next run
            }
        }
        stats.entries += added;
        return added;
    }

    /** { due, reason } for the pending entries. */
    async function due(list, at = nowMs()) {
        if (!list.length) return { due: false, reason: 'nothing pending' };
        const last = await q.lastPost.get();
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

    /**
     * Read the body, the files and the PR of commits that do not have them yet. The body is where the measurements
     * live; the files are how a story that shared a package is found. Kept in the row, so a later draft does not ask
     * GitHub again. Failures are not fatal: the draft is written from what is known.
     */
    async function enrich(list) {
        const out = [];
        for (const e of list) {
            if (e.message_body || e.body) { out.push({ ...e, body: e.body || e.message_body }); continue; }
            try {
                const c = await gh(`/repos/${e.repo}/commits/${e.sha}`);
                const body = String((c.commit && c.commit.message) || '');
                const files = (Array.isArray(c.files) ? c.files : []).map((f) => f.filename).slice(0, 60);
                const pr = Number((e.subject.match(/\(#(\d+)\)\s*$/) || [])[1]) || null;
                await q.enrich.run(body, JSON.stringify(files), pr, e.service, e.sha);
                out.push({ ...e, body, files, pr_number: pr });
            } catch (err) {
                if (err.status === 403 || err.status === 429) { out.push(...list.slice(out.length)); break; }
                out.push({ ...e, body: e.subject });
            }
        }
        return out;
    }

    /** The pending commits, oldest first, with their URL: what a draft is made from. */
    async function pendingEntries() {
        return (await q.pending.all()).map((e) => ({ ...e, url: `https://github.com/${e.repo}/commit/${e.sha}` }));
    }

    /** A draft owns its commits (they are not in a second draft); the feed shows the link once the post publishes. */
    async function markEntries(list, postId) {
        for (const e of list) if (e.id != null) await q.mark.run(postId, e.id);
    }

    /**
     * The open PRs of the organisation, for What's next. Search API, ten minutes cached: a rate limit answers [].
     */
    let pullsCache = { at: 0, value: [] };
    async function openPulls() {
        if (nowMs() - pullsCache.at < 10 * 60 * 1000) return pullsCache.value;
        try {
            const r = await gh(`/search/issues?q=${encodeURIComponent('org:OpenVibers type:pr state:open')}&per_page=50&sort=updated`);
            const value = (Array.isArray(r.items) ? r.items : []).map((i) => ({
                number: i.number, title: i.title, url: i.html_url,
                repo: String(i.repository_url || '').split('/').slice(-2).join('/'),
            })).filter((p) => p.number && p.url);
            pullsCache = { at: nowMs(), value };
            return value;
        } catch (err) {
            stats.lastError = `pulls: ${err.message}`;
            return pullsCache.value;
        }
    }

    /** File the draft: Patch notes are never published from here (devblog §3.6). */
    async function fileDraft(list, reason) {
        if (!patchNotes) return null;
        try {
            const out = await patchNotes.draftPending({ entries: list, reason });
            if (out && out.created) {
                stats.drafts++;
                await q.putPost.run({ post_id: out.post.id, blog_id: out.post.blog_id, entries: list.length, from_at: list[0].deployed_at, to_at: list[list.length - 1].deployed_at, reason, ai_draft_id: null, created_at: nowMs() });
                log.log && log.log(`[changelog] filed Patch notes draft ${out.post.id} (${list.length} entries, ${reason})`);
            }
            return out;
        } catch (err) {
            stats.lastError = `draft: ${err.message}`;
            log.warn && log.warn(`[changelog] Patch notes draft not filed: ${err.message}`);
            return null;
        }
    }

    async function tick() {
        stats.runs++; stats.lastRunAt = new Date(nowMs()).toISOString();
        try {
            await collect();
            const list = await q.pending.all();
            const d = await due(list);
            if (d.due) return await fileDraft(list.slice(0, c.batchSize * 3), d.reason);
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

    /** The public feed, newest first: { entries, next } (next = the cursor for the page after, or null). */
    async function page({ service = null, limit = 20, before = null } = {}) {
        const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
        const cur = decodeCursor(before);
        const where = [];
        const args = [];
        if (service) { where.push('service = ?'); args.push(String(service)); }
        if (cur) { where.push('(deployed_at < ? OR (deployed_at = ? AND id < ?))'); args.push(cur.at, cur.at, cur.id); }
        const rows = await db.prepare(`SELECT e.*, (SELECT p.state FROM blog_posts p WHERE p.id = e.post_id) AS post_state
            FROM changelog_entries e ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.deployed_at DESC, e.id DESC LIMIT ?`).all(...args, n + 1);
        const more = rows.length > n;
        const shown = rows.slice(0, n);
        return {
            entries: shown.map((e) => ({
                service: e.service, sha: e.sha, short: e.sha.slice(0, 7), subject: e.subject, author: e.author || null, committed_at: e.committed_at, deployed_at: e.deployed_at,
                major: Boolean(e.major), url: `https://github.com/${e.repo}/commit/${e.sha}`,
                post_id: e.post_id && e.post_id !== 'history' && e.post_state === 'published' ? e.post_id : null,
            })),
            next: more && shown.length ? encodeCursor(shown[shown.length - 1]) : null,
        };
    }
    async function entries(opts = {}) { return (await page(opts)).entries; }
    async function latestPost() { return await q.lastPost.get() || null; }
    async function recentPosts(limit = 5) { return await q.recentPosts.all(Math.min(Math.max(parseInt(limit, 10) || 5, 1), 20)); }
    /** Every site with entries: [{ service, entries, latest_at }], most recently shipped first. */
    async function sites() { return await q.sites.all(); }

    return { tick, collect, due, fileDraft, enrich, pendingEntries, markEntries, openPulls, start, stop, entries, page, latestPost, recentPosts, sites, importHistory, stats: async () => ({ enabled: c.enabled, ...stats, github_token: cachedToken.source, pending: (await q.pending.all()).length }) };
}

/** A stable id for a batch (tests). */
function batchKey(list) { return crypto.createHash('sha256').update(list.map((e) => `${e.service}:${e.sha}`).join(',')).digest('hex').slice(0, 16); }

module.exports = { createChangelog, subjectOf, ensureSchema, batchKey, encodeCursor, decodeCursor };
