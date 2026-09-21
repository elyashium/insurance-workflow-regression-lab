/**
 * End-to-end: the whole corpus, through every workflow version, scored.
 *
 * The unit tests pin individual rules. This file pins the thing the lab is
 * actually claiming - that running the same eight packets through two versions
 * produces a specific, defensible set of decisions, and that the diff between
 * two versions names exactly what moved.
 *
 * The matrix asserted below is the demo. If a change to any rule moves a single
 * packet from one column to another, this test fails and names it, which is the
 * behaviour the whole project is arguing for.
 *
 * Every packet, figure and threshold referenced here is synthetic and invented
 * for the lab. None of it is underwriting guidance.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSuite, runComparison } from '../src/core/lab.js';
import { compare } from '../src/core/scorecard.js';
import { GUIDELINE_DISCLAIMER } from '../src/core/checks.js';
import { VERSIONS } from '../src/core/versions.js';

const DETERMINISTIC_IDS = ['v1-regex', 'v2-heuristic', 'v2.1-no-backfill'];
const VERSION_IDS = [...DETERMINISTIC_IDS];

/**
 * v3 needs a model. It runs live with GROQ_API_KEY, or deterministically
 * offline against a seeded response cache (the adapter checks the cache
 * before the key). Either way the registration below is unconditional.
 */
function v3Available() {
  if (process.env.GROQ_API_KEY) return true;
  const dir = process.env.GROQ_CACHE_DIR
    ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'data', '.llm-cache');
  try {
    return readdirSync(dir).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}

if (v3Available()) VERSION_IDS.push('v3-llm');

/** Each suite loads its own copy of the corpus, so no version can see another's annotations. */
const suites = new Map();
for (const id of VERSION_IDS) suites.set(id, await runSuite(id));

/** @param {string} id */
function suite(id) {
  const s = suites.get(id);
  assert.ok(s, `no suite for ${id}`);
  return s;
}

/**
 * @param {string} versionId
 * @param {string} packetId
 */
function runOf(versionId, packetId) {
  const found = suite(versionId).scored.find((/** @type {any} */ s) => s.run.packetId === packetId);
  assert.ok(found, `${versionId} produced no run for ${packetId}`);
  return found.run;
}

/**
 * @param {string} versionId
 * @param {string} packetId
 */
function scoreOf(versionId, packetId) {
  const found = suite(versionId).scored.find((/** @type {any} */ s) => s.run.packetId === packetId);
  return found.score;
}

/** @param {string} versionId */
function decisionsOf(versionId) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const s of suite(versionId).scored) out[s.run.packetId] = s.run.routing.decision;
  return out;
}

/** @param {string} versionId */
function abstainedIn(versionId) {
  return suite(versionId)
    .scored.filter((/** @type {any} */ s) => s.run.routing.abstained)
    .map((/** @type {any} */ s) => s.run.packetId);
}

/**
 * @param {string} versionId
 * @param {string} packetId
 */
function flagsOf(versionId, packetId) {
  return runOf(versionId, packetId)
    .checks.filter((/** @type {any} */ c) => c.status === 'flag')
    .map((/** @type {any} */ c) => c.id);
}

/**
 * @param {string} versionId
 * @param {string} packetId
 */
function reasonKinds(versionId, packetId) {
  return runOf(versionId, packetId).routing.reasons.map((/** @type {any} */ r) => r.kind);
}

/**
 * @param {string} baselineId
 * @param {string} candidateId
 */
function diffOf(baselineId, candidateId) {
  return compare(suite(baselineId).scored, suite(candidateId).scored);
}

/**
 * @param {any} diff
 * @param {string} packetId
 */
function packetDiff(diff, packetId) {
  const found = diff.packets.find((/** @type {any} */ p) => p.packetId === packetId);
  assert.ok(found, `the diff has no entry for ${packetId}`);
  return found;
}

/* ------------------------------------------------------------------ *
 * Shape: every run is complete and auditable
 * ------------------------------------------------------------------ */

