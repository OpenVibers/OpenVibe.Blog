'use strict';
/**
 * The screenshot pass, from the Blog's side (server/patch-notes/shots.js, plan L9, devblog §3.3):
 * the newest shot before a release and the first one after it are compared; more than 0.5 % of the
 * pixels changed and both are attached, otherwise only the one after is; no shot at all and the
 * draft keeps its "No screenshot" line.
 */
const assert = require('assert');
const zlib = require('zlib');
const { diffRatio, pickPair, decide, captionFor, altFor, DIFF_THRESHOLD, groupKey } = require('../server/patch-notes/shots');

/** A PNG (8-bit RGB, no filter): one colour per pixel. */
function png(width, height, pixels) {
    const stride = width * 3;
    const raw = Buffer.alloc(height * (1 + stride));
    for (let y = 0; y < height; y++) {
        const row = y * (1 + stride);
        raw[row] = 0;
        for (let x = 0; x < width; x++) {
            const p = pixels[y * width + x];
            raw[row + 1 + x * 3] = p[0];
            raw[row + 2 + x * 3] = p[1];
            raw[row + 3 + x * 3] = p[2];
        }
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const t = Buffer.from(type, 'ascii');
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])));
        return Buffer.concat([len, t, data, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;    // 8 bits
    ihdr[9] = 2;    // truecolour
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const flat = (w, h, colour) => png(w, h, Array.from({ length: w * h }, () => colour));

const shot = (id, { service = 'live', path = '/', viewport = 'phone', at = '2026-11-01T00:00:00Z', release = 'abc123' } = {}) => ({
    id,
    metadata: { service, path, viewport, release, captured_at: at },
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const run = async () => {
    for (const t of tests) {
        await t.fn();
        process.stdout.write(`✓ ${t.name}\n`);
    }
};

(async () => {
    test('two identical shots differ in no pixel', async () => {
        assert.strictEqual(diffRatio(flat(10, 10, [10, 20, 30]), flat(10, 10, [10, 20, 30])), 0);
    });

    test('one changed pixel in a hundred is more than the 0.5 % threshold', async () => {
        const before = flat(10, 10, [0, 0, 0]);
        const pixels = Array.from({ length: 100 }, () => [0, 0, 0]);
        pixels[0] = [255, 255, 255];            // one pixel of the hundred changed
        const after = png(10, 10, pixels);
        const ratio = diffRatio(before, after);
        assert.ok(ratio > DIFF_THRESHOLD, `${ratio} is more than ${DIFF_THRESHOLD}`);
        assert.strictEqual(decide({ id: 'a' }, { id: 'b' }, ratio), 'both');
    });

    test('shots of a different size count as different', async () => {
        assert.strictEqual(diffRatio(flat(10, 10, [0, 0, 0]), flat(20, 10, [0, 0, 0])), 1);
    });

    test('the pair around a release is the newest shot before it and the first one after it', async () => {
        const list = [
            shot('a', { at: '2026-10-30T00:00:00Z' }),
            shot('b', { at: '2026-10-31T00:00:00Z' }),
            shot('c', { at: '2026-11-02T00:00:00Z' }),
            shot('d', { at: '2026-11-03T00:00:00Z' }),
        ];
        const pair = pickPair(list, '2026-11-01T12:00:00Z');
        assert.deepStrictEqual([pair.before.id, pair.after.id], ['b', 'c']);
    });

    test('the shots of one page and viewport share a key', async () => {
        assert.strictEqual(groupKey(shot('a', { service: 'blog', path: '/pricing' })), 'blog|/pricing|phone');
    });

    test('without a pair of shots nothing is attached', async () => {
        assert.strictEqual(decide(null, null, 0), 'none');
        assert.strictEqual(decide(null, { id: 'a' }, 0), 'after');
    });

    test('the caption and the alt text follow the formula of §3.3', async () => {
        const caption = captionFor({ viewport: 'phone', date: '2026-11-06', whatWasWrong: 'the page ran wider than the phone', whatChanged: 'it fits now' });
        assert.strictEqual(caption, 'Before: the page ran wider than the phone. After: it fits now. 390px, 2026-11-06.');
        assert.strictEqual(altFor({ mode: 'both', whatWasWrong: 'it was too wide', whatChanged: 'it fits now' }), 'Two phone screens. Left: it was too wide. Right: it fits now.');
        assert.ok(altFor({ mode: 'after', whatChanged: 'it fits now' }).length > 0, 'the single shot has alt text too');
    });

    await run();
    console.log('patch notes shots: the pair, the 0.5 % threshold, the caption and the alt text');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
