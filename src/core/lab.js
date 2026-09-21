/**
 * The lab: run the whole corpus through a version, and diff two versions.
 *
 * This is the layer the HTTP API and the tests both sit on, so that what the
 * demo shows and what the test suite asserts are produced by the same code
 * path. A scorecard the UI computes differently from the tests is a scorecard
 * nobody should believe.
 */

import { loadAllPackets, loadGroundTruth } from './packets.js';
import { getVersion } from './versions.js';
import { runPacket } from './runner.js';
import { scoreRun, summarize, compare, calibration } from './scorecard.js';
import { runDrills as scoreDrills } from './drills.js';

/**
 * Run every packet through one version and score the results.
 *
 * @param {string} versionId
 * @param {{packets?: import('./packets.js').Packet[], groundTruth?: any}} [preloaded]
 * @returns {Promise<any>}
 */
export async function runSuite(versionId, preloaded = {}) {
  const version = getVersion(versionId);
  const groundTruth = preloaded.groundTruth ?? (await loadGroundTruth());
  const packets = preloaded.packets ?? (await loadAllPackets());

  const scored = await Promise.all(
    packets.map(async (packet) => {
      const run = await runPacket(packet, version);
      const truth = groundTruth[packet.packetId];
      if (!truth) {
        throw new Error(`No ground truth entry for ${packet.packetId}.`);
      }
      return { run, score: scoreRun(run, truth) };
    }),
  );

  return {
    versionId,
    versionName: version.name,
    versionSummary: version.summary,
    changes: version.changes,
    guidelines: version.guidelines,
    scored,
    summary: summarize(scored),
    calibration: calibration(scored),
  };
}

/**
 * Run two versions over the corpus and diff them.
 *
 * Both suites are run against the same freshly loaded packets so that neither
 * version can be advantaged by warm caches or by state the other left behind.
 *
 * @param {string} baselineId
 * @param {string} candidateId
 * @returns {Promise<any>}
 */
export async function runComparison(baselineId, candidateId) {
  const groundTruth = await loadGroundTruth();

  // Each suite gets its own copy of the corpus: reconciliation annotates the
  // location rows it inspects, and sharing indexed documents between versions
  // would let one run's annotations show up in the other's trace.
  const baseline = await runSuite(baselineId, {
    groundTruth,
    packets: await loadAllPackets(),
  });
  const candidate = await runSuite(candidateId, {
    groundTruth,
    packets: await loadAllPackets(),
  });

  return {
    baseline: publicSuite(baseline),
    candidate: publicSuite(candidate),
    diff: compare(baseline.scored, candidate.scored),
  };
}

/** Guideline keys a what-if run is allowed to move, with sane bounds. */
const WHATIF_LIMITS = {
  tivCeiling: { min: 1_000_000, max: 1_000_000_000 },
  lossRatioCeilingPct: { min: 0, max: 100 },
  maxMonthsAhead: { min: 1, max: 36 },
};

/**
 * @param {any} value
 * @param {string} name
 * @returns {Error}
 */
function badWhatIf(value, name) {
  const err = /** @type {Error & {status?: number}} */ (
    new Error(`Invalid what-if override ${name}: ${JSON.stringify(value)}.`)
  );
  err.status = 400;
  return err;
}

/**
 * Re-run one version with hypothetical guideline thresholds.
 *
 * This is a lab instrument, not a version: nothing is persisted, no review
 * attaches to it, and the version id is unchanged. It answers "what would
 * move if the ceiling were $X?" by actually re-running the pipeline, not by
 * editing the scorecard.
 *
 * @param {string} versionId
 * @param {Record<string, any>} overrides
 * @returns {Promise<any>}
 */
export async function runWhatIf(versionId, overrides = {}) {
  const version = getVersion(versionId);

  /** @type {Record<string, number>} */
  const clean = {};
  for (const [key, value] of Object.entries(overrides)) {
    const limits = WHATIF_LIMITS[key];
    const n = Number(value);
    if (!limits || !Number.isFinite(n) || n < limits.min || n > limits.max) {
      throw badWhatIf(value, key);
    }
    clean[key] = n;
  }

  const hypothetical = {
    ...version,
    guidelines: { ...version.guidelines, ...clean },
  };

  // Fresh corpus copies: the runner annotates as it reconciles.
  const [baseRuns, hypoRuns] = await Promise.all([
    Promise.all((await loadAllPackets()).map((p) => runPacket(p, version))),
    Promise.all((await loadAllPackets()).map((p) => runPacket(p, hypothetical))),
  ]);

  /** @param {any} run */
  const row = (run) => ({
    packetId: run.packetId,
    packetLabel: run.packetLabel,
    decision: run.routing.decision,
    abstained: run.routing.abstained,
    flags: run.checks.filter((c) => c.status === 'flag').map((c) => c.id),
    computedTiv: run.fields.computedTiv?.value ?? null,
  });

  const changed = [];
  const packets = hypoRuns.map((run, i) => {
    const base = row(baseRuns[i]);
    const hypo = row(run);
    const moved =
      base.decision !== hypo.decision ||
      base.abstained !== hypo.abstained ||
      JSON.stringify(base.flags) !== JSON.stringify(hypo.flags);
    if (moved) changed.push({ ...hypo, baselineDecision: base.decision, baselineFlags: base.flags });
    return hypo;
  });

  return {
    versionId,
    versionName: version.name,
    hypothetical: true,
    overrides: clean,
    guidelines: hypothetical.guidelines,
    packets,
    changed,
  };
}

/**
 * Mutation-test the gate between two versions: inject three canonical
 * failures into the candidate and report whether the diff catches each one.
 *
 * @param {string} baselineId
 * @param {string} candidateId
 * @returns {Promise<any>}
 */
export async function runDrills(baselineId, candidateId) {
  const groundTruth = await loadGroundTruth();
  const baseline = await runSuite(baselineId, {
    groundTruth,
    packets: await loadAllPackets(),
  });
  const candidate = await runSuite(candidateId, {
    groundTruth,
    packets: await loadAllPackets(),
  });

  return {
    baselineVersionId: baselineId,
    candidateVersionId: candidateId,
    drills: scoreDrills(baseline.scored, candidate.scored),
  };
}

/**
 * Strip the heavy per-run payloads out of a suite for API responses. The full
 * run, with its trace and evidence spans, is fetched one at a time.
 *
 * @param {any} suite
 */
function publicSuite(suite) {
  return {
    versionId: suite.versionId,
    versionName: suite.versionName,
    versionSummary: suite.versionSummary,
    changes: suite.changes,
    guidelines: suite.guidelines,
    summary: suite.summary,
    calibration: suite.calibration,
    packets: suite.scored.map((s) => ({
      packetId: s.run.packetId,
      packetLabel: s.run.packetLabel,
      edgeCases: s.run.edgeCases,
      runId: s.run.runId,
      decision: s.run.routing.decision,
      abstained: s.run.routing.abstained,
      correct: s.score.correct,
      total: s.score.total,
      accuracy: s.score.accuracy,
      durationMs: s.run.durationMs,
      costUsd: s.run.cost.usd,
    })),
  };
}
