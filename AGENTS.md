# AGENTS.md — OpenVibe.Blog

## Project overview

The official OpenVibe blog (`openvibe.blog/`) and a blog for every member: drafts, immutable
revisions, series, tags and nested categories, scheduling, feeds, comments and AI writing desks. It
uses the shared publishing packages (ADR-019) rather than its own copies. Node.js/Express,
PostgreSQL (`ov_blog`), server-rendered, CommonJS, **no build step**.

- Service id `blog`, port `4810`, origin `https://openvibe.blog`, unit `openvibe-blog.service`,
  release root `/opt/openvibe.blog`.
- Charter tables are in Blog's database ([migrations/](migrations/)); the publishing packages own the
  revision, schedule, taxonomy, citation, media, discussion and SEO state behind `blog_`-prefixed
  tables and three views that keep the charter names readable without a second copy.

## What it owns

- `blogs` (the official blog and one per member), `blog_memberships` (owner, editor, author),
  `blog_posts`, `blog_series`, `blog_feed_settings`; revision/schedule/taxonomy/redirect state comes
  from `openvibe-publishing` with the `blog` prefix.
- Publishing state: draft → published revision; publish, unpublish, soft delete (`410 Gone`),
  scheduled publish/unpublish (idempotent across worker restarts, leases, `blog.schedule.failed`).
- Canonical URLs, RSS/Atom/JSON Feed, sitemap, robots, `llms.txt`, Search documents and IndexNow.
- Members-only posts through OpenVibe.VIP (teaser + join link for everyone else).
- The network changelog: Patch notes **drafts** on the official blog, for a person to review and
  publish; the AI devblog desk (`server/devblog/`), patch-notes story selection and images.
- Comments are Community threads referenced, never copied.

Not owned: identity, the AI run engine, Media objects, VIP membership decisions, Search's index,
Community's threads, Events' delivery.

## Who calls it, and whom it calls

- Callers: people in the browser; Network and other services with a Network service token audience
  `openvibe.blog` and the route's capability; an `X-OV-Subject` membership header for on-behalf calls.
- Depends on: Network (SSO client `blog`, JWKS, `identity.subject.resolve`), Community
  (`community.comment.write`, optionally moderate), Media (`media.object.read`, namespace `blog`),
  AI (`blog.draft_post`, drafts only), VIP (`vip.resource.policy.evaluate`, default
  `http://127.0.0.1:4620`), Events (SDK outbox), Search (consumes `blog.index_document.*`),
  `openvibe-publishing` and the pinned SDK/Shared/Contracts tarballs.
- Without VIP, the members-only gate **fails closed**: the teaser and join link, never the body.

## Repository map

- **Entry:** [server/index.js](server/index.js) — app, worker (scheduled publication, media
  verification), outbox, changelog and desks; graceful shutdown.
- **App:** [server/app.js](server/app.js) — helmet/CSP, cookies, `/auth`, `/shared`, `/api/v1`,
  `/write`, pages, editor, discovery, actor limits, account-data events.
- **Config:** [server/config.js](server/config.js); database [server/db.js](server/db.js).
- **Domain:** [server/domain/](server/domain/) — `blogs.js`, `publication.js`, `posts.js`,
  `access.js`, `reading.js`, `effects.js`, `ai-drafts.js`, `account-data.js`.
- **HTTP:** [server/http/](server/http/) — `public.js`, `editor.js`, `api.js`, `discovery.js`,
  `openapi.js`, `actor-limits.js`, `errors.js`.
- **Clients:** [server/clients/](server/clients/) — `network.js`, `community.js`, `media.js`,
  `vip.js`.
- **Auth/viewer:** [server/auth/viewer.js](server/auth/viewer.js), [server/auth/capabilities.js](server/auth/capabilities.js).
- **Render:** [server/render/](server/render/) — `blocks.js`, `editor.js`, `home.js`, `layout.js`,
  `pages.js`, `short.js`.
- **Patch notes/AI desks:** [server/patch-notes/](server/patch-notes/), [server/devblog/](server/devblog/).
- **Browser:** [public/js/blog-index.js](public/js/blog-index.js), [public/js/blog-editor.js](public/js/blog-editor.js),
  [public/css/blog.css](public/css/blog.css).
- **Deploy:** [deploy/systemd/openvibe-blog.service](deploy/systemd/openvibe-blog.service),
  [deploy/nginx/openvibe.blog.conf](deploy/nginx/openvibe.blog.conf).

## Commands

```bash
npm ci
cp .env.example .env       # OV_OAUTH_CLIENT_SECRET, BLOG_OFFICIAL_OWNERS, BLOG_FORM_SECRET, EVENTS_URL, BASE_URL
npm run dev                # http://localhost:4810
npm run seed               # the seed post (stays a draft until a person reviews it)
npm test                   # test/run.js, PGlite, mock Network/Community/Media/Events
npm run test:pg            # same suite on PostgreSQL
npm test -- schedule       # filter by file name
ov test                    # the harness's sharded run of what the change reaches
node --check <file.js>
```

