/**
 * Extraction behaviour over the real synthetic corpus.
 *
 * The unit tests elsewhere use hand-built fixtures so a single value can be put
 * on a boundary. These tests do the opposite: they run the actual profiles over
 * the actual packets, because the packets are where the planted defects live
 * and a profile change that stops finding one of them should fail loudly here
 * rather than show up as a moved number in the scorecard.
 *
 * Every packet named below is synthetic. The addresses, insureds and brokers
 * are invented for this lab.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadAllPackets, loadGroundTruth } from '../src/core/packets.js';
import { runExtraction } from '../src/core/extractors/engine.js';
import { V1_PROFILE } from '../src/core/extractors/v1-regex.js';
import { V2_PROFILE } from '../src/core/extractors/v2-heuristic.js';
import { getVersion } from '../src/core/versions.js';

const packets = await loadAllPackets();
const byId = new Map(packets.map((p) => [p.packetId, p]));
const groundTruth = await loadGroundTruth();

/** v2 with the back-fill switch off and nothing else changed. */
const V21_PROFILE = getVersion('v2.1-no-backfill').extractorProfile;

/**
 * @param {string} packetId
 * @param {any} profile
 */
function extract(packetId, profile) {
  const packet = byId.get(packetId);
  assert.ok(packet, `${packetId} is missing from the corpus`);
  return runExtraction(packet, profile);
}

/**
 * @param {import('../src/core/types.js').ExtractionResult} extraction
 * @param {string} locId
 */
function loc(extraction, locId) {
  const found = extraction.locations.find((l) => l.locId === locId);
  assert.ok(found, `expected a location row ${locId}`);
  return found;
}

/* ------------------------------------------------------------------ *
 * The corpus itself
 * ------------------------------------------------------------------ */

test('the corpus on disk matches the ground truth file', () => {
  const onDisk = packets.map((p) => p.packetId);
  const labelled = Object.keys(groundTruth).filter((k) => !k.startsWith('_'));
  assert.deepEqual(onDisk, labelled.sort());
  assert.ok(onDisk.length >= 6 && onDisk.length <= 10, 'the brief asks for 6-10 packets');
});

test('all five required edge cases are represented in the corpus', () => {
  const seen = new Set(packets.flatMap((p) => p.edgeCases));
  for (const required of [
    'MISSING_FIELD',
    'DUPLICATE_LOCATION',
    'INCONSISTENT_DATES',
    'CONFLICTING_LIMITS',
    'LATE_ENDORSEMENT',
  ]) {
    assert.ok(seen.has(required), `no packet in the corpus exercises ${required}`);
  }
});

test('PKT-001 is a clean baseline both versions read identically', () => {
  const expected = groundTruth['PKT-001'].fields;

  for (const profile of [V1_PROFILE, V2_PROFILE]) {
    const e = extract('PKT-001', profile);
    for (const [name, value] of Object.entries(expected)) {
      if (name === 'computedTiv') continue; // derived in resolve(), not extraction
      assert.equal(e.fields[name].value, value, `${profile.id} misread ${name}`);
    }
    assert.equal(e.locations.length, 2);
    assert.deepEqual(e.notes, [], `${profile.id} should have nothing to report on a clean packet`);
  }
});

/* ------------------------------------------------------------------ *
 * Document scope
 * ------------------------------------------------------------------ */

test('v1 leaves the broker email and the endorsement out of scope', () => {
  assert.deepEqual(extract('PKT-002', V1_PROFILE).documentsRead, ['acord', 'sov', 'loss_run']);
  assert.deepEqual(extract('PKT-006', V1_PROFILE).documentsRead, ['acord', 'sov', 'loss_run']);
});

