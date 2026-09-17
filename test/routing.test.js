import test from 'node:test';
import assert from 'node:assert/strict';

import { findConflicts } from '../src/core/conflicts.js';
import { makeContext, makeLocation, makeLoss, evaluate } from './fixtures.js';

/**
 * @param {string} id
 * @param {Partial<import('../src/core/types.js').Endorsement>} spec
 * @returns {import('../src/core/types.js').Endorsement}
 */
function makeEndorsement(id, spec) {
  return {
    endorsementId: id,
    endorsementDate: '2026-03-10',
    locHintId: null,
    locHintAddress: null,
    targetField: 'buildingValue',
    fromValue: null,
    toValue: 0,
    span: null,
    ...spec,
  };
}

/** Two rows for the same building, spelled differently. */
const DUPLICATE_PAIR = [
  makeLocation('L1', { address: '400 Kiln Street', zip: '62704' }),
  makeLocation('L2', { address: '400 Kiln St', zip: '62704' }),
];

const NORMALIZED = { addressMatching: 'normalized' };

/**
 * @param {import('../src/core/types.js').Conflict[]} conflicts
 * @param {string} id
 */
function conflictById(conflicts, id) {
  return conflicts.find((c) => c.id === id) ?? null;
}

/* ------------------------------------------------------------------ *
 * CF-001 - stated total does not foot to the schedule
 * ------------------------------------------------------------------ */

test('CF-001 stays quiet when the stated total foots to the schedule', () => {
  assert.equal(conflictById(findConflicts(makeContext()), 'CF-001'), null);
});

test('CF-001 treats a small difference as rounding', () => {
  const ctx = makeContext({ fields: { statedTiv: 1_350_000 - 900 } });
  assert.equal(conflictById(findConflicts(ctx), 'CF-001'), null);
});

test('CF-001 fires on an unexplained difference', () => {
  const ctx = makeContext({ fields: { statedTiv: 5_000_000 } });
  const conflict = conflictById(findConflicts(ctx), 'CF-001');
  assert.ok(conflict, 'expected an unreconciled total to be reported');
  assert.equal(conflict.severity, 'high');
  assert.match(conflict.detail, /No deduplication or endorsement in this run accounts for the gap/);
});

test('CF-001 accepts deduplication as an explanation only when the figures reconcile', () => {
  // The broker footed the duplicated rows into the stated total, so removing
  // one is exactly what accounts for the difference. Nothing to report.
  const reconciled = makeContext({
    locations: DUPLICATE_PAIR,
    guidelines: NORMALIZED,
    fields: { statedTiv: 2_700_000 },
  });
  assert.equal(conflictById(findConflicts(reconciled), 'CF-001'), null);
});

test('CF-001 is not silenced by a deduplication that explains nothing', () => {
  // Regression guard. Treating "a duplicate was removed" as a blanket
  // explanation would let any disagreement through the moment a dedup
  // happened, which is the most dangerous kind of false negative here: the
  // packet looks clean precisely because the workflow touched it.
  const unexplained = makeContext({
    locations: DUPLICATE_PAIR,
    guidelines: NORMALIZED,
    fields: { statedTiv: 2_000_000 },
  });
  const conflict = conflictById(findConflicts(unexplained), 'CF-001');
  assert.ok(conflict, 'a dedup that does not reconcile the two figures must not suppress CF-001');
  assert.equal(conflict.severity, 'high');
});

test('CF-001 accepts an endorsement that accounts for the gap exactly', () => {
  const ctx = makeContext({
    endorsements: [
      makeEndorsement('end-1', { locHintId: 'L1', fromValue: 1_000_000, toValue: 4_000_000 }),
    ],
  });
  assert.equal(ctx.resolution.computedTiv, 4_350_000);
  assert.equal(ctx.resolution.appliedEndorsements.length, 1);
  assert.equal(conflictById(findConflicts(ctx), 'CF-001'), null);
});

/* ------------------------------------------------------------------ *
 * CF-002 - a claim dated after the submission
 * ------------------------------------------------------------------ */

