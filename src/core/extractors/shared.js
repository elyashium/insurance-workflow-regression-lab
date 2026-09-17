/**
 * Parsing helpers shared by the extractors.
 *
 * The two extractors differ in which labels they recognise and how tolerant
 * their number parsing is, not in how they walk the documents. Keeping the
 * walking here means a difference in the scorecard is always traceable to a
 * difference in label aliases or number handling, never to a difference in
 * document traversal.
 */

import { makeSpan, splitCells, linesStartingWith, matchWithSpan } from '../text.js';
import { field, missingField } from '../types.js';

const CITY_STATE_ZIP_RE = /^(.+?),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/;

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @typedef {Object} Cell
 * @property {string} text
 * @property {number} start
 * @property {number} end
 */

/**
 * @typedef {Object} LabelHit
 * @property {string} raw          the value text after the colon, trimmed
 * @property {import('../text.js').Span} span
 * @property {string} labelMatched
 * @property {boolean} blank       label was present but carried no value
 */

/**
 * Read a "Label: value" cell, trying each alias in order.
 *
 * The distinction between "no alias matched" and "alias matched but blank"
 * carries real weight downstream. A blank is an assertion by the document that
 * the value is unknown, and an extractor can report null for it with high
 * confidence. An unmatched label means the extractor simply could not read the
 * cell, and its null is a guess that should be reported with low confidence.
 *
 * @param {import('../text.js').SourceDoc} doc
 * @param {Cell} cell
 * @param {string[]} labels
 * @returns {LabelHit | null} null when no alias matched
 */
export function readLabeledCell(doc, cell, labels) {
  for (const label of labels) {
    const re = new RegExp(`^${escapeRegex(label)}\\s*:\\s*(.*)$`, 'i');
    const m = re.exec(cell.text);
    if (!m) continue;

    const raw = m[1].trim();
    if (raw === '') {
      return {
        raw: '',
        span: makeSpan(doc, cell.start, cell.end),
        labelMatched: label,
        blank: true,
      };
    }
    const idx = cell.text.indexOf(raw);
    return {
      raw,
      span: makeSpan(doc, cell.start + idx, cell.start + idx + raw.length),
      labelMatched: label,
      blank: false,
    };
  }
  return null;
}

/**
 * Read a whole-line "Label: value" pair from a document, trying each alias in
 * order. Used for the application form, which is line-oriented rather than
 * pipe-delimited.
 *
 * @param {import('../text.js').SourceDoc} doc
 * @param {string[]} labels
 * @returns {{ raw: string, span: import('../text.js').Span, labelMatched: string } | null}
 */
export function readDocLabel(doc, labels) {
  for (const label of labels) {
    const re = new RegExp(`^${escapeRegex(label)}\\s*:[ \\t]*(.+?)[ \\t]*$`, 'm');
    const hit = matchWithSpan(doc, re);
    if (hit) return { raw: hit.value, span: hit.span, labelMatched: label };
  }
  return null;
}

/**
 * Find the first labelled cell on a record line matching any alias.
 *
 * @param {import('../text.js').SourceDoc} doc
 * @param {Cell[]} cells
 * @param {string[]} labels
 * @returns {LabelHit | null}
 */
export function findLabeled(doc, cells, labels) {
  for (const cell of cells) {
    const hit = readLabeledCell(doc, cell, labels);
    if (hit) return hit;
  }
  return null;
}

/**
 * Turn a labelled currency cell into an ExtractedField.
 *
 * @param {string} name
 * @param {import('../text.js').SourceDoc} doc
 * @param {Cell[]} cells
 * @param {string[]} labels
 * @param {(raw: string) => number | null} parseCurrency
 * @returns {import('../types.js').ExtractedField}
 */
export function currencyField(name, doc, cells, labels, parseCurrency) {
  const hit = findLabeled(doc, cells, labels);
  if (!hit) {
    return missingField(name, 0.2, `No cell matched any of: ${labels.join(', ')}`, 'label-miss');
  }
  if (hit.blank) {
    return field(name, null, 0.9, hit.span, {
      note: `"${hit.labelMatched}" present but blank - value is absent from the packet`,
      method: 'explicit-blank',
    });
  }
  const parsed = parseCurrency(hit.raw);
  if (parsed == null) {
    return missingField(
      name,
      0.25,
      `Could not parse "${hit.raw}" as a currency amount`,
      'currency-parse-fail',
    );
  }
  return field(name, parsed, 0.96, hit.span, { method: `label:${hit.labelMatched}` });
}

/**
 * Turn a labelled four-digit-year cell into an ExtractedField.
 *
 * @param {string} name
 * @param {import('../text.js').SourceDoc} doc
 * @param {Cell[]} cells
 * @param {string[]} labels
 * @returns {import('../types.js').ExtractedField}
 */
