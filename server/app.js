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
const { createAuthClient, createAuthRoutes } = require('./auth/sso');
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
const { createBlogOutbox } = require('./events/outbox');
const { createPublicRoutes } = require('./http/public');
const { createEditorRoutes } = require('./http/editor');
const { createApi } = require('./http/api');
const { createDiscoveryRoutes } = require('./http/discovery');
const { createBlogReadiness } = require('./observability');
const { createWorker } = require('./worker');
const { assetVersion } = require('./render/layout');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

/**
 * opts: config, store | dbPath, now (clock), fetchImpl, auth (a createAuthClient-like object),
 *       entitlementCheck ({ subject, key, blog, post }) → bool (replaces VIP), log
 */
function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const store = opts.store || openStore(opts.dbPath || config.dbPath, { now: opts.now });

    const outbox = createBlogOutbox({ db: store.db, config, fetchImpl, now: store.now, log });
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
    const auth = opts.auth || createAuthClient(config);
    const viewers = createViewerResolver({ auth, config, people });
    const worker = createWorker({ config, store, posts, media, outbox, log });
    blogs.ensureOfficial();

    const aiDrafts = opts.aiDrafts || require('./domain/ai-drafts').createAiDrafts({ config, store, posts, access, fetchImpl });
    const changelog = opts.changelog || require('./changelog').createChangelog({ config, store, blogs, posts, aiDrafts, fetchImpl, log });
    const ctx = { config, store, outbox, blogs, publication, posts, people, community, media, reading, effects, entitlements, vip, auth, viewers, access, worker, aiDrafts, changelog };

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'blog', root: path.join(__dirname, '..') });
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'blog', release: release.release });
    app.locals.metrics = metrics.registry;
    app.locals.ctx = ctx;

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The shared chrome (theme-loader, navbar) comes from the Network; the inline init is ours.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                // Media objects are served by openvibe.media (which may redirect to object storage).
                imgSrc: ["'self'", 'data:', 'https:'],
                mediaSrc: ["'self'", 'https:'],
                connectSrc: ["'self'", 'https://openvibe.network'],
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
    const readiness = createBlogReadiness({ store, auth, outbox, release: release.release });
    app.get('/api/ready', readiness.handler);

    // ── Sign-in (OAuth2 client of OpenVibe.Network) ─────────
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', createAuthRoutes(config, auth));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'blog', service: 'blog', host: 'openvibe.blog', name: 'OpenVibe.Blog', profile: 'ugc' })); }

    // ── Static assets (content-hashed ?v= → immutable) ──────
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
