# Weekly devblog drafts

`POST /api/v1/blogs/{handle}/posts/devblog { "service": "live" }` and the editor’s **Draft a devblog** use the same writer. Only the owner of the configured destination blog may invoke it. The reusable `actor.skill@1` document is served at `/skills/devblog.json`; it describes the input and the draft-only result, and grants no permissions. Actor can load this document; importing it into Actor’s central catalogue is a separate registration action.

Blog supplies existing `changelog_entries`, clustered stories, commit/PR/file evidence, its voice card, and Media’s stored Host screenshots. `content.devblog` runs through AI task `blog.devblog.write` (AI PR #397 supplies choices), honoring the caller’s saved task choice and owner defaults. It plans, writes, checks claims and, if needed, revises once and checks again. It makes at most five model calls. No paid image or search tool is invoked. With no screenshot, the existing typographic hero is used. The draft records AI workflow, run and model provenance; attached Media IDs make figures render through B1. A person must approve the revision before publish or schedule; an AI-editor approval is insufficient.

`BLOG_DEVBLOG_ENABLED=on` enables weekly drafting from the existing changelog worker (also requires `BLOG_WORKER` and changelog collection enabled). It considers the previous complete Monday–Sunday UTC week. On-demand drafting considers the current week. Both use the same durable `(service, week_start)` reservation and a seven-day live cadence check, serialized by the destination blog row. An existing draft is returned unchanged. Failed scheduled attempts do not retry automatically; an owner’s explicit request can retry. A process interruption leaves a reserved slot for operator reconciliation: verify the AI run and any stored draft before clearing it. Daily Patch notes and their `post_id` assignments remain unchanged.

By default sites use `CHANGELOG_BLOG` (the official blog). Set `BLOG_DEVBLOG_SITES` to a JSON object such as `{"my-site":"my-blog"}` to bind another site to its owner’s blog. This trusted deployment mapping prevents a member from claiming a different site. Only meaningful merged changes qualify: pins and test/docs-only changes do not. Weeks exceeding 200 commits require review before drafting; nothing is silently truncated into a partial weekly post.

Public `/devblog` lists published devblogs across blogs; `/devblog/{service}` narrows to a site. `/api/v1/devblogs?service=live` returns the same public summaries and first figure, with offset pagination. Existing B1 classes/styles are retained. Private posts and drafts never enter these lists. Folded patch notes read the exact historical date window and the weekly slot’s site.

## Back catalogue

Run a dry run first, against a local database or an exported JSON array of changelog rows:

```
node scripts/devblog-backfill.js --from 2026-10-01 --to 2026-11-09 --dry-run
node scripts/devblog-backfill.js --input /tmp/changelog-entries.json --from 2026-10-01 --to 2026-11-09
```

Without `--input`, the dry run uses a read-only PostgreSQL transaction with a 10-second statement timeout. It does not boot/migrate/seed the app, fetch screenshots, call AI, or write posts. It prints each qualifying site/week and omits already reserved/drafted weeks. `--to` is exclusive. Windows are grouped into whole UTC weeks; an actual draft includes all entries in that week.

Only after reviewing that list, `--write` drafts those weeks from the local database. Historical backfill bypasses the rolling seven-day guard but never the unique weekly reservation or human publication gate. `NODE_ENV=production`, snapshot input with writes, and combining `--dry-run` with `--write` are refused. Do not run the writer against production for this rollout. No legacy post is redirected or replaced while its weekly replacement is a draft.
