/**
 * Deterministic guideline checks.
 *
 * IMPORTANT: every threshold in this file is invented for the demonstration.
 * These are not real underwriting guidelines, they are not derived from any
 * carrier's appetite, and nothing here should be treated as insurance advice.
 * They exist so the lab has rules that are unambiguous enough to regression
 * test - which is the entire point. A real guideline engine would be sourced
 * from an underwriting manual and versioned against it.
 *
 * Every check is a pure function of already-extracted values. None of them
 * re-read the documents. That separation is deliberate: it means a change in
 * the extractor can move a check's outcome, but a change in a check can never
 * silently alter what was extracted, so the two halves of the scorecard stay
 * independently attributable.
 */

import { parseIsoDate, daysBetween, monthsBetween } from './dates.js';
import { formatUsd } from './money.js';
import { REQUIRED_FIELDS, REQUIRED_LOCATION_FIELDS } from './types.js';

export const GUIDELINE_DISCLAIMER =
  'Invented demo threshold. Not real underwriting guidance.';

/** Fields that are useful but whose absence should not halt a run. */
const SOFT_SCALAR_FIELDS = ['statedTiv'];
const SOFT_LOCATION_FIELDS = ['contentsValue', 'biValue', 'constructionType', 'yearBuilt'];

/**
 * Minimum confidence for a value to count as "read" rather than "guessed at".
 * Sits above the 0.5 the context back-fill assigns, so a back-filled value is
 * never treated as a confident read.
 */
export const CONFIDENCE_FLOOR = 0.6;

/**
 * @typedef {Object} CheckContext
 * @property {import('./packets.js').Packet} packet
 * @property {import('./types.js').ExtractionResult} extraction
 * @property {Record<string, import('./types.js').ExtractedField>} fields  incl. computedTiv
 * @property {import('./types.js').LocationRecord[]} locations  deduplicated, endorsed
 * @property {import('./types.js').LocationRecord[]} listedLocations  as written
 * @property {any[]} duplicateGroups
 * @property {any[]} appliedEndorsements
 * @property {any} guidelines
 */

/**
 * Collect the non-null evidence spans off a set of fields.
 *
 * @param {(import('./types.js').ExtractedField | null | undefined)[]} fields
 * @returns {import('./text.js').Span[]}
 */
function evidenceOf(fields) {
  return fields.filter((f) => f && f.evidence).map((f) => f.evidence);
}

/* ------------------------------------------------------------------ *
 * Pure predicates. Exported so the abstention logic can re-run them on
 * hypothetical inputs to detect when an adjustment flips an outcome.
 * ------------------------------------------------------------------ */

/**
 * @param {number | null} tiv
 * @param {number} ceiling
 * @returns {'pass'|'flag'|'not_evaluated'}
 */
export function appetiteOutcome(tiv, ceiling) {
  if (tiv == null) return 'not_evaluated';
  return tiv > ceiling ? 'flag' : 'pass';
}

/**
 * @param {number | null} incurred
 * @param {number | null} tiv
 * @param {number} ceilingPct
 * @returns {'pass'|'flag'|'not_evaluated'}
 */
export function lossRatioOutcome(incurred, tiv, ceilingPct) {
  if (incurred == null || tiv == null || tiv <= 0) return 'not_evaluated';
  return (incurred / tiv) * 100 > ceilingPct ? 'flag' : 'pass';
}

/* ------------------------------------------------------------------ *
 * The checks.
 * ------------------------------------------------------------------ */

/**
 * GL-001 - total insured value against the appetite ceiling.
 *
 * The ceiling differs between workflow versions on purpose. It is the one
 * change in the lab that is a pure business-rule edit with no extraction
 * component, which makes it the control case in the diff: any packet whose
 * outcome moves only because of this number is a rule change, not a model
 * change.
 *
 * @param {CheckContext} ctx
 * @returns {import('./types.js').CheckResult}
 */
function checkAppetiteTiv(ctx) {
  const ceiling = ctx.guidelines.tivCeiling;
  const tiv = ctx.fields.computedTiv?.value ?? null;
  const status = appetiteOutcome(tiv, ceiling);

  return {
    id: 'GL-001',
    title: 'Total insured value within appetite',
    status,
    detail:
      status === 'not_evaluated'
        ? 'Total insured value could not be computed from the schedule, so the appetite ceiling was not applied.'
        : status === 'flag'
          ? `Computed TIV of ${formatUsd(tiv)} exceeds the ${formatUsd(ceiling)} ceiling for this workflow version.`
          : `Computed TIV of ${formatUsd(tiv)} is within the ${formatUsd(ceiling)} ceiling.`,
    inputs: { computedTiv: tiv, ceiling },
    evidence: evidenceOf(ctx.locations.map((l) => l.fields.buildingValue)),
    disclaimer: GUIDELINE_DISCLAIMER,
  };
}