test('every declared version runs the whole corpus', () => {
  assert.deepEqual(
    VERSIONS.map((v) => v.id).filter((id) => VERSION_IDS.includes(id)),
    VERSION_IDS,
  );
  assert.ok(
    VERSIONS.some((v) => v.id === 'v3-llm'),
    'v3-llm must stay registered even with no key and no cache',
  );
  for (const id of VERSION_IDS) {
    assert.equal(suite(id).scored.length, 8, `${id} did not run all eight packets`);
    assert.equal(suite(id).summary.packets, 8);
  }
});

test('every run carries a five-stage trace in pipeline order', () => {
  for (const id of VERSION_IDS) {
    for (const { run } of suite(id).scored) {
      assert.deepEqual(
        run.trace.map((/** @type {any} */ t) => t.name),
        ['Extract', 'Reconcile', 'Apply guidelines', 'Detect conflicts', 'Route'],
        `${id}/${run.packetId} trace is not the pipeline`,
      );
      let previousStart = -1;
      for (const step of run.trace) {
        assert.ok(step.startMs >= previousStart, 'trace steps must be in the order they ran');
        assert.ok(step.durationMs >= 0);
        assert.ok(step.summary.length > 0, `${step.name} recorded no summary`);
        assert.ok(Array.isArray(step.detail) && step.detail.length > 0, `${step.name} recorded no detail`);
        previousStart = step.startMs;
      }
      assert.ok(run.durationMs >= run.trace.at(-1).startMs);
    }
  }
});

test('every run applies the same five guidelines, and every one of them disclaims itself', () => {
  // The brief's constraint, asserted rather than trusted: nothing in this lab
  // may present an invented threshold as real underwriting guidance.
  for (const id of VERSION_IDS) {
    for (const { run } of suite(id).scored) {
      assert.deepEqual(
        run.checks.map((/** @type {any} */ c) => c.id),
        ['GL-001', 'GL-002', 'GL-003', 'GL-004', 'GL-005'],
      );
      for (const check of run.checks) {
        assert.equal(check.disclaimer, GUIDELINE_DISCLAIMER);
        assert.ok(check.detail.length > 0, `${check.id} said nothing`);
      }
    }
  }
});

test('routing is internally consistent on every run', () => {
  const KINDS = new Set(['NOT_READABLE', 'UNRECONCILED', 'ADJUSTMENT_DECISIVE']);

  for (const id of VERSION_IDS) {
    for (const { run } of suite(id).scored) {
      const { abstained, decision, reasons } = run.routing;
      const where = `${id}/${run.packetId}`;

      assert.equal(abstained, decision === 'referred', `${where} abstained and decision disagree`);
      if (abstained) {
        assert.ok(reasons.length > 0, `${where} abstained without saying why`);
        for (const reason of reasons) {
          assert.ok(KINDS.has(reason.kind), `${where} used an unknown reason kind ${reason.kind}`);
          assert.ok(reason.detail.length > 0, `${where} gave an empty reason`);
        }
      } else {
        assert.deepEqual(reasons, [], `${where} proceeded but carried reasons to stop`);
      }
    }
  }
});

test('the cost on every deterministic run is labelled simulated', () => {
  // Both rule-based extractors are local code and really cost nothing. v3 is
  // metered and asserts the opposite in its own block below.
  for (const id of DETERMINISTIC_IDS) {
    assert.equal(suite(id).summary.costIsSimulated, true);
    for (const { run } of suite(id).scored) {
      assert.equal(run.cost.simulated, true);
      assert.ok(run.cost.usd > 0);
      assert.ok(run.durationMs > 0, 'latency, unlike cost, is really measured');
    }
  }
});

