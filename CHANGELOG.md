# Changelog

## Unreleased

- Every page is rendered through `openvibe-publishing/layout` (v1.2.0, on `openvibe-shared/shell` v2.6.0): the head, the Frame, the noscript navigation, the footer and its init come from the shared document; robots and the canonical still come from the indexability gate's decision, and a blog's theme preset stays on its content surface. The shell adds `web-runtime.js`, so the home page's JS budget is raised to 5 files, 245 KB, 59 KB brotli (measured 239.1 KB, 56.3 KB brotli; 212.2 KB, 49.9 KB before).
