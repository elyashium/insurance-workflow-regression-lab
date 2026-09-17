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
import { scoreRun, summarize, compare } from './scorecard.js';

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

  const scored = packets.map((packet) => {
    const run = runPacket(packet, version);
    const truth = groundTruth[packet.packetId];
    if (!truth) {
      throw new Error(`No ground truth entry for ${packet.packetId}.`);
    }
    return { run, score: scoreRun(run, truth) };
  });

  return {
    versionId,
    versionName: version.name,
    versionSummary: version.summary,
    changes: version.changes,
    guidelines: version.guidelines,
    scored,
    summary: summarize(scored),
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
