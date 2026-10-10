'use strict';
// deploy/nginx/openvibe.blog.conf: Express routes case-insensitively, so the nginx guards that keep the
// internal-only paths off the public vhost must match case-insensitively too — otherwise /Metrics and
// /Internal/events fall through to `location /` and reach the Node app (answered 404/403 there today, but
// the nginx guard is what should be protecting them). The corpus-built crawl artifacts are rate-limited.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const conf = fs.readFileSync(path.join(__dirname, '..', ...'deploy/nginx/openvibe.blog.conf'.split('/')), 'utf8');

assert.match(conf, /location ~\* \^\/metrics\(\/\|\$\) \{ return 404; \}/, 'the /metrics guard is case-insensitive');
assert.match(conf, /location ~\* \^\/internal\(\/\|\$\) \{ return 404; \}/, 'the /internal/ guard is case-insensitive');
assert.ok(!conf.includes('location = /metrics'), 'no case-sensitive exact /metrics block');
assert.ok(!conf.includes('location /internal/ {'), 'no case-sensitive /internal/ prefix block');

assert.match(conf, /limit_req_zone \$binary_remote_addr zone=ovblog_crawl:10m rate=3r\/s;/);
assert.match(conf, /location \/sitemap \{[\s\S]*?limit_req zone=ovblog_crawl[^;]*;[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:4810;/, 'the sitemap is rate-limited');
assert.match(conf, /location = \/llms-full\.txt \{[\s\S]*?limit_req zone=ovblog_crawl[^;]*;/, 'llms-full.txt is rate-limited');

console.log('nginx internal guard: /Metrics and /Internal/events blocked case-insensitively; crawl artifacts rate-limited');
