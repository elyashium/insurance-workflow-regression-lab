/**
 * Fault drills: the gate, mutation-tested.
 *
 * Each drill injects one canonical failure into the candidate's scored runs
 * and asserts the diff catches it. These run against the real corpus (via
 * runSuite, like the integration test) because the drills themselves operate
 * on scored suites — the fixtures are in the target selection, not the data.
 *
 * Everything below is synthetic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runSuite } from '../src/core/lab.js';
import { runDrills } from '../src/core/drills.js';

const baseline = await runSuite('v1-regex');
const candidate = await runSuite('v2-heuristic');
const drills = runDrills(baseline.scored, candidate.scored);

test('three drills run, and every one is caught and named', () => {
  assert.deepEqual(
    drills.map((d) => d.id),
    ['single-field', 'blank-fill', 'decoy-gains'],
  );
  for (const drill of drills) {
    assert.equal(drill.verdict, 'regressed', `${drill.id} did not move the verdict`);
    assert.equal(drill.caught, true, `${drill.id} escaped the gate`);
    assert.equal(drill.flipped.length, 1, `${drill.id} should inject exactly one break`);
    assert.ok(drill.flipped[0].packetId.length > 0);
    assert.ok(drill.flipped[0].key.length > 0);
  }
});

test('blank-fill replays the PKT-002 pattern on a genuine absence', () => {
  const drill = drills.find((d) => d.id === 'blank-fill');
  assert.ok(drill, 'no blank-fill drill ran');
  assert.equal(drill.flipped[0].expected, null, 'the drill must target a true blank');
  assert.notEqual(drill.flipped[0].injected, null, 'and fill it with something');
});

test('decoy-gains still blocks when the average improves', () => {
  const drill = drills.find((d) => d.id === 'decoy-gains');
  assert.ok(drill, 'no decoy-gains drill ran');
  assert.ok(drill.fixed >= 1, 'the decoy needs at least one genuine gain to hide behind');
  assert.equal(drill.caught, true, 'a better average must not buy back the broken field');
});
