'use strict';
/**
 * OpenAPI 3.1 for OpenVibe.Blog's JSON API, from the route table below.
 *
 * ROUTES is the table: every entry is one method on one path under /api/v1, with the operation the
 * router serves. server/http/api.js mounts exactly these, and test/openapi.test.js walks the mounted
 * router and fails when the two differ in either direction — so the document can never advertise an
 * address this service does not answer.
 *
 *   GET /openapi.json           this document (public, Cache-Control 5 minutes)
 *   GET /api/v1/openapi.json    308 to /openapi.json
 *
 * Request fields come from what the handlers read out of the body (http/api.js) and what the domain
 * validates (domain/posts.js, domain/blogs.js); response properties are the DTOs' output.
 */
const pkg = require('../../package.json');

const MOUNT = '/api/v1';
const SITE = 'https://openvibe.blog';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (extra = {}) => ({ type: 'string', ...extra });
const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });
const arrayOf = (items) => ({ type: 'array', items });

const problem = {
    description: 'A problem (RFC 9457, application/problem+json): type, title, status and a stable code',
    content: {
        'application/problem+json': {
            schema: {
                type: 'object',
                required: ['type', 'title', 'status'],
                properties: { type: str(), title: str(), status: { type: 'integer' }, code: str(), detail: str(), request_id: str() },
            },
        },
    },
};
const errors = (codes = [400, 401, 403, 404, 409, 413, 422, 428, 429]) => ({
    ...Object.fromEntries(codes.map((code) => [code, problem])),
    default: problem,
});

const path = (name, schema, description) => ({ name, in: 'path', required: true, schema, ...(description && { description }) });
const query = (name, schema, description) => ({ name, in: 'query', required: false, schema, ...(description && { description }) });

const HANDLE = path('handle', str({ pattern: '^[a-z0-9-]{2,40}$' }), 'The blog handle');
const POST = path('id', { type: 'string', pattern: '^pst_[0-9A-HJKMNP-TV-Z]{26}$' }, 'The post id');
const REVISION = path('n', { type: 'integer', minimum: 1 }, 'The revision number');
const SUBJECT = path('subject', { type: 'string', pattern: '^usr_[0-9A-HJKMNP-TV-Z]{26}$' }, 'The person (usr_ id)');
const ATTACHMENT = path('aid', str(), 'The attachment id');

const ANONYMOUS = [{}];
const PERSON = [{ bearer: [] }, { cookie: [] }];

const json = (description, schema) => ({ description, ...(schema ? { content: { 'application/json': { schema } } } : {}) });
const body = (schema, required = true) => ({ required, content: { 'application/json': { schema } } });

const citation = { type: 'object', properties: {
    url: nullable('string'), title: nullable('string'), retrieved_at: nullable('string', { format: 'date-time' }),
    quote: nullable('string'), license_note: nullable('string'),
} };
const visibility = { type: 'string', enum: ['public', 'unlisted', 'members', 'private'], default: 'public' };

const PATHS = {};
function route(method, p, operation) {
    (PATHS[p] = PATHS[p] || {})[method] = operation;
}