## Database and migrations

PostgreSQL database `ov_blog` on the host's data role (ADR-035); development and tests use PGlite.
Async reads/writes through `openvibe-sdk/db`. Migrations are `migrations/NNNN_*.sql`, applied at
boot; never edit one that has run — add a new number. Revision rows are **immutable** (triggers abort
UPDATE/DELETE); drafts live in `blog_post_drafts`, and a published post keeps showing its published
revision while newer ones are drafted. A stale edit is `412 revision.conflict`, never lost work.
Nothing is created at runtime.

## Auth

People sign in through Network SSO (OAuth client `blog`, callback `/auth/callback`) and get the
viewer/session in [server/auth/viewer.js](server/auth/viewer.js). Memberships (`owner`, `editor`,
`author`) gate the editor and API. Service callers need a Network service token with the
capability from the pinned contracts release; `X-OV-Subject` scopes a call to a member. The official
blog's owners come from `BLOG_OFFICIAL_OWNERS`, and Network admins act as its owners. Forms need
`BLOG_FORM_SECRET`; a form token failure refuses the write.

## Frontend loading model

Server-rendered HTML and **plain forms** work without JavaScript: write, edit, publish, comment and
configure ([test/nojs-editor.test.js](test/nojs-editor.test.js)). Two page scripts enhance the index
and the editor; there is no SPA, no bundler and no build. `openvibe-shared` supplies the Frame and
theme presets; `/shared/*` is served from the pinned package. CSP lives in
[server/app.js](server/app.js) — add an origin there before loading from it. Public pages must stay
cache-safe: no members-only or private text through cache headers, feeds, sitemap, Search or API.

## Deploy

`sudo ovhost deploy blog` (strategy `git-checkout`): fetch, fast-forward `/opt/openvibe.blog`,
install on a lockfile change, restart, wait for `/api/ready`, roll back on failure. Unit
`openvibe-blog.service` on `127.0.0.1:4810`, env `/etc/openvibe/blog.env` (0600); the release
migrates `ov_blog` at boot. `sudo ovhost rollback blog --to <sha>`; the schema only adds tables and
columns, so a rollback is safe. The vhost is
[deploy/nginx/openvibe.blog.conf](deploy/nginx/openvibe.blog.conf). No secret in a command line,
file or log.

## Tests

`npm test` runs each `test/*.test.js` in its own process through `openvibe-shared/test-runner`
(60 s/file), with PGlite and in-process Network/Community/Media/Events mocks. The README's
"Acceptance" table maps each guarantee to its test: scheduling idempotency and failures, immutable
revisions and 412, feeds/canonical/Search convergence, slug 301s, VIP privacy across pages/JSON/
feeds/sitemap/Search, broken Media assets vs outage, no-JS editing, capabilities, the seed and
discovery files, and contracts. `ov test` runs the same.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; domain logic in `server/domain/`, HTTP in
  `server/http/`, no SQL in routes.
- Reuse `openvibe-publishing` for revisions/schedule/taxonomy/citations/media/discussion/seo; do not
  reimplement a publishing primitive.
- IDs and errors from `openvibe-contracts`; `application/problem+json` with request ids.
- Everything a reader can see is escaped; never interpolate raw Markdown or user HTML.
- A visible change needs a test that a private post stays private.

## Pitfalls

- **AI drafts are drafts.** `blog.draft_post` output is never published by the model; a person
  reviews and publishes. The seed post stays a draft for the same reason.
- **VIP fails closed.** A VIP outage yields the teaser and join link, never the body; a cached "yes"
  ends within its TTL and at once on `vip.membership.changed`.
- **Revisions are immutable.** Revert is a new revision; do not UPDATE history.
- **Unpublishing closes the share door:** an unpublish/delete must tombstone with a higher revision
  and must not leave a public share row or Search document behind.
- **Draft and members-only content must not leak** through feeds, sitemap, JSON, `.json` API, cache
  headers or product events; `test/privacy.test.js` and `test/members-vip.test.js` enforce it.
- **Slug changes leave 301s from every old path**, and chains collapse.
- **No JavaScript must still work** in the editor and forms; do not move a required action into a
  script.
- **The changelog writes drafts**, not releases; Patch notes and the seed are reviewed by a person.
- **Community threads are referenced, never copied** into the post body.

## Documentation

- [README.md](README.md) — features, routes, capabilities, acceptance, security and deploy.
- [docs/devblog-writer.md](docs/devblog-writer.md) — the AI devblog desk.
- [docs/service-manifest-proposal.json](docs/service-manifest-proposal.json), [docs/capabilities-proposal/](docs/capabilities-proposal/).
- The shared publishing contracts are in OpenVibe.Contracts (`publishing.*`, `blog.*`).
