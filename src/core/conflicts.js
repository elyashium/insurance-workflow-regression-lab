/**
 * Conflict detection.
 *
 * A check asks "does this packet meet the guideline". A conflict asks "do the
 * documents even agree with each other". The distinction matters for routing:
 * a failed check is an answer, and a conflict is a reason not to trust any
 * answer yet.
 *
 * The central rule here is that a discrepancy is only a conflict if the
 * workflow cannot already account for it. A stated total that disagrees with
 * the schedule is alarming on its own, but if the workflow removed a duplicate
 * row or applied an endorsement, the gap is explained and raising it would be
 * noise. Explained gaps are recorded as adjustments; unexplained ones are
 * conflicts.
 */

import { formatUsd } from './money.js';
import { parseIsoDate, daysBetween } from './dates.js';

/** Gaps below this are treated as rounding, not disagreement. */
const TIV_TOLERANCE = 1000;

/**
 * Detect everything in the packet that does not agree with itself.
 *
 * @param {import('./checks.js').CheckContext & { resolution: import('./resolve.js').Resolution }} ctx
 * @returns {import('./types.js').Conflict[]}
 */
export function findConflicts(ctx) {
  /** @type {import('./types.js').Conflict[]} */
  const conflicts = [];

  conflicts.push(...tivMismatch(ctx));
  conflicts.push(...lossesAfterSubmission(ctx));
  conflicts.push(...duplicatesDisagree(ctx));
  conflicts.push(...inferredValues(ctx));

  return conflicts;
}

/**
 * CF-001 - the stated total does not foot to the schedule.
 *
 * @param {any} ctx
 * @returns {import('./types.js').Conflict[]}
 */
function tivMismatch(ctx) {
  const stated = ctx.fields.statedTiv?.value ?? null;
  const computed = ctx.fields.computedTiv?.value ?? null;
  if (stated == null || computed == null) return [];

  const gap = computed - stated;
  if (Math.abs(gap) <= TIV_TOLERANCE) return [];

  // Did this workflow make an adjustment that accounts for the gap?
  const { duplicateGroups, appliedEndorsements, listedTiv } = ctx.resolution;
  const explanations = [];

  // Deduplication explains the gap only when the stated total matches the
  // schedule as listed - i.e. the broker footed the duplicated rows too. A
  // dedup that does not reconcile the two figures explains nothing, and must
  // not be allowed to suppress a real disagreement.
  if (duplicateGroups.length && listedTiv != null && Math.abs(listedTiv - stated) <= TIV_TOLERANCE) {
    explanations.push('the stated total appears to include the duplicated row(s)');
  }

  const endorsementDelta = appliedEndorsements.reduce(
    (sum, e) => sum + (e.toValue - (e.fromValue ?? 0)),
    0,
  );
  if (appliedEndorsements.length && Math.abs(gap - endorsementDelta) <= TIV_TOLERANCE) {
    explanations.push(
      `an endorsement raised a scheduled value by ${formatUsd(endorsementDelta)} after the total was written`,
    );
  }

  if (explanations.length > 0) return [];

  return [
    {
      id: 'CF-001',
      title: 'Stated insured value does not match the schedule',
      severity: 'high',
      detail: `The packet states a total insured value of ${formatUsd(stated)} but the schedule foots to ${formatUsd(computed)}, a difference of ${formatUsd(Math.abs(gap))}. No deduplication or endorsement in this run accounts for the gap, so it is unreconciled in the packet as submitted.`,
      evidence: [ctx.fields.statedTiv?.evidence, ctx.fields.computedTiv?.evidence].filter(Boolean),
    },
  ];
}

/**
 * CF-002 - a claim is dated after the submission arrived.
 *
 * @param {any} ctx
 * @returns {import('./types.js').Conflict[]}
 */
