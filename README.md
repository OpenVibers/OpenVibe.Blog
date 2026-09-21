# OpenVibe.Blog

> The official OpenVibe blog and a blog for every member: drafts, revisions, series, scheduling, feeds.

**Status:** placeholder — planning only, no runnable code yet.  
**Domain:** `openvibe.blog`  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §12.6.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

Official and user blogs with canonical URLs and feeds, reusing Media, Community comments, AI drafting workflows, themes and optional VIP gating.

## Owns

- `blogs`, `blog_memberships`, `blog_posts`, `blog_post_revisions`, `blog_series`, `blog_taxonomy`, `blog_post_terms`, `blog_schedules`, `blog_redirects`, `blog_feed_settings`

## Does not own

- comments (Community)
- media bytes (Media)
- entitlements (Billing/VIP)

## Planned surfaces

- blog creation and configuration per eligible account, draft/preview/revision/publish/unpublish/schedule, tags/categories/series, RSS/Atom and sitemaps, theme inheritance, official release notes

## Data (authority tables / families)

- see above

## Capabilities and events

- `blog.create`, `blog.post.create|update|publish|schedule|unpublish`, `blog.feed.read`, `blog.theme.set`

Events: ``blog.post.created|published|updated|unpublished|deleted``, ``blog.schedule.failed``

## Depends on

- shared publishing packages
- OpenVibe.Network
- OpenVibe.Media
- OpenVibe.Community
- themes
- Search
- optional OpenVibe.VIP

## Acceptance (must be true before "done")

- scheduled publication is idempotent across worker restarts
- feeds, canonical HTML, sitemap and search converge on publication state
- VIP-only/private posts never leak through cache, feed or search
- a deleted media object yields an explicit broken-asset state

## Bootstrap / extraction source

No current implementation; bootstraps from the shared publishing runtime (Wave 14).

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
