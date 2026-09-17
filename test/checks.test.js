import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runChecks,
  appetiteOutcome,
  lossRatioOutcome,
  CONFIDENCE_FLOOR,
  GUIDELINE_DISCLAIMER,
} from '../src/core/checks.js';
import { makeContext, makeLocation, makeLoss, checkById } from './fixtures.js';

/**
 * @param {Parameters<typeof makeContext>[0]} [spec]
 */
function checks(spec) {
  return runChecks(makeContext(spec));
}

test('every check carries the "not real guidance" disclaimer', () => {
  // The brief is explicit that no real insurance guidance may be presented as
  // authoritative. That has to be a property of the data, not of the README.
  for (const check of checks()) {
    assert.equal(check.disclaimer, GUIDELINE_DISCLAIMER, `${check.id} is missing its disclaimer`);
  }
});

test('the checks run in a stable order', () => {
  assert.deepEqual(
    checks().map((c) => c.id),
    ['GL-001', 'GL-002', 'GL-003', 'GL-004', 'GL-005'],
  );
});

/* ------------------------------------------------------------------ *
 * GL-001 - appetite ceiling
 * ------------------------------------------------------------------ */

test('appetiteOutcome puts the boundary above the ceiling, not at it', () => {
  assert.equal(appetiteOutcome(40_000_000, 40_000_000), 'pass');
  assert.equal(appetiteOutcome(40_000_001, 40_000_000), 'flag');
  assert.equal(appetiteOutcome(0, 40_000_000), 'pass');
  assert.equal(appetiteOutcome(null, 40_000_000), 'not_evaluated');
});

test('GL-001 passes a schedule that foots to exactly the ceiling', () => {
  const result = checkById(
    checks({
      locations: [
        makeLocation('L1', { buildingValue: 40_000_000, contentsValue: 0, biValue: 0 }),
      ],
    }),
    'GL-001',
  );
  assert.equal(result.status, 'pass');
  assert.equal(result.inputs.computedTiv, 40_000_000);
});

test('GL-001 flags a schedule one dollar over', () => {
  const result = checkById(
    checks({
      locations: [
        makeLocation('L1', { buildingValue: 40_000_001, contentsValue: 0, biValue: 0 }),
      ],
    }),
    'GL-001',
  );
  assert.equal(result.status, 'flag');
  assert.match(result.detail, /exceeds/);
});

test('GL-001 is a pure rule change between versions', () => {
  // Same schedule, same extraction, different ceiling. This is the control
  // case in the scorecard: a packet that moves only here moved because of a
  // business rule, not because the extractor changed.
  const locations = [makeLocation('L1', { buildingValue: 45_000_000, contentsValue: 0, biValue: 0 })];

  assert.equal(checkById(checks({ locations }), 'GL-001').status, 'flag');
  assert.equal(
    checkById(checks({ locations, guidelines: { tivCeiling: 50_000_000 } }), 'GL-001').status,
    'pass',
  );
});

test('GL-001 declines to evaluate when nothing on the schedule was readable', () => {
  const result = checkById(checks({ locations: [] }), 'GL-001');
  assert.equal(result.status, 'not_evaluated');
  assert.equal(result.inputs.computedTiv, null);
});

/* ------------------------------------------------------------------ *
 * GL-002 - data completeness
 * ------------------------------------------------------------------ */

test('GL-002 passes a packet with everything present', () => {
  const result = checkById(checks(), 'GL-002');
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.inputs.missingRequired, []);
  assert.deepEqual(result.inputs.missingSupporting, []);
});

test('GL-002 separates required values from merely useful ones', () => {
  const missingRequired = checkById(checks({ fields: { insuredName: null } }), 'GL-002');
  assert.equal(missingRequired.status, 'flag');
  assert.deepEqual(missingRequired.inputs.missingRequired, ['insuredName']);
  assert.deepEqual(missingRequired.inputs.missingSupporting, []);

  const missingSupporting = checkById(
    checks({ locations: [makeLocation('L1', { yearBuilt: null })] }),
    'GL-002',
  );
  assert.equal(missingSupporting.status, 'flag');
  assert.deepEqual(missingSupporting.inputs.missingRequired, []);
  assert.deepEqual(missingSupporting.inputs.missingSupporting, ['L1.yearBuilt']);
});

