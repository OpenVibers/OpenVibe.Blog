'use strict';
// Staff powers come from the openvibe-contracts staff map (ADR-022): the viewer asks staff.can() for
// staff.content.moderate (any blog) and staff.editorial.manage (the official blog); no server file
// compares a person's role by hand.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { staff } = require('openvibe-contracts');

for (const [claims, mod, ed] of [
    [{ role: 'user' }, false, false],
    [{ role: 'global_mod' }, true, false],
    [{ role: 'admin' }, true, true],
    [{ role: 'admin', staff_caps: ['staff.moderation.chat'], staff_map: '1.1.0' }, false, false],
    [{ role: 'admin', staff_caps: ['staff.moderation.chat'] }, true, true],
]) {
    assert.strictEqual(staff.can(claims, 'staff.content.moderate'), mod, JSON.stringify(claims));
    assert.strictEqual(staff.can(claims, 'staff.editorial.manage'), ed, JSON.stringify(claims));
}

const offenders = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { walk(f); continue; }
        if (!e.name.endsWith('.js')) continue;
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            if (/STAFF_ROLES|claims\.role\b|\brole\s*[!=]==?\s*['"](admin|global_mod|moderator)['"]|\.includes\(\s*claims\.role/.test(line)) offenders.push(`${path.relative(path.join(__dirname, '..'), f)}:${i + 1}`);
        });
    }
})(path.join(__dirname, '..', 'server'));
assert.deepStrictEqual(offenders, [], 'raw role checks; ask staff.can(claims, \'staff.…\') in the viewer');
console.log('staff map: all checks passed');
