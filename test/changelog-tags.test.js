'use strict';
/**
 * The changelog vocabulary (plan §9): the fixed kinds and areas, the deterministic plain words,
 * the housekeeping rule that never asks a model, and the tagger's answer parser. The feed's filters
 * and the blog.changelog-entry@2 contract repeat this exact list, so the count matters.
 */
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { check, done } = require('./helpers/boot');
const tags = require('../server/changelog/tags');
const { tagsFrom, parseLoose, createChangelogTagger } = require('../server/changelog/tagger');

(async () => {
    await check('the vocabulary is 30 fixed areas and four kinds, with no duplicates', async () => {
        assert.deepStrictEqual(tags.KINDS, ['new', 'better', 'fixed', 'internal']);
        assert.strictEqual(tags.AREAS.length, 30);
        assert.strictEqual(new Set(tags.AREA_IDS).size, 30);
        assert.strictEqual(tags.AREAS.filter((a) => a.id === 'go-live')[0].label, 'Go live');
        assert.strictEqual(tags.AREAS.filter((a) => a.id === 'machines')[0].label, 'Machines (Link)');
        assert.ok(tags.AREAS.every((a) => /^[a-z][a-z0-9-]*$/.test(a.id)));
        const v = tags.vocabulary();
        assert.deepStrictEqual(v.kinds, tags.KINDS);
        assert.strictEqual(v.areas.length, 30);
    });

    await check('plain words drop the PR number and stage tag, and keep the subject', async () => {
        assert.strictEqual(tags.plainOf('Recent changes card: show the newest devblog with its art (#714)'), 'Recent changes card: show the newest devblog with its art');
        assert.strictEqual(tags.plainOf('[A6] Add the changelog tags (#61)'), 'Add the changelog tags');
        assert.strictEqual(tags.plainOf('feat(chat): show the newest devblog'), 'show the newest devblog');
        assert.strictEqual(tags.plainOf('0.376.0: Complete the Feed contract'), 'Complete the Feed contract');
        assert.strictEqual(tags.plainOf(''), 'A change');
        assert.strictEqual(tags.prOf('A change (#714)'), 714);
        assert.strictEqual(tags.prOf('A change'), null);
    });

    await check('housekeeping is internal without a model: pins, merges, test/docs/CI-only work', async () => {
        for (const s of [
            'openvibe-shared v4.175.0 (was v4.173.0) (#401)',
            'Pin openvibe-contracts 0.379.0',
            'Merge branch main',
            'Merge pull request #12 from x/y',
            'test: cover the filters',
            'docs(readme): the new call',
            'ci: rerun',
            'chore: deps',
            '0.376.0: Complete the Feed contract',
            'Tidy the docs',
        ]) assert.strictEqual(tags.isHousekeeping(s), true, s);
        for (const s of ['Recent tools in the launcher', 'Make sign-in faster']) {
            assert.strictEqual(tags.isHousekeeping(s), false, s);
            const initial = tags.initial(s);
            assert.strictEqual(initial.kind, null, `${s} waits for the model`);
            assert.ok(initial.plain.length > 0);
        }
        assert.strictEqual(tags.initial('Fix the chat scroll').kind, 'fixed');
        const hk = tags.initial('openvibe-shared v4.175.0 (was v4.173.0) (#401)');
        assert.strictEqual(hk.kind, 'internal');
        assert.deepStrictEqual(hk.areas, []);
        assert.strictEqual(hk.plain, 'openvibe-shared v4.175.0 (was v4.173.0)');
    });

    await check('clear commit subjects are classified before the AI task', async () => {
        for (const subject of ['Add a watch page', 'feat: Add project sharing', 'Introduce saved searches']) assert.strictEqual(tags.initial(subject).kind, 'new', subject);
        for (const subject of ['Fix the player controls', 'fix(chat): stop duplicate messages', 'No longer drops the last frame', 'Keep the image whole']) assert.strictEqual(tags.initial(subject).kind, 'fixed', subject);
        assert.strictEqual(tags.initial('Improve the chat history').kind, null, 'ambiguous improvements are left to the AI task');
        assert.deepStrictEqual(tags.fallbackTag('Improve the chat history'), { kind: 'better', areas: ['chat'], plain: 'Improve the chat history' }, 'ambiguous or unavailable AI output defaults to Improved');
    });

    await check('a model answer is made safe: a known kind, up to three known areas, plain words', async () => {
        assert.deepStrictEqual(tags.normalizeTag({ kind: 'new', areas: ['video', 'chat'], plain: 'Watch the clip' }), { kind: 'new', areas: ['video', 'chat'], plain: 'Watch the clip' });
        assert.deepStrictEqual(tags.normalizeTag({ kind: 'fixed', areas: ['chat', 'chat', 'podcast'], plain: 'Fix the chat (#2)' }), { kind: 'fixed', areas: ['chat'], plain: 'Fix the chat' });
        assert.deepStrictEqual(tags.normalizeTag({ kind: 'internal', areas: ['chat'], plain: 'Pin a library' }), { kind: 'internal', areas: ['chat'], plain: 'Pin a library' });
        assert.strictEqual(tags.normalizeTag({ kind: 'improvement', areas: ['chat'], plain: 'x' }), null);
        assert.strictEqual(tags.normalizeTag({ kind: 'new', areas: [], plain: 'x' }), null, 'a non-internal change has an area');
        assert.strictEqual(tags.normalizeTag({ kind: 'new', areas: ['podcast'], plain: 'x' }), null, 'unknown areas are dropped, leaving none');
        assert.strictEqual(tags.normalizeTag(null), null);
    });

    await check('a tagger answer is read from { tags } or from ai.generate\'s JSON text', async () => {
        const tagsList = [{ id: '1', kind: 'new', areas: ['video'], plain: 'Watch the clip' }];
        assert.deepStrictEqual(tagsFrom({ tags: tagsList }), tagsList);
        assert.deepStrictEqual(tagsFrom({ text: JSON.stringify({ tags: tagsList }) }), tagsList);
        assert.deepStrictEqual(tagsFrom({ text: '```json\n{"tags":[]}\n```' }), []);
        assert.deepStrictEqual(parseLoose('not json'), null);
        assert.deepStrictEqual(tagsFrom(null), []);
    });

    await check('the tagger is on by default and CHANGELOG_AI_TAG=off turns it off', async () => {
        const config = require('../server/config');
        assert.strictEqual(config.load({}).changelog.tag, true);
        assert.strictEqual(config.load({ CHANGELOG_AI_TAG: 'off' }).changelog.tag, false);
    });

    await check('the tagger asks AI for the blog.changelog.tag task, as a service, and reads its answer', async () => {
        const seen = { token: null, run: null };
        const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
        const fetchImpl = async (url, opts = {}) => {
            if (String(url).includes('/oauth/token')) { seen.token = String(opts.body); return await json({ access_token: 'svc', token_type: 'Bearer', expires_in: 300 }); }
            if (String(url).includes('/api/v1/runs')) { seen.run = { url: String(url), body: JSON.parse(opts.body), auth: opts.headers.Authorization }; return await json({ run: { id: 'run_1', status: 'succeeded', workflow: { key: 'blog.changelog.tag' }, output: { tags: [
                { id: '7', kind: 'new', areas: ['chat', 'video'], plain: 'A calmer chat' },
                { id: '8', kind: 'improvement', areas: ['chat'], plain: 'dropped: unknown kind' },
            ] } } }, 201); }
            return await json({}, 404);
        };
        const tagger = createChangelogTagger({ config: {
            aiUrl: 'http://ai.test', networkInternalUrl: 'http://network.test', oauth: { clientId: 'blog', clientSecret: 'shh' }, changelog: { tag: true },
        }, fetchImpl });
        assert.strictEqual(tagger.enabled, true);
        const answer = await tagger.tag([{ id: 7, service: 'live', subject: 'Add a calmer chat (#9)', repo: 'OpenVibers/OpenVibe.Live' }]);
        assert.strictEqual(seen.run.body.task, 'blog.changelog.tag');
        assert.strictEqual(seen.run.body.workflow, 'blog.changelog.tag', 'the AI API checks the workflow namespace before resolving the task');
        assert.strictEqual(seen.run.body.target.service, 'blog');
        assert.deepStrictEqual(seen.run.body.input.entries, [{ id: '7', service: 'live', subject: 'Add a calmer chat (#9)', repo: 'OpenVibers/OpenVibe.Live' }]);
        assert.match(seen.token, /audience=openvibe\.ai/);
        assert.strictEqual(seen.run.auth, 'Bearer svc');
        assert.deepStrictEqual(answer.get('7'), { kind: 'new', areas: ['chat', 'video'], plain: 'A calmer chat' });
        assert.strictEqual(answer.has('8'), false, 'an unknown kind is not written');
        assert.strictEqual((await createChangelogTagger({ config: { aiUrl: '', networkInternalUrl: '', oauth: {}, changelog: { tag: true } }, fetchImpl }).tag([{ id: 1 }])).size, 0, 'unconfigured is off');
    });

    await check('synthetic AI output is discarded so it cannot overwrite changelog subjects', async () => {
        const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
        const fetchImpl = async (url, opts = {}) => {
            if (String(url).includes('/oauth/token')) return await json({ access_token: 'svc', token_type: 'Bearer', expires_in: 300 });
            if (String(url).includes('/api/v1/runs')) return await json({ run: { id: 'run_synth', status: 'succeeded', synthetic: true, output: { tags: [{ id: '7', kind: 'internal', areas: [], plain: 'synthetic' }] } } }, 201);
            return await json({}, 404);
        };
        const tagger = createChangelogTagger({ config: {
            aiUrl: 'http://ai.test', networkInternalUrl: 'http://network.test', oauth: { clientId: 'blog', clientSecret: 'shh' }, changelog: { tag: true },
        }, fetchImpl, log: { warn() {} } });
        assert.strictEqual((await tagger.tag([{ id: '7', service: 'blog', subject: 'Improve the page' }])).size, 0);
    });

    await check('the backfill script is safe by default: it prints what it would do and writes nothing', async () => {
        const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'backfill-changelog-tags.js'), '--help'], { encoding: 'utf8' });
        assert.match(out, /--apply/);
        assert.match(out, /--production/);
    });

    done();
})();