/**
 * GL-002 - is enough of the packet actually readable to underwrite it.
 *
 * Splits "required" from "useful". A missing insured name stops the run; a
 * missing year built does not, it just gets surfaced. The split matters
 * because it decides which packets abstain and which merely carry a flag.
 *
 * @param {CheckContext} ctx
 * @returns {import('./types.js').CheckResult}
 */
function checkDataCompleteness(ctx) {
  /** @type {string[]} */
  const hard = [];
  /** @type {string[]} */
  const soft = [];
  /** @type {import('./types.js').ExtractedField[]} */
  const touched = [];

  for (const name of REQUIRED_FIELDS) {
    const f = ctx.fields[name];
    touched.push(f);
    if (!f || f.value == null || f.confidence < CONFIDENCE_FLOOR) hard.push(name);
  }
  for (const name of SOFT_SCALAR_FIELDS) {
    const f = ctx.fields[name];
    touched.push(f);
    if (!f || f.value == null) soft.push(name);
  }

  if (ctx.locations.length === 0) hard.push('locations');

  for (const loc of ctx.locations) {
    for (const name of REQUIRED_LOCATION_FIELDS) {
      const f = loc.fields[name];
      touched.push(f);
      if (!f || f.value == null || f.confidence < CONFIDENCE_FLOOR) hard.push(`${loc.locId}.${name}`);
    }
    for (const name of SOFT_LOCATION_FIELDS) {
      const f = loc.fields[name];
      touched.push(f);
      if (!f || f.value == null) soft.push(`${loc.locId}.${name}`);
    }
  }

  const status = hard.length || soft.length ? 'flag' : 'pass';
  const parts = [];
  if (hard.length) parts.push(`Required values missing or low-confidence: ${hard.join(', ')}.`);
  if (soft.length) parts.push(`Supporting values absent: ${soft.join(', ')}.`);

  return {
    id: 'GL-002',
    title: 'Submission data complete enough to rate',
    status,
    detail: parts.join(' ') || 'All required and supporting values were read from the packet.',
    inputs: { missingRequired: hard, missingSupporting: soft },
    evidence: evidenceOf(touched).slice(0, 12),
    disclaimer: GUIDELINE_DISCLAIMER,
  };
}

/**
 * GL-003 - does the requested effective date make sense.
 *
 * Two failure modes, both real. A date in the past means the account has been
 * running with no cover and someone needs to know before it is bound. A date
 * far in the future means the submission is speculative and the values will be
 * stale by inception.
 *
 * @param {CheckContext} ctx
 * @returns {import('./types.js').CheckResult}
 */
function checkEffectiveDateWindow(ctx) {
  const received = ctx.fields.receivedDate?.value ?? null;
  const effective = ctx.fields.requestedEffectiveDate?.value ?? null;

  // The fields hold ISO strings; the arithmetic needs timestamps. Parsing here
  // rather than storing timestamps keeps the extracted value identical to what
  // the document says, which is what the evidence panel and the scorecard both
  // compare against.
  const receivedTs = parseIsoDate(received);
  const effectiveTs = parseIsoDate(effective);

  if (receivedTs == null || effectiveTs == null) {
    return {
      id: 'GL-003',
      title: 'Requested effective date within a workable window',
      status: 'not_evaluated',
      detail: 'Received date or requested effective date could not be read, so the window was not evaluated.',
      inputs: { receivedDate: received, requestedEffectiveDate: effective },
      evidence: evidenceOf([ctx.fields.receivedDate, ctx.fields.requestedEffectiveDate]),
      disclaimer: GUIDELINE_DISCLAIMER,
    };
  }

  const days = daysBetween(receivedTs, effectiveTs);
  const months = monthsBetween(receivedTs, effectiveTs);
  const maxMonths = ctx.guidelines.maxMonthsAhead;
  const evidence = evidenceOf([ctx.fields.receivedDate, ctx.fields.requestedEffectiveDate]);

  if (days < 0) {
    return {
      id: 'GL-003',
      title: 'Requested effective date within a workable window',
      status: 'flag',
      detail: `Requested effective date ${effective} is ${Math.abs(days)} days before the received date ${received}. The account appears to have been running without cover.`,
      inputs: { receivedDate: received, requestedEffectiveDate: effective, days, months },
      evidence,
      disclaimer: GUIDELINE_DISCLAIMER,
    };
  }

  if (months > maxMonths) {
    return {
      id: 'GL-003',
      title: 'Requested effective date within a workable window',
      status: 'flag',
      detail: `Requested effective date ${effective} is ${months.toFixed(1)} months after the received date ${received}, beyond the ${maxMonths}-month window. Values are likely to be stale by inception.`,
      inputs: { receivedDate: received, requestedEffectiveDate: effective, days, months },
      evidence,
      disclaimer: GUIDELINE_DISCLAIMER,
    };
  }

  return {
    id: 'GL-003',
    title: 'Requested effective date within a workable window',
    status: 'pass',
    detail: `Requested effective date ${effective} is ${days} days after the received date ${received}, within the ${maxMonths}-month window.`,
    inputs: { receivedDate: received, requestedEffectiveDate: effective, days, months },
    evidence,
    disclaimer: GUIDELINE_DISCLAIMER,
  };
}

