/**
 * Scoring and version comparison.
 *
 * These tests use hand-built runs rather than the corpus, because the point is
 * to put one field on one side of one line and check that the scorecard says
 * the right thing about it. The corpus-level assertions live in the integration
 * test.
 *
 * The convention under test, and the reason the lab works at all: ground truth
 * records `null` where a value is genuinely absent from the packet, so
 * reporting null there is CORRECT and inventing a plausible value there is
 * wrong. A regression that only ever fills in blanks raises no errors and
 * breaks no checks. The scorecard is the only thing that sees it.
 *
 * Every figure below is invented for the fixture.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { valuesEqual, scoreRun, summarize, compare, calibration } from '../src/core/scorecard.js';
import { SCALAR_FIELDS, LOCATION_FIELDS } from '../src/core/types.js';
import { makeField, makeLocation } from './fixtures.js';

/** Marks a scalar the version never produced at all, as distinct from one it produced as null. */
const OMITTED = Symbol('omitted');

const TRUTH = {
  fields: {
    insuredName: 'Kiln Street Manufacturing LLC',
    receivedDate: '2026-03-02',
    requestedEffectiveDate: '2026-04-01',
    statedTiv: 2_000_000,
    computedTiv: 2_000_000,
    lossRunTotalIncurred: 5_000,
    lossCount: 1,
  },
  locations: [
    {
      address: '400 Kiln Street',
      city: 'Springfield',
      state: 'IL',
      zip: '62704',
      buildingValue: 1_000_000,
      contentsValue: 250_000,
      biValue: 100_000,
      constructionType: 'Joisted Masonry',
      yearBuilt: 1998,
    },
    {
      address: '18 Draper Lane',
      city: 'Peoria',
      state: 'IL',
      zip: '61602',
      buildingValue: 650_000,
      contentsValue: 90_000,
      biValue: 40_000,
      constructionType: 'Frame',
      // Genuinely absent from the fixture packet. A version that reports null
      // here is right; a version that fills it in is wrong.
      yearBuilt: null,
    },
  ],
};

/** 7 scalars + 2 locations x 9 sub-fields + 1 for the shape of the schedule. */
const TOTAL_ITEMS = SCALAR_FIELDS.length + TRUTH.locations.length * LOCATION_FIELDS.length + 1;

/**
 * A run that reads TRUTH exactly, with overrides applied on top.
 *
 * @param {{
 *   fields?: Record<string, any>,
 *   locations?: any[],
 *   packetId?: string,
 *   versionId?: string,
 *   decision?: 'quote'|'decline'|'referred',
 *   abstained?: boolean,
 *   flags?: string[],
 *   passes?: string[],
 *   durationMs?: number,
 *   costUsd?: number,
 * }} [spec]
 */
function makeRun(spec = {}) {
  const scalars = { ...TRUTH.fields, ...(spec.fields ?? {}) };

  /** @type {Record<string, any>} */
  const fields = {};
  for (const [name, raw] of Object.entries(scalars)) {
    const spec_ = /** @type {any} */ (raw);
    if (spec_ === OMITTED) continue;
    fields[name] =
      spec_ !== null && typeof spec_ === 'object' && 'value' in spec_
        ? makeField(name, spec_.value, spec_.confidence ?? 0.96, spec_)
        : makeField(name, spec_, spec_ == null ? 0.9 : 0.96);
  }

  const rows = spec.locations ?? TRUTH.locations.map((l, i) => ({ locId: `L${i + 1}`, ...l }));
  const locations = rows.map(({ locId, ...overrides }) => makeLocation(locId, overrides));

  const versionId = spec.versionId ?? 'vA';
  const packetId = spec.packetId ?? 'PKT-X';

  return {
    runId: `${versionId}:${packetId}`,
    packetId,
    packetLabel: 'Fixture packet',
    edgeCases: [],
    versionId,
    versionName: versionId,
    durationMs: spec.durationMs ?? 12,
    cost: { usd: spec.costUsd ?? 0.01, simulated: true },
    fields,
    resolution: { locations },
    checks: [
      ...(spec.flags ?? []).map((id) => ({ id, status: 'flag' })),
      ...(spec.passes ?? []).map((id) => ({ id, status: 'pass' })),
    ],
    conflicts: [],
    routing: {
      decision: spec.decision ?? 'quote',
      abstained: spec.abstained ?? false,
      reasons: [],
    },
  };
}

