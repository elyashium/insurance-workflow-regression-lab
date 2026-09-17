/**
 * The extraction engine.
 *
 * One traversal, driven by a profile. v1 and v2 are the same walk over the
 * same documents with different label aliases, a different number parser, a
 * different set of documents in scope, and two optional heuristics. That is
 * deliberate: when the scorecard shows a difference between versions, it can
 * be attributed to a named config value rather than to two codebases that
 * drifted apart. The profiles live in v1-regex.js and v2-heuristic.js.
 */

import { linesStartingWith, splitCells, makeSpan } from '../text.js';
import { field, missingField } from '../types.js';
import { parseStrictCurrency, parseLooseCurrency } from '../money.js';
import { distinctiveStreetToken } from '../address.js';
import {
  readDocLabel,
  currencyField,
  yearField,
  textField,
  parseCityStateZip,
  parseLossRows,
  totalIncurred,
  estimateTokens,
} from './shared.js';

/**
 * Construction classes the context back-fill will guess at, most specific
 * first. This list is the mechanism behind the regression v2 introduces: a
 * hedged phrase in a broker email ("looks like older masonry") becomes a
 * confident-looking structured value.
 */
const CONSTRUCTION_KEYWORDS = [
  { re: /fire[-\s]resistive/i, value: 'Fire Resistive' },
  { re: /masonry non[-\s]combustible/i, value: 'Masonry Non-Combustible' },
  { re: /non[-\s]combustible/i, value: 'Non-Combustible' },
  { re: /joisted masonry/i, value: 'Joisted Masonry' },
  { re: /masonry/i, value: 'Joisted Masonry' },
  { re: /\bframe\b/i, value: 'Frame' },
];

const BACKFILL_WINDOW_CHARS = 400;
const EARLIEST_PLAUSIBLE_BUILD_YEAR = 1850;

/**
 * @param {import('../core/packets.js').Packet} packet
 * @param {string} docId
 */
function getDoc(packet, docId) {
  return packet.documents.find((d) => d.docId === docId) || null;
}

/**
 * Read the scalar fields off the application form.
 *
 * @param {import('../text.js').SourceDoc | null} acord
 * @param {any} profile
 * @param {(raw: string) => number | null} parseCurrency
 */
function extractApplicationFields(acord, profile, parseCurrency) {
  /** @type {Record<string, import('../types.js').ExtractedField>} */
  const fields = {};

  if (!acord) {
    for (const name of ['insuredName', 'receivedDate', 'requestedEffectiveDate', 'statedTiv']) {
      fields[name] = missingField(name, 0.1, 'Application document not in scope', 'doc-missing');
    }
    return fields;
  }

  const name = readDocLabel(acord, profile.labels.insuredName);
  fields.insuredName = name
    ? field('insuredName', name.raw, 0.96, name.span, { method: `label:${name.labelMatched}` })
    : missingField(
        'insuredName',
        0.2,
        `No line matched any of: ${profile.labels.insuredName.join(', ')}`,
        'label-miss',
      );

  for (const [key, labels] of [
    ['receivedDate', profile.labels.receivedDate],
    ['requestedEffectiveDate', profile.labels.effectiveDate],
  ]) {
    const hit = readDocLabel(acord, labels);
    if (!hit) {
      fields[key] = missingField(
        key,
        0.2,
        `No line matched any of: ${labels.join(', ')}`,
        'label-miss',
      );
      continue;
    }
    const iso = /^(\d{4}-\d{2}-\d{2})$/.exec(hit.raw);
    fields[key] = iso
      ? field(key, iso[1], 0.97, hit.span, { method: `label:${hit.labelMatched}` })
      : missingField(key, 0.25, `Could not parse "${hit.raw}" as an ISO date`, 'date-parse-fail');
  }

  const tiv = readDocLabel(acord, profile.labels.statedTiv);
  if (!tiv) {
    fields.statedTiv = missingField(
      'statedTiv',
      0.2,
      `No line matched any of: ${profile.labels.statedTiv.join(', ')}`,
      'label-miss',
    );
  } else {
    const parsed = parseCurrency(tiv.raw);
    fields.statedTiv =
      parsed == null
        ? missingField(
            'statedTiv',
            0.25,
            `Could not parse "${tiv.raw}" as a currency amount`,
            'currency-parse-fail',
          )
        : field('statedTiv', parsed, 0.96, tiv.span, { method: `label:${tiv.labelMatched}` });
  }

  return fields;
}

/**
 * Read the location rows off the schedule of values.
 *
 * @param {import('../text.js').SourceDoc | null} sov
 * @param {any} profile
 * @param {(raw: string) => number | null} parseCurrency
 * @returns {import('../types.js').LocationRecord[]}
 */