test('v2 reads them, and v1 says out loud that it did not', () => {
  assert.deepEqual(
    extract('PKT-002', V2_PROFILE).documentsRead,
    ['acord', 'sov', 'loss_run', 'email'],
  );

  const v1 = extract('PKT-006', V1_PROFILE);
  assert.equal(v1.endorsements.length, 0);
  assert.ok(
    v1.notes.some((n) => /endorsement document is present .* not in this version's document scope/.test(n)),
    'a version that cannot see a document in the packet has to record that it could not',
  );
});

/* ------------------------------------------------------------------ *
 * "Blank" and "unreadable" are different claims
 * ------------------------------------------------------------------ */

test('a label present but empty is an assertion of absence, not a failure to read', () => {
  // PKT-002 L2 carries "Year Built:" with nothing after it. The broker is
  // saying they do not know. Both versions recognise that label, so both should
  // report null with high confidence rather than a low-confidence guess.
  for (const profile of [V1_PROFILE, V2_PROFILE, V21_PROFILE]) {
    const f = loc(extract('PKT-002', profile), 'L2').fields.yearBuilt;
    if (f.method === 'context-backfill') continue; // covered by the regression test below
    assert.equal(f.value, null);
    assert.equal(f.confidence, 0.9, `${profile.id} should be confident the value is absent`);
    assert.equal(f.method, 'explicit-blank');
  }
});

test('an unrecognised label is a failure to read, and is reported as one', () => {
  // The same row writes "Constr:" where v1 only knows "Construction:". v1's
  // null here means "I could not read this cell", which is a different claim
  // from the one above and must not be reported with the same confidence.
  const f = loc(extract('PKT-002', V1_PROFILE), 'L2').fields.constructionType;
  assert.equal(f.value, null);
  assert.equal(f.confidence, 0.2);
  assert.equal(f.method, 'label-miss');
  assert.match(f.note, /Construction/);
});

/* ------------------------------------------------------------------ *
 * The planted regression
 * ------------------------------------------------------------------ */

test('v2 invents two values on PKT-002 L2 that the packet does not contain', () => {
  // This is the regression the lab exists to catch. The schedule leaves both
  // cells blank and the ground truth records null for both; v2 fills them from
  // prose. The email hedges ("looks like" older masonry) and the schedule note
  // gives an acquisition year, not a build year - so both values are plausible,
  // confidently typed, and wrong.
  const truth = groundTruth['PKT-002'].locations[1];
  assert.equal(truth.constructionType, null);
  assert.equal(truth.yearBuilt, null);

  const l2 = loc(extract('PKT-002', V2_PROFILE), 'L2');

  assert.equal(l2.fields.constructionType.value, 'Joisted Masonry');
  assert.equal(l2.fields.constructionType.confidence, 0.5);
  assert.equal(l2.fields.constructionType.method, 'context-backfill');

  assert.equal(l2.fields.yearBuilt.value, 2025);
  assert.equal(l2.fields.yearBuilt.confidence, 0.5);
  assert.equal(l2.fields.yearBuilt.method, 'context-backfill');
});

test('an inferred value points at the prose it came from, not at the blank cell', () => {
  const l2 = loc(extract('PKT-002', V2_PROFILE), 'L2');

  const construction = l2.fields.constructionType.evidence;
  assert.equal(construction.docId, 'email');
  assert.match(construction.snippet.toLowerCase(), /masonry/);

  const year = l2.fields.yearBuilt.evidence;
  assert.equal(year.docId, 'sov');
  assert.equal(year.snippet, '2025');
});

test('v2 records the two inferences in its own notes', () => {
  const notes = extract('PKT-002', V2_PROFILE).notes;
  assert.equal(notes.length, 2);
  assert.ok(notes.some((n) => /Back-filled constructionType="Joisted Masonry" for L2/.test(n)));
  assert.ok(notes.some((n) => /Back-filled yearBuilt=2025 for L2/.test(n)));
});

test('v2.1 drops the inferences and keeps everything else v2 gained', () => {
  const l2 = loc(extract('PKT-002', V21_PROFILE), 'L2');
  assert.equal(l2.fields.constructionType.value, null);
  assert.equal(l2.fields.yearBuilt.value, null);
  assert.deepEqual(extract('PKT-002', V21_PROFILE).notes, []);

  // The fix has to be narrow: v2.1 still resolves the alias v1 could not.
  assert.equal(l2.fields.constructionType.method, 'explicit-blank');
  assert.equal(l2.fields.constructionType.confidence, 0.9);
});

test('back-fill stays silent when the prose declines to guess', () => {
  // PKT-008's email names the blank location three times and each time says
  // the construction class is not known yet. Nothing in the window matches a
  // construction keyword, so nothing is filled in. This is the control case
  // for the regression above: back-fill is not unconditionally destructive,
  // which is exactly what makes it hard to notice.
  const l3 = loc(extract('PKT-008', V2_PROFILE), 'L3');
  assert.equal(l3.fields.constructionType.value, null);
  assert.equal(l3.fields.yearBuilt.value, null);
  assert.ok(
    !extract('PKT-008', V2_PROFILE).notes.some((n) => /Back-filled/.test(n)),
    'nothing should have been inferred on PKT-008',
  );
});

/* ------------------------------------------------------------------ *
 * Number parsing
 * ------------------------------------------------------------------ */

test('v1 refuses "$3.1M" rather than guessing at it', () => {
  const f = loc(extract('PKT-007', V1_PROFILE), 'L3').fields.biValue;
  assert.equal(f.value, null);
  assert.equal(f.confidence, 0.25);
  assert.equal(f.method, 'currency-parse-fail');
  assert.match(f.note, /\$3\.1M/);
});

test('v2 reads the shorthand, and reads it as whole dollars', () => {
  assert.equal(loc(extract('PKT-007', V2_PROFILE), 'L3').fields.biValue.value, 3_100_000);
});

test('v2 reads an unformatted figure that v1 cannot match a label to', () => {
  // PKT-008 L3 is written "Bldg Val: 16700000" - a label v1 does not know, and
  // a number v1 would not accept even if it did.
  const v1 = loc(extract('PKT-008', V1_PROFILE), 'L3').fields;
  assert.equal(v1.buildingValue.value, null);
  assert.equal(v1.buildingValue.method, 'label-miss');
  assert.equal(v1.contentsValue.value, null);

  const v2 = loc(extract('PKT-008', V2_PROFILE), 'L3').fields;
  assert.equal(v2.buildingValue.value, 16_700_000);
  assert.equal(v2.buildingValue.method, 'label:Bldg Val');
  assert.equal(v2.contentsValue.value, 9_900_000);
  assert.equal(v2.biValue.value, 4_200_000);
});

/* ------------------------------------------------------------------ *
 * Label aliases on the application form
 * ------------------------------------------------------------------ */

test('v1 cannot read an insured name written as "Insured Name (DBA)"', () => {
  const v1 = extract('PKT-008', V1_PROFILE).fields.insuredName;
  assert.equal(v1.value, null);
  assert.equal(v1.method, 'label-miss');

  const v2 = extract('PKT-008', V2_PROFILE).fields.insuredName;
  assert.equal(v2.value, 'Quarry Point Data Centers');
  assert.equal(v2.method, 'label:Insured Name (DBA)');
});

test('v1 cannot read a total written as "TIV (stated)" - which is why it never sees the mismatch', () => {
  // PKT-005's whole point: the packet states $48.9M and the schedule foots to
  // $55.65M. A version that cannot read the stated figure cannot notice the
  // disagreement, so it reports a clean packet that is not clean.
  const v1 = extract('PKT-005', V1_PROFILE).fields.statedTiv;
  assert.equal(v1.value, null);
  assert.equal(v1.method, 'label-miss');

  assert.equal(extract('PKT-005', V2_PROFILE).fields.statedTiv.value, 48_900_000);
});

test('v1 reports a year it could not read the label for as simply absent', () => {
  // PKT-004 writes "Yr Built:" with the year plainly present. v1 reports null.
  // Nothing downstream can tell this apart from a genuinely empty cell except
  // by the confidence and the method, which is why both are carried.
  const v1 = loc(extract('PKT-004', V1_PROFILE), 'L1').fields.yearBuilt;
  assert.equal(v1.value, null);
  assert.equal(v1.confidence, 0.2);
  assert.equal(v1.method, 'label-miss');

  const v2 = loc(extract('PKT-004', V2_PROFILE), 'L1').fields.yearBuilt;
  assert.equal(v2.value, 1991);
  assert.equal(v2.method, 'label:Yr Built');
});

/* ------------------------------------------------------------------ *
 * Endorsements
 * ------------------------------------------------------------------ */

test('v2 reads the late endorsement as a change, not as a value', () => {
  const [endorsement, ...rest] = extract('PKT-006', V2_PROFILE).endorsements;
  assert.deepEqual(rest, [], 'PKT-006 carries exactly one endorsement row');

  assert.equal(endorsement.locHintId, 'L1');
  assert.equal(endorsement.locHintAddress, '500 Lakeshore Promenade');
  assert.equal(endorsement.targetField, 'buildingValue');
  assert.equal(endorsement.fromValue, 14_200_000);
  assert.equal(endorsement.toValue, 28_200_000);
  assert.equal(endorsement.endorsementDate, '2026-02-04');

  // The schedule value is untouched at extraction time. Applying the change is
  // resolve()'s job, so the trace can show both figures.
  assert.equal(loc(extract('PKT-006', V2_PROFILE), 'L1').fields.buildingValue.value, 14_200_000);
});

/* ------------------------------------------------------------------ *
 * Properties that should hold for every packet
 * ------------------------------------------------------------------ */

test('every value the extractor reports is either evidenced or explained', () => {
  for (const packet of packets) {
    for (const profile of [V1_PROFILE, V2_PROFILE]) {
      const e = runExtraction(packet, profile);
      const rows = [...e.locations, ...e.losses];

      for (const row of rows) {
        const rowId = 'locId' in row ? row.locId : row.lossId;
        for (const [name, f] of Object.entries(row.fields)) {
          const where = `${packet.packetId}/${profile.id}/${rowId}.${name}`;
          if (f.value != null) {
            assert.ok(f.evidence, `${where} has a value but no evidence span`);
            assert.equal(typeof f.evidence.line, 'number', `${where} evidence has no line`);
            assert.ok(f.evidence.end > f.evidence.start, `${where} evidence span is empty`);
          } else {
            assert.ok(f.note, `${where} is null without saying why`);
          }
        }
      }
    }
  }
});

test('an evidence span quotes the document it points into', () => {
  for (const packet of packets) {
    const e = runExtraction(packet, V2_PROFILE);
    for (const row of e.locations) {
      for (const f of Object.values(row.fields)) {
        if (!f.evidence) continue;
        const doc = packet.documents.find((d) => d.docId === f.evidence.docId);
        assert.ok(doc, `${f.evidence.docId} is not a document in ${packet.packetId}`);
        assert.equal(
          doc.text.slice(f.evidence.start, f.evidence.end),
          f.evidence.snippet,
          `${packet.packetId} ${row.locId} span offsets do not match the snippet they carry`,
        );
      }
    }
  }
});

test('confidence never claims more than the method earns', () => {
  const CEILING = { 'context-backfill': 0.5, 'label-miss': 0.2, 'currency-parse-fail': 0.25 };

  for (const packet of packets) {
    for (const profile of [V1_PROFILE, V2_PROFILE]) {
      for (const row of runExtraction(packet, profile).locations) {
        for (const [name, f] of Object.entries(row.fields)) {
          const ceiling = CEILING[f.method];
          if (ceiling === undefined) continue;
          assert.ok(
            f.confidence <= ceiling,
            `${packet.packetId} ${row.locId}.${name} claims ${f.confidence} via ${f.method}`,
          );
        }
      }
    }
  }
});

test('the cost model has something to charge for', () => {
  const v1 = extract('PKT-002', V1_PROFILE);
  const v2 = extract('PKT-002', V2_PROFILE);

  assert.equal(v1.passes, 1);
  assert.equal(v2.passes, 2);
  assert.ok(v2.inputChars > v1.inputChars, 'v2 reads a document v1 does not');
  assert.ok(v1.outputTokensEstimate > 0 && v2.outputTokensEstimate > 0);
});
