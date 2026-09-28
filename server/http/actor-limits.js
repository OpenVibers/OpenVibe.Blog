'use strict';

/**
 * Per-actor rate limits on /api/v1, the editor and comment posts (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * The per-address limits in app.js (/api/v1 240 a minute, /write 120 a minute, sign-in) stay. These
 * count requests by who makes them, once req.viewer is resolved (auth/viewer.js):
 *
 *   a person                        user:usr_… (their own token or cookie, named by a service in
 *                                   X-OV-Subject, or an app's on_behalf_of)
 *   a first-party service relaying  ip:<address> of the signed-out visitor it forwards (X-Forwarded-For)
 *     a signed-out visitor
 *   a service or app acting as      its principal (svc:ai, app:app_…)
 *     itself
 *   a signed-out caller             ip:<address>
 *
 * A first-party service reading for itself (no person, no visitor) is not counted on reads: its
 * pages speak for all its visitors, and the per-address limit already bounds it. GET
 * /api/v1/changelog is not counted either: OpenVibe.Network reads it for every site's "shipped"
 * widget, from loopback and without a token, so it would count as one caller for the whole network
 * (Network caches each answer for 60 s; the per-address limit still applies).
 *
 * Past a limit the route answers 429 problem+json `rate_limited` with Retry-After before it does any
 * work (before the body is read); the refusal is logged once and counted in
 * blog_rate_limited_total{limit,window}. API reads get BLOG_LIMITS_MINUTE / BLOG_LIMITS_HOUR (120 and
 * 3000); every write has its own number below, shared by the API route and the editor form that do
 * the same thing. Counters live in this process: a restart forgets them.
 *
 * Never limited: /api/health, /api/ready, /release.json, /metrics, sign-in, and the pages and feeds
 * people read.
 */
const { createActorLimiter, defaultActor } = require('openvibe-sdk/limits');

const FIRST_PARTY = /^svc:/;
const LOOPBACK = /^(::1$|127\.|::ffff:127\.)/;

/** A first-party service that forwards the address of the signed-out visitor it acts for. */
function relaysVisitor(req) {
    const v = req.viewer;
    return !!(v && v.kind === 'service' && !v.subject && FIRST_PARTY.test(String(v.service)) && req.get('x-forwarded-for') && req.ip && !LOOPBACK.test(req.ip));
}

function actor(req) {
    const v = req.viewer;
    if (!v || v.kind === 'anonymous') return defaultActor(req);
    if (v.subject) return `user:${v.subject}`;
    if (v.kind === 'service') return relaysVisitor(req) ? `ip:${req.ip}` : v.service;
    return defaultActor(req);
}

/** A first-party service reading for itself: no person, no visitor. */
function serviceItself(req) {
    const v = req.viewer;
    return !!(v && v.kind === 'service' && !v.subject && FIRST_PARTY.test(String(v.service)) && !relaysVisitor(req));
}

/**
 * The writes and expensive reads, each with its numbers per caller (a minute, an hour). An editor
 * form and the API route that do the same thing share one budget.
 */
const BUDGETS = {
    // A member has one blog (get-or-create): a few tries at most.
    'blog.blog.create': { minute: 10, hour: 60 },
    // Title, description, feeds, theme and members: an owner saves a form now and then.
    'blog.blog.configure': { minute: 30, hour: 300 },
    'blog.member.manage': { minute: 30, hour: 300 },
    // A new draft, or a new revision of one (the whole text again): a writer saves every few seconds at
    // most, 30 a minute, and 300 new posts or 600 revisions an hour. A revert writes a revision too.
    'blog.post.create': { minute: 30, hour: 300 },
    'blog.post.update': { minute: 30, hour: 600 },
    // A draft written by OpenVibe.AI is a model run on the network's budget: 5 a minute, 30 an hour.
    'blog.post.ai_draft': { minute: 5, hour: 30 },
    // Publishing, scheduling, unpublishing and reviews change what readers, feeds, sitemaps and Search
    // see, and each emits events.
    'blog.post.publish': { minute: 30, hour: 300 },
    'blog.post.delete': { minute: 30, hour: 300 },
    // Attaching media asks OpenVibe.Media about the object.
    'blog.post.media': { minute: 20, hour: 200 },
    // A word diff of two long revisions costs CPU: a writer's pace, not a crawler's.
    'blog.post.diff': { minute: 30, hour: 600 },
    // A comment goes to OpenVibe.Community in the person's name (Community allows 20 a minute).
    'blog.comment.create': { minute: 20, hour: 300 },
};

/**
 * limits(name, own) middleware for one app, plus limits.reads(name, { skip }) (the defaults on every
 * GET/HEAD, a first-party service reading for itself not counted) and limits.budget(name).
 */
function createActorLimits({ config, now = () => Date.now(), registry = null, log = console }) {
    const refused = registry
        ? registry.counter({ name: 'blog_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.limits.minute, hour: config.limits.hour },
        actor,
        now,
        onLimited(e) {
            // The actor is a subject id, a principal or an address, never a token.
            log.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name, { skip = null } = {}) => {
        const limit = limiter(name);
        return (req, res, next) => ((req.method === 'GET' || req.method === 'HEAD') && !serviceItself(req) && !(skip && skip(req)) ? limit(req, res, next) : next());
    };
    const budgets = new Map(Object.entries(BUDGETS).map(([name, own]) => [name, limiter(name, own)]));
    limiter.budget = (name) => {
        const m = budgets.get(name);
        if (!m) throw new Error(`limits: no budget named ${name}`);
        return m;
    };
    return limiter;
}

module.exports = { createActorLimits, actor, serviceItself, BUDGETS };