test('running a version twice gives the same answer', async () => {
  // Nothing in the pipeline may depend on wall-clock time, iteration order or
  // residue from a previous run. Without this, a scorecard diff means nothing.
  const again = await runSuite('v2-heuristic');

  const shape = (/** @type {any} */ s) =>
    s.scored.map((/** @type {any} */ x) => ({
      packetId: x.run.packetId,
      decision: x.run.routing.decision,
      reasons: x.run.routing.reasons.map((/** @type {any} */ r) => r.kind),
      checks: x.run.checks.map((/** @type {any} */ c) => `${c.id}:${c.status}`),
      conflicts: x.run.conflicts.map((/** @type {any} */ c) => c.id),
      correct: x.score.correct,
      total: x.score.total,
      costUsd: x.run.cost.usd,
    }));

  assert.deepEqual(shape(again), shape(suite('v2-heuristic')));
});

/* ------------------------------------------------------------------ *
 * The matrix
 * ------------------------------------------------------------------ */

test('v1 and v2 reach a different decision on five of the eight packets', () => {
  assert.deepEqual(decisionsOf('v1-regex'), {
    'PKT-001': 'quote',
    'PKT-002': 'decline', // $43.85M is over v1's $40M ceiling
    'PKT-003': 'referred',
    'PKT-004': 'referred',
    'PKT-005': 'decline', // v1 cannot read the stated total, so it never sees the conflict
    'PKT-006': 'quote', // v1 never reads the endorsement, so it sees $38M
    'PKT-007': 'referred',
    'PKT-008': 'referred',
  });

  assert.deepEqual(decisionsOf('v2-heuristic'), {
    'PKT-001': 'quote',
    'PKT-002': 'quote', // same figure, v2's $50M ceiling
    'PKT-003': 'referred',
    'PKT-004': 'referred',
    'PKT-005': 'referred',
    'PKT-006': 'referred',
    'PKT-007': 'decline',
    'PKT-008': 'decline',
  });
});

test('both versions abstain on half the corpus, on almost entirely different packets', () => {
  // The single most useful number in the lab, and the reason an aggregate
  // abstention rate is not a quality metric. The rates are identical. The
  // packets are not, and only two of the four overlap.
  assert.deepEqual(abstainedIn('v1-regex'), ['PKT-003', 'PKT-004', 'PKT-007', 'PKT-008']);
  assert.deepEqual(abstainedIn('v2-heuristic'), ['PKT-003', 'PKT-004', 'PKT-005', 'PKT-006']);

  assert.equal(suite('v1-regex').summary.abstentionRate, 0.5);
  assert.equal(suite('v2-heuristic').summary.abstentionRate, 0.5);
});

test('the two versions abstain for different kinds of reason', () => {
  // v1's abstentions are mostly its own fault; v2's are mostly the packet's.
  // PKT-008 carries both kinds at once, and the order is the order route()
  // collects them in: what could not be read, then what does not reconcile.
  assert.deepEqual(reasonKinds('v1-regex', 'PKT-008'), ['NOT_READABLE', 'UNRECONCILED']);
  assert.deepEqual(reasonKinds('v1-regex', 'PKT-007'), ['UNRECONCILED']);

  assert.deepEqual(reasonKinds('v2-heuristic', 'PKT-005'), ['UNRECONCILED']);
  assert.deepEqual(reasonKinds('v2-heuristic', 'PKT-003'), ['ADJUSTMENT_DECISIVE']);
  assert.deepEqual(reasonKinds('v2-heuristic', 'PKT-006'), ['ADJUSTMENT_DECISIVE']);

  // PKT-004's suspect loss date is in the packet, so both versions see it.
  assert.deepEqual(reasonKinds('v1-regex', 'PKT-004'), ['UNRECONCILED']);
  assert.deepEqual(reasonKinds('v2-heuristic', 'PKT-004'), ['UNRECONCILED']);
});

test('the clean baseline packet is read perfectly by every version', () => {
  for (const id of VERSION_IDS) {
    assert.equal(scoreOf(id, 'PKT-001').accuracy, 1, `${id} misread the clean packet`);
    assert.deepEqual(flagsOf(id, 'PKT-001'), []);
    assert.equal(runOf(id, 'PKT-001').routing.decision, 'quote');
  }
});

