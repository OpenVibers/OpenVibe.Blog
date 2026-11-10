#!/usr/bin/env node
'use strict';
/**
 * Backfill the network changelog's tags (plan §9): existing entries with no kind get plain words,
 * a kind and one to three areas. Housekeeping (library pins, merges, test-only and docs-only work)
 * is decided here without a model; everything else goes to OpenVibe.AI's blog.changelog.tag task in
 * batches, exactly as collection does (server/changelog/tagger.js).
 *
 *   node scripts/backfill-changelog-tags.js                  # dry run: print what it would do
 *   node scripts/backfill-changelog-tags.js --service live   # one site
 *   node scripts/backfill-changelog-tags.js --limit 200      # at most this many rows (default 500)
 *   node scripts/backfill-changelog-tags.js --apply          # write, spending the AI task's calls
 *   node scripts/backfill-changelog-tags.js --apply --retag  # reclassify existing tags too
 *   node scripts/backfill-changelog-tags.js --apply --production
 *
 * The dry run writes nothing and never calls the model. --apply needs OV_AI_INTERNAL_URL and the
 * service secret; a production database also needs --production, so it is never an accident.
 */
const tags = require('../server/changelog/tags');
const { createChangelogTagger } = require('../server/changelog/tagger');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const has = (name) => args.includes(`--${name}`);

async function main() {
    if (has('help')) {
        console.log('usage: node scripts/backfill-changelog-tags.js [--service <id>] [--limit 500] [--chunk 20] [--apply] [--retag] [--production]');
        return 0;
    }
    const config = require('../server/config').load();
    if (config.isProduction && has('apply') && !has('production')) {
        console.error('[backfill] refusing to write to a production database without --production');
        return 1;
    }
    const apply = has('apply');
    const service = opt('service');
    const limit = Math.max(1, Math.min(10000, parseInt(opt('limit'), 10) || 500));
    const chunk = Math.max(1, Math.min(25, parseInt(opt('chunk'), 10) || 20));
    const { openStore } = require('../server/db');
    const store = await openStore(config, { log: console });
    const db = store.db;
    const retag = has('retag');
    const where = retag ? ["COALESCE(tagged_by, '') NOT LIKE 'retagged%'"] : ['kind IS NULL'];
    const params = [];
    if (service) { where.push('service = ?'); params.push(service); }
    const rows = await db.prepare(`SELECT id, service, repo, sha, subject FROM changelog_entries WHERE ${where.join(' AND ')} ORDER BY deployed_at, id LIMIT ?`).all(...params, limit);

    const housekeeping = [];
    const needModel = [];
    for (const row of rows) {
        const initial = tags.initial(row.subject);
        if (initial.kind) housekeeping.push({ ...row, tag: initial });
        else needModel.push({ ...row, plain: initial.plain });
    }
    console.log(`[backfill] ${rows.length} untagged entr${rows.length === 1 ? 'y' : 'ies'}${service ? ` on ${service}` : ''} (limit ${limit})`);
    console.log(`[backfill] ${housekeeping.length} subject-rule classifications without a model; ${needModel.length} need blog.changelog.tag (${Math.ceil(needModel.length / chunk)} run${Math.ceil(needModel.length / chunk) === 1 ? '' : 's'})`);
    for (const row of housekeeping.slice(0, 40)) console.log(`  ${row.tag.kind.padEnd(8)} ${row.service}  ${row.sha.slice(0, 7)}  ${row.tag.plain}`);
    if (housekeeping.length > 40) console.log(`  … ${housekeeping.length - 40} more subject-rule classifications`);
    for (const row of needModel.slice(0, 40)) console.log(`  model     ${row.service}  ${row.sha.slice(0, 7)}  ${row.plain}`);
    if (needModel.length > 40) console.log(`  … ${needModel.length - 40} more for the model`);

    if (!apply) {
        console.log('[backfill] dry run: no writes, no AI calls. Re-run with --apply to write.');
        await store.close();
        return 0;
    }
    const tagger = createChangelogTagger({ config, log: console });
    if (needModel.length && !tagger.enabled) {
        console.error('[backfill] blog.changelog.tag is not configured (OV_AI_INTERNAL_URL and OV_OAUTH_CLIENT_SECRET)');
        await store.close();
        return 1;
    }
    const tagStmt = db.prepare(`UPDATE changelog_entries SET kind = ?, areas = ?, plain = ?, tagged_at = ?, tagged_by = ? WHERE id = ?${retag ? '' : ' AND kind IS NULL'}`);
    let tagged = 0;
    for (const row of housekeeping) tagged += (await tagStmt.run(row.tag.kind, row.tag.areas, row.tag.plain, store.now(), retag ? 'retagged-subject' : row.tag.kind === 'internal' ? 'housekeeping' : 'subject-rule', row.id)).changes;
    for (let i = 0; i < needModel.length; i += chunk) {
        const batch = needModel.slice(i, i + chunk);
        try {
            const answer = await tagger.tag(batch);
            for (const row of batch) {
                const t = answer.get(String(row.id)) || tags.fallbackTag(row.subject);
                const source = answer.has(String(row.id)) ? 'ai' : 'fallback';
                tagged += (await tagStmt.run(t.kind, t.areas, t.plain, store.now(), retag ? `retagged-${source}` : source, row.id)).changes;
            }
            console.log(`[backfill] tagged ${Math.min(i + chunk, needModel.length)}/${needModel.length} model entries`);
        } catch (err) {
            console.error(`[backfill] batch ${i / chunk + 1} failed; applying subject fallback: ${err.message}`);
            for (const row of batch) {
                const t = tags.fallbackTag(row.subject);
                tagged += (await tagStmt.run(t.kind, t.areas, t.plain, store.now(), retag ? 'retagged-fallback' : 'fallback', row.id)).changes;
            }
        }
    }
    console.log(`[backfill] wrote ${tagged} of ${rows.length} entries`);
    await store.close();
    return tagged === rows.length ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (err) => { console.error(`[backfill] ${err.message}`); process.exitCode = 1; });