export function yearField(name, doc, cells, labels) {
  const hit = findLabeled(doc, cells, labels);
  if (!hit) {
    return missingField(name, 0.2, `No cell matched any of: ${labels.join(', ')}`, 'label-miss');
  }
  if (hit.blank) {
    return field(name, null, 0.9, hit.span, {
      note: `"${hit.labelMatched}" present but blank - value is absent from the packet`,
      method: 'explicit-blank',
    });
  }
  const m = /^(\d{4})$/.exec(hit.raw);
  if (!m) {
    return missingField(name, 0.25, `Could not parse "${hit.raw}" as a year`, 'year-parse-fail');
  }
  return field(name, Number(m[1]), 0.96, hit.span, { method: `label:${hit.labelMatched}` });
}

/**
 * Turn a labelled free-text cell into an ExtractedField.
 *
 * @param {string} name
 * @param {import('../text.js').SourceDoc} doc
 * @param {Cell[]} cells
 * @param {string[]} labels
 * @returns {import('../types.js').ExtractedField}
 */
export function textField(name, doc, cells, labels) {
  const hit = findLabeled(doc, cells, labels);
  if (!hit) {
    return missingField(name, 0.2, `No cell matched any of: ${labels.join(', ')}`, 'label-miss');
  }
  if (hit.blank) {
    return field(name, null, 0.9, hit.span, {
      note: `"${hit.labelMatched}" present but blank - value is absent from the packet`,
      method: 'explicit-blank',
    });
  }
  return field(name, hit.raw, 0.95, hit.span, { method: `label:${hit.labelMatched}` });
}

/**
 * Split "Tacoma, WA 98421" into its parts.
 *
 * @param {import('../text.js').SourceDoc} doc
 * @param {Cell} cell
 * @returns {{ city: import('../types.js').ExtractedField, state: import('../types.js').ExtractedField, zip: import('../types.js').ExtractedField }}
 */
export function parseCityStateZip(doc, cell) {
  const m = CITY_STATE_ZIP_RE.exec(cell.text);
  if (!m) {
    return {
      city: missingField('city', 0.2, `Could not parse "${cell.text}"`, 'csz-parse-fail'),
      state: missingField('state', 0.2, `Could not parse "${cell.text}"`, 'csz-parse-fail'),
      zip: missingField('zip', 0.2, `Could not parse "${cell.text}"`, 'csz-parse-fail'),
    };
  }
  const span = makeSpan(doc, cell.start, cell.end);
  return {
    city: field('city', m[1].trim(), 0.96, span, { method: 'city-state-zip' }),
    state: field('state', m[2], 0.98, span, { method: 'city-state-zip' }),
    zip: field('zip', m[3], 0.98, span, { method: 'city-state-zip' }),
  };
}

/**
 * Parse the CLAIM rows of a loss run.
 *
 * @param {import('../text.js').SourceDoc} doc
 * @param {(raw: string) => number | null} parseCurrency
 * @returns {import('../types.js').LossRecord[]}
 */
export function parseLossRows(doc, parseCurrency) {
  const records = [];
  const lines = linesStartingWith(doc, 'CLAIM |');

  lines.forEach((line, i) => {
    const cells = splitCells(doc, line);
    const lineSpan = makeSpan(doc, line.start, line.end);

    const dateCell = cells[1];
    const dateMatch = dateCell ? /^(\d{4}-\d{2}-\d{2})$/.exec(dateCell.text) : null;
    const dateField = dateMatch
      ? field(
          'lossDate',
          dateMatch[1],
          0.97,
          makeSpan(doc, dateCell.start, dateCell.end),
          { method: 'claim-row' },
        )
      : missingField('lossDate', 0.2, 'Claim row had no ISO date in position 2', 'claim-row');

    const causeField = cells[2]
      ? field('cause', cells[2].text, 0.95, makeSpan(doc, cells[2].start, cells[2].end), {
          method: 'claim-row',
        })
      : missingField('cause', 0.2, 'Claim row had no cause in position 3', 'claim-row');

    records.push({
      lossId: `${doc.docId}-claim-${i + 1}`,
      sourceSpan: lineSpan,
      fields: {
        lossDate: dateField,
        cause: causeField,
        paid: currencyField('paid', doc, cells, ['Paid'], parseCurrency),
        reserved: currencyField('reserved', doc, cells, ['Reserved'], parseCurrency),
        status: textField('status', doc, cells, ['Status']),
      },
    });
  });

  return records;
}

/**
 * Sum paid + reserved across loss records, treating unreadable amounts as
 * zero but reporting how many were unreadable.
 *
 * @param {import('../types.js').LossRecord[]} losses
 * @returns {{ total: number, unreadable: number }}
 */
export function totalIncurred(losses) {
  let total = 0;
  let unreadable = 0;
  for (const loss of losses) {
    const paid = loss.fields.paid.value;
    const reserved = loss.fields.reserved.value;
    if (paid == null) unreadable++;
    else total += paid;
    if (reserved == null) unreadable++;
    else total += reserved;
  }
  return { total, unreadable };
}

/**
 * Rough token estimate for the simulated cost model. Four characters per
 * token is the usual English approximation and is accurate enough for a
 * relative comparison between workflow versions.
 *
 * @param {number} chars
 * @returns {number}
 */
export function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}