/* ------------------------------------------------------------------ *
 * The packets that carry the argument
 * ------------------------------------------------------------------ */

test('PKT-006: the version that reads less is the one that answers confidently', () => {
  // The schedule was marked FINAL at $38M. An endorsement thirteen days later
  // takes it to $52M. v1 never opens that document, clears its own ceiling and
  // returns a clean answer with no flags at all - which is the failure mode
  // worth being afraid of, because nothing about the output looks wrong.
  const v1 = runOf('v1-regex', 'PKT-006');
  assert.equal(v1.fields.computedTiv.value, 38_000_000);
  assert.equal(v1.resolution.appliedEndorsements.length, 0);
  assert.deepEqual(flagsOf('v1-regex', 'PKT-006'), []);
  assert.deepEqual(v1.conflicts, []);
  assert.equal(v1.routing.decision, 'quote');

  const v2 = runOf('v2-heuristic', 'PKT-006');
  assert.equal(v2.resolution.appliedEndorsements.length, 1);
  assert.equal(v2.fields.computedTiv.value, 52_000_000);
  assert.equal(v2.routing.decision, 'referred');

  // The stated total is $38M and the reconciled total is $52M, but that gap is
  // fully explained by the endorsement this run applied, so it is recorded as
  // an adjustment rather than raised as a contradiction.
  assert.deepEqual(v2.conflicts.map((/** @type {any} */ c) => c.id), []);
  assert.deepEqual(reasonKinds('v2-heuristic', 'PKT-006'), ['ADJUSTMENT_DECISIVE']);
  assert.match(v2.routing.reasons[0].detail, /applying 1 endorsement\(s\)/);

  // Ground truth applies the endorsement, so v1 is wrong about the total.
  assert.equal(scoreOf('v2-heuristic', 'PKT-006').correct > scoreOf('v1-regex', 'PKT-006').correct, true);
});

test('PKT-007: a confident decline is not an abstention, and the difference is legible', () => {
  // v2 reads the packet correctly and declines outright - nothing here is
  // ambiguous. v1 abstains, but not because the packet is hard: it could not
  // parse "$3.1M", so its schedule foots short and disagrees with the header.
  const v2 = runOf('v2-heuristic', 'PKT-007');
  assert.equal(v2.routing.abstained, false);
  assert.equal(v2.routing.decision, 'decline');
  assert.deepEqual(flagsOf('v2-heuristic', 'PKT-007'), ['GL-001', 'GL-003', 'GL-004']);
  assert.equal(v2.fields.computedTiv.value, 128_300_000);

  const v1 = runOf('v1-regex', 'PKT-007');
  assert.equal(v1.routing.decision, 'referred');
  assert.equal(v1.fields.computedTiv.value, 125_200_000, 'the unparsed $3.1M is simply missing');
  assert.deepEqual(v1.conflicts.map((/** @type {any} */ c) => c.id), ['CF-001']);
  assert.match(v1.routing.reasons[0].detail, /CF-001/);
});

test('PKT-008: the messiest packet is the one where the tolerant version abstains less', () => {
  // The argument cuts both ways, and the corpus has to contain the case that
  // cuts against v1 or the scorecard is just an advertisement for caution.
  assert.equal(runOf('v1-regex', 'PKT-008').routing.abstained, true);

  // Two independent failures on one packet, which is the reason `reasons` is a
  // list. v1 cannot read a required value, AND the schedule it did read does
  // not foot to the stated total - it never removes the Basalt Ridge duplicate,
  // so it over-counts by a whole campus. A reviewer needs both of those, not
  // whichever one the router happened to find first.
  assert.deepEqual(reasonKinds('v1-regex', 'PKT-008'), ['NOT_READABLE', 'UNRECONCILED']);
  assert.match(runOf('v1-regex', 'PKT-008').routing.reasons[0].detail, /L3\.buildingValue/);
  assert.match(runOf('v1-regex', 'PKT-008').routing.reasons[1].detail, /CF-001/);

  const v2 = runOf('v2-heuristic', 'PKT-008');
  assert.equal(v2.routing.abstained, false);
  assert.equal(v2.routing.decision, 'decline');
  assert.equal(v2.resolution.duplicateGroups.length, 1);
  assert.equal(v2.fields.computedTiv.value, 112_300_000);
  assert.ok(flagsOf('v2-heuristic', 'PKT-008').includes('GL-005'));
});