route('get', '/blogs/{handle}', {
    operationId: 'getBlog', summary: 'One blog', tags: ['blogs'], security: ANONYMOUS, parameters: [HANDLE],
    description: 'A member of the blog (or Network staff) also sees its status, owner and feed settings.',
    responses: { 200: json('The blog', { type: 'object', required: ['blog'], properties: { blog: ref('Blog') } }), ...errors([400, 404, 429]) },
});
route('post', '/blogs', {
    operationId: 'ensureBlog', summary: 'Get or create the acting member\'s blog', tags: ['blogs'], security: PERSON,
    description: 'blog.blog.create. Idempotent: 201 when it created the blog, 200 when it already existed.',
    requestBody: body({ type: 'object', properties: { handle: str({ pattern: '^[a-z0-9-]{2,40}$' }), title: str({ maxLength: 200 }), description: str({ maxLength: 1000 }) } }, false),
    responses: { 200: json('The existing blog', { type: 'object', properties: { blog: ref('Blog'), created: { const: false } } }),
        201: json('The new blog', { type: 'object', properties: { blog: ref('Blog'), created: { const: true } } }), ...errors() },
});
route('patch', '/blogs/{handle}', {
    operationId: 'configureBlog', summary: 'Change a blog\'s title, description, language or feeds', tags: ['blogs'], security: PERSON, parameters: [HANDLE],
    description: 'blog.blog.configure. Owners only.',
    requestBody: body({ type: 'object', properties: {
        title: str({ maxLength: 200 }), description: str({ maxLength: 1000 }), language: str(),
        feeds: { type: 'object', properties: { rss: { type: 'boolean' }, atom: { type: 'boolean' }, json: { type: 'boolean' }, item_count: { type: 'integer', minimum: 1 }, full_content: { type: 'boolean' } } },
    } }),
    responses: { 200: json('The blog', { type: 'object', properties: { blog: ref('Blog') } }), ...errors() },
});
route('put', '/blogs/{handle}/theme', {
    operationId: 'setBlogTheme', summary: 'Set the blog\'s theme preset', tags: ['blogs'], security: PERSON, parameters: [HANDLE],
    description: 'blog.theme.set.',
    requestBody: body({ type: 'object', required: ['theme'], properties: { theme: { type: 'string', enum: ['vibe', 'paper', 'slate', 'sand', 'nord', 'high-contrast'] } } }),
    responses: { 200: json('The blog and every preset', { type: 'object', properties: { blog: ref('Blog'), themes: arrayOf(str()) } }), ...errors() },
});
route('get', '/blogs/{handle}/members', {
    operationId: 'listBlogMembers', summary: 'A blog\'s members', tags: ['members'], security: PERSON, parameters: [HANDLE],
    description: 'blog.member.manage. Owners only.',
    responses: { 200: json('The members', { type: 'object', properties: { members: arrayOf(ref('Member')) } }), ...errors([400, 401, 403, 404, 429]) },
});
route('put', '/blogs/{handle}/members/{subject}', {
    operationId: 'setBlogMember', summary: 'Set a person\'s role on a blog', tags: ['members'], security: PERSON, parameters: [HANDLE, SUBJECT],
    description: 'blog.member.manage. Owners only.',
    requestBody: body({ type: 'object', required: ['role'], properties: { role: { type: ['string', 'null'], enum: ['owner', 'editor', 'author', null] } } }),
    responses: { 200: json('The member', { type: 'object', properties: { member: ref('Member') } }), ...errors() },
});
route('delete', '/blogs/{handle}/members/{subject}', {
    operationId: 'removeBlogMember', summary: 'Remove a person from a blog', tags: ['members'], security: PERSON, parameters: [HANDLE, SUBJECT],
    description: 'blog.member.manage. Owners only.',
    responses: { 200: json('Whether a role was removed', { type: 'object', properties: { removed: { type: 'boolean' } } }), ...errors() },
});
route('get', '/blogs/{handle}/posts', {
    operationId: 'listBlogPosts', summary: 'A blog\'s posts (published, or every draft with ?all=1 for a member)', tags: ['posts'], security: ANONYMOUS, parameters: [HANDLE,
        query('limit', { type: 'integer', minimum: 1, maximum: 100, default: 20 }), query('offset', { type: 'integer', minimum: 0, maximum: 100000 }),
        query('all', { type: 'string', enum: ['1'] }, 'Every state: members only, and a service token needs blog.post.read')],
    responses: { 200: json('Posts, newest first', { type: 'object', properties: { total: { type: 'integer' }, posts: arrayOf(ref('Post')) } }), ...errors([400, 403, 404, 429]) },
});
route('get', '/changelog', {
    operationId: 'getChangelog', summary: 'What shipped on every OpenVibe site, newest first', tags: ['changelog'], security: ANONYMOUS, parameters: [
        query('service', str({ pattern: '^[a-z][a-z0-9-]{1,39}$' }), 'Only this service\'s entries (default: every site)'),
        query('limit', { type: 'integer', minimum: 1 }), query('before', str(), 'The cursor from the previous page')],
    description: 'Public and CORS *, cached 60 seconds: each site\'s "recently shipped" reads it.',
    responses: { 200: json('Entries, the cursor for the next page and the latest patch notes post', { type: 'object', properties: {
        service: nullable('string'), entries: arrayOf({ type: 'object' }), next: nullable('string'),
        latest_post: nullable('object'), posts: arrayOf({ type: 'object' }), sites: arrayOf({ type: 'object' }),
    } }), ...errors([400, 429]) },
});
route('post', '/blogs/{handle}/posts/ai-draft', {
    operationId: 'draftPostWithAi', summary: 'Have OpenVibe.AI write a draft', tags: ['posts'], security: PERSON, parameters: [HANDLE],
    description: 'blog.post.create. The draft is AI-authored and cannot publish until a person reviews it; 503 when AI drafting is not configured here.',
    requestBody: body({ type: 'object', required: ['topic'], properties: {
        topic: str({ maxLength: 300 }), brief: str({ maxLength: 4000 }), tone: str({ maxLength: 200 }), audience: str({ maxLength: 300 }),
    } }),
    responses: { 201: json('The draft and its revision number', { type: 'object', properties: { post: ref('Post'), revision: { type: 'integer' } } }), 503: problem, ...errors() },
});
route('post', '/blogs/{handle}/posts', {
    operationId: 'createPost', summary: 'Create a post (a draft)', tags: ['posts'], security: PERSON, parameters: [HANDLE],
    description: 'blog.post.create. X-OV-Origin: ai marks the revision AI-authored (it then needs a review before publishing).',
    requestBody: body({ type: 'object', required: ['title'], properties: {
        title: str({ maxLength: 200 }), body: str({ maxLength: 200000, description: 'Markdown' }), summary: str({ maxLength: 500 }),
        slug: str({ pattern: '^[a-z0-9][a-z0-9-]{0,79}$' }), visibility,
        entitlement_key: str({ pattern: '^[a-z][a-z0-9_.:-]{0,127}$', description: 'Only for visibility members' }),
        tags: arrayOf(str({ maxLength: 50 })), categories: arrayOf(str()), series: nullable('string'), series_position: nullable('integer', { minimum: 1 }),
        allow_comments: { type: 'boolean' }, noindex: { type: 'boolean' }, citations: arrayOf(citation), message: str(),
    } }),
    responses: { 201: json('The post and its revision number', { type: 'object', properties: { post: ref('Post'), revision: { type: 'integer' } } }), ...errors() },
});
route('get', '/blogs/{handle}/feed', {
    operationId: 'getBlogFeed', summary: 'The blog\'s JSON Feed', tags: ['feeds'], security: ANONYMOUS, parameters: [HANDLE],
    description: 'blog.feed.read. Public posts only, per the blog\'s feed settings; JSON Feed 1.1.',
    responses: { 200: { description: 'The feed (application/feed+json)', content: { 'application/feed+json': { schema: { type: 'object' } } } }, ...errors([404, 429]) },
});
route('get', '/posts/{id}', {
    operationId: 'getPost', summary: 'One post', tags: ['posts'], security: ANONYMOUS, parameters: [POST],
    description: 'blog.post.read. A member sees the full post; a reader of a members-only post gets 403 with a teaser.',
    responses: { 200: json('The post', { type: 'object', properties: { post: ref('Post') } }), 403: problem, ...errors([400, 404, 429]) },
});
route('patch', '/posts/{id}', {
    operationId: 'updatePost', summary: 'Edit a post: a new revision, or the row (slug, visibility, terms, flags)', tags: ['posts'], security: PERSON, parameters: [POST],
    description: 'blog.post.update. Any content change needs expected_revision (428 without it; 412 when it is stale).',
    requestBody: body({ type: 'object', properties: {
        expected_revision: { type: 'integer', minimum: 0 }, title: str({ maxLength: 200 }), body: str({ maxLength: 200000 }), summary: str({ maxLength: 500 }),
        slug: str({ pattern: '^[a-z0-9][a-z0-9-]{0,79}$' }), visibility, entitlement_key: str(),
        tags: arrayOf(str()), categories: arrayOf(str()), series: nullable('string'), series_position: nullable('integer'),
        allow_comments: { type: 'boolean' }, noindex: { type: 'boolean' }, citations: arrayOf(citation), message: str(),
    } }),
    responses: { 200: json('The post, the revision and whether one was created', { type: 'object', properties: { post: ref('Post'), revision: { type: 'integer' }, created: { type: 'boolean' } } }), ...errors([412]) },
});
route('post', '/posts/{id}/publish', {
    operationId: 'publishPost', summary: 'Publish a post (its head, or a named revision)', tags: ['posts'], security: PERSON, parameters: [POST],
    description: 'blog.post.publish. An AI-authored revision needs a person\'s review first (409 post.review_required).',
    requestBody: body({ type: 'object', properties: { revision: { type: 'integer', minimum: 1 } } }, false),
    responses: { 200: json('The post and whether this call changed it', { type: 'object', properties: { post: ref('Post'), changed: { type: 'boolean' } } }), ...errors() },
});
route('post', '/posts/{id}/schedule', {
    operationId: 'schedulePost', summary: 'Schedule a publish or an unpublish', tags: ['posts'], security: PERSON, parameters: [POST],
    description: 'blog.post.schedule. Idempotent: the same (post, action, time, revision) is one job.',
    requestBody: body({ type: 'object', required: ['at'], properties: {
        at: str({ format: 'date-time' }), revision: { type: 'integer', minimum: 1 }, action: { type: 'string', enum: ['publish', 'unpublish'], default: 'publish' },
    } }),
    responses: { 201: json('The job and the post', { type: 'object', properties: { job: { type: 'object' }, created: { type: 'boolean' }, post: ref('Post') } }), ...errors() },
});
route('delete', '/posts/{id}/schedule', {
    operationId: 'cancelScheduledPost', summary: 'Cancel a post\'s pending schedule', tags: ['posts'], security: PERSON, parameters: [POST],
    description: 'blog.post.schedule.',
    responses: { 200: json('Whether a job was cancelled', { type: 'object', properties: { cancelled: { type: 'boolean' }, post: ref('Post') } }), ...errors() },
});
route('post', '/posts/{id}/unpublish', {
    operationId: 'unpublishPost', summary: 'Unpublish a post', tags: ['posts'], security: PERSON, parameters: [POST],
    description: 'blog.post.unpublish.',
    responses: { 200: json('The post and whether this call changed it', { type: 'object', properties: { post: ref('Post'), changed: { type: 'boolean' } } }), ...errors() },
});
route('delete', '/posts/{id}', {
    operationId: 'deletePost', summary: 'Delete a post', tags: ['posts'], security: PERSON, parameters: [POST],
    description: 'blog.post.delete.',
    responses: { 200: json('What was deleted', { type: 'object', properties: { deleted: { const: true }, id: str() } }), ...errors() },
});
route('post', '/posts/{id}/revert', {
    operationId: 'revertPost', summary: 'Revert a post to an earlier revision', tags: ['revisions'], security: PERSON, parameters: [POST],
    description: 'blog.post.update. The revert is a new revision, not a rewrite of history.',
    requestBody: body({ type: 'object', required: ['to_revision', 'expected_revision'], properties: {
        to_revision: { type: 'integer', minimum: 1 }, expected_revision: { type: 'integer', minimum: 0 },
    } }),
    responses: { 201: json('The revert revision and the post', { type: 'object', properties: { revision: { type: 'integer' }, post: ref('Post') } }), ...errors() },
});
route('post', '/posts/{id}/reviews', {
    operationId: 'reviewPostRevision', summary: 'Approve or reject an AI-authored revision', tags: ['revisions'], security: PERSON, parameters: [POST],
    description: 'People only. An approved revision may then publish.',
    requestBody: body({ type: 'object', required: ['revision', 'decision'], properties: {
        revision: { type: 'integer', minimum: 1 }, decision: { type: 'string', enum: ['approved', 'rejected'] }, note: nullable('string'),
    } }),
    responses: { 201: json('The review', { type: 'object', properties: { review: { type: 'object' } } }), ...errors() },
});
route('post', '/posts/{id}/attachments', {
    operationId: 'attachMedia', summary: 'Attach an OpenVibe.Media object to a post', tags: ['media'], security: PERSON, parameters: [POST],
    description: 'blog.post.update. Attaching the same object twice updates its role, alt, caption and position instead.',
    requestBody: body({ type: 'object', required: ['media_id'], properties: {
        media_id: str(), role: { type: 'string', enum: ['cover', 'inline', 'gallery'], default: 'inline' },
        alt: nullable('string'), caption: nullable('string'), position: { type: 'integer', minimum: 0, default: 0 },
    } }),
    responses: { 201: json('The attachment', { type: 'object', properties: { attachment: { type: 'object' } } }), ...errors() },
});
route('delete', '/posts/{id}/attachments/{aid}', {
    operationId: 'detachMedia', summary: 'Remove an attachment from a post', tags: ['media'], security: PERSON, parameters: [POST, ATTACHMENT],
    description: 'blog.post.update.',
    responses: { 200: json('Whether an attachment was removed', { type: 'object', properties: { removed: { type: 'boolean' } } }), ...errors() },
});
route('get', '/posts/{id}/revisions', {
    operationId: 'listRevisions', summary: 'A post\'s revision history (no bodies)', tags: ['revisions'], security: PERSON, parameters: [POST,
        query('limit', { type: 'integer', minimum: 1 }), query('before', { type: 'integer', minimum: 1 }, 'The cursor: the newest revision to return')],
    description: 'blog.post.read, and writers or staff only.',
    responses: { 200: json('Revisions with their content length', { type: 'object', properties: { revisions: arrayOf({ type: 'object' }) } }), ...errors([400, 401, 403, 404, 429]) },
});
route('get', '/posts/{id}/revisions/{n}', {
    operationId: 'getRevision', summary: 'One revision of a post, with its citations', tags: ['revisions'], security: PERSON, parameters: [POST, REVISION],
    description: 'blog.post.read, and writers or staff only.',
    responses: { 200: json('The revision and its citations', { type: 'object', properties: { revision: { type: 'object' }, citations: arrayOf(citation) } }), ...errors([400, 401, 403, 404, 429]) },
});
route('get', '/posts/{id}/diff', {
    operationId: 'diffRevisions', summary: 'The diff between two revisions', tags: ['revisions'], security: PERSON, parameters: [POST,
        query('from', { type: 'integer', minimum: 1 }, 'Required'), query('to', { type: 'integer', minimum: 1 }, 'Required'),
        query('mode', { type: 'string', enum: ['word', 'line'] })],
    description: 'blog.post.read, and writers or staff only.',
    responses: { 200: json('{ diff }', { type: 'object', properties: { diff: { type: 'object' } } }), ...errors([400, 401, 403, 404, 429]) },
});