test('CF-002 fires on a claim that post-dates the submission', () => {
  // Regression guard: this comparison once ran on ISO strings, which produces
  // NaN and turns the check into a permanent pass.
  const ctx = makeContext({
    fields: { receivedDate: '2026-03-02' },
    losses: [makeLoss('loss-1', { lossDate: '2026-03-20', cause: 'Hail' })],
  });
  const conflict = conflictById(findConflicts(ctx), 'CF-002');
  assert.ok(conflict, 'a loss dated after the loss run was produced must be reported');
  assert.equal(conflict.severity, 'medium');
  assert.match(conflict.detail, /2026-03-20 \(Hail\)/);
});

test('CF-002 stays quiet for claims that precede the submission', () => {
  assert.equal(conflictById(findConflicts(makeContext()), 'CF-002'), null);
});

test('CF-002 stays quiet when the received date itself could not be read', () => {
  const ctx = makeContext({
    fields: { receivedDate: { value: null, confidence: 0.2 } },
    losses: [makeLoss('loss-1', { lossDate: '2026-03-20' })],
  });
  assert.equal(conflictById(findConflicts(ctx), 'CF-002'), null);
});

/* ------------------------------------------------------------------ *
 * CF-003 - duplicated rows that disagree
 * ------------------------------------------------------------------ */

test('CF-003 reports duplicated rows that carry different values', () => {
  const ctx = makeContext({
    locations: [
      makeLocation('L1', { address: '400 Kiln Street', contentsValue: 250_000 }),
      makeLocation('L2', { address: '400 Kiln St', contentsValue: 300_000 }),
    ],
    guidelines: NORMALIZED,
    fields: { statedTiv: 2_750_000 },
  });
  const conflict = conflictById(findConflicts(ctx), 'CF-003');
  assert.ok(conflict);
  assert.equal(conflict.severity, 'low');
  assert.match(conflict.detail, /contentsValue \(\$250,000 vs \$300,000\)/);
  assert.match(conflict.detail, /convention rather than a finding/);
});

test('CF-003 stays quiet when the duplicated rows agree', () => {
  const ctx = makeContext({ locations: DUPLICATE_PAIR, guidelines: NORMALIZED });
  assert.equal(conflictById(findConflicts(ctx), 'CF-003'), null);
});

/* ------------------------------------------------------------------ *
 * CF-004 - values inferred from prose
 * ------------------------------------------------------------------ */

test('CF-004 names every value that was inferred rather than read', () => {
  const ctx = makeContext({
    locations: [
      makeLocation('L1', {
        constructionType: { value: 'Joisted Masonry', confidence: 0.5, method: 'context-backfill' },
      }),
    ],
  });
  const conflict = conflictById(findConflicts(ctx), 'CF-004');
  assert.ok(conflict);
  assert.equal(conflict.severity, 'low');
  assert.match(conflict.detail, /L1\.constructionType = "Joisted Masonry"/);
});

test('CF-004 does not fire on values read straight from the schedule', () => {
  assert.equal(conflictById(findConflicts(makeContext()), 'CF-004'), null);
});

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

test('a clean packet is quoted without a human', () => {
  const { routing } = evaluate(makeContext());
  assert.equal(routing.abstained, false);
  assert.equal(routing.decision, 'quote');
  assert.deepEqual(routing.reasons, []);
});

test('an unreadable required value routes to review as NOT_READABLE', () => {
  const { routing } = evaluate(
    makeContext({ fields: { insuredName: { value: null, confidence: 0.2 } } }),
  );
  assert.equal(routing.abstained, true);
  assert.equal(routing.decision, 'referred');
  assert.deepEqual(routing.reasons.map((r) => r.kind), ['NOT_READABLE']);
  assert.match(routing.reasons[0].detail, /insuredName/);
});