/**
 * @param {Parameters<typeof makeRun>[0]} [spec]
 */
function scored(spec) {
  const run = makeRun(spec);
  return { run, score: scoreRun(run, TRUTH) };
}

/**
 * @param {any} score
 * @param {string} key
 */
function item(score, key) {
  const found = score.fields.find((/** @type {any} */ f) => f.key === key);
  assert.ok(found, `expected a score item for ${key}`);
  return found;
}

/* ------------------------------------------------------------------ *
 * valuesEqual
 * ------------------------------------------------------------------ */

test('two absences agree', () => {
  assert.equal(valuesEqual(null, null), true);
  assert.equal(valuesEqual(null, undefined), true);
});

test('an absence and a value never agree, in either direction', () => {
  // Left to right: the packet says nothing, the version produced something.
  assert.equal(valuesEqual(null, 2025), false);
  // Right to left: the value was there, the version dropped it.
  assert.equal(valuesEqual(2025, null), false);
});

test('zero is a value, not an absence', () => {
  assert.equal(valuesEqual(0, 0), true);
  assert.equal(valuesEqual(0, null), false);
  assert.equal(valuesEqual(null, 0), false);
});

test('numbers compare numerically however they were typed', () => {
  assert.equal(valuesEqual(16_700_000, '16700000'), true);
  assert.equal(valuesEqual('3100000', 3_100_000), true);
  assert.equal(valuesEqual(3_100_000, 3_100_001), false);
});

test('text compares without punishing case or padding', () => {
  assert.equal(valuesEqual('Joisted Masonry', '  joisted masonry '), true);
  assert.equal(valuesEqual('Joisted Masonry', 'Frame'), false);
});

/* ------------------------------------------------------------------ *
 * scoreRun
 * ------------------------------------------------------------------ */

test('a run that reads the packet exactly scores every item', () => {
  const { score } = scored();
  assert.equal(score.total, TOTAL_ITEMS);
  assert.equal(score.correct, TOTAL_ITEMS);
  assert.equal(score.accuracy, 1);
});

test('reporting a blank as blank is correct; filling it in is not', () => {
  const honest = scored({ locations: rowsWith('L2', { yearBuilt: null }) });
  assert.equal(honest.score.correct, TOTAL_ITEMS);
  assert.equal(item(honest.score, 'L2.yearBuilt').correct, true);

  const invented = scored({
    locations: rowsWith('L2', { yearBuilt: { value: 2025, confidence: 0.5, method: 'context-backfill' } }),
  });
  const f = item(invented.score, 'L2.yearBuilt');
  assert.equal(f.correct, false);
  assert.equal(f.expected, null);
  assert.equal(f.actual, 2025);
  assert.equal(invented.score.correct, TOTAL_ITEMS - 1, 'exactly one item should have moved');
});

test('dropping a value the packet does contain is wrong too', () => {
  const { score } = scored({ locations: rowsWith('L1', { yearBuilt: null }) });
  const f = item(score, 'L1.yearBuilt');
  assert.equal(f.correct, false);
  assert.equal(f.expected, 1998);
  assert.equal(f.actual, null);
});

test('the score item records how the value was produced, not just what it was', () => {
  // Without the method and the confidence, a diff cannot tell an inference
  // apart from a reading, which is the only interesting thing about it.
  const { score } = scored({
    locations: rowsWith('L2', {
      constructionType: { value: 'Joisted Masonry', confidence: 0.5, method: 'context-backfill' },
    }),
  });
  const f = item(score, 'L2.constructionType');
  assert.equal(f.confidence, 0.5);
  assert.equal(f.method, 'context-backfill');
});

