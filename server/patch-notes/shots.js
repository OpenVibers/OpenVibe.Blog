'use strict';
/**
 * The screenshot pass, from the Blog's side (plan L9, devblog §3.3).
 *
 * OpenVibe.Host captures the public pages (ovhost shots, every six hours) and stores each PNG in
 * OpenVibe.Media, in Host's own tenant, with the service, the path, the viewport, the release and the
 * time it was taken. When the patch notes are drafted for a release, Blog reads that index: for the
 * page a story names, the newest shot taken before the release and the first one taken after it.
 *
 *   both    the two shots differ by more than 0.5 % of the pixels: both are attached (before, after)
 *   after   they do not: only the shot after the release is attached
 *   none    there is no shot: the draft keeps its "No screenshot" line
 *
 * A person still reviews the draft; nothing here publishes anything.
 */
const zlib = require('zlib');

/** More than this share of the pixels changed and the two shots are worth showing side by side. */
const DIFF_THRESHOLD = 0.005;
const PNG_MAGIC = 0x89504e47;
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** A PNG, decoded: { width, height, channels, data }. 8-bit, not interlaced (what Chrome writes). */
function decodePng(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (b.length < 8 || b.readUInt32BE(0) !== PNG_MAGIC) throw new Error('not a PNG');
    let pos = 8;
    let ihdr = null;
    const idat = [];
    while (pos + 8 <= b.length) {
        const len = b.readUInt32BE(pos);
        const type = b.toString('ascii', pos + 4, pos + 8);
        const data = b.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
        else if (type === 'IDAT') idat.push(Buffer.from(data));
        else if (type === 'IEND') break;
        pos += 12 + len;
    }
    if (!ihdr) throw new Error('the PNG has no header');
    if (ihdr.bitDepth !== 8) throw new Error('only 8-bit PNGs are compared');
    if (ihdr.interlace) throw new Error('an interlaced PNG cannot be compared');
    const channels = CHANNELS[ihdr.colorType];
    if (!channels) throw new Error(`unsupported PNG colour type ${ihdr.colorType}`);
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = ihdr.width * channels;
    const out = Buffer.alloc(ihdr.height * stride);
    let rp = 0;
    for (let y = 0; y < ihdr.height; y++) {
        const filter = raw[rp++];
        const line = raw.subarray(rp, rp + stride);
        rp += stride;
        const cur = out.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? cur[x - channels] : 0;
            const b = prev[x];
            const c = x >= channels ? prev[x - channels] : 0;
            let v = line[x];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += Math.floor((a + b) / 2);
            else if (filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
                v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
            }
            cur[x] = v & 0xff;
        }
    }
    return { width: ihdr.width, height: ihdr.height, channels, data: out };
}

/** The share of the pixels that differ between two PNGs (1 when the sizes differ). */
function diffRatio(a, b) {
    const x = decodePng(a);
    const y = decodePng(b);
    if (x.width !== y.width || x.height !== y.height) return 1;
    const total = x.width * x.height;
    if (!total) return 0;
    const n = Math.min(x.channels, y.channels, 3);
    let different = 0;
    for (let p = 0; p < total; p++) {
        const o = p * x.channels;
        const q = p * y.channels;
        if (x.data[o] !== y.data[q] || x.data[o + 1] !== y.data[q + 1] || x.data[o + 2] !== y.data[q + 2]) different++;
    }
    return different / total;
}

/** The shots of one page and viewport, oldest first. */
function groupKey(shot) {
    const m = (shot && shot.metadata) || {};
    return `${m.service || ''}|${m.path || ''}|${m.viewport || ''}`;
}

/**
 * The pair around a release: the newest shot taken before it and the first one taken after it.
 * answers { before, after } (either may be null).
 */
function pickPair(shots, at) {
    const list = [...(shots || [])].sort((a, b) => Date.parse((a.metadata || {}).captured_at || 0) - Date.parse((b.metadata || {}).captured_at || 0));
    const t = Date.parse(at || 0);
    let before = null;
    let after = null;
    for (const s of list) {
        const at2 = Date.parse((s.metadata || {}).captured_at || 0);
        if (Number.isFinite(t) && at2 <= t) before = s;
        else if (!after) after = s;
    }
    if (!after && before) { after = before; before = null; }
    return { before, after };
}

/** What to do with a pair: both shots, only the one after, or nothing. */
function decide(before, after, ratio) {
    if (!after) return 'none';
    if (!before) return 'after';
    return ratio > DIFF_THRESHOLD ? 'both' : 'after';
}

/** The caption of §3.3: "Before: …. After: …. 390px, <date>." */
function captionFor({ before, after, viewport = 'phone', date = '', whatWasWrong = null, whatChanged = null }) {
    const wrong = whatWasWrong || 'the page looked different';
    const changed = whatChanged || 'the page changed';
    const width = viewport === 'desktop' ? '1440px' : '390px';
    const when = date || new Date().toISOString().slice(0, 10);
    return `Before: ${wrong}. After: ${changed}. ${width}, ${when}.`;
}

/** The alt text of §3.3: "Two phone screens. Left: …. Right: …." */
function altFor({ mode, whatWasWrong = null, whatChanged = null }) {
    const wrong = whatWasWrong || 'the page before this release';
    const changed = whatChanged || 'the page after this release';
    if (mode === 'both') return `Two phone screens. Left: ${wrong}. Right: ${changed}.`;
    return `A phone screen: ${changed}.`;
}

module.exports = { DIFF_THRESHOLD, decodePng, diffRatio, groupKey, pickPair, decide, captionFor, altFor };
