'use strict';
/**
 * Draft with AI (roadmap W13, proof flow 5 on Blog): a member who may write on a blog asks
 * OpenVibe.AI's blog.draft_post workflow for a draft from a topic (and optionally a brief, tone and
 * audience). The answer becomes a new post that is AI-authored (openvibe-publishing/authorship mode
 * 'ai', naming the workflow and run), a draft, and noindex until a person reviews it; the run's
 * citations are attached to its first revision. The member is the acting subject (their blog, their
 * post); the text is never attributed to them as its writer.
 *
 * Uses openvibe-publishing/ai with Blog's service token (audience openvibe.ai, ai.run.create and
 * ai.run.read in the blog namespace). Off unless OV_AI_INTERNAL_URL and OV_OAUTH_CLIENT_SECRET are set.
 */
const { serviceAuth } = require('openvibe-contracts');
const { createAiClient, AiRunError } = require('openvibe-publishing/ai');
const { ApiError } = require('../http/errors');

const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

function createAiDrafts({ config, store, posts, access, fetchImpl = globalThis.fetch }) {
    const tokenClient = config.aiUrl && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.ai', scope: 'ai.run.create ai.run.read', fetchImpl,
    }) : null;
    const ai = createAiClient({ baseUrl: config.aiUrl, tokenClient, fetch: fetchImpl });

    async function draft(viewer, blog, input = {}, { traceparent } = {}) {
        if (!viewer || !viewer.subject) throw new ApiError(401, 'subject.required', 'Sign in to ask for an AI draft');
        if (!access.canWrite(store, viewer, blog, 'create')) throw new ApiError(403, 'blog.forbidden', 'You cannot write on this blog');
        const topic = clean(input.topic, 300);
        if (!topic) throw new ApiError(422, 'ai_draft.topic_required', 'Say what the post should be about');
        const brief = String(input.brief == null ? '' : input.brief).trim().slice(0, 4000);
        const tone = clean(input.tone, 200);
        const audience = clean(input.audience, 300);
        let r;
        try {
            r = await ai.run('blog.draft_post', { topic, ...(brief ? { brief } : {}), ...(tone ? { tone } : {}), ...(audience ? { audience } : {}) }, {
                onBehalfOf: { type: 'user', id: viewer.subject }, target: { service: 'blog', type: 'blog', id: String(blog.id) }, traceparent,
            });
        } catch (err) {
            if (err instanceof AiRunError) throw new ApiError(err.status || 502, err.code, err.message);
            throw err;
        }
        const out = r.output || {};
        const body = String(out.body_markdown || '').trim();
        if (!body) throw new ApiError(422, 'ai_draft.empty', `The AI run (${r.runId}) returned no text, so no draft was made`);
        const citations = (r.citations || []).filter((c) => c && (c.url || c.title)).map((c) => ({
            url: c.url || null, title: c.title || null, retrievedAt: c.retrieved_at || c.retrievedAt || null,
            quote: c.snippet ? { text: String(c.snippet).slice(0, 1000) } : null,
        }));
        // The member acts (their blog, their draft); the text is the AI's (authorship mode 'ai').
        const aiViewer = { kind: 'service', service: 'svc:ai', origin: 'ai', subject: viewer.subject };
        return posts.create(aiViewer, blog, {
            title: clean(out.title, 200) || topic,
            summary: clean(out.dek, 400) || null,
            body,
            tags: Array.isArray(out.tags) ? out.tags.map((t) => clean(t, 50)).filter(Boolean).slice(0, 5) : undefined,
            citations,
            authorship: { workflow: r.workflow, stubProvider: r.synthetic },
            message: `AI draft (blog.draft_post, run ${r.runId}) requested by ${viewer.subject}`,
        }, { traceparent });
    }

    return { enabled: ai.enabled, draft };
}

module.exports = { createAiDrafts };
