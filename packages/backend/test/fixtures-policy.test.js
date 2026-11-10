import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Test data must never contain a phone number that could belong to someone.
// Only numbers reserved for fiction are allowed:
//   US/Canada  +1 NXX 555 0100-0199
//   UK London  +44 20 7946 0000-0999 (Ofcom's drama range)
const RESERVED = [/^\+1\d{3}55501\d{2}$/, /^\+442079460\d{3}$/];

// E.164-looking literals: a "+" followed by 8 to 15 digits.
const PHONE_LITERAL = /\+\d{8,15}(?!\d)/g;

const thisFile = fileURLToPath(import.meta.url);
const testRoot = path.dirname(thisFile);
const repoRoot = path.resolve(testRoot, '../../..');

function sourceFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === 'node_modules') return [];
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return /\.(js|ts|tsx)$/.test(entry.name) ? [full] : [];
    });
}

// This file is skipped: it has to spell out the patterns and number prefixes.
const scanned = [
    ...sourceFiles(testRoot),
    ...sourceFiles(path.join(repoRoot, 'packages/frontend/test')),
    ...sourceFiles(path.join(repoRoot, 'tests'))
].filter((file) => file !== thisFile);

test('test fixtures only use phone numbers reserved for fiction', () => {
    assert.ok(scanned.length > 5, 'the scan found the test files');

    const offenders = [];
    for (const file of scanned) {
        const text = fs.readFileSync(file, 'utf8');
        for (const match of text.matchAll(PHONE_LITERAL)) {
            if (!RESERVED.some((allowed) => allowed.test(match[0]))) {
                offenders.push(`${path.relative(repoRoot, file)}: ${match[0]}`);
            }
        }
    }

    assert.deepEqual(offenders, []);
});

test('the policy itself recognises reserved and non-reserved numbers', () => {
    const ok = (n) => RESERVED.some((allowed) => allowed.test(n));
    assert.equal(ok('+14155550100'), true);
    assert.equal(ok('+12125550199'), true);
    assert.equal(ok('+442079460123'), true);
    // Built from parts so that this file contains no out-of-range literal itself.
    assert.equal(ok('+1415555' + '0200'), false, '555-0200 is outside the reserved block');
    assert.equal(ok('+1415555' + '1234'), false);
    assert.equal(ok('+44207946' + '1000'), false);
    assert.equal(ok('+44207183' + '0000'), false);
});