test('a scalar the version never produced is scored, and marked as never produced', () => {
  const { score } = scored({ fields: { computedTiv: OMITTED } });
  const f = item(score, 'computedTiv');
  assert.equal(f.actual, null);
  assert.equal(f.correct, false);
  assert.equal(f.confidence, 0);
  assert.equal(f.method, 'not-extracted');
});

test('locations are matched by address, so row order does not affect the score', () => {
  const reversed = TRUTH.locations
    .map((l, i) => ({ locId: `L${i + 1}`, ...l }))
    .reverse();
  const { score } = scored({ locations: reversed });

  assert.equal(score.correct, TOTAL_ITEMS);
  assert.equal(item(score, 'L1.buildingValue').actual, 1_000_000);
  assert.equal(item(score, 'L2.buildingValue').actual, 650_000);
});

test('a misread address falls back to position so the rest of the row is still scored', () => {
  const { score } = scored({ locations: rowsWith('L1', { address: '400 Kiln Steet' }) });

  assert.equal(item(score, 'L1.address').correct, false);
  assert.equal(item(score, 'L1.buildingValue').correct, true, 'one bad cell should not void the row');
  assert.equal(score.correct, TOTAL_ITEMS - 1);
});

test('a duplicate left on the books is penalised once, by the shape item', () => {
  // Every cell on the extra row reads correctly. The mistake is that the row is
  // there at all, and that is a single error about the schedule, not nine.
  const rows = [
    ...TRUTH.locations.map((l, i) => ({ locId: `L${i + 1}`, ...l })),
    { locId: 'L3', ...TRUTH.locations[0] },
  ];
  const { score } = scored({ locations: rows });

  const wrong = score.fields.filter((/** @type {any} */ f) => !f.correct).map((/** @type {any} */ f) => f.key);
  assert.deepEqual(wrong, ['locationCount']);
  assert.equal(item(score, 'locationCount').expected, 2);
  assert.equal(item(score, 'locationCount').actual, 3);
});

test('a row the version never produced earns no credit, not even for its blanks', () => {
  // L2's yearBuilt is null in ground truth, and a missing row also reports
  // null. Scoring that as a match would let a version raise its accuracy by
  // dropping locations, so an unmatched row is wrong across the board.
  const { score } = scored({ locations: [{ locId: 'L1', ...TRUTH.locations[0] }] });

  const orphaned = score.fields.filter((/** @type {any} */ f) => f.key.startsWith('expected#2.'));
  assert.equal(orphaned.length, LOCATION_FIELDS.length);
  assert.ok(orphaned.every((/** @type {any} */ f) => f.correct === false));
  assert.equal(item(score, 'expected#2.yearBuilt').expected, null);
  assert.equal(item(score, 'expected#2.yearBuilt').correct, false);
  assert.equal(item(score, 'expected#2.yearBuilt').method, 'not-extracted');

  assert.equal(score.correct, TOTAL_ITEMS - LOCATION_FIELDS.length - 1);
});

test('accuracy is just the item count, with nothing weighted', () => {
  const { score } = scored({ fields: { insuredName: 'Kiln Str Mfg' } });
  assert.equal(score.accuracy, score.correct / score.total);
  assert.equal(score.correct, TOTAL_ITEMS - 1);
});

/* ------------------------------------------------------------------ *
 * summarize
 * ------------------------------------------------------------------ */

