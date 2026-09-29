'use strict';

/**
 * OpenVibe.Blog — Express app factory. server/index.js listens and starts the worker; tests build
 * their own instance with a temp database, an injectable clock and mock neighbours.
 *
 *   Pages (server-rendered, http/public.js)   Editor (forms, http/editor.js)   API (http/api.js)
 *   Discovery (robots, llms, sitemaps)         /auth/* (Network SSO)            /api/health, /api/ready,
 *                                                                               /release.json, /metrics
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');

const configLib = require('./config');
const { openStore } = require('./db');
const { createSsoClient, claimsToUser } = require('openvibe-sdk/sso');
const { jwksClient } = require('openvibe-sdk/auth');
const { createViewerResolver } = require('./auth/viewer');
const access = require('./domain/access');
const { createBlogs } = require('./domain/blogs');
const { createPublication } = require('./domain/publication');
const { createPosts } = require('./domain/posts');
const { createReading } = require('./domain/reading');
const { createEffects } = require('./domain/effects');
const { createPeople } = require('./clients/network');
const { createCommunity } = require('./clients/community');
const { createMedia } = require('./clients/media');
const { createVip } = require('./clients/vip');
const { createServiceOutbox } = require('openvibe-sdk/events');
const { createPublicRoutes } = require('./http/public');
const { createEditorRoutes } = require('./http/editor');
const { createApi } = require('./http/api');
const { createDiscoveryRoutes } = require('./http/discovery');
const { createActorLimits } = require('./http/actor-limits');
const { createBlogReadiness } = require('./observability');
const { createWorker } = require('./worker');
const { assetVersion } = require('./render/layout');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

/**
 * opts: config, store, now (clock), fetchImpl, auth (an openvibe-sdk/sso client-like object),
 *       entitlementCheck ({ subject, key, blog, post }) → bool (replaces VIP), log,
 *       limitsNow (the per-actor limiter's clock, tests)
 */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test, a script) hands in a store.
    const store = opts.store || await openStore(config, { now: opts.now, log });

    // Service outbox (openvibe-sdk/events): rows join the change's own transaction; the relay publishes
    // with Blog's service token when EVENTS_URL and the client secret are set, else rows wait in event_outbox.
    const outbox = createServiceOutbox({
        db: store.db, source: 'blog', eventsUrl: config.events.url, networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, intervalMs: config.events.intervalMs,
        now: store.now, fetch: fetchImpl, log,
    });
    const blogs = createBlogs({ store, config });
    const publication = createPublication({ store, config, outbox });
    const posts = createPosts({ store, blogs, publication, access, outbox, log });
    const people = createPeople({ store, config, fetchImpl });
    const community = createCommunity({ store, config, fetchImpl });
    const media = createMedia({ config, fetchImpl });
    const vip = createVip({ config, fetchImpl, now: store.now, log });
    const reading = createReading({ store, blogs, posts, publication, people, media, vip });
    const effects = createEffects({ outbox, community });
    const entitlements = access.createEntitlementChecker({ provider: config.entitlements.provider, check: opts.entitlementCheck, vip });
    // Sign-in with OpenVibe.Network (openvibe-sdk/sso): routes, cookies and offline verification in one call.
    const networkJwksUrl = `${config.networkInternalUrl}/api/.well-known/jwks`;
    const sso = createSsoClient({
        site: 'blog', baseUrl: config.baseUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        redirectUri: config.oauth.redirectUri, scope: config.oauth.scope, networkUrl: config.networkUrl,
        networkInternalUrl: config.networkInternalUrl, issuer: config.networkUrl, secureCookies: config.cookies.secure,
    });
    const auth = opts.auth || sso;
    // Warm the shared JWKS cache at boot (non-fatal if the Network is down).
    if (auth === sso) jwksClient(networkJwksUrl).keysForKid(null).catch(() => {});
    const viewers = createViewerResolver({ auth, config, people });
    const worker = createWorker({ config, store, posts, media, outbox, log });
    await blogs.ensureOfficial();

    const aiDrafts = opts.aiDrafts || require('./domain/ai-drafts').createAiDrafts({ config, store, posts, access, fetchImpl });
    const changelog = opts.changelog || require('./changelog').createChangelog({ config, store, blogs, posts, aiDrafts, fetchImpl, log });
    const ctx = { config, store, outbox, blogs, publication, posts, people, community, media, reading, effects, entitlements, vip, auth, viewers, access, worker, aiDrafts, changelog };

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'blog', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'blog', release: release.release });
    app.locals.metrics = metrics.registry;
    app.locals.ctx = ctx;
    // Per-actor limits (http/actor-limits.js) for the API, the editor and comment posts, counted once each
    // router resolved req.viewer; the per-address limits below stay.
    // Valkey (ADR-035): shared, never-authoritative state (per-actor limit counters). Optional.
    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;
    ctx.limits = createActorLimits({ config, now: opts.limitsNow || (() => Date.now()), registry: metrics.registry, log, valkey });

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The OpenVibe Frame (theme-loader, navbar, footer) comes from the Network; the inline init is ours.
                // Cloudflare Web Analytics: Cloudflare injects its beacon at the edge and the privacy text says it may
                // measure performance; script-src loads the beacon, connect-src is where it reports.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                // Media objects are served by openvibe.media (which may redirect to object storage).
                imgSrc: ["'self'", 'data:', 'https:'],
                mediaSrc: ["'self'", 'https:'],
                // events.openvibe.network: release notifications (release-watch's EventSource, openvibe-shared 1.17).
                connectSrc: ["'self'", 'https://openvibe.network', 'https://cloudflareinsights.com', 'https://events.openvibe.network'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    app.use(cookieParser());

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-blog', version: VERSION }));
    // GET /release.json (ADR-016) and POST /release-metrics: open tabs' update reports into /metrics.
    release.mount(app, { registry: metrics.registry });
    const readiness = createBlogReadiness({ store, auth, outbox, release: release.release, valkey: ctx.valkey, jwksUrl: networkJwksUrl });
    app.get('/api/ready', readiness.handler);

    // ── Sign-in (OAuth2 client of OpenVibe.Network) ─────────
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));
    // /auth/me: the shared navbar probes it on every page view, so a guest is a signed-out answer (200
    // { user: null }), not a 401. The SDK router's own /me answers 401 for an absent session; this route,
    // registered first, keeps Blog's contract and marks the answer private / no-store.
    app.get('/auth/me', async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        res.vary('Cookie');
        res.vary('Authorization');
        const token = auth.extractToken(req);
        if (!token) return res.json({ user: null });
        const claims = await auth.verify(token);
        if (!claims) return res.status(401).json({ error: 'Invalid or expired token' });
        return res.json({ user: claimsToUser(claims), expires_at: claims.exp ? claims.exp * 1000 : null });
    });
    app.use('/auth', sso.router(express));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'blog', service: 'blog', host: 'openvibe.blog', name: 'OpenVibe.Blog', profile: 'ugc' })); }

    // ── Static assets (content-hashed ?v= → immutable) ──────
    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', v && v === assetVersion(rel) ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
        },
    }));

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }), createApi(ctx));

    // ── Discovery, editor, public pages ─────────────────────
    app.use(createDiscoveryRoutes(ctx));
    const publicRoutes = createPublicRoutes(ctx);
    ctx.publicRoutes = publicRoutes;
    app.use('/write', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }), createEditorRoutes({ ...ctx, publicRoutes }));
    app.use(publicRoutes.router);
    app.use((req, res) => publicRoutes.notFound(req, res));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        log.error('[Blog]', err && err.stack ? err.stack : err);
        if (res.headersSent) return;
        res.set('Cache-Control', 'private, no-store');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