test('GL-002 treats a low-confidence read as unread', () => {
  // A value the extractor guessed at is not a value it read. This is the floor
  // that keeps a back-filled figure from satisfying a required field.
  const result = checkById(
    checks({
      locations: [
        makeLocation('L1', {
          buildingValue: { value: 900_000, confidence: CONFIDENCE_FLOOR - 0.1 },
        }),
      ],
    }),
    'GL-002',
  );
  assert.equal(result.status, 'flag');
  assert.deepEqual(result.inputs.missingRequired, ['L1.buildingValue']);
});

test('GL-002 accepts a value sitting exactly on the confidence floor', () => {
  const result = checkById(
    checks({
      locations: [makeLocation('L1', { buildingValue: { value: 900_000, confidence: CONFIDENCE_FLOOR } })],
    }),
    'GL-002',
  );
  assert.deepEqual(result.inputs.missingRequired, []);
});

test('GL-002 flags a schedule with no rows at all', () => {
  const result = checkById(checks({ locations: [] }), 'GL-002');
  assert.equal(result.status, 'flag');
  assert.ok(result.inputs.missingRequired.includes('locations'));
});

test('GL-002 reports per-location field names, not just a count', () => {
  const result = checkById(
    checks({
      locations: [makeLocation('L1'), makeLocation('L2', { address: '9 Tannery Row', constructionType: null })],
    }),
    'GL-002',
  );
  assert.deepEqual(result.inputs.missingSupporting, ['L2.constructionType']);
});

/* ------------------------------------------------------------------ *
 * GL-003 - effective date window
 * ------------------------------------------------------------------ */

test('GL-003 passes a normal renewal date and reports a real day count', () => {
  // Regression guard: the day count was once computed on the ISO strings
  // themselves, which yields NaN and silently disables both branches below.
  const result = checkById(checks(), 'GL-003');
  assert.equal(result.status, 'pass');
  assert.equal(result.inputs.days, 30);
  assert.ok(Number.isFinite(result.inputs.months));
});

test('GL-003 flags an effective date that precedes the submission', () => {
  const result = checkById(
    checks({ fields: { receivedDate: '2026-03-02', requestedEffectiveDate: '2026-02-01' } }),
    'GL-003',
  );
  assert.equal(result.status, 'flag');
  assert.equal(result.inputs.days, -29);
  assert.match(result.detail, /without cover/);
});

test('GL-003 allows a submission exactly twelve months ahead', () => {
  const result = checkById(
    checks({ fields: { receivedDate: '2026-03-02', requestedEffectiveDate: '2027-03-02' } }),
    'GL-003',
  );
  assert.equal(result.status, 'pass');
  assert.equal(result.inputs.months, 12);
});

test('GL-003 flags a submission beyond the twelve-month window', () => {
  const result = checkById(
    checks({ fields: { receivedDate: '2026-03-02', requestedEffectiveDate: '2027-04-01' } }),
    'GL-003',
  );
  assert.equal(result.status, 'flag');
  assert.ok(result.inputs.months > 12);
  assert.match(result.detail, /stale by inception/);
});

test('GL-003 declines to evaluate an unreadable date', () => {
  const unread = checkById(
    checks({ fields: { requestedEffectiveDate: { value: null, confidence: 0.2 } } }),
    'GL-003',
  );
  assert.equal(unread.status, 'not_evaluated');

  const malformed = checkById(checks({ fields: { receivedDate: '03/02/2026' } }), 'GL-003');
  assert.equal(malformed.status, 'not_evaluated');
});

/* ------------------------------------------------------------------ *
 * GL-004 - loss ratio
 * ------------------------------------------------------------------ */