test('the summary counts abstentions and decisions across the suite', () => {
  const suite = [
    scored({ packetId: 'PKT-1', decision: 'quote', durationMs: 10, costUsd: 0.01 }),
    scored({ packetId: 'PKT-2', decision: 'quote', durationMs: 20, costUsd: 0.02 }),
    scored({ packetId: 'PKT-3', decision: 'referred', abstained: true, durationMs: 30, costUsd: 0.03 }),
    scored({ packetId: 'PKT-4', decision: 'referred', abstained: true, durationMs: 40, costUsd: 0.04 }),
  ];
  const s = summarize(suite);

  assert.equal(s.packets, 4);
  assert.equal(s.abstained, 2);
  assert.equal(s.abstentionRate, 0.5);
  assert.deepEqual(s.decisions, { quote: 2, decline: 0, referred: 2 });
  assert.equal(s.totalLatencyMs, 100);
  assert.equal(s.meanLatencyMs, 25);
  assert.equal(s.totalCostUsd, 0.1);
  assert.equal(s.meanCostUsd, 0.025);
  assert.equal(s.accuracy, s.correct / s.total);
});

test('the summary always says the cost is simulated', () => {
  // The UI reads this flag rather than being trusted to remember. Both
  // extractors are local deterministic code and really cost nothing to run.
  assert.equal(summarize([scored()]).costIsSimulated, true);
  assert.equal(summarize([]).costIsSimulated, true);
});

test('an empty suite summarises to zeroes rather than NaN', () => {
  const s = summarize([]);
  assert.equal(s.packets, 0);
  assert.equal(s.accuracy, 0);
  assert.equal(s.abstentionRate, 0);
  assert.equal(s.meanLatencyMs, 0);
  assert.equal(s.meanCostUsd, 0);
});

/* ------------------------------------------------------------------ *
 * compare - the gate
 * ------------------------------------------------------------------ */

test('a candidate that is more accurate overall still fails if it lost a field', () => {
  // This is the whole argument of the lab expressed as one assertion. The
  // candidate wins on three fields and loses one, so its average improves -
  // and it is still not shippable, because a field that used to be right is
  // now confidently wrong.
  const baseline = [
    scored({
      versionId: 'vA',
      fields: { insuredName: 'Kiln Str Mfg', statedTiv: null },
      locations: rowsWith('L1', { yearBuilt: null }),
    }),
  ];
  const candidate = [
    scored({
      versionId: 'vB',
      locations: rowsWith('L2', {
        yearBuilt: { value: 2025, confidence: 0.5, method: 'context-backfill' },
      }),
    }),
  ];

  const diff = compare(baseline, candidate);

  assert.equal(diff.baselineVersionId, 'vA');
  assert.equal(diff.candidateVersionId, 'vB');
  assert.ok(diff.summary.delta.accuracy > 0, 'the candidate should look better on the average');
  assert.ok(diff.summary.delta.correct > 0);
  assert.equal(diff.verdict, 'regressed');

  assert.deepEqual(diff.regressions.map((/** @type {any} */ r) => r.key), ['L2.yearBuilt']);
  assert.deepEqual(
    diff.improvements.map((/** @type {any} */ r) => r.key),
    ['insuredName', 'statedTiv', 'L1.yearBuilt'],
  );
});

test('a regression names the value, the confidence and the rule behind it', () => {
  const baseline = [scored({ versionId: 'vA' })];
  const candidate = [
    scored({
      versionId: 'vB',
      locations: rowsWith('L2', {
        yearBuilt: { value: 2025, confidence: 0.5, method: 'context-backfill' },
      }),
    }),
  ];

  const [r] = compare(baseline, candidate).regressions;
  assert.equal(r.packetId, 'PKT-X');
  assert.equal(r.key, 'L2.yearBuilt');
  assert.equal(r.expected, null);
  assert.equal(r.baselineValue, null);
  assert.equal(r.candidateValue, 2025);
  assert.equal(r.baselineCorrect, true);
  assert.equal(r.candidateCorrect, false);
  assert.equal(r.candidateConfidence, 0.5);
  assert.equal(r.candidateMethod, 'context-backfill');
});

test('fields that did not move are not reported', () => {
  const baseline = [scored({ versionId: 'vA', fields: { insuredName: 'Kiln Str Mfg' } })];
  const candidate = [scored({ versionId: 'vB' })];

  const [packet] = compare(baseline, candidate).packets;
  assert.deepEqual(packet.movedFields.map((/** @type {any} */ f) => f.key), ['insuredName']);
  assert.equal(packet.netFieldDelta, 1);
});

