# OpenVibe.Blog

> The official OpenVibe blog and a blog for every member: drafts, revisions, series, scheduling, feeds.

**Status:** alpha (roadmap Wave 16, Blog half). **Public at https://openvibe.blog since 2026-09-23**
(the launch release also removed the domain from OpenVibe.Sites). Its capabilities and service
manifest are released in openvibe-contracts v0.18.0. The only post in production is the seed post,
which is still a draft, so nothing is published yet.
**Domain:** `openvibe.blog` · **Port:** 4810 · **Service id:** `blog`
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §12.6; roadmap §15.13, §29, §32.
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

This service hosts the official OpenVibe blog and a blog for each member, with canonical URLs and
feeds. It uses the shared publishing packages (ADR-019) and doesn't write its own versions of them.
It also uses:

- Media for attachments
- Community for comments
- OpenVibe.AI's `blog.draft_post` output, as drafts that need review
- openvibe-shared theme presets
- an optional VIP gate: members-only posts with an entitlement check that fails closed

## Owns

The ten charter tables live in Blog's own SQLite (`BLOG_DB_PATH`). Where a publishing package
applies, it creates the table with the `blog` prefix:

| Charter table | What it is |
|---|---|
| `blogs` | Owned by Blog. The official blog (`openvibe`, served at `/`) and the member blogs. One per member, owned by their Network subject (`usr_…`). |
| `blog_memberships` | Owned by Blog. Roles are owner, editor and author. |
| `blog_posts` | Owned by Blog. Publication state: slug, state, visibility, entitlement key, published revision, series, flags. |
| `blog_post_revisions` | `openvibe-publishing/revisions` (prefix `blog_post`). Immutable: triggers abort UPDATE and DELETE. Drafts go in `blog_post_drafts`. |
| `blog_series` | Owned by Blog. Ordered series for each blog. |
| `blog_taxonomy` | A view over `blog_terms` (`openvibe-publishing/taxonomy`, prefix `blog`). Tags are network-wide. Categories are per blog (vocabulary `category_<blog>`) and can be nested. |
| `blog_post_terms` | A view over `blog_term_links`. |
| `blog_schedules` | A view over `blog_schedule_jobs` (`openvibe-publishing/schedule`, prefix `blog`). |
| `blog_redirects` | `openvibe-publishing/seo` history-aware redirects (prefix `blog`). |
| `blog_feed_settings` | Owned by Blog. RSS, Atom and JSON Feed switches, item count, and full text or summaries. |

The three views keep the charter's names readable without keeping a second copy of the package state.

Other tables in the same database:

- Package companions: `blog_post_citations`, `blog_post_attachments`, `blog_post_reviews`,
  `blog_post_discussion_refs` and `blog_index_revisions`.
- `event_outbox`, the SDK transactional outbox.
- `subject_projections`, a display cache of Network names. It isn't authority.

## Does not own

- **Comments.** They belong to OpenVibe.Community. A public post's thread is resolved from
  `EntityRef {service: 'blog', type: 'post', id}`. Blog stores only the thread id and renders the
  thread live.
- **Media bytes.** They belong to OpenVibe.Media. Blog stores Media object ids (`med_…`) and has an
  explicit broken-asset state.
- **Entitlements.** They belong to Billing/VIP.
- **Identity.** It belongs to OpenVibe.Network: SSO, subjects and service principals.
- **Search.** OpenVibe.Search indexes what Blog sends through Events.
- **AI generation.** OpenVibe.AI makes no provider calls from Blog.

## What works

- **Blogs:**
  - The official blog exists from the first boot. Its owners come from `BLOG_OFFICIAL_OWNERS`,
    and Network admins act as its owners.
  - Every member gets a blog on first use (`/write/start` or `POST /api/v1/blogs`), with handle =
    Network username unless the member picks another.
  - Owners, editors and authors. Owners manage members, settings, theme and feeds.
- **Posts:**
  - Drafts and immutable revisions, with optimistic concurrency. A stale edit is `412
    revision.conflict` and nothing is lost.
  - Diff, and revert as a new revision.
  - A published post keeps showing its published revision while newer ones are drafted.
