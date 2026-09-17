/**
 * Synthetic fixtures for the unit tests.
 *
 * The packet corpus is the integration test's input. These builders are for the
 * unit tests, where the point is to isolate one rule and feed it a value chosen
 * to sit on a boundary - which is hard to do with a fixed corpus and easy to do
 * here.
 *
 * Everything in this file is invented. It carries no relationship to any real
 * insured, broker, or carrier, and the default figures are chosen purely so the
 * baseline context passes every check cleanly, giving each test a single thing
 * to move.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolve, computedTivField, sumInsuredValue } from '../src/core/resolve.js';
import { runChecks } from '../src/core/checks.js';
import { findConflicts } from '../src/core/conflicts.js';
import { route } from '../src/core/abstain.js';

/** The v1 guideline set, restated here so a change to versions.js cannot
 * silently move a boundary a unit test was written to sit on. */
export const BASE_GUIDELINES = {
  tivCeiling: 40_000_000,
  lossRatioCeilingPct: 1.5,
  maxMonthsAhead: 12,
  addressMatching: 'exact',
};

/**
 * @param {string} name
 * @param {any} value
 * @param {number} [confidence]
 * @param {{note?: string, method?: string, evidence?: any}} [meta]
 */
export function makeField(name, value, confidence = 0.96, meta = {}) {
  return {
    name,
    value: value === undefined ? null : value,
    confidence,
    evidence: meta.evidence ?? null,
    note: meta.note ?? null,
    method: meta.method ?? 'fixture',
  };
}

/**
 * Accept either a bare value or `{ value, confidence, method }`.
 *
 * @param {string} name
 * @param {any} spec
 */
function toField(name, spec) {
  if (spec !== null && typeof spec === 'object' && 'value' in spec) {
    return makeField(name, spec.value, spec.confidence ?? 0.96, spec);
  }
  // A null default stands for "the document said nothing here", which is an
  // assertion the extractor makes with high confidence, not a failure.
  return makeField(name, spec, spec == null ? 0.9 : 0.96);
}

const LOCATION_DEFAULTS = {
  address: '400 Kiln Street',
  city: 'Springfield',
  state: 'IL',
  zip: '62704',
  buildingValue: 1_000_000,
  contentsValue: 250_000,
  biValue: 100_000,
  constructionType: 'Joisted Masonry',
  yearBuilt: 1998,
};

/**
 * @param {string} locId
 * @param {Record<string, any>} [overrides]
 * @returns {import('../src/core/types.js').LocationRecord}
 */
export function makeLocation(locId, overrides = {}) {
  const merged = { ...LOCATION_DEFAULTS, ...overrides };
  /** @type {Record<string, any>} */
  const fields = {};
  for (const [name, spec] of Object.entries(merged)) fields[name] = toField(name, spec);
  return { locId, fields, sourceSpan: null, isDuplicateOf: null };
}

const LOSS_DEFAULTS = {
  lossDate: '2025-06-14',
  cause: 'Water damage',
  paid: 4_000,
  reserved: 1_000,
  status: 'Closed',
};

/**
 * @param {string} lossId
 * @param {Record<string, any>} [overrides]
 * @returns {import('../src/core/types.js').LossRecord}
 */
export function makeLoss(lossId, overrides = {}) {
  const merged = { ...LOSS_DEFAULTS, ...overrides };
  /** @type {Record<string, any>} */
  const fields = {};
  for (const [name, spec] of Object.entries(merged)) fields[name] = toField(name, spec);
  return { lossId, fields, sourceSpan: null };
}

/**
 * Build a complete check/conflict/routing context.
 *
 * Reconciliation is done by the real `resolve()` rather than by hand, so a
 * fixture can never claim a duplicate was removed in a way the production code
 * would not actually have removed it.
 *
 * @param {{
 *   fields?: Record<string, any>,
 *   locations?: any[],
 *   losses?: any[],
 *   endorsements?: any[],
 *   guidelines?: Record<string, any>,
 *   notes?: string[],
 * }} [spec]
 */
export function makeContext(spec = {}) {
  const locations = spec.locations ?? [makeLocation('L1')];
  const losses = spec.losses ?? [makeLoss('loss-1')];
  const endorsements = spec.endorsements ?? [];
  const guidelines = { ...BASE_GUIDELINES, ...(spec.guidelines ?? {}) };

  let incurred = 0;
  let unreadableLoss = 0;
  for (const loss of losses) {
    for (const name of ['paid', 'reserved']) {
      const v = loss.fields[name].value;
      if (v == null) unreadableLoss++;
      else incurred += v;
    }
  }

  /** @type {Record<string, any>} */
  const scalars = {
    insuredName: 'Kiln Street Manufacturing LLC',
    receivedDate: '2026-03-02',
    requestedEffectiveDate: '2026-04-01',
    // Default the stated total to what the schedule actually foots to, so the
    // baseline context raises no TIV conflict and each test moves one thing.
    statedTiv: sumInsuredValue(locations).total,
    ...(spec.fields ?? {}),
  };

  /** @type {Record<string, any>} */
  const fields = {};
  for (const [name, value] of Object.entries(scalars)) fields[name] = toField(name, value);

  fields.lossRunTotalIncurred = losses.length
    ? makeField('lossRunTotalIncurred', incurred, unreadableLoss === 0 ? 0.95 : 0.6)
    : makeField('lossRunTotalIncurred', null, 0.2);
  fields.lossCount = makeField('lossCount', losses.length, losses.length ? 0.97 : 0.4);

  /** @type {import('../src/core/types.js').ExtractionResult} */
  const extraction = {
    fields,
    locations,
    losses,
    endorsements,
    notes: spec.notes ?? [],
    documentsRead: ['acord', 'sov', 'loss_run'],
    inputChars: 4_000,
    passes: 1,
    outputTokensEstimate: 500,
  };

  const version = { id: 'fixture', guidelines };
  const resolution = resolve(extraction, version);
  const resolvedFields = { ...extraction.fields, computedTiv: computedTivField(resolution) };

  return {
    packet: { packetId: 'PKT-FIXTURE', label: 'Fixture packet', documents: [], edgeCases: [] },
    extraction,
    resolution,
    fields: resolvedFields,
    locations: resolution.locations,
    listedLocations: resolution.listedLocations,
    duplicateGroups: resolution.duplicateGroups,
    appliedEndorsements: resolution.appliedEndorsements,
    guidelines,
  };
}

/**
 * Run the whole downstream pipeline over a fixture context.
 *
 * @param {ReturnType<typeof makeContext>} ctx
 */
export function evaluate(ctx) {
  const checks = runChecks(ctx);
  const conflicts = findConflicts(ctx);
  return { checks, conflicts, routing: route(ctx, checks, conflicts) };
}

/**
 * @param {import('../src/core/types.js').CheckResult[]} checks
 * @param {string} id
 */
export function checkById(checks, id) {
  const found = checks.find((c) => c.id === id);
  assert.ok(found, `expected a ${id} result`);
  return found;
}

test('the default fixture is clean, so every other test moves exactly one thing', () => {
  const ctx = makeContext();
  const { checks, conflicts, routing } = evaluate(ctx);

  assert.deepEqual(
    checks.filter((c) => c.status !== 'pass').map((c) => `${c.id}:${c.status}`),
    [],
    'the baseline fixture should pass all five guidelines',
  );
  assert.deepEqual(conflicts, []);
  assert.equal(routing.abstained, false);
  assert.equal(routing.decision, 'quote');
});
