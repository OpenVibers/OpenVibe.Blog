'use strict';

/**
 * OpenVibe.Blog — process entry. `node server/index.js`
 * Listens on PORT (4810) behind nginx (deploy/). Starts the outbox relay (when EVENTS_URL and the
 * client secret are set) and the worker (scheduled publication, media verification).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { startSubscriptions } = require('openvibe-sdk/account-data');

/**
 * The process stop (openvibe-sdk/service, docs/service.md's Blog family): the worker and the
 * changelog stop taking new work, the HTTP drain runs (defaults 4000/5000), then the outbox settles
 * and the store closes. Exported so a test can inject `exit` and `signals: false`.
 */
function createLifecycle({ server, ctx, exit, signals, extra = [] }) {
    return gracefulStop({
        name: 'Blog', server, deadlineExitCode: 0, exit, signals,
        stop: [() => { clearInterval(ctx.telemetryTick); return ctx.telemetry.stop(); }, () => ctx.worker.stop(), () => ctx.changelog.stop(), () => ctx.desks.stop(), ...extra],
        close: [() => ctx.outbox.stop(), () => ctx.store.close()],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    // Socket activation (2026-10-31): systemd's .socket unit holds the listener across restarts, so a deploy
    // queues requests in the kernel instead of answering 502. Without the socket unit, the usual listen.
    const socketActivated = process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;
    const server = app.listen(...(socketActivated ? [{ fd: 3 }] : [config.port, config.host]), () => {
        console.log(`[Blog] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.store.db.store})`);
        console.log(`[Blog] events relay ${ctx.outbox.enabled ? `on → ${config.events.url}` : 'off (events wait in event_outbox)'}; worker ${config.worker.enabled ? 'on' : 'off'}`);
    });
    server.keepAliveTimeout = 65_000;
    ctx.outbox.start();
    ctx.worker.start();
    // The request collector aggregates in memory and has no timer of its own (openvibe-sdk 0.46 createHttpTelemetry):
    // this tick writes each minute's samples; the stop clears it and flushes once more.
    ctx.telemetryTick = setInterval(() => { ctx.telemetry.flush().catch(() => {}); }, 60_000);
    ctx.telemetryTick.unref();
    // The network changelog and patch notes run where the worker runs (one process).
    if (config.worker.enabled) ctx.changelog.start();
    // The AI desks (server/desks/desks.js) write where the worker runs too.
    if (config.worker.enabled) ctx.desks.start();

    // The two account subscriptions at OpenVibe.Events (ADR-033), created when missing; off without EVENTS_URL,
    // BLOG_EVENTS_SECRET or the client secret.
    const subscriptions = startSubscriptions({
        eventsUrl: config.events.url, endpoint: `http://127.0.0.1:${config.port}/internal/events`, secret: config.events.secrets[0],
        networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
    });
    createLifecycle({ server, ctx, extra: [() => { if (subscriptions) subscriptions.stop(); }] });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[Blog] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
