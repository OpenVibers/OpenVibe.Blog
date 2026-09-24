'use strict';

/**
 * OpenVibe.Blog — process entry. `node server/index.js`
 * Listens on PORT (4810) behind nginx (deploy/). Starts the outbox relay (when EVENTS_URL and the
 * client secret are set) and the worker (scheduled publication, media verification).
 */
const { createApp } = require('./app');

const { app, ctx } = createApp();
const { config } = ctx;

const server = app.listen(config.port, config.host, () => {
    console.log(`[Blog] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${config.dbPath})`);
    console.log(`[Blog] events relay ${ctx.outbox.enabled ? `on → ${config.events.url}` : 'off (events wait in event_outbox)'}; worker ${config.worker.enabled ? 'on' : 'off'}`);
});
server.keepAliveTimeout = 65_000;
ctx.outbox.start();
ctx.worker.start();
// The network changelog and patch notes run where the worker runs (one process).
if (config.worker.enabled) ctx.changelog.start();

function shutdown(signal) {
    console.log(`[Blog] ${signal}: closing`);
    ctx.worker.stop();
    ctx.changelog.stop();
    server.close(async () => {
        try { await ctx.outbox.stop(); } catch { /* best effort */ }
        try { ctx.store.close(); } catch { /* already closed */ }
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
