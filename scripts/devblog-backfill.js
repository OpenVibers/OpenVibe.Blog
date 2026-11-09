#!/usr/bin/env node
'use strict';
// Dry run never boots the app (boot migrates/seeds) and never calls an AI provider.
const fs = require('fs');
const { Client } = require('pg');
const { candidates, weekOf, WEEK } = require('../server/devblog');
async function main(args = process.argv.slice(2)) {
    const opt = name => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args[i + 1]; };
    const to = opt('to') || weekOf(Date.now());
    const from = opt('from') || new Date(Date.parse(to) - 6 * WEEK).toISOString().slice(0, 10);
    if (![from, to].every(v => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v))) || from >= to) throw new Error('Use --from YYYY-MM-DD --to YYYY-MM-DD (exclusive)');
    let entries, slots = [];
    if (opt('input')) entries = JSON.parse(fs.readFileSync(opt('input'), 'utf8'));
    else {
        const client = new Client({ connectionString: process.env.DATABASE_URL });
        await client.connect();
        try {
            await client.query('BEGIN READ ONLY');
            await client.query("SET LOCAL statement_timeout = '10s'");
            entries = (await client.query('SELECT * FROM changelog_entries WHERE deployed_at >= $1 AND deployed_at < $2 ORDER BY deployed_at, id', [from, to])).rows;
            // Before the B2 migration, there are no weekly slots yet.
            if ((await client.query("SELECT to_regclass('blog_devblog_slots') AS name")).rows[0].name) slots = (await client.query('SELECT service, week_start, status FROM blog_devblog_slots')).rows;
            await client.query('ROLLBACK');
        } finally { await client.end(); }
    }
    const plan = candidates(entries, { from, to }).filter(c => !slots.some(s => s.service === c.service && s.week_start === c.week && s.status !== 'failed'));
    for (const c of plan) console.log(`DRAFT ${c.service} week ${c.week}: ${c.entries.length} merged changes`);
    console.log(`${plan.length} draft(s); ${args.includes('--write') ? 'write requested' : 'dry run, no AI calls or writes'}`);
    if (!args.includes('--write')) return plan;
    if (args.includes('--dry-run')) throw new Error('Choose --dry-run or --write, not both');
    if (process.env.NODE_ENV === 'production') throw new Error('Back-catalogue writes are disabled in production');
    if (opt('input')) throw new Error('--input is a dry-run snapshot only; writes read the local database');
    const { ctx } = await require('../server/app').createApp();
    try {
        for (const c of plan) {
            const blog = await ctx.devblog.blogFor(c.service);
            if (!blog) throw new Error(`No configured blog for ${c.service}`);
            const owner = await ctx.store.db.prepare("SELECT subject FROM blog_memberships WHERE blog_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1").get(blog.id);
            if (!owner) throw new Error(`No owner for ${c.service}`);
            const out = await ctx.devblog.draft({ kind: 'user', subject: owner.subject }, blog, { service: c.service, week: c.week, backfill: true, retry: true });
            console.log(`Saved draft ${out.post.id}`);
        }
    } finally { ctx.worker.stop(); await ctx.outbox.stop(); await ctx.store.close(); }
    return plan;
}
if (require.main === module) main().catch(() => { console.error('Devblog backfill failed; no post was published. Check the input, configuration and draft queue.'); process.exitCode = 1; });
module.exports = { main };