function extractLocations(sov, profile, parseCurrency) {
  if (!sov) return [];

  return linesStartingWith(sov, 'LOC |').map((line, i) => {
    const cells = splitCells(sov, line);
    const locId = cells[1]?.text || `L${i + 1}`;
    const addressCell = cells[2];
    const cszCell = cells[3];

    const address = addressCell
      ? field(
          'address',
          addressCell.text,
          0.97,
          makeSpan(sov, addressCell.start, addressCell.end),
          { method: 'sov-row' },
        )
      : missingField('address', 0.15, 'Row had no address cell', 'sov-row');

    const csz = cszCell
      ? parseCityStateZip(sov, cszCell)
      : {
          city: missingField('city', 0.15, 'Row had no city/state/zip cell', 'sov-row'),
          state: missingField('state', 0.15, 'Row had no city/state/zip cell', 'sov-row'),
          zip: missingField('zip', 0.15, 'Row had no city/state/zip cell', 'sov-row'),
        };

    return {
      locId,
      sourceSpan: makeSpan(sov, line.start, line.end),
      isDuplicateOf: null,
      fields: {
        address,
        city: csz.city,
        state: csz.state,
        zip: csz.zip,
        buildingValue: currencyField(
          'buildingValue', sov, cells, profile.labels.building, parseCurrency),
        contentsValue: currencyField(
          'contentsValue', sov, cells, profile.labels.contents, parseCurrency),
        biValue: currencyField('biValue', sov, cells, profile.labels.bi, parseCurrency),
        constructionType: textField(
          'constructionType', sov, cells, profile.labels.construction),
        yearBuilt: yearField('yearBuilt', sov, cells, profile.labels.yearBuilt),
      },
    };
  });
}

/**
 * Read ENDORSE rows out of a late endorsement document.
 *
 * @param {import('../text.js').SourceDoc | null} endorsementDoc
 * @param {(raw: string) => number | null} parseCurrency
 */
function extractEndorsements(endorsementDoc, parseCurrency) {
  if (!endorsementDoc) return [];

  const dateHit = readDocLabel(endorsementDoc, ['Date']);
  const endorsementDate = dateHit && /^\d{4}-\d{2}-\d{2}$/.test(dateHit.raw) ? dateHit.raw : null;

  /** Map the document's field wording onto our own field names. */
  const FIELD_MAP = {
    building: 'buildingValue',
    contents: 'contentsValue',
    bi: 'biValue',
    'business interruption': 'biValue',
  };

  return linesStartingWith(endorsementDoc, 'ENDORSE |')
    .map((line, i) => {
      const cells = splitCells(endorsementDoc, line);
      const locHintId = cells[1]?.text || null;
      const locHintAddress = cells[2]?.text || null;
      const changeCell = cells[3];
      if (!changeCell) return null;

      const m = /^(.+?)\s*:\s*(.+?)\s*->\s*(.+?)$/.exec(changeCell.text);
      if (!m) return null;

      const targetField = FIELD_MAP[m[1].trim().toLowerCase()];
      if (!targetField) return null;

      const toValue = parseCurrency(m[3]);
      if (toValue == null) return null;

      return {
        endorsementId: `end-${i + 1}`,
        endorsementDate,
        locHintId,
        locHintAddress,
        targetField,
        fromValue: parseCurrency(m[2]),
        toValue,
        span: makeSpan(endorsementDoc, line.start, line.end),
      };
    })
    .filter(Boolean);
}

/**
 * Guess at values the schedule left blank, using nearby prose.
 *
 * This is the heuristic that makes v2 look clever and is also the one that
 * introduces a regression. A schedule that leaves a cell blank is asserting
 * "we do not know". Replacing that assertion with an inference drawn from an
 * adjacent sentence produces a value that is plausible, confidently typed, and
 * wrong - and it suppresses the data-completeness flag that would otherwise
 * have sent the packet to an underwriter. Confidence is set low (0.5) and the
 * method is tagged, so the trace shows exactly where the value came from.
 *
 * @param {import('../types.js').LocationRecord[]} locations
 * @param {import('../text.js').SourceDoc | null} sov
 * @param {import('../text.js').SourceDoc | null} email
 * @param {string[]} notes
 */
