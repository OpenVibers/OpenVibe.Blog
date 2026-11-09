'use strict';
/**
 * The AI tagger for the network changelog (plan §9): one blog.changelog.tag run per batch of new
 * entries. The task is OpenVibe.AI's: its owner-chosen model (the cheapest good one by default)
 * answers kind, one to three areas and the plain words; Blog never names a model here.
 *
 * A service token with ai.run.create in the blog namespace starts the run, as itself (collection
 * is not a person's act). The run's answer is either the task workflow's { tags } or the general
 * ai.generate { text } holding the same JSON (the task's fallback while it names ai.generate).
 * Nothing here throws into collection: a missing or failed AI leaves the entries untagged for the
 * backfill (scripts/backfill-changelog-tags.js).
 */
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');
const { normalizeTag } = require('./tags');

const WAIT_MS = 20000;
const TIMEOUT_MS = 60000;
const POLL_MS = 1500;

function parseLoose(text) {
    const s = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    try { return JSON.parse(s); } catch {}
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
    return null;
}

/** { tags } from either workflow's output. */
function tagsFrom(output) {
    if (!output || typeof output !== 'object') return [];
    if (Array.isArray(output.tags)) return output.tags;
    const parsed = typeof output.text === 'string' ? parseLoose(output.text) : null;
    return parsed && Array.isArray(parsed.tags) ? parsed.tags : [];
}

function createChangelogTagger({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const tokenClient = config.aiUrl && config.oauth && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.ai', scope: 'ai.run.create ai.run.read', fetchImpl,
    }) : null;
    const enabled = Boolean(config.changelog && config.changelog.tag !== false && config.aiUrl && tokenClient);

    async function call(method, path, body, { retried = false } = {}) {
        const res = await fetchImpl(`${String(config.aiUrl).replace(/\/+$/, '')}${path}`, {
            method,
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokenClient.authHeaders()) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(WAIT_MS + 10000),
        });
        if (res.status === 401 && !retried && typeof tokenClient.invalidate === 'function') {
            tokenClient.invalidate();
            return call(method, path, body, { retried: true });
        }
        const json = await res.json().catch(() => ({}));
        return { status: res.status, ok: res.ok, body: json };
    }

    const runOf = (body) => (body && body.run ? body.run : body);

    async function run(body) {
        const started = await call('POST', `/api/v1/runs?wait=${WAIT_MS}`, body);
        // Older AI (before tasks and choices) refuses a task: the same workflow by name still runs.
        if (!started.ok && body.task && [404, 422].includes(started.status)
            && /task|workflow/i.test(`${started.body.code || ''} ${started.body.detail || ''}`)) {
            const { task, ...rest } = body;
            return { ...(await call('POST', `/api/v1/runs?wait=${WAIT_MS}`, { ...rest, workflow: 'blog.changelog.tag' })), workflowFallback: true };
        }
        if (!started.ok) throw Object.assign(new Error(`AI refused the run (${started.body.code || started.status})`), { status: started.status });
        let run = runOf(started.body);
        const deadline = Date.now() + TIMEOUT_MS;
        while (run && (run.status === 'queued' || run.status === 'running')) {
            if (Date.now() > deadline) throw Object.assign(new Error(`run ${run.id} did not finish`), { status: 504 });
            await new Promise((ok) => setTimeout(ok, POLL_MS));
            const got = await call('GET', `/api/v1/runs/${encodeURIComponent(run.id)}`);
            if (!got.ok) throw Object.assign(new Error(`reading run ${run.id} failed (${got.status})`), { status: got.status });
            run = runOf(got.body);
        }
        if (!run || !['succeeded', 'cached'].includes(run.status)) {
            throw Object.assign(new Error(`run ${run && run.id} ${run && run.status}`), { status: 502 });
        }
        return { output: run.output || {}, workflow: run.workflow || null, runId: run.id };
    }

    /**
     * Tag these entries: [{ id, service, subject, repo, plain }] → Map(id → { kind, areas, plain }).
     * One run for the whole batch (at most the caller's slice). Rejects on failure so the caller
     * can log it; the entries stay untagged.
     */
    async function tag(entries) {
        if (!enabled || !entries.length) return new Map();
        const input = {
            entries: entries.slice(0, 25).map((e) => ({ id: String(e.id), service: e.service, subject: e.subject, ...(e.repo ? { repo: e.repo } : {}), ...(e.plain ? { plain: e.plain } : {}) })),
        };
        const idempotency = crypto.createHash('sha256').update(input.entries.map((e) => `${e.service}:${e.id}`).join(',')).digest('hex');
        const answer = await run({
            task: 'blog.changelog.tag', input,
            target: { service: 'blog', type: 'changelog', id: 'network' },
            idempotency_key: `changelog-tags:${idempotency}`,
        });
        const out = new Map();
        for (const t of tagsFrom(answer.output)) {
            const safe = normalizeTag(t);
            if (safe && input.entries.some((e) => e.id === String(t.id))) out.set(String(t.id), safe);
        }
        if (answer.workflowFallback) log.warn && log.warn('[changelog] AI does not know the blog.changelog.tag task yet; ran the workflow by name');
        return out;
    }

    return { enabled, tag };
}

module.exports = { createChangelogTagger, tagsFrom, parseLoose };