/**
 * GL-004 - incurred losses as a share of insured value.
 *
 * @param {CheckContext} ctx
 * @returns {import('./types.js').CheckResult}
 */
function checkLossRatio(ctx) {
  const incurred = ctx.fields.lossRunTotalIncurred?.value ?? null;
  const tiv = ctx.fields.computedTiv?.value ?? null;
  const ceiling = ctx.guidelines.lossRatioCeilingPct;
  const status = lossRatioOutcome(incurred, tiv, ceiling);
  const ratio = incurred != null && tiv ? (incurred / tiv) * 100 : null;

  return {
    id: 'GL-004',
    title: 'Loss history proportionate to insured value',
    status,
    detail:
      status === 'not_evaluated'
        ? 'Either the loss total or the insured value was unavailable, so the ratio was not evaluated.'
        : `Incurred losses of ${formatUsd(incurred)} against ${formatUsd(tiv)} of insured value is ${ratio.toFixed(2)}%, ${status === 'flag' ? 'above' : 'within'} the ${ceiling}% threshold.`,
    inputs: { incurred, tiv, ratioPct: ratio, ceilingPct: ceiling },
    evidence: evidenceOf([ctx.fields.lossRunTotalIncurred]),
    disclaimer: GUIDELINE_DISCLAIMER,
  };
}

/**
 * GL-005 - the same building listed more than once.
 *
 * Double-counting a location inflates the insured value, which can push an
 * account out of appetite that should be in it. v1 compares raw strings and
 * therefore only catches character-identical repeats; v2 normalises first.
 *
 * @param {CheckContext} ctx
 * @returns {import('./types.js').CheckResult}
 */
function checkDuplicateLocations(ctx) {
  const groups = ctx.duplicateGroups;

  if (groups.length === 0) {
    return {
      id: 'GL-005',
      title: 'Each location listed once',
      status: 'pass',
      detail: `No repeated locations found across ${ctx.listedLocations.length} scheduled rows using ${ctx.guidelines.addressMatching} address matching.`,
      inputs: { listedRows: ctx.listedLocations.length, duplicateGroups: 0 },
      evidence: [],
      disclaimer: GUIDELINE_DISCLAIMER,
    };
  }

  const described = groups.map((g) => {
    const kept = ctx.listedLocations[g.keepIndex];
    const dupes = g.duplicateIndexes.map((i) => ctx.listedLocations[i]);
    return `${kept.locId} (${kept.fields.address.value}) repeated by ${dupes
      .map((d) => `${d.locId} (${d.fields.address.value})`)
      .join(', ')} - matched on ${g.basis}${g.basis === 'fuzzy' ? ` at ${(g.score * 100).toFixed(1)}% similarity` : ''}`;
  });

  return {
    id: 'GL-005',
    title: 'Each location listed once',
    status: 'flag',
    detail: `${groups.length} duplicated location(s) found and removed from the insured value: ${described.join('; ')}.`,
    inputs: {
      listedRows: ctx.listedLocations.length,
      deduplicatedRows: ctx.locations.length,
      duplicateGroups: groups.length,
    },
    evidence: groups.flatMap((g) =>
      [ctx.listedLocations[g.keepIndex], ...g.duplicateIndexes.map((i) => ctx.listedLocations[i])]
        .map((l) => l.sourceSpan)
        .filter(Boolean),
    ),
    disclaimer: GUIDELINE_DISCLAIMER,
  };
}

/** The checks, in the order they should be displayed. */
export const CHECKS = [
  checkAppetiteTiv,
  checkDataCompleteness,
  checkEffectiveDateWindow,
  checkLossRatio,
  checkDuplicateLocations,
];

/**
 * Run every guideline check.
 *
 * @param {CheckContext} ctx
 * @returns {import('./types.js').CheckResult[]}
 */
export function runChecks(ctx) {
  return CHECKS.map((check) => check(ctx));
}