function applyContextBackfill(locations, sov, email, notes) {
  const thisYear = new Date().getUTCFullYear();

  // Prose lines on the schedule: everything that is not a location row.
  const proseLines = sov ? sov.lines.filter((l) => !l.text.trimStart().startsWith('LOC |')) : [];

  for (const loc of locations) {
    // Year built, taken from a schedule note that names this row's location id.
    if (loc.fields.yearBuilt.value == null && sov) {
      const idRe = new RegExp(`\\b${loc.locId}\\b`);
      const noteLine = proseLines.find((l) => idRe.test(l.text));
      if (noteLine) {
        const yearMatch = /\b(1[89]\d{2}|20\d{2})\b/.exec(noteLine.text);
        const year = yearMatch ? Number(yearMatch[1]) : null;
        if (year && year >= EARLIEST_PLAUSIBLE_BUILD_YEAR && year <= thisYear + 1) {
          const idx = noteLine.text.indexOf(yearMatch[1]);
          loc.fields.yearBuilt = field('yearBuilt', year, 0.5, makeSpan(
            sov, noteLine.start + idx, noteLine.start + idx + yearMatch[1].length), {
            note: `Inferred from a schedule note referencing ${loc.locId}. Not stated as a build year.`,
            method: 'context-backfill',
          });
          notes.push(
            `Back-filled yearBuilt=${year} for ${loc.locId} from schedule prose (low confidence).`,
          );
        }
      }
    }

    // Construction class, taken from broker prose near a mention of the street.
    if (loc.fields.constructionType.value == null && email) {
      const token = distinctiveStreetToken(loc.fields.address.value);
      const hit = token ? findConstructionNear(email, token) : null;
      if (hit) {
        loc.fields.constructionType = field(
          'constructionType', hit.value, 0.5, makeSpan(email, hit.start, hit.end), {
            note: `Inferred from broker email prose near "${token}". The email hedges this; the schedule left it blank.`,
            method: 'context-backfill',
          },
        );
        notes.push(
          `Back-filled constructionType="${hit.value}" for ${loc.locId} from email prose (low confidence).`,
        );
      }
    }
  }
}

/**
 * Look for a construction class in prose near any mention of `token`.
 *
 * Every occurrence is considered, not just the first, so whether this fires
 * depends on what the email actually says rather than on where the first
 * mention happens to fall. PKT-008's email names its blank location three
 * times and never guesses at a construction class, so nothing is back-filled
 * there. PKT-002's email hedges - "looks like older masonry" - and that hedge
 * is what gets promoted into a structured value.
 *
 * @param {import('../text.js').SourceDoc} email
 * @param {string} token
 * @returns {{ value: string, start: number, end: number } | null}
 */
function findConstructionNear(email, token) {
  const haystack = email.text.toLowerCase();
  const needle = token.toLowerCase();

  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const from = Math.max(0, at - BACKFILL_WINDOW_CHARS);
    const to = Math.min(email.text.length, at + BACKFILL_WINDOW_CHARS);
    const window = email.text.slice(from, to);

    for (const keyword of CONSTRUCTION_KEYWORDS) {
      const m = keyword.re.exec(window);
      if (m) {
        return { value: keyword.value, start: from + m.index, end: from + m.index + m[0].length };
      }
    }
  }
  return null;
}

/**
 * Run an extraction profile over a packet.
 *
 * @param {import('../packets.js').Packet} packet
 * @param {any} profile
 * @returns {import('../types.js').ExtractionResult}
 */
export function runExtraction(packet, profile) {
  const parseCurrency = profile.currency === 'strict' ? parseStrictCurrency : parseLooseCurrency;

  const inScope = packet.documents.filter((d) => profile.documents.includes(d.docId));
  const acord = getDoc(packet, 'acord');
  const sov = getDoc(packet, 'sov');
  const lossRun = getDoc(packet, 'loss_run');
  const email = getDoc(packet, 'email');
  const endorsementDoc = getDoc(packet, 'endorsement');

  const readable = (doc) => (doc && profile.documents.includes(doc.docId) ? doc : null);

  /** @type {string[]} */
  const notes = [];

  const fields = extractApplicationFields(readable(acord), profile, parseCurrency);
  const locations = extractLocations(readable(sov), profile, parseCurrency);
  const losses = readable(lossRun) ? parseLossRows(lossRun, parseCurrency) : [];

  const endorsements = profile.readEndorsements
    ? extractEndorsements(readable(endorsementDoc), parseCurrency)
    : [];

  if (!profile.readEndorsements && endorsementDoc) {
    notes.push(
      'An endorsement document is present in this packet but is not in this version\'s document scope.',
    );
  }

  if (profile.contextBackfill) {
    applyContextBackfill(locations, readable(sov), readable(email), notes);
  }

  const incurred = totalIncurred(losses);
  fields.lossRunTotalIncurred = losses.length
    ? field('lossRunTotalIncurred', incurred.total, incurred.unreadable === 0 ? 0.95 : 0.6,
        losses[0].sourceSpan, {
          note: incurred.unreadable
            ? `${incurred.unreadable} claim amount(s) could not be parsed and were treated as zero.`
            : null,
          method: 'sum:claim-rows',
        })
    : missingField('lossRunTotalIncurred', 0.2, 'No claim rows in scope', 'no-loss-rows');

  fields.lossCount = field('lossCount', losses.length, losses.length ? 0.97 : 0.4, null, {
    method: 'count:claim-rows',
  });

  const inputChars = inScope.reduce((sum, d) => sum + d.text.length, 0);
  const result = {
    fields,
    locations,
    losses,
    endorsements,
    notes,
    documentsRead: inScope.map((d) => d.docId),
    inputChars,
    passes: profile.passes ?? 1,
    outputTokensEstimate: 0,
  };

  result.outputTokensEstimate = estimateTokens(JSON.stringify(result).length);
  return result;
}
