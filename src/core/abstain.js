/**
 * Routing: proceed, or hand it to a human.
 *
 * The lab's position is that the interesting number is not how often the
 * workflow is right, it is how often the workflow knows it might be wrong. An
 * abstention is a correct output. A confident answer built on a value the
 * extractor guessed at is not, even when it happens to be right.
 *
 * Three things send a packet to review, and they are kept distinct because
 * they mean different things to whoever picks it up:
 *
 *   NOT_READABLE  - a required value could not be read with confidence. The
 *                   problem is the extraction.
 *   UNRECONCILED  - the documents disagree with each other in a way this run
 *                   cannot account for. The problem is the packet.
 *   ADJUSTMENT_DECISIVE - the workflow's own reconciliation is what decided the
 *                   outcome. Had it not deduplicated, or not applied the
 *                   endorsement, the answer would have gone the other way. The
 *                   machine is not wrong here; it is load-bearing, which is a
 *                   different thing and worth a human signature.
 */

import { appetiteOutcome, lossRatioOutcome, CONFIDENCE_FLOOR } from './checks.js';
import { REQUIRED_FIELDS, REQUIRED_LOCATION_FIELDS } from './types.js';

/** Checks that bear on the appetite decision itself, as opposed to hygiene. */
const DECISIVE_CHECKS = ['GL-001', 'GL-003', 'GL-004'];

/** Conflict severities serious enough to stop a run on their own. */
const BLOCKING_SEVERITIES = new Set(['medium', 'high']);

/**
 * @typedef {Object} AbstentionReason
 * @property {'NOT_READABLE'|'UNRECONCILED'|'ADJUSTMENT_DECISIVE'} kind
 * @property {string} detail
 */

/**
 * @typedef {Object} Routing
 * @property {boolean} abstained
 * @property {'quote'|'decline'|'referred'} decision
 * @property {AbstentionReason[]} reasons
 * @property {number} confidence   lowest confidence among the decisive inputs
 */

/**
 * Required values that were not read well enough to rely on.
 *
 * @param {any} ctx
 * @returns {string[]}
 */
function unreadableRequired(ctx) {
  /** @type {string[]} */
  const out = [];

  for (const name of REQUIRED_FIELDS) {
    const f = ctx.fields[name];
    if (!f || f.value == null || f.confidence < CONFIDENCE_FLOOR) out.push(name);
  }
  if (ctx.locations.length === 0) {
    out.push('locations (no readable rows on the schedule)');
    return out;
  }
  for (const loc of ctx.locations) {
    for (const name of REQUIRED_LOCATION_FIELDS) {
      const f = loc.fields[name];
      if (!f || f.value == null || f.confidence < CONFIDENCE_FLOOR) out.push(`${loc.locId}.${name}`);
    }
  }
  return out;
}

/**
 * Would the outcome have been different without the workflow's adjustments?
 *
 * Re-runs the two value-driven guidelines against the schedule exactly as it
 * was written, and compares. This is the only place the lab looks at a
 * counterfactual, and it is worth the extra evaluation: a decision that hinges
 * entirely on the machine's own reconciliation is the case most worth putting
 * in front of a person.
 *
 * @param {any} ctx
 * @returns {AbstentionReason[]}
 */
function adjustmentWasDecisive(ctx) {
  const { listedTiv, computedTiv, duplicateGroups, appliedEndorsements } = ctx.resolution;
  const adjusted = duplicateGroups.length > 0 || appliedEndorsements.length > 0;
  if (!adjusted || listedTiv == null || computedTiv == null) return [];

  /** @type {AbstentionReason[]} */
  const reasons = [];
  const incurred = ctx.fields.lossRunTotalIncurred?.value ?? null;

  const asListedAppetite = appetiteOutcome(listedTiv, ctx.guidelines.tivCeiling);
  const adjustedAppetite = appetiteOutcome(computedTiv, ctx.guidelines.tivCeiling);
  if (asListedAppetite !== adjustedAppetite) {
    reasons.push({
      kind: 'ADJUSTMENT_DECISIVE',
      detail: `The appetite outcome depends on this run's own reconciliation. As scheduled the total is ${listedTiv.toLocaleString('en-US')} (${asListedAppetite}); after ${describeAdjustments(duplicateGroups, appliedEndorsements)} it is ${computedTiv.toLocaleString('en-US')} (${adjustedAppetite}). Confirm the reconciliation before the decision stands.`,
    });
  }

  const asListedRatio = lossRatioOutcome(incurred, listedTiv, ctx.guidelines.lossRatioCeilingPct);
  const adjustedRatio = lossRatioOutcome(incurred, computedTiv, ctx.guidelines.lossRatioCeilingPct);
  if (asListedRatio !== adjustedRatio) {
    reasons.push({
      kind: 'ADJUSTMENT_DECISIVE',
      detail: `The loss ratio outcome depends on this run's own reconciliation: ${asListedRatio} against the schedule as written, ${adjustedRatio} after reconciliation.`,
    });
  }

  return reasons;
}

/**
 * @param {any[]} duplicateGroups
 * @param {any[]} appliedEndorsements
 * @returns {string}
 */
function describeAdjustments(duplicateGroups, appliedEndorsements) {
  const parts = [];
  if (duplicateGroups.length) parts.push(`removing ${duplicateGroups.length} duplicated location(s)`);
  if (appliedEndorsements.length) parts.push(`applying ${appliedEndorsements.length} endorsement(s)`);
  return parts.join(' and ');
}

/**
 * Decide what happens to this packet.
 *
 * @param {any} ctx
 * @param {import('./types.js').CheckResult[]} checks
 * @param {import('./types.js').Conflict[]} conflicts
 * @returns {Routing}
 */
export function route(ctx, checks, conflicts) {
  /** @type {AbstentionReason[]} */
  const reasons = [];

  const unreadable = unreadableRequired(ctx);
  if (unreadable.length) {
    reasons.push({
      kind: 'NOT_READABLE',
      detail: `Required values could not be read with confidence: ${unreadable.join(', ')}. No decision should be made on a submission this version could not fully parse.`,
    });
  }

  for (const conflict of conflicts) {
    if (!BLOCKING_SEVERITIES.has(conflict.severity)) continue;
    reasons.push({
      kind: 'UNRECONCILED',
      detail: `${conflict.id}: ${conflict.title}. ${conflict.detail}`,
    });
  }

  reasons.push(...adjustmentWasDecisive(ctx));

  // Lowest confidence among the values the decision actually rests on.
  const decisiveFields = [
    ctx.fields.computedTiv,
    ctx.fields.lossRunTotalIncurred,
    ctx.fields.receivedDate,
    ctx.fields.requestedEffectiveDate,
  ].filter(Boolean);
  const confidence = decisiveFields.length
    ? Math.min(...decisiveFields.map((f) => f.confidence))
    : 0;

  if (reasons.length > 0) {
    return { abstained: true, decision: 'referred', reasons, confidence };
  }

  const declined = checks.some((c) => DECISIVE_CHECKS.includes(c.id) && c.status === 'flag');
  return {
    abstained: false,
    decision: declined ? 'decline' : 'quote',
    reasons: [],
    confidence,
  };
}
