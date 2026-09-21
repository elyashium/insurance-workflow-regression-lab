/**
 * Resolution: turning what the documents said into what the workflow believes.
 *
 * Extraction reports the packet as written. This step reconciles it - removes
 * locations that are the same building listed twice, applies endorsements that
 * arrived after the schedule was issued, and foots the result into a single
 * insured value.
 *
 * Kept separate from extraction because the adjustments made here are exactly
 * the ones a human needs to be able to audit. Every adjustment is recorded
 * rather than applied silently, and the abstention logic re-runs the guidelines
 * with and without them to find out whether an adjustment changed the answer.
 */

import { findDuplicateGroups, normalizeAddress } from './address.js';
import { field } from './types.js';

/**
 * @typedef {Object} AppliedEndorsement
 * @property {string} endorsementId
 * @property {string} locId
 * @property {string} targetField
 * @property {number | null} fromValue
 * @property {number} toValue
 * @property {string | null} endorsementDate
 * @property {import('./text.js').Span | null} span
 */

/**
 * @typedef {Object} Resolution
 * @property {import('./types.js').LocationRecord[]} listedLocations  as written
 * @property {import('./types.js').LocationRecord[]} locations        reconciled
 * @property {any[]} duplicateGroups
 * @property {AppliedEndorsement[]} appliedEndorsements
 * @property {number | null} listedTiv     before any adjustment
 * @property {number | null} computedTiv   after every adjustment
 * @property {number} unreadableSummands     schedule cells that could not be read
 * @property {string[]} adjustments        human-readable audit trail
 */

/**
 * Sum building + contents + BI across a set of locations.
 *
 * Unreadable values contribute zero and are counted, so the caller can lower
 * the confidence of the total rather than presenting a short sum as if it were
 * complete.
 *
 * @param {import('./types.js').LocationRecord[]} locations
 * @returns {{ total: number, unreadable: number }}
 */
export function sumInsuredValue(locations) {
  let total = 0;
  let unreadable = 0;
  for (const loc of locations) {
    for (const name of ['buildingValue', 'contentsValue', 'biValue']) {
      const v = loc.fields[name]?.value;
      if (v == null) unreadable++;
      else total += v;
    }
  }
  return { total, unreadable };
}

/**
 * Shallow-copy a location so applying an endorsement does not mutate the
 * extraction result the trace will display.
 *
 * @param {import('./types.js').LocationRecord} loc
 * @returns {import('./types.js').LocationRecord}
 */
function cloneLocation(loc) {
  return { ...loc, fields: { ...loc.fields } };
}

/**
 * Find the location an endorsement row refers to.
 *
 * The row names a location id and an address. The id is trusted first; the
 * address is the fallback for endorsements that only identify the building by
 * street.
 *
 * @param {import('./types.js').LocationRecord[]} locations
 * @param {import('./types.js').Endorsement} endorsement
 * @returns {import('./types.js').LocationRecord | null}
 */
function locationForEndorsement(locations, endorsement) {
  if (endorsement.locHintId) {
    const byId = locations.find((l) => l.locId === endorsement.locHintId);
    if (byId) return byId;
  }
  if (endorsement.locHintAddress) {
    const target = normalizeAddress(endorsement.locHintAddress);
    const byAddress = locations.find((l) => normalizeAddress(l.fields.address.value) === target);
    if (byAddress) return byAddress;
  }
  return null;
}

/**
 * Reconcile an extraction into the values the guidelines will run on.
 *
 * @param {import('./types.js').ExtractionResult} extraction
 * @param {any} version
 * @returns {Resolution}
 */
export function resolve(extraction, version) {
  const listedLocations = extraction.locations;
  /** @type {string[]} */
  const adjustments = [];

  const listed = sumInsuredValue(listedLocations);
  const listedTiv = listedLocations.length ? listed.total : null;

  // --- Deduplicate ---------------------------------------------------
  const fuzzy = version.guidelines.addressMatching === 'normalized';
  const duplicateGroups = findDuplicateGroups(
    listedLocations.map((l) => ({ address: l.fields.address.value, zip: l.fields.zip.value })),
    { fuzzy },
  );

  const removed = new Set();
  for (const group of duplicateGroups) {
    for (const i of group.duplicateIndexes) removed.add(i);
  }

  let locations = listedLocations
    .map((loc, i) => {
      if (!removed.has(i)) return loc;
      const group = duplicateGroups.find((g) => g.duplicateIndexes.includes(i));
      const kept = listedLocations[group.keepIndex];
      adjustments.push(
        `Removed ${loc.locId} (${loc.fields.address.value}) as a repeat of ${kept.locId} (${kept.fields.address.value}), matched on ${group.basis}.`,
      );
      return null;
    })
    .filter(Boolean)
    .map(cloneLocation);

  // Record the relationship on the rows the trace will show.
  for (const group of duplicateGroups) {
    for (const i of group.duplicateIndexes) {
      listedLocations[i].isDuplicateOf = listedLocations[group.keepIndex].locId;
    }
  }

  // --- Apply endorsements --------------------------------------------
  /** @type {AppliedEndorsement[]} */
  const appliedEndorsements = [];

  for (const endorsement of extraction.endorsements) {
    const loc = locationForEndorsement(locations, endorsement);
    if (!loc) {
      adjustments.push(
        `Endorsement ${endorsement.endorsementId} could not be matched to a scheduled location and was not applied.`,
      );
      continue;
    }

    const previous = loc.fields[endorsement.targetField]?.value ?? null;
    loc.fields[endorsement.targetField] = field(
      endorsement.targetField,
      endorsement.toValue,
      0.93,
      endorsement.span,
      {
        note: `Superseded by endorsement ${endorsement.endorsementId}${endorsement.endorsementDate ? ` dated ${endorsement.endorsementDate}` : ''}. Schedule showed ${previous == null ? 'no value' : previous}.`,
        method: 'endorsement',
      },
    );

    appliedEndorsements.push({
      endorsementId: endorsement.endorsementId,
      locId: loc.locId,
      targetField: endorsement.targetField,
      fromValue: previous,
      toValue: endorsement.toValue,
      endorsementDate: endorsement.endorsementDate,
      span: endorsement.span,
    });

    adjustments.push(
      `Applied endorsement ${endorsement.endorsementId} to ${loc.locId}: ${endorsement.targetField} ${previous ?? 'absent'} -> ${endorsement.toValue}.`,
    );
  }

  const computed = sumInsuredValue(locations);
  const computedTiv = locations.length ? computed.total : null;

  return {
    listedLocations,
    locations,
    duplicateGroups,
    appliedEndorsements,
    listedTiv,
    computedTiv,
    unreadableSummands: computed.unreadable,
    adjustments,
  };
}

/**
 * Build the derived computedTiv field, with confidence reflecting how much of
 * the schedule was actually readable.
 *
 * @param {Resolution} resolution
 * @returns {import('./types.js').ExtractedField}
 */
export function computedTivField(resolution) {
  if (resolution.computedTiv == null) {
    return field('computedTiv', null, 0.1, null, {
      note: 'No location rows were readable, so no insured value could be computed.',
      method: 'sum:locations',
    });
  }

  const unreadable = resolution.unreadableSummands;
  return field('computedTiv', resolution.computedTiv, unreadable === 0 ? 0.94 : 0.45, null, {
    note: unreadable
      ? `${unreadable} value(s) across the schedule could not be read and were summed as zero. This total is a floor, not a figure.`
      : `Sum of building, contents and business interruption across ${resolution.locations.length} reconciled location(s).`,
    method: 'sum:locations',
  });
}
