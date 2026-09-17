import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeAddress,
  addressKey,
  levenshtein,
  similarity,
  addressesMatch,
  findDuplicateGroups,
  distinctiveStreetToken,
} from '../src/core/address.js';

test('normalizeAddress canonicalises street suffixes', () => {
  assert.equal(normalizeAddress('1420 Kestrel Ave'), '1420 KESTREL AVENUE');
  assert.equal(normalizeAddress('1420 Kestrel Avenue'), '1420 KESTREL AVENUE');
  assert.equal(normalizeAddress('2900 Basalt Ridge Rd'), '2900 BASALT RIDGE ROAD');
});

test('normalizeAddress canonicalises directionals', () => {
  assert.equal(normalizeAddress('88 N Main St'), '88 NORTH MAIN STREET');
  assert.equal(normalizeAddress('88 North Main Street'), '88 NORTH MAIN STREET');
});

test('normalizeAddress drops sub-building designators', () => {
  // A suite number does not make a second structure. This is the PKT-008 case.
  assert.equal(
    normalizeAddress('2900 Basalt Ridge Road, Suite 100'),
    normalizeAddress('2900 Basalt Ridge Rd'),
  );
  assert.equal(normalizeAddress('10 Harbor Way #3'), '10 HARBOR WAY');
  assert.equal(normalizeAddress('10 Harbor Way Floor 2'), '10 HARBOR WAY');
});

test('normalizeAddress tolerates absent input', () => {
  assert.equal(normalizeAddress(null), '');
  assert.equal(normalizeAddress(undefined), '');
  assert.equal(normalizeAddress('   '), '');
});

test('addressKey keeps identical streets in different towns apart', () => {
  assert.notEqual(addressKey('100 Main St', '11111'), addressKey('100 Main St', '22222'));
  assert.equal(addressKey('100 Main St', '11111'), addressKey('100 MAIN STREET', '11111'));
});

test('levenshtein computes known distances', () => {
  assert.equal(levenshtein('', ''), 0);
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('flaw', 'lawn'), 2);
});

test('similarity is symmetric and bounded', () => {
  assert.equal(similarity('', ''), 1);
  assert.equal(similarity('abc', 'abc'), 1);
  assert.equal(similarity('abc', 'xyz'), 0);
  assert.equal(similarity('abcd', 'abcx'), similarity('abcx', 'abcd'));
});

test('exact matching misses a suffix spelling difference - the v1 behaviour', () => {
  const a = { address: '1420 Kestrel Ave', zip: '46514' };
  const b = { address: '1420 Kestrel Avenue', zip: '46514' };

  const strict = addressesMatch(a, b, { fuzzy: false });
  assert.equal(strict.match, false);
  assert.equal(strict.basis, 'none');
});

test('normalised matching catches a suffix spelling difference - the v2 behaviour', () => {
  const a = { address: '1420 Kestrel Ave', zip: '46514' };
  const b = { address: '1420 Kestrel Avenue', zip: '46514' };

  const loose = addressesMatch(a, b, { fuzzy: true });
  assert.equal(loose.match, true);
  assert.equal(loose.basis, 'exact-normalized');
});

test('identical raw addresses match without normalisation', () => {
  const a = { address: '7 Foundry Lane', zip: '16505' };
  const b = { address: '7 Foundry Lane', zip: '16505' };
  assert.deepEqual(addressesMatch(a, b, { fuzzy: false }), {
    match: true,
    score: 1,
    basis: 'exact-raw',
  });
});

test('fuzzy matching is gated on a shared postcode', () => {
  // Same street spelling, different towns: must never merge, however similar.
  const a = { address: '500 Lakeshore Promenade', zip: '53703' };
  const b = { address: '500 Lakeshore Promenade', zip: '53711' };
  assert.equal(addressesMatch(a, b, { fuzzy: true }).match, false);
});

test('fuzzy matching tolerates a typo inside one postcode', () => {
  const a = { address: '9400 Trunkline Road', zip: '95678' };
  const b = { address: '9400 Trunkiine Road', zip: '95678' };
  const result = addressesMatch(a, b, { fuzzy: true });
  assert.equal(result.match, true);
  assert.equal(result.basis, 'fuzzy');
  assert.ok(result.score >= 0.92, `expected a high similarity, got ${result.score}`);
});

test('fuzzy matching rejects genuinely different streets in one postcode', () => {
  const a = { address: '288 Loom Street', zip: '29601' };
  const b = { address: '3301 Carding Road', zip: '29601' };
  assert.equal(addressesMatch(a, b, { fuzzy: true }).match, false);
});

test('an empty address never matches anything', () => {
  assert.equal(addressesMatch({ address: '', zip: '1' }, { address: '', zip: '1' }).match, false);
  assert.equal(
    addressesMatch({ address: null, zip: '1' }, { address: '10 A St', zip: '1' }, { fuzzy: true })
      .match,
    false,
  );
});

test('findDuplicateGroups keeps the first occurrence', () => {
  const rows = [
    { address: '2900 Basalt Ridge Rd', zip: '97124' },
    { address: '2900 Basalt Ridge Road, Suite 100', zip: '97124' },
    { address: '145 Quarry Point Loop', zip: '97123' },
  ];

  const groups = findDuplicateGroups(rows, { fuzzy: true });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keepIndex, 0);
  assert.deepEqual(groups[0].duplicateIndexes, [1]);
});

test('findDuplicateGroups finds nothing under exact matching', () => {
  const rows = [
    { address: '2900 Basalt Ridge Rd', zip: '97124' },
    { address: '2900 Basalt Ridge Road, Suite 100', zip: '97124' },
  ];
  assert.deepEqual(findDuplicateGroups(rows, { fuzzy: false }), []);
});

test('findDuplicateGroups does not double-claim a row', () => {
  const rows = [
    { address: '10 Elm Street', zip: '11111' },
    { address: '10 Elm St', zip: '11111' },
    { address: '10 ELM STREET', zip: '11111' },
  ];
  const groups = findDuplicateGroups(rows, { fuzzy: true });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].duplicateIndexes, [1, 2]);
});

test('distinctiveStreetToken picks the identifying word', () => {
  assert.equal(distinctiveStreetToken('14 Spindle Court'), 'SPINDLE');
  assert.equal(distinctiveStreetToken('145 Quarry Point Loop'), 'QUARRY');
  assert.equal(distinctiveStreetToken('500 Lakeshore Promenade'), 'LAKESHORE');
});

test('distinctiveStreetToken declines when nothing is distinctive enough', () => {
  // Too short to anchor a prose search without hitting unrelated sentences.
  assert.equal(distinctiveStreetToken('5 Elm St'), null);
  assert.equal(distinctiveStreetToken('100'), null);
  assert.equal(distinctiveStreetToken(null), null);
});
