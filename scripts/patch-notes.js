#!/usr/bin/env node
'use strict';
/**
 * File the next Patch notes draft from the commits since the last one. A DRAFT: it is never published here.
 *
 *   node scripts/patch-notes.js                 # the pending commits, AI prose when OpenVibe.AI is configured
 *   node scripts/patch-notes.js --no-ai         # the deterministic post
 *   node scripts/patch-notes.js --dry-run       # print the post, write nothing
 *   node scripts/patch-notes.js --reason manual # what the changelog row records
 *
 * Runs with the service's environment (DATABASE_URL, OV_OAUTH_CLIENT_SECRET, OV_AI_INTERNAL_URL) and its outbox.
 */
const { createApp } = require('../server/app');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };

(async () => {
    const { ctx } = await createApp();
    try {
        const reason = opt('reason') || 'manual';
        if (args.includes('--dry-run')) {
            const blog = await ctx.blogs.byHandle(ctx.config.changelog.blogHandle) || await ctx.blogs.ensureOfficial();
            let entries = await ctx.changelog.pendingEntries();
            entries = await ctx.changelog.enrich(entries);
            const plan = await ctx.patchNotes.plan({ entries, blog, useAi: !args.includes('--no-ai') });
            if (!plan) { console.log('nothing pending'); return; }
            console.log(`title: ${plan.doc.title}\ndek: ${plan.doc.dek}\ntags: ${plan.doc.tags.join(', ')}\n\n${plan.doc.body}`);
            const b = plan.checks.blocking;
            console.log(`\n---\n${b.length} blocking, ${plan.checks.warnings.length} warnings${plan.usedAi ? ' (AI prose)' : ''}${b.length ? `: ${[...new Set(b.map((x) => x.code))].join(', ')}` : ''}`);
            return;
        }
        const out = await ctx.patchNotes.draftPending({ reason, useAi: !args.includes('--no-ai') });
        if (!out.created) { console.log(`no draft: ${out.reason}`); return; }
        const b = out.checks.blocking;
        console.log(`draft: ${out.post.id} (${out.post.state}) ${out.url}`);
        console.log(`${b.length} blocking, ${out.checks.warnings.length} warnings${out.usedAi ? ' (AI prose)' : ''}${b.length ? `: ${[...new Set(b.map((x) => x.code))].join(', ')}` : ''}`);
        console.log('left as a draft: a person reviews it in /write, then approves the revision and publishes.');
    } catch (err) {
        console.error(`[patch-notes] ${err.message}`);
        process.exitCode = 1;
    } finally {
        await ctx.store.close();
    }
})();