test('PKT-003: deduplication that flips the outcome is escalated, not just applied', () => {
  const v2 = runOf('v2-heuristic', 'PKT-003');
  assert.equal(v2.resolution.listedTiv, 55_300_000);
  assert.equal(v2.resolution.computedTiv, 40_950_000);
  assert.equal(v2.routing.decision, 'referred');
  assert.match(v2.routing.reasons[0].detail, /removing 1 duplicated location\(s\)/);

  // The same building at two spellings, and the values disagree by $50,000, so
  // the run also records that it had to pick one.
  assert.ok(v2.conflicts.some((/** @type {any} */ c) => c.id === 'CF-003'));
});

/* ------------------------------------------------------------------ *
 * The diff - what the lab is for
 * ------------------------------------------------------------------ */

test('v2 is more accurate than v1 across the corpus, and is still not shippable', () => {
  const diff = diffOf('v1-regex', 'v2-heuristic');

  assert.ok(diff.summary.delta.accuracy > 0, 'v2 should win on the aggregate');
  assert.ok(diff.improvements.length > diff.regressions.length);
  assert.equal(diff.verdict, 'regressed');
});

test('the diff names the two invented values, and nothing else, as regressions', () => {
  const diff = diffOf('v1-regex', 'v2-heuristic');

  assert.deepEqual(
    diff.regressions.map((/** @type {any} */ r) => `${r.packetId}/${r.key}`),
    ['PKT-002/L2.constructionType', 'PKT-002/L2.yearBuilt'],
  );

  for (const r of diff.regressions) {
    assert.equal(r.expected, null, 'ground truth records these as genuinely absent');
    assert.equal(r.baselineValue, null, 'v1 correctly reported nothing');
    assert.equal(r.candidateMethod, 'context-backfill');
    assert.equal(r.candidateConfidence, 0.5);
  }
  assert.deepEqual(
    diff.regressions.map((/** @type {any} */ r) => r.candidateValue),
    ['Joisted Masonry', 2025],
  );
});

test('PKT-002 also shows a pure threshold change, separable from the extraction change', () => {
  // Both versions compute the same $43.85M. Only the ceiling moved, so this
  // packet is the control: its routing change is a business-rule edit, not a
  // model change, and the diff has to make that distinguishable.
  const packet = packetDiff(diffOf('v1-regex', 'v2-heuristic'), 'PKT-002');

  assert.equal(runOf('v1-regex', 'PKT-002').fields.computedTiv.value, 43_850_000);
  assert.equal(runOf('v2-heuristic', 'PKT-002').fields.computedTiv.value, 43_850_000);
  assert.equal(packet.routingChanged, true);
  assert.equal(packet.baseline.decision, 'decline');
  assert.equal(packet.candidate.decision, 'quote');
  assert.deepEqual(packet.flagsRemoved, ['GL-001', 'GL-002']);
});

test('the invented values raise no error, break no check and change no decision', () => {
  // v2.1 is v2 with one switch flipped, so this diff isolates the back-fill
  // from every other change in the release. Turning it off restores the
  // data-completeness flag - the signal a reviewer would have acted on - and
  // moves nothing else at all.
  const diff = diffOf('v2-heuristic', 'v2.1-no-backfill');
  const packet = packetDiff(diff, 'PKT-002');

  assert.equal(packet.routingChanged, false, 'the regression is invisible in the decision');
  assert.deepEqual(packet.flagsAdded, ['GL-002']);
  assert.deepEqual(packet.flagsRemoved, []);
  assert.equal(packet.netFieldDelta, 2);

  // Under v2 the only trace of it is a low-severity conflict that stops nothing.
  assert.deepEqual(
    runOf('v2-heuristic', 'PKT-002').conflicts.map((/** @type {any} */ c) => `${c.id}:${c.severity}`),
    ['CF-004:low'],
  );
  assert.deepEqual(runOf('v2.1-no-backfill', 'PKT-002').conflicts, []);
});