test('a candidate that only gains ground is clean', () => {
  const baseline = [scored({ versionId: 'vA', fields: { statedTiv: null } })];
  const candidate = [scored({ versionId: 'vB' })];

  const diff = compare(baseline, candidate);
  assert.deepEqual(diff.regressions, []);
  assert.equal(diff.improvements.length, 1);
  assert.equal(diff.verdict, 'clean');
});

test('two identical versions produce an empty, clean diff', () => {
  const diff = compare([scored({ versionId: 'vA' })], [scored({ versionId: 'vB' })]);
  assert.deepEqual(diff.regressions, []);
  assert.deepEqual(diff.improvements, []);
  assert.equal(diff.packets[0].movedFields.length, 0);
  assert.equal(diff.packets[0].netFieldDelta, 0);
  assert.equal(diff.verdict, 'clean');
});

test('the diff reports the routing and flag changes, not only the field changes', () => {
  const baseline = [
    scored({ versionId: 'vA', decision: 'referred', abstained: true, flags: ['GL-002', 'GL-005'] }),
  ];
  const candidate = [
    scored({ versionId: 'vB', decision: 'quote', abstained: false, flags: ['GL-005', 'GL-004'] }),
  ];

  const [packet] = compare(baseline, candidate).packets;
  assert.equal(packet.routingChanged, true);
  assert.equal(packet.baseline.decision, 'referred');
  assert.equal(packet.candidate.decision, 'quote');
  assert.deepEqual(packet.flagsAdded, ['GL-004']);
  assert.deepEqual(packet.flagsRemoved, ['GL-002']);
});

test('unchanged routing is reported as unchanged', () => {
  const diff = compare(
    [scored({ versionId: 'vA', decision: 'quote', flags: ['GL-005'] })],
    [scored({ versionId: 'vB', decision: 'quote', flags: ['GL-005'] })],
  );
  assert.equal(diff.packets[0].routingChanged, false);
  assert.deepEqual(diff.packets[0].flagsAdded, []);
  assert.deepEqual(diff.packets[0].flagsRemoved, []);
});

test('only packets both versions ran are diffed', () => {
  const baseline = [
    scored({ versionId: 'vA', packetId: 'PKT-1' }),
    scored({ versionId: 'vA', packetId: 'PKT-2' }),
  ];
  const candidate = [scored({ versionId: 'vB', packetId: 'PKT-1' })];

  const diff = compare(baseline, candidate);
  assert.deepEqual(diff.packets.map((/** @type {any} */ p) => p.packetId), ['PKT-1']);
});

test('comparing nothing to nothing is clean rather than an error', () => {
  const diff = compare([], []);
  assert.equal(diff.verdict, 'clean');
  assert.equal(diff.baselineVersionId, null);
  assert.deepEqual(diff.packets, []);
});

/**
 * TRUTH's location rows with one row's cells overridden.
 *
 * @param {string} locId
 * @param {Record<string, any>} overrides
 */
function rowsWith(locId, overrides) {
  return TRUTH.locations.map((l, i) => {
    const row = { locId: `L${i + 1}`, ...l };
    return row.locId === locId ? { ...row, ...overrides } : row;
  });
}

test('calibration buckets reported confidence against empirical accuracy', () => {
  const scored = [
    {
      score: {
        fields: [
          { confidence: 0.5, correct: false },
          { confidence: 0.2, correct: false },
          { confidence: 0.7, correct: true },
          { confidence: 0.95, correct: true },
          { confidence: 0.96, correct: true },
        ],
      },
    },
  ];

  assert.deepEqual(calibration(scored), [
    { range: '<0.6', n: 2, correct: 0, accuracy: 0 },
    { range: '0.6–0.8', n: 1, correct: 1, accuracy: 1 },
    { range: '0.8–0.9', n: 0, correct: 0, accuracy: null },
    { range: '≥0.9', n: 2, correct: 2, accuracy: 1 },
  ]);
});