- **Publishing:**
  - Publish, unpublish and soft delete (`410 Gone`).
  - Scheduled publish or unpublish, idempotent across worker restarts (leases, and "revision N is
    published" as the effect).
  - `blog.schedule.failed` when a job gives up.
- **Organizing:**
  - Author pages, both per blog and network-wide.
  - Tags, nested categories and ordered series.
  - Slug changes leave 301s from every old path, and chains collapse.
- **Media and themes:**
  - Media-rich posts: cover, inline (`[[media:med_…]]` lines) and gallery figures.
  - The worker re-verifies attachments against Media. Deleted or missing objects render
    "This media is no longer available." An outage changes nothing.
  - Themes are six openvibe-shared token presets.
- **Comments:** Community threads on public posts, with a plain comment form. The thread is hidden
  when a post is deleted or stops being public.
- **AI drafts:** `X-OV-Origin: ai` with an OpenVibe.AI workflow run. The draft is AI-generated,
  noindex and can't be published or scheduled until a person records an approving review. A person
  editing it makes a hybrid (AI-assisted) revision. The disclosure appears on the page, in the JSON
  and in the Search document.
- **Members-only (VIP) posts:**
  - Visibility `members` with an `entitlement_key` in the ACL.
  - The entitlement seam (`server/domain/access.js`) admits nobody while
    `BLOG_ENTITLEMENTS_PROVIDER=none`, the default: OpenVibe.VIP runs loopback-only on the host but
    Blog has no VIP client yet. Only the blog's members and staff can read these posts.

### Routes (server-rendered, useful without JavaScript)

| Route | What |
|---|---|
| `/` | the official blog |
| `/@:handle` | a member's blog |
| `/@:handle/:slug`, `/@:handle/:slug.json` | a post, and the same post as data |
| `/@:handle/tags/:tag` · `/tags/:tag` | tag pages, per blog and network-wide |
| `/@:handle/categories/:category` | category pages; a parent includes its children, with breadcrumbs |
| `/@:handle/series/:series` | series pages, in order |
| `/@:handle/authors/:who` · `/authors/:who` | author pages |
| `/feed.xml`, `/atom.xml`, `/feed.json` | the official blog's feeds |
| `/@:handle/feed.xml`, `/@:handle/atom.xml`, `/@:handle/feed.json` | each member blog's feeds |
| `/sitemap.xml` → `/sitemaps/posts.xml`, `/sitemaps/blogs.xml` | sitemaps |
| `/robots.txt` | names the sitemap and states the policy for automated consumers |
| `/llms.txt` | orientation for language models |
| `/write/…` | the editor, as plain HTML forms with Network SSO and a form token |
| `/auth/*` | sign-in; the same session layer as OpenVibe.Community |
| `/api/health`, `/api/ready`, `/release.json`, `/metrics` | health, readiness and metrics; `/metrics` is loopback only |

### Discoverability (roadmap §32)

- Every page gets its robots meta, canonical and `X-Robots-Tag` from the
  `openvibe-publishing/seo` gate, with explicit reasons (for example `thin (42 of 80 words)`).
  Reasons show in the editor and in the JSON.
- Blog's gate policy: 80 words minimum, sources optional. A short post is served and appears in
  feeds but is noindex.
- JSON-LD `BlogPosting` is built from real fields only. Missing fields are omitted, and a
  publisher is set only for the official blog.
- Drafts, scheduled posts, unlisted, members-only, private, unpublished, deleted and noindex posts
  never appear in feeds, sitemaps or Search. Feeds and sitemaps are never built for a particular
  viewer.

### Caching (no leaks through shared caches)

- All HTML and JSON varies on `Cookie` and `Authorization`.
- `Cache-Control: public, max-age=60` applies only to public, published posts and to lists of
  public posts shown to anonymous visitors.
- Everything else is `private, no-store` plus `X-Robots-Tag`. That covers signed-in views, drafts,
  previews, unlisted, members-only and private posts, 403, 404, 410 and the API.
- Feeds and sitemaps are public for 5 minutes. They only ever contain public posts.

### Events (SDK outbox, same transaction as the change)

| Event | Notes |
|---|---|
| `blog.post.created` | internal |
| `blog.post.published`, `.updated`, `.unpublished`, `.deleted` | `openvibe-publishing/index-hooks` `publicationEvent`. Public visibility only for public, listable posts. The payload is the canonical URL, state and indexability, never the body. |
| `blog.schedule.failed` | internal |
| `blog.index_document.upserted` / `.deleted` | Documents and tombstones in `search.index-document@1` form, with a monotonic index revision (`createIndexSequencer`). Only published, public, listable posts are upserted; every other state is a tombstone. A post that was never indexed gets no tombstone. |

### Capabilities (released in openvibe-contracts v0.18.0; proposal: `docs/capabilities-proposal/`)

Service tokens use audience `openvibe.blog`, with one capability per route. The person the service
acts for goes in `X-OV-Subject`, and membership still applies:

- `blog.blog.create` (the charter's `blog.create`), `blog.blog.configure`, `blog.theme.set`
- `blog.member.manage`
- `blog.post.create`, `blog.post.read`, `blog.post.update`, `blog.post.publish`,
  `blog.post.schedule`, `blog.post.unpublish`, `blog.post.delete`
- `blog.feed.read`

Browser and app user JWTs are judged by blog membership. Grants for these ids are decided locally
with the contracts library's matching rule (`server/auth/capabilities.js`). The service manifest
(proposal: `docs/service-manifest-proposal.json`) is released in openvibe-contracts v0.18.0; this
repo pins v0.19.0.

## Depends on

- **Packages** (all pinned by release tarball): `openvibe-publishing` v0.2.1 (revisions, schedule,
  taxonomy, citations, media, discussion, seo, authorship, index-hooks, ssr), `openvibe-contracts`
  v0.19.0, `openvibe-shared` v1.3.0 (chrome, app icon, footer, legal, release, metrics, ready,
  theme presets), `openvibe-sdk` v0.2.2 (events outbox, service tokens).
- **OpenVibe.Network:**
  - SSO: the OAuth client `blog` is already seeded with redirect
    `https://openvibe.blog/auth/callback`.
  - JWKS.
  - `identity.subject.resolve` for author names.
- **OpenVibe.Community:** `community.comment.write`, and optionally `community.comment.moderate`.
- **OpenVibe.Media:** `media.object.read` for namespace `blog`.
- **OpenVibe.Events:** `events.event.publish`.
- **OpenVibe.Search:** consumes `blog.index_document.*` through its `*.index_document.*`
  subscription. `blog` is already in Search's default `SEARCH_EVENT_OWNERS`.
- **Optional:** an entitlement service (OpenVibe.VIP or Billing's `billing.entitlement.check`) for
  members-only posts. Until one exists, the gate fails closed.

### Grants the Network must hold for client `blog`

Each grant is `[client, capability, audience]`:

- `[blog, identity.subject.resolve, openvibe.network]`
- `[blog, events.event.publish, openvibe.events]`
- `[blog, community.comment.write, openvibe.community]`
- `[blog, community.comment.moderate, openvibe.community]` (optional: hides the threads of deleted
  or no-longer-public posts)
- `[blog, media.object.read, openvibe.media]`, namespace `blog`. Media also needs a `blog` tenant.
- For OpenVibe.AI to deliver drafts: `[ai, blog.post.create, openvibe.blog]`. Add
  `[ai, blog.post.read, openvibe.blog]` if it reads the drafts back.

## Acceptance (automated: `npm test`)

| Charter / roadmap requirement | Test |
|---|---|
| Scheduled publication is idempotent across worker restarts: a worker dies after applying and before completing, the app restarts on the same database, and after the lease expires the job re-runs with exactly one published event and one Search upsert. Duplicate scheduling is one job, and a failing job emits `blog.schedule.failed`. | `test/schedule.test.js` |
| Revisions survive edits: they're immutable, 412 on a stale base, and revert makes a new revision. | `test/lifecycle.test.js` |
| Feeds, canonical HTML, sitemap and Search converge on publication state: publish, revise, unpublish and delete. | `test/lifecycle.test.js` |
| Feeds and canonical URLs stay stable across slug changes: the feed id is unchanged, old paths 301 and chains collapse. | `test/slug-media.test.js` |
| VIP-only and private posts never leak through cache headers, Search, feeds or sitemaps. Visibility changes tombstone with a higher revision, and the entitlement seam fails closed. | `test/privacy.test.js` |
| A deleted Media object yields an explicit broken-asset state in the page, JSON, feed and editor, and an outage is not a deletion. | `test/slug-media.test.js` |
| Useful without JavaScript: write, edit, publish, comment and configure with forms only. Form tokens, the 412 message and Community threads referenced, never copied. | `test/nojs-editor.test.js` |
| Capability-guarded service tokens, X-OV-Subject membership, AI drafts that need a person's review, and problem+json with request ids. | `test/api-ai.test.js` |
| The seed post, readiness, release, robots, llms.txt and the sitemap index. | `test/seed-ops.test.js` |
| The contract proposals are valid against the released schemas and match the code. | `test/contracts.test.js` |

## Launch rule

This repository alone doesn't make the product live. `openvibe.blog` kept its placeholder on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of plan §12.12
existed; the launch release went out on 2026-09-23. Status against each point:

1. **Runtime, health, readiness, observability:** done.
2. **Canonical identity and auth:** done.
3. **SSR public routes useful without JS:** done.
4. **Persistence and end-to-end workflows:** done; `ovhost drill blog` restored it on the production
   host on 2026-09-23.
5. **Capability and event registration against OpenVibe.Contracts:** released in v0.18.0
   (capabilities and service manifest; no `blog.*` event payload schemas yet).
6. **Migration and seed strategy, threat review, sitemap/robots/feed behaviour:** done. There is
   nothing to migrate, the seed is described below and the threat review is below.
7. **Acceptance tests:** done.

**The launch release did all of these in one release (2026-09-23):**

- Removes `openvibe.blog` from `OpenVibe.Sites/sites.json`.
- Switches routing: nginx vhost, DNS and TLS.
- Flips the Network hub entry (`server/chrome/sites.js`, `status: 'soon'`).
- Registers maturity in the ecosystem registry.

A placeholder never counts as an implemented service. The site is public, but nothing is published
on it until a person reviews and publishes the seed post (below).

## Seed

`npm run seed` creates the official blog's first post, "Released in the OpenVibe repositories,
16–22 September 2026". It's built only from verbatim quotes of commit messages and a CHANGELOG line
on the main branches of the OpenVibers repositories (`seed/week-2026-09-16.json`). Each quote keeps
its commit or tag, date and GitHub URL, and is attached as a citation.

- It makes no deployment claims. Several services' `STATUS.json` say `deployed: false`, and the
  post says it doesn't state that anything is running.
- There's no pricing copy.
- It is created as a **draft**. No person has reviewed it yet, so it isn't marked as reviewed.
- To publish it, a person checks the quotes and runs
  `npm run seed -- --publish --reviewer usr_…`. That records their approving review and publishes
  the post.

## Security and threat review

- **Identity:**
  - Only verified Network JWTs (offline RS256 against JWKS) and service tokens for audience
    `openvibe.blog`.
  - Service tokens are judged on the token alone. A bad one is refused, never downgraded to
    anonymous.
  - Identity never comes from a body or query. `X-OV-*` headers are ignored for browsers.
- **CSRF:** SameSite=Lax session cookie plus an HMAC form token (`BLOG_FORM_SECRET`) on every form
  POST.
- **XSS:**
  - All HTML goes through `openvibe-publishing/ssr` auto-escaping.
  - Markdown uses the package's safe subset: no raw HTML and no images (media only by object id).
  - Links on member blogs get `rel="nofollow ugc noopener"`.
  - CSP from helmet.
- **Private content:** read decisions live in `server/domain/access.js`. 404 hides drafts and
  private posts, and 403 applies to members-only posts. A redirect never reveals the new slug of a
  post the reader may not see.
- **Leaks:** see the caching and events sections above. The product events carry no body. Search
  gets bodies only for public, listable posts.
- **SSRF:** Blog makes no outbound calls to user-chosen URLs. It calls only its configured Network,
  Community and Media hosts.
- **AI:** output is never attributed to a person. It needs a person's (`usr_`) review before
  publication or indexing, and only a signed-in person can record a review.
- **Abuse:** rate limits on `/auth`, `/write` and `/api/v1`, both in Express and in the nginx
  reference.
- **Known gaps:**
  - Uploads go through OpenVibe.Media. The editor attaches existing `med_…` ids and doesn't
    upload.
  - Media publishes no deletion event yet, so broken assets are found by polling (the worker
    interval).
  - The Community thread visibility sync is best effort and needs `community.comment.moderate`.

## Development

```bash
fnm exec --using=22.22.1 npm install
fnm exec --using=22.22.1 npm test          # temp databases and in-process mocks, no network
fnm exec --using=22.22.1 npm run dev       # http://localhost:4810 (set OV_OAUTH_CLIENT_SECRET to sign in)
```

## Deploy (for the lead)

1. **Code and config:**
   - Put the code at `/opt/openvibe.blog` and run `npm ci --omit=dev` on Node 22.
   - Create `/etc/openvibe/blog.env` (0600) from `.env.example`. Set these values:
     - `OV_OAUTH_CLIENT_SECRET`
     - `BLOG_OFFICIAL_OWNERS`
     - `BLOG_FORM_SECRET`
     - `EVENTS_URL=http://127.0.0.1:4300`
     - `BASE_URL=https://openvibe.blog`
2. **Network:** set a secret for the seeded OAuth client `blog`, then add the grants listed above.
3. **Media:** create the `blog` tenant/namespace.
4. **systemd:** install `deploy/systemd/openvibe-blog.service` (port 4810, `StateDirectory=openvibe-blog`).
5. **nginx:** install `deploy/nginx/openvibe.blog.conf`. `/metrics` is never proxied.
6. **Seed:** `npm run seed`. It stays a draft until someone has reviewed it.
7. **Contracts:** done: released in openvibe-contracts v0.18.0.
8. **Launch:** in the same release, remove `openvibe.blog` from OpenVibe.Sites and flip the Network
   hub entry (see the launch rule above).

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
