/**
 * The runner: one packet, one workflow version, one auditable run.
 *
 * Every stage is timed with a real clock and recorded in a trace. The trace is
 * not logging - it is the product. A run that reaches the right answer without
 * showing which document, which line and which rule produced it is not
 * reviewable, and an unreviewable answer is not usable in a file that someone
 * has to sign.
 *
 * Latency in the scorecard is this measurement, not a simulation. v2 genuinely
 * reads two more documents and makes a second pass over the blanks, so it
 * genuinely takes longer, and the ratio between the versions is real. (Cost,
 * by contrast, is modelled - see cost.js, which says so at length.)
 */

import { randomUUID } from 'node:crypto';
import { runExtractionAsync } from './extractors/engine.js';
import { resolve, computedTivField } from './resolve.js';
import { runChecks } from './checks.js';
import { findConflicts } from './conflicts.js';
import { route } from './abstain.js';
import { estimateCost } from './cost.js';

/**
 * @typedef {Object} TraceStep
 * @property {string} name
 * @property {string} summary
 * @property {number} startMs      offset from the start of the run
 * @property {number} durationMs
 * @property {string[]} detail
 */

/**
 * Run one packet through one version.
 *
 * @param {import('./packets.js').Packet} packet
 * @param {import('./versions.js').WorkflowVersion} version
 * @returns {Promise<any>} the Run record
 */
export async function runPacket(packet, version) {
  /** @type {TraceStep[]} */
  const trace = [];
  const runStart = performance.now();

  /**
   * Time a stage and record what it concluded.
   *
   * @template T
   * @param {string} name
   * @param {() => T | Promise<T>} fn
   * @param {(result: T) => { summary: string, detail: string[] }} describe
   * @returns {Promise<T>}
   */
  async function step(name, fn, describe) {
    const startMs = performance.now() - runStart;
    const began = performance.now();
    const result = await fn();
    const durationMs = performance.now() - began;
    const { summary, detail } = describe(result);
    trace.push({
      name,
      summary,
      detail,
      startMs: round(startMs),
      durationMs: round(durationMs),
    });
    return result;
  }

  const extraction = await step(
    'Extract',
    () => runExtractionAsync(packet, version.extractorProfile),
    (r) => ({
      summary: `Read ${r.documentsRead.length} document(s), ${r.locations.length} location row(s), ${r.losses.length} claim row(s).`,
      detail: [
        `Documents in scope: ${r.documentsRead.join(', ')}.`,
        `Currency parsing: ${version.extractorProfile.currency}.`,
        `Context back-fill: ${version.extractorProfile.contextBackfill ? 'on' : 'off'}.`,
        ...describeLowConfidence(r),
        ...r.notes,
      ],
    }),
  );

  const resolution = await step(
    'Reconcile',
    () => resolve(extraction, version),
    (r) => ({
      summary: r.adjustments.length
        ? `${r.adjustments.length} adjustment(s) applied. Insured value ${fmt(r.listedTiv)} as listed, ${fmt(r.computedTiv)} reconciled.`
        : `No adjustments needed. Insured value ${fmt(r.computedTiv)}.`,
      detail: r.adjustments.length
        ? r.adjustments
        : ['Schedule as written was taken at face value: no duplicates found and no endorsements in scope.'],
    }),
  );

  const fields = { ...extraction.fields, computedTiv: computedTivField(resolution) };

  /** @type {any} */
  const ctx = {
    packet,
    extraction,
    resolution,
    fields,
    locations: resolution.locations,
    listedLocations: resolution.listedLocations,
    duplicateGroups: resolution.duplicateGroups,
    appliedEndorsements: resolution.appliedEndorsements,
    guidelines: version.guidelines,
  };

  const checks = await step(
    'Apply guidelines',
    () => runChecks(ctx),
    (r) => ({
      summary: `${r.filter((c) => c.status === 'flag').length} flag(s), ${r.filter((c) => c.status === 'pass').length} pass, ${r.filter((c) => c.status === 'not_evaluated').length} not evaluated.`,
      detail: r.map((c) => `${c.id} ${c.status.toUpperCase()} - ${c.detail}`),
    }),
  );

  const conflicts = await step(
    'Detect conflicts',
    () => findConflicts(ctx),
    (r) => ({
      summary: r.length ? `${r.length} conflict(s) found.` : 'The documents agree with each other.',
      detail: r.length
        ? r.map((c) => `${c.id} [${c.severity}] ${c.title} - ${c.detail}`)
        : ['No unreconciled disagreement between the application, the schedule and the loss run.'],
    }),
  );

  const routing = await step(
    'Route',
    () => route(ctx, checks, conflicts),
    (r) => ({
      summary: r.abstained
        ? `Referred to human review: ${r.reasons.length} reason(s).`
        : `Proceeded with a ${r.decision} decision.`,
      detail: r.abstained
        ? r.reasons.map((reason) => `${reason.kind} - ${reason.detail}`)
        : [
            `No required value was unreadable, no unreconciled conflict was found, and the outcome did not hinge on this run's own adjustments.`,
            `Decision: ${r.decision}.`,
          ],
    }),
  );

  // A metered extractor reports its own cost; estimates are the fallback.
  // Either way the run carries exactly one cost figure, labelled honestly.
  const cost = extraction.cost ?? estimateCost(extraction);
  const durationMs = round(performance.now() - runStart);

  return {
    runId: randomUUID(),
    packetId: packet.packetId,
    packetLabel: packet.label,
    edgeCases: packet.edgeCases,
    versionId: version.id,
    versionName: version.name,
    startedAt: new Date().toISOString(),
    durationMs,
    extraction,
    resolution,
    fields,
    checks,
    conflicts,
    routing,
    cost,
    trace,
  };
}

/**
 * Surface the values the extractor was least sure about, so the trace leads
 * with its own weak points rather than burying them.
 *
 * @param {import('./types.js').ExtractionResult} extraction
 * @returns {string[]}
 */
function describeLowConfidence(extraction) {
  /** @type {string[]} */
  const weak = [];

  for (const [name, f] of Object.entries(extraction.fields)) {
    if (f.confidence < 0.6) weak.push(`${name}: ${f.note || 'low confidence'} (${f.confidence}).`);
  }
  for (const loc of extraction.locations) {
    for (const [name, f] of Object.entries(loc.fields)) {
      if (f.confidence < 0.6) {
        weak.push(`${loc.locId}.${name}: ${f.note || 'low confidence'} (${f.confidence}).`);
      }
    }
  }

  return weak.length ? weak : ['Every value was read at normal confidence.'];
}

/**
 * @param {number | null} n
 * @returns {string}
 */
function fmt(n) {
  return n == null ? 'unavailable' : `$${n.toLocaleString('en-US')}`;
}

/**
 * @param {number} ms
 * @returns {number}
 */
function round(ms) {
  return Math.round(ms * 1000) / 1000;
}