test('a blocking conflict routes to review as UNRECONCILED', () => {
  const { routing } = evaluate(makeContext({ fields: { statedTiv: 5_000_000 } }));
  assert.equal(routing.abstained, true);
  assert.deepEqual(routing.reasons.map((r) => r.kind), ['UNRECONCILED']);
  assert.match(routing.reasons[0].detail, /CF-001/);
});

test('a low-severity conflict is surfaced but does not stop the run', () => {
  // This is deliberate, and it is why the back-fill regression reaches a
  // decision unchallenged: the field-level diff has to catch it, not routing.
  const ctx = makeContext({
    locations: [
      makeLocation('L1', {
        constructionType: { value: 'Joisted Masonry', confidence: 0.5, method: 'context-backfill' },
      }),
    ],
  });
  const { conflicts, routing } = evaluate(ctx);
  assert.ok(conflictById(conflicts, 'CF-004'), 'the inference should still be recorded');
  assert.equal(routing.abstained, false);
  assert.equal(routing.decision, 'quote');
});

test('a deduplication that flips the appetite outcome routes to review', () => {
  const ctx = makeContext({
    locations: [
      makeLocation('L1', {
        address: '400 Kiln Street', buildingValue: 25_000_000, contentsValue: 0, biValue: 0,
      }),
      makeLocation('L2', {
        address: '400 Kiln St', buildingValue: 25_000_000, contentsValue: 0, biValue: 0,
      }),
    ],
    guidelines: NORMALIZED,
  });

  assert.equal(ctx.resolution.listedTiv, 50_000_000);
  assert.equal(ctx.resolution.computedTiv, 25_000_000);

  const { routing } = evaluate(ctx);
  assert.equal(routing.abstained, true);
  assert.ok(routing.reasons.some((r) => r.kind === 'ADJUSTMENT_DECISIVE'));
  assert.match(routing.reasons.at(-1).detail, /removing 1 duplicated location/);
});

test('an endorsement that flips the appetite outcome routes to review', () => {
  const ctx = makeContext({
    endorsements: [
      makeEndorsement('end-1', { locHintId: 'L1', fromValue: 1_000_000, toValue: 45_000_000 }),
    ],
  });
  const { routing } = evaluate(ctx);
  assert.equal(routing.abstained, true);
  assert.ok(routing.reasons.some((r) => r.kind === 'ADJUSTMENT_DECISIVE'));
  assert.match(routing.reasons.at(-1).detail, /applying 1 endorsement/);
});

test('a reconciliation that changes nothing decisive does not route to review', () => {
  // The workflow removed a duplicate, but the answer was the same either way,
  // so there is nothing for a human to adjudicate.
  const { checks, routing } = evaluate(
    makeContext({ locations: DUPLICATE_PAIR, guidelines: NORMALIZED, fields: { statedTiv: 2_700_000 } }),
  );
  assert.ok(checks.find((c) => c.id === 'GL-005').status === 'flag');
  assert.equal(routing.abstained, false);
  assert.equal(routing.decision, 'quote');
});

test('an out-of-appetite packet is declined, not referred', () => {
  const { routing } = evaluate(
    makeContext({
      locations: [makeLocation('L1', { buildingValue: 45_000_000, contentsValue: 0, biValue: 0 })],
    }),
  );
  assert.equal(routing.abstained, false);
  assert.equal(routing.decision, 'decline');
});

test('hygiene flags alone do not decline an account', () => {
  // GL-002 and GL-005 describe the quality of the submission, not the risk.
  // Letting them drive the decision would decline accounts for paperwork.
  const { checks, routing } = evaluate(
    makeContext({ locations: [makeLocation('L1', { yearBuilt: null })] }),
  );
  assert.equal(checks.find((c) => c.id === 'GL-002').status, 'flag');
  assert.equal(routing.decision, 'quote');
});

test('routing reports the weakest confidence among the values it relied on', () => {
  const { routing } = evaluate(
    makeContext({ fields: { requestedEffectiveDate: { value: '2026-04-01', confidence: 0.31 } } }),
  );
  assert.equal(routing.confidence, 0.31);
});
