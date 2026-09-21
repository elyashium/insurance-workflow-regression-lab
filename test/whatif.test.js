/**
 * What-if runs: hypothetical thresholds, actually executed.
 *
 * A what-if run replays the corpus through one version with overridden
 * guideline thresholds and reports which packets move. Nothing is persisted
 * and no review attaches — it is a lab instrument, not a version.
 *
 * Every figure below is synthetic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runWhatIf } from '../src/core/lab.js';

test('lowering the ceiling moves PKT-002 back to decline', async () => {
  const res = await runWhatIf('v2-heuristic', { tivCeiling: 40_000_000 });

  assert.equal(res.versionId, 'v2-heuristic');
  assert.equal(res.hypothetical, true);
  assert.deepEqual(res.overrides, { tivCeiling: 40_000_000 });
  assert.equal(res.guidelines.tivCeiling, 40_000_000);
  assert.equal(res.packets.length, 8);

  const moved = new Map(res.changed.map((p) => [p.packetId, p]));
  assert.ok(moved.has('PKT-002'), 'PKT-002 at $43.85M must react to a $40M ceiling');
  assert.equal(moved.get('PKT-002').baselineDecision, 'quote');
  assert.equal(moved.get('PKT-002').decision, 'decline');
  assert.ok(moved.get('PKT-002').flags.includes('GL-001'));
});

test('no overrides moves nothing', async () => {
  const res = await runWhatIf('v2-heuristic', {});
  assert.deepEqual(res.overrides, {});
  assert.deepEqual(res.changed, []);
  assert.equal(res.packets.length, 8);
});

test('unknown keys and out-of-range values fail with a 400', async () => {
  await assert.rejects(
    () => runWhatIf('v2-heuristic', { bogus: 1 }),
    (/** @type {any} */ err) => err.status === 400,
  );
  await assert.rejects(
    () => runWhatIf('v2-heuristic', { tivCeiling: -5 }),
    (/** @type {any} */ err) => err.status === 400,
  );
  await assert.rejects(
    () => runWhatIf('v2-heuristic', { maxMonthsAhead: 999 }),
    (/** @type {any} */ err) => err.status === 400,
  );
  await assert.rejects(() => runWhatIf('v3-imaginary', {}), /Unknown workflow version/);
});
