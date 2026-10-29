'use strict';
// What openvibe.blog tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this host really serves: the public front page, every blog's index and its
// published posts, the JSON API under /api/v1 and its OpenAPI document, llms.txt/llms-full.txt and the
// sitemap. No separate documentation page is published, so none is named.
module.exports = {
    id: 'blog',
    name: 'OpenVibe.Blog',
    purpose: 'The official OpenVibe blog and a blog for every member: authored posts with citations, series, categories and a correction history.',
    home: 'https://openvibe.blog',
    site: 'openvibe.blog',
    api: '/api/v1',
    openapi: '/openapi.json',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: 'The public pages are not limited by the app; /api/v1 is limited to 240 requests a minute per address and sign-in attempts to 60 per 15 minutes',
    },
};
