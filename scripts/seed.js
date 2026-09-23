#!/usr/bin/env node
'use strict';
/**
 * Seed the official blog with its first post (a DRAFT built from verbatim quotes; see server/seed.js).
 *
 *   npm run seed                                     # draft only (author: first BLOG_OFFICIAL_OWNERS)
 *   npm run seed -- --author usr_…                   # a different accountable author
 *   npm run seed -- --publish --reviewer usr_…       # a person reviewed it: record that and publish
 *
 * Uses the same database and outbox as the service (BLOG_DB_PATH); events wait in event_outbox and
 * are relayed by the running service.
 */
const { createApp } = require('../server/app');
const { seedOfficialPost } = require('../server/seed');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };

const { ctx } = createApp();
try {
    const out = seedOfficialPost(ctx, { author: opt('author'), reviewer: opt('reviewer'), publish: args.includes('--publish') });
    console.log(`${out.created ? 'created' : 'exists'}: ${out.post.id} (${out.post.state}) ${ctx.publication.postUrl(ctx.blogs.get(out.post.blog_id), out.post)}`);
    if (out.review) console.log(`review recorded by ${out.review.reviewer}: ${out.review.decision}`);
    if (!out.published && out.post.state !== 'published') console.log('left as a draft: publish it after a person has checked the quotes (--publish --reviewer usr_…)');
} catch (err) {
    console.error(`[seed] ${err.message}`);
    process.exitCode = 1;
} finally {
    ctx.store.close();
}