test('v2.1 clears the regression without giving back anything v2 gained', () => {
  const fix = diffOf('v2-heuristic', 'v2.1-no-backfill');

  assert.deepEqual(
    fix.improvements.map((/** @type {any} */ r) => `${r.packetId}/${r.key}`),
    ['PKT-002/L2.constructionType', 'PKT-002/L2.yearBuilt'],
  );
  assert.deepEqual(fix.regressions, []);
  assert.equal(fix.verdict, 'clean');

  // And against the original baseline, the fix is a clean upgrade.
  const shipped = diffOf('v1-regex', 'v2.1-no-backfill');
  assert.deepEqual(shipped.regressions, []);
  assert.equal(shipped.verdict, 'clean');
  assert.ok(shipped.summary.delta.accuracy > 0);
});

test('every other packet is untouched by the fix', () => {
  for (const packet of diffOf('v2-heuristic', 'v2.1-no-backfill').packets) {
    if (packet.packetId === 'PKT-002') continue;
    assert.deepEqual(packet.movedFields, [], `${packet.packetId} moved and should not have`);
    assert.equal(packet.routingChanged, false);
    assert.deepEqual(packet.flagsAdded, []);
    assert.deepEqual(packet.flagsRemoved, []);
  }
});

test('the thorough version costs more to run, and dropping the second pass costs less', () => {
  const v1 = suite('v1-regex').summary;
  const v2 = suite('v2-heuristic').summary;
  const v21 = suite('v2.1-no-backfill').summary;

  assert.ok(v2.totalCostUsd > v1.totalCostUsd, 'v2 reads two more documents, twice');
  assert.ok(v21.totalCostUsd < v2.totalCostUsd, 'v2.1 makes one pass instead of two');
});

/* ------------------------------------------------------------------ *
 * The API layer computes the same scorecard the tests do
 * ------------------------------------------------------------------ */

test('runComparison agrees with the scorecard these tests assert against', async () => {
  // The UI reads runComparison. If it could disagree with the test suite, the
  // demo would be showing numbers nothing verifies.
  const live = await runComparison('v1-regex', 'v2-heuristic');
  const expected = diffOf('v1-regex', 'v2-heuristic');

  assert.equal(live.diff.verdict, expected.verdict);
  assert.deepEqual(
    live.diff.regressions.map((/** @type {any} */ r) => `${r.packetId}/${r.key}`),
    expected.regressions.map((/** @type {any} */ r) => `${r.packetId}/${r.key}`),
  );
  assert.equal(live.diff.summary.baseline.accuracy, expected.summary.baseline.accuracy);
  assert.equal(live.diff.summary.candidate.accuracy, expected.summary.candidate.accuracy);

  assert.deepEqual(
    live.baseline.packets.map((/** @type {any} */ p) => p.decision),
    suite('v1-regex').scored.map((/** @type {any} */ s) => s.run.routing.decision),
  );
});

test('an unknown version id fails loudly rather than silently scoring nothing', async () => {
  await assert.rejects(() => runSuite('v3-imaginary'), /Unknown workflow version/);
});