function lossesAfterSubmission(ctx) {
  const received = ctx.fields.receivedDate?.value ?? null;
  const receivedTs = parseIsoDate(received);
  if (receivedTs == null) return [];

  const late = ctx.extraction.losses.filter((loss) => {
    const ts = parseIsoDate(loss.fields.lossDate.value);
    return ts != null && daysBetween(receivedTs, ts) > 0;
  });
  if (late.length === 0) return [];

  return [
    {
      id: 'CF-002',
      title: 'Loss run contains a claim dated after the submission',
      severity: 'medium',
      detail: `${late.length} claim row(s) are dated after the submission was received on ${received}: ${late
        .map((l) => `${l.fields.lossDate.value} (${l.fields.cause.value})`)
        .join(', ')}. A loss cannot post-date the loss run it appears on, so either the date is wrong or the document is not the one described. The row is left in the stated total rather than dropped, because deciding which is wrong is an underwriting judgement.`,
      evidence: late.map((l) => l.sourceSpan).filter(Boolean),
    },
  ];
}

/**
 * CF-003 - two rows for the same building carry different values.
 *
 * @param {any} ctx
 * @returns {import('./types.js').Conflict[]}
 */
function duplicatesDisagree(ctx) {
  /** @type {import('./types.js').Conflict[]} */
  const out = [];

  for (const group of ctx.resolution.duplicateGroups) {
    const kept = ctx.resolution.listedLocations[group.keepIndex];
    for (const i of group.duplicateIndexes) {
      const dupe = ctx.resolution.listedLocations[i];
      const differing = ['buildingValue', 'contentsValue', 'biValue'].filter((name) => {
        const a = kept.fields[name]?.value ?? null;
        const b = dupe.fields[name]?.value ?? null;
        return a !== b;
      });
      if (differing.length === 0) continue;

      out.push({
        id: 'CF-003',
        title: 'Duplicated locations carry different values',
        severity: 'low',
        detail: `${kept.locId} and ${dupe.locId} are the same building but disagree on ${differing
          .map(
            (n) =>
              `${n} (${formatUsd(kept.fields[n]?.value)} vs ${formatUsd(dupe.fields[n]?.value)})`,
          )
          .join(', ')}. The earlier row was treated as authoritative, which is a convention rather than a finding - the correct figure is whichever register is current, and this run cannot tell which that is.`,
        evidence: [kept.sourceSpan, dupe.sourceSpan].filter(Boolean),
      });
    }
  }

  return out;
}

/**
 * CF-004 - a value was inferred from prose rather than read from a field.
 *
 * Surfaced so that an inferred value is never indistinguishable from a read
 * one in the trace. It is low severity by design: it does not stop a run. That
 * is exactly why the v2 back-fill regression is able to reach a decision
 * unchallenged, and why the field-level accuracy diff - not the routing
 * outcome - is what catches it.
 *
 * @param {any} ctx
 * @returns {import('./types.js').Conflict[]}
 */
function inferredValues(ctx) {
  /** @type {{locId: string, name: string, value: any, evidence: any}[]} */
  const inferred = [];

  for (const loc of ctx.extraction.locations) {
    for (const [name, f] of Object.entries(loc.fields)) {
      if (f.method === 'context-backfill') {
        inferred.push({ locId: loc.locId, name, value: f.value, evidence: f.evidence });
      }
    }
  }
  if (inferred.length === 0) return [];

  return [
    {
      id: 'CF-004',
      title: 'Values inferred from prose, not read from the schedule',
      severity: 'low',
      detail: `${inferred.length} value(s) were filled in from surrounding prose because the schedule left the field blank: ${inferred
        .map((i) => `${i.locId}.${i.name} = ${JSON.stringify(i.value)}`)
        .join(', ')}. A blank field is the broker asserting the value is unknown. Replacing that assertion with an inference is a guess wearing the same clothes as a fact.`,
      evidence: inferred.map((i) => i.evidence).filter(Boolean),
    },
  ];
}
