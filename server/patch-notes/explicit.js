'use strict';
/**
 * Blog's publishing gate: a Patch notes draft whose text says a scene shows sex acts or pornography is never
 * published (owner, 2026-10-31: nudity is art, describing people is fine; only sex and porn stay gated).
 */
const EXPLICIT = /\b(?:sexual(?:ly)?\s+(?:acts?|activity|intercourse)|sex\s+acts?|having\s+sex|(?:pornographic|sexually\s+explicit|explicit\s+adult)\s+(?:content|material|footage|scenes?|imagery|videos?|acts?)|adult\s+(?:films?|videos?)|porn(?:o|ography|ographic)?|masturbat\w*|intercourse|oral\s+sex|penetrat\w*)\b/i;
function isExplicit(...texts) {
    return texts.some((t) => t != null && EXPLICIT.test(String(t)));
}
module.exports = { isExplicit, EXPLICIT };
