'use strict';

/**
 * OpenVibe.Blog configuration. Every value comes from the environment (production:
 * /etc/openvibe/blog.env, see .env.example). Only environment variable NAMES appear in code and
 * docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();

const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4810);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.blog' : `http://localhost:${port}`));

    return {
        service: 'blog',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        // Public origin: canonical URLs, feeds, sitemaps and JSON-LD are built from it.
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,

        dbPath: env.BLOG_DB_PATH || './data/blog.db',

        // OpenVibe.Network: SSO (OAuth2 authorization server), JWKS, client-credentials tokens.
        networkUrl: trim(env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        // The network changelog and its patch notes (server/changelog.js).
        changelog: {
            enabled: env.CHANGELOG !== 'off',
            networkUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
            githubToken: env.CHANGELOG_GITHUB_TOKEN || '',
            blogHandle: String(env.CHANGELOG_BLOG || 'openvibe').toLowerCase(),
            batchSize: Math.max(5, parseInt(env.CHANGELOG_BATCH_SIZE, 10) || 40),
            majorLines: Math.max(50, parseInt(env.CHANGELOG_MAJOR_LINES, 10) || 800),
            quietMs: Math.max(0, parseInt(env.CHANGELOG_QUIET_MS, 10) || 30 * 60 * 1000),
            maxAgeMs: Math.max(0, parseInt(env.CHANGELOG_MAX_AGE_MS, 10) || 7 * 24 * 3600 * 1000),
            minGapMs: Math.max(0, parseInt(env.CHANGELOG_MIN_GAP_MS, 10) || 6 * 3600 * 1000),
            intervalMs: Math.max(60 * 1000, parseInt(env.CHANGELOG_INTERVAL_MS, 10) || 5 * 60 * 1000),
            history: Math.max(0, Math.min(100, parseInt(env.CHANGELOG_HISTORY ?? '60', 10) || 0)),
            firstDelayMs: 60 * 1000,
            since: env.CHANGELOG_SINCE && !Number.isNaN(Date.parse(env.CHANGELOG_SINCE)) ? new Date(env.CHANGELOG_SINCE).toISOString() : null,
            aiDraft: env.CHANGELOG_AI_DRAFT !== 'off',
        },
        // OpenVibe.AI for "Draft with AI" (server/domain/ai-drafts.js); empty = the button is not offered.
        aiUrl: trim(env.OV_AI_INTERNAL_URL || ''),
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'blog',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile theme',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },
        // Signs the per-session form token (CSRF). Unset: a random per-process key (forms opened
        // before a restart must be re-submitted).
        formSecret: env.BLOG_FORM_SECRET || '',

        // The official blog (served at /). Its owners are Network subjects (usr_…); Network
        // admins may also edit it (staff).
        official: {
            handle: 'openvibe',
            title: env.BLOG_OFFICIAL_TITLE || 'The OpenVibe blog',
            description: env.BLOG_OFFICIAL_DESCRIPTION || 'News and release notes from the OpenVibe network.',
            owners: list(env.BLOG_OFFICIAL_OWNERS),
        },

        // OpenVibe.Media: attachments are Media object ids; bytes are served by Media.
        media: {
            publicUrl: trim(env.OV_MEDIA_URL || 'https://openvibe.media'),
            internalUrl: trim(env.OV_MEDIA_INTERNAL_URL || 'http://127.0.0.1:4100'),
            // The Media tenant (namespace) Blog's objects live in; media.object.read is granted for it.
            app: env.BLOG_MEDIA_APP || 'blog',
            verifyIntervalMs: int(env.BLOG_MEDIA_VERIFY_INTERVAL_MS, 10 * 60 * 1000),
        },

        // OpenVibe.Community: comment threads (referenced by id, never copied).
        community: {
            publicUrl: trim(env.OV_COMMUNITY_URL || 'https://openvibe.community'),
            internalUrl: trim(env.OV_COMMUNITY_INTERNAL_URL || 'http://127.0.0.1:4200'),
        },

        // OpenVibe.Events: the outbox relay runs only when EVENTS_URL and the client secret are set.
        events: {
            url: trim(env.EVENTS_URL || ''),
            intervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
        },

        // Scheduled publication worker.
        worker: {
            enabled: env.BLOG_WORKER !== 'off',
            intervalMs: int(env.BLOG_SCHEDULE_INTERVAL_MS, 15000),
            id: env.BLOG_WORKER_ID || `blog-${process.pid}`,
        },

        // Entitlement checks for members-only posts. 'vip' (the default when Blog has a client secret):
        // OpenVibe.VIP decides (policies/evaluate with the blog owner as owner and the product's default
        // gate { member, blog:gated_post }), through a cache. 'none' (the default without a secret):
        // nobody outside the blog's members and staff reads a members-only post. Both fail closed.
        entitlements: { provider: env.BLOG_ENTITLEMENTS_PROVIDER || (env.OV_OAUTH_CLIENT_SECRET ? 'vip' : 'none') },

        // OpenVibe.VIP: the service Blog asks (loopback) and the public site readers join on. A cached
        // "yes" lives BLOG_VIP_CACHE_TTL_MS at most — the bound on how long Blog keeps admitting a
        // reader after VIP stops (README, "Members-only posts").
        vip: {
            internalUrl: trim(env.OV_VIP_INTERNAL_URL || 'http://127.0.0.1:4620'),
            publicUrl: trim(env.OV_VIP_URL || 'https://openvibe.vip'),
            timeoutMs: int(env.BLOG_VIP_TIMEOUT_MS, 2000),
            ttlMs: int(env.BLOG_VIP_CACHE_TTL_MS, 30_000),
            denyTtlMs: int(env.BLOG_VIP_CACHE_DENY_TTL_MS, 10_000),
            unavailableTtlMs: int(env.BLOG_VIP_CACHE_UNAVAILABLE_TTL_MS, 2_000),
        },

        // Browser origins that may call /api/v1 with a Bearer Network JWT (no cookies cross origins).
        apiCorsOrigins: list(env.API_CORS_ORIGINS || 'https://openvibe.network,https://openvibe.live,https://openvibe.community,https://openvibe.media'),
    };
}

module.exports = { load };