test(
  'v3 runs the corpus with metered cost when a model is reachable',
  { skip: !v3Available() },
  () => {
    const s = suite('v3-llm');
    assert.equal(s.scored.length, 8);
    assert.equal(s.summary.costIsSimulated, false);

    for (const { run } of s.scored) {
      assert.equal(run.cost.simulated, false, 'model spend must never wear the simulated label');
      assert.ok(typeof run.cost.model === 'string' && run.cost.model.length > 0);
      assert.ok(run.cost.usd >= 0);
      assert.ok(run.cost.inputTokens > 0, 'a model run that read nothing is a bug');
      // The four model-read scalars carry the method that produced them.
      // lossRunTotalIncurred and lossCount are derived downstream
      // (sum:/count:), exactly as in the deterministic engine.
      for (const name of ['insuredName', 'receivedDate', 'requestedEffectiveDate', 'statedTiv']) {
        assert.equal(run.fields[name].method, 'llm-extract');
      }
      for (const loc of run.resolution.locations) {
        for (const f of Object.values(loc.fields)) {
          // Read cells are llm-extract; cells the model left blank (correctly,
          // on PKT-002 L2) are llm-miss. Anything else means the contract broke.
          assert.ok(
            f.method === 'llm-extract' || f.method === 'llm-miss',
            `unexpected method ${f.method}`,
          );
          if (f.value == null) assert.ok(f.note, 'a null with no explanation is a guess in disguise');
        }
      }
    }
  },
);

test('the v1→v2 movement slices to the missing-field family', () => {
  const diff = diffOf('v1-regex', 'v2-heuristic');
  const bySlice = new Map(diff.slices.map((s) => [s.slice, s]));

  const missing = bySlice.get('MISSING_FIELD');
  assert.ok(missing, 'expected a MISSING_FIELD slice');
  // Two packets carry the tag: PKT-002 contributes the 2 regressions,
  // PKT-008 contributes 7 improvements. The slice nets +5 — which is exactly
  // why the release looked shippable on averages while carrying regressions.
  assert.equal(missing.packets, 2);
  assert.equal(missing.regressions, 2);
  assert.equal(missing.improvements, 7);
  assert.equal(missing.net, 5);

  for (const s of diff.slices) {
    if (s.slice === 'MISSING_FIELD') continue;
    assert.equal(s.regressions, 0, `${s.slice} should carry no regression`);
  }
});

test('the v2→v2.1 fix moves only the missing-field slice, upward', () => {
  const fix = diffOf('v2-heuristic', 'v2.1-no-backfill');

  assert.deepEqual(fix.regressions, []);
  assert.equal(fix.slices.length, 1);
  assert.equal(fix.slices[0].slice, 'MISSING_FIELD');
  assert.equal(fix.slices[0].improvements, 2);
  assert.equal(fix.slices[0].net, 2);
});

test('calibration buckets account for every scored field, and the diagonal holds', () => {
  for (const id of VERSION_IDS) {
    const cal = suite(id).calibration;
    assert.deepEqual(
      cal.map((b) => b.range),
      ['<0.6', '0.6–0.8', '0.8–0.9', '≥0.9'],
    );
    assert.equal(
      cal.reduce((sum, b) => sum + b.n, 0),
      suite(id).summary.total,
      `${id} left fields out of its calibration`,
    );
    for (const b of cal) {
      assert.ok(b.accuracy == null || (b.accuracy >= 0 && b.accuracy <= 1));
      assert.equal(b.accuracy == null, b.n === 0);
    }
  }

  // The diagonal (guesses worse than reads) is meaningful for imperfect
  // readers. A perfect run fills every band at 1.0 — vacuous, and correctly so.
  for (const id of DETERMINISTIC_IDS) {
    const cal = suite(id).calibration;
    assert.ok(
      cal[0].accuracy < cal[3].accuracy,
      `${id} claims more for its guesses than its reads`,
    );
  }

  // v2's only low-confidence fields are the two back-filled inventions, both
  // wrong at 0.50 — the calibration pins the demo's central claim numerically.
  const v2low = suite('v2-heuristic').calibration[0];
  assert.deepEqual({ n: v2low.n, correct: v2low.correct }, { n: 2, correct: 0 });
  assert.equal(suite('v2-heuristic').calibration[3].accuracy, 1);
});