test('lossRatioOutcome guards against a zero or absent denominator', () => {
  assert.equal(lossRatioOutcome(5_000, 0, 1.5), 'not_evaluated');
  assert.equal(lossRatioOutcome(5_000, null, 1.5), 'not_evaluated');
  assert.equal(lossRatioOutcome(null, 1_000_000, 1.5), 'not_evaluated');
  assert.equal(lossRatioOutcome(0, 1_000_000, 1.5), 'pass');
});

test('GL-004 passes a ratio sitting exactly on the threshold', () => {
  const result = checkById(
    checks({
      locations: [makeLocation('L1', { buildingValue: 1_000_000, contentsValue: 0, biValue: 0 })],
      losses: [makeLoss('loss-1', { paid: 15_000, reserved: 0 })],
    }),
    'GL-004',
  );
  assert.equal(result.status, 'pass');
  assert.equal(result.inputs.ratioPct, 1.5);
});

test('GL-004 flags a ratio one dollar over the threshold', () => {
  const result = checkById(
    checks({
      locations: [makeLocation('L1', { buildingValue: 1_000_000, contentsValue: 0, biValue: 0 })],
      losses: [makeLoss('loss-1', { paid: 15_001, reserved: 0 })],
    }),
    'GL-004',
  );
  assert.equal(result.status, 'flag');
  assert.match(result.detail, /above the 1\.5% threshold/);
});

test('GL-004 sums paid and reserved, not just paid', () => {
  const result = checkById(
    checks({
      locations: [makeLocation('L1', { buildingValue: 1_000_000, contentsValue: 0, biValue: 0 })],
      losses: [makeLoss('loss-1', { paid: 10_000, reserved: 8_000 })],
    }),
    'GL-004',
  );
  assert.equal(result.inputs.incurred, 18_000);
  assert.equal(result.status, 'flag');
});

test('GL-004 declines to evaluate a packet with no loss run in scope', () => {
  const result = checkById(checks({ losses: [] }), 'GL-004');
  assert.equal(result.status, 'not_evaluated');
});

/* ------------------------------------------------------------------ *
 * GL-005 - duplicate locations
 * ------------------------------------------------------------------ */

const DUPLICATE_PAIR = [
  makeLocation('L1', { address: '400 Kiln Street', zip: '62704' }),
  makeLocation('L2', { address: '400 Kiln St', zip: '62704' }),
];

test('GL-005 passes a schedule with no repeats', () => {
  const result = checkById(
    checks({ locations: [makeLocation('L1'), makeLocation('L2', { address: '9 Tannery Row' })] }),
    'GL-005',
  );
  assert.equal(result.status, 'pass');
  assert.equal(result.inputs.duplicateGroups, 0);
});

test('GL-005 under exact matching misses a re-spelled street - the v1 behaviour', () => {
  const result = checkById(
    checks({ locations: DUPLICATE_PAIR, guidelines: { addressMatching: 'exact' } }),
    'GL-005',
  );
  assert.equal(result.status, 'pass');
  assert.equal(result.inputs.listedRows, 2);
});

test('GL-005 under normalised matching catches it - the v2 behaviour', () => {
  const result = checkById(
    checks({ locations: DUPLICATE_PAIR, guidelines: { addressMatching: 'normalized' } }),
    'GL-005',
  );
  assert.equal(result.status, 'flag');
  assert.equal(result.inputs.duplicateGroups, 1);
  assert.equal(result.inputs.deduplicatedRows, 1);
  assert.match(result.detail, /L1 .*repeated by L2/);
});

test('the duplicate a version cannot see inflates its insured value', () => {
  // This is the whole reason GL-005 matters: the hygiene flag is incidental,
  // the double-counted building is the harm.
  const strict = checks({ locations: DUPLICATE_PAIR, guidelines: { addressMatching: 'exact' } });
  const loose = checks({ locations: DUPLICATE_PAIR, guidelines: { addressMatching: 'normalized' } });

  assert.equal(checkById(strict, 'GL-001').inputs.computedTiv, 2_700_000);
  assert.equal(checkById(loose, 'GL-001').inputs.computedTiv, 1_350_000);
});