function openapi() {
    return {
        openapi: '3.1.0',
        info: {
            title: 'OpenVibe.Blog API',
            version: pkg.version,
            description: pkg.description,
            license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
            contact: { name: 'OpenVibers', url: 'https://github.com/OpenVibers/OpenVibe.Blog', email: 'contact@openvibe.network' },
        },
        servers: [{ url: SITE }],
        tags: ['blogs', 'posts', 'revisions', 'members', 'media', 'feeds', 'changelog'].map((name) => ({ name })),
        components: {
            securitySchemes: {
                bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A Network user JWT (people) or a service token for audience openvibe.blog carrying the route\'s capability, acting for the person named in X-OV-Subject' },
                cookie: { type: 'apiKey', in: 'cookie', name: 'ov_token', description: 'The browser session: the same Network user JWT as a host-only cookie' },
            },
            schemas: {
                Blog: { type: 'object', required: ['id', 'handle', 'title'], properties: {
                    id: str({ pattern: '^blg_' }), kind: str(), handle: str(), title: str(), description: nullable('string'), url: str(),
                    theme: str(), language: str(), feeds: arrayOf({ type: 'object', properties: { type: str(), url: str() } }),
                    status: str({ description: 'Active blogs only are readable; members also see it' }),
                    owner_subject: nullable('string'), feed_settings: { type: 'object' },
                } },
                Post: { type: 'object', required: ['id', 'blog', 'slug', 'state'], properties: {
                    id: str({ pattern: '^pst_' }), blog: { type: 'object', properties: { id: str(), handle: str() } }, slug: str(), url: str(),
                    state: { type: 'string', enum: ['draft', 'scheduled', 'published', 'unpublished', 'deleted'] },
                    visibility: { type: 'string', enum: ['public', 'unlisted', 'members', 'private'] },
                    author_subject: nullable('string'), title: nullable('string'), summary: nullable('string'),
                    revision: nullable('integer'), published_revision: nullable('integer'),
                    first_published_at: nullable('string', { format: 'date-time' }), published_at: nullable('string', { format: 'date-time' }),
                    tags: arrayOf(str()), categories: arrayOf(str()),
                    series: nullable('object', { properties: { id: str(), slug: str(), title: str(), position: nullable('integer') } }),
                    allow_comments: { type: 'boolean' }, noindex: { type: 'boolean' },
                    indexability: nullable('object', { properties: { indexable: { type: 'boolean' }, robots: nullable('string'), reasons: arrayOf(str()) } }),
                    entitlement_key: nullable('string'), body: nullable('string'), authorship: nullable('object'),
                    review: nullable('object'), scheduled: arrayOf({ type: 'object' }), attachments: arrayOf({ type: 'object' }),
                    citations: arrayOf(citation),
                } },
                Member: { type: 'object', properties: { subject: str(), role: str(), name: nullable('string'), username: nullable('string') } },
            },
        },
        paths: { ...Object.fromEntries(Object.entries(PATHS).map(([p, item]) => [MOUNT + p, item])) },
    };
}

/** The documented routes as "METHOD /api/v1/path": what the router must mount. */
function routes() {
    return Object.entries(PATHS).flatMap(([p, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${MOUNT}${p}`)).sort();
}

/** Serve GET /openapi.json here; GET /api/v1/openapi.json redirects to it (308). */
function mount(app, document = openapi()) {
    const send = (_req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.type('application/json; charset=utf-8').send(JSON.stringify(document));
    };
    app.get('/openapi.json', send);
    app.get('/api/v1/openapi.json', (_req, res) => res.redirect(308, '/openapi.json'));
}

module.exports = { openapi, routes, mount, MOUNT };
