# Changelog

## Unreleased

- The screenshot pass, from the Blog's side (plan L9, devblog §3.3): when the patch notes are drafted, Blog reads the shots
  OpenVibe.Host captured (the newest one taken before the release and the first one taken after it, per page and viewport).
  When the two differ by more than 0.5 % of the pixels, both are attached to the draft (before, after) with the alt text and the
  caption of §3.3; when they do not, only the shot after the release is attached; when there is no shot, the draft keeps its
  "No screenshot" line. A person still reviews the draft; nothing publishes itself.

- Patch notes: one waiting draft per day (2026-11-02). A person reviews every Patch notes post, and drafts filed every
  few hours piled up faster than anyone could read them (27 waiting, none published since v2). A batch whose day
  already has a waiting draft nobody has touched is folded into it: a fresh draft from all of the day's commits, the
  old one soft-deleted, so a reviewer opens one post per day. Each tick folds the backlog the same way. A draft a
  person edited or reviewed is never folded.
- Account export and deletion (ADR-033): `POST /internal/events` (loopback, `BLOG_EVENTS_SECRET`) answers network.account.export_requested and network.account.deleted through `server/domain/account-data.js` over `openvibe-sdk/account-data` (SDK v0.37.0, was v0.35.0).
  - **Their own blog:** its posts are removed and the blog closed.
  - **Elsewhere:** their posts stay without their id.
  - **Deleted:** memberships, drafts and the name cache.
  - **Kept:** reviews.
  - Migration `0002_account_erasure.sql` adds `account_data_events` and lets only the erasure transaction clear the author on the append-only revisions and citations. The two subscriptions are created at boot. `test/account-data.test.js`.
- openvibe-contracts moves from v0.79.0 to v0.97.0 (pin, lockfile and `node_modules`); nothing in the range breaks Blog, and the contracts' own service check is green. All twelve `blog.*` ids are now defined by the release, so `server/auth/capabilities.js` drops its local fallback for proposed ids and sends every check through the library's grant rule; `test/capabilities.test.js` pins that every guarded id is defined and that exact, prefix, denied and unknown ids answer as `capabilities.check()` does. README and STATUS.json name v0.97.0.
- Every page is rendered through `openvibe-publishing/layout` (v1.2.0, on `openvibe-shared/shell` v2.6.0): the head, the Frame, the noscript navigation, the footer and its init come from the shared document; robots and the canonical still come from the indexability gate's decision, and a blog's theme preset stays on its content surface. The shell adds `web-runtime.js`, so the home page's JS budget is raised to 5 files, 245 KB, 59 KB brotli (measured 239.1 KB, 56.3 KB brotli; 212.2 KB, 49.9 KB before).
