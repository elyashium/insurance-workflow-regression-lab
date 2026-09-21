/**
 * Workflow version 3: model-backed extraction (Groq).
 *
 * Same engine, same pipeline, same guidelines as v2 — the only change is who
 * does the reading. A chat model reads the in-scope documents and returns
 * structured JSON; this module resolves every returned quote back to exact
 * character offsets, so a model value carries the same evidence contract as a
 * regex one. A quote that cannot be found in the documents is kept but
 * distrusted (confidence halved, evidence null, noted) rather than dropped —
 * an unverifiable value is a fact about the run, not a reason to hide it.
 *
 * The model is instructed to report null where the packet is genuinely blank
 * and never to infer. v3 is therefore the anti-back-fill version: where v2's
 * heuristic guessed "Joisted Masonry" on PKT-002, v3 is asked to leave the
 * blank blank. The v2→v3 diff is the interesting one.
 */

import { makeSpan } from '../text.js';
import { field, missingField } from '../types.js';
import { complete, meterCost, DEFAULT_MODEL } from '../llm.js';

/** @type {any} */
export const V3_PROFILE = {
  id: 'v3-llm',
  name: 'v3 - model extraction',
  engine: 'llm',
  model: DEFAULT_MODEL,

  // Same document scope as v2. The endorsement is read as context (the model
  // is told to report amended values) but applying it stays a deterministic
  // reconciliation behavior v3 does not perform — see the note below.
  documents: ['acord', 'sov', 'loss_run', 'email', 'endorsement'],
  readEndorsements: false,
  contextBackfill: false,
  passes: 1,
};

const SYSTEM = [
  'You extract structured data from commercial-insurance submission documents.',
  'Return ONLY a single JSON object matching the schema. No prose, no markdown.',
  '',
  'Rules:',
  '- Every leaf is {"value": ..., "quote": "..."}. "quote" must be an EXACT substring of the supplied documents, copied verbatim, that states the value. It is how your answer is audited.',
  '- If the packet genuinely does not state a value, use {"value": null, "quote": null}. NEVER guess, infer, or fill a blank from context. A null is a correct answer, not a failure.',
  '- Currency: whole-dollar numbers with no symbols or commas (e.g. 12400000).',
  '- Dates: ISO YYYY-MM-DD strings. Year built: a 4-digit number.',
  '- ZIP codes: strings, exactly as printed.',
  '- "statedTiv" is the total insured value printed on the APPLICATION form, ignoring later amendments.',
  '- Locations: every insured location row, in schedule order, even partial rows (use nulls for unreadable cells).',
  '- If an endorsement amends a scheduled value, report the AMENDED value and quote the endorsement.',
  '- Losses: every claim row with lossDate (ISO), cause, paid and reserved (whole dollars, null if unreadable), status.',
  '',
  'Schema:',
  '{"insuredName": leaf, "receivedDate": leaf, "requestedEffectiveDate": leaf, "statedTiv": leaf,',
  ' "locations": [{"address": leaf, "city": leaf, "state": leaf, "zip": leaf, "buildingValue": leaf, "contentsValue": leaf, "biValue": leaf, "constructionType": leaf, "yearBuilt": leaf}],',
  ' "losses": [{"lossDate": leaf, "cause": leaf, "paid": leaf, "reserved": leaf, "status": leaf}]}',
  'where leaf is {"value": string|number|null, "quote": string|null}.',
].join('\n');

/**
 * @param {import('../packets.js').Packet} packet
 * @returns {{model: string, messages: any[]}} deterministic for a given packet
 */
export function buildPrompt(packet, profile) {
  const inScope = packet.documents.filter((d) => profile.documents.includes(d.docId));
  const sections = inScope.map(
    (d) => `=== DOCUMENT ${d.docId} (${d.name}) ===\n${d.text}`,
  );
  return {
    model: process.env.GROQ_MODEL ?? profile.model ?? DEFAULT_MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: sections.join('\n\n') },
    ],
  };
}

/**
 * Resolve a model-returned quote to an exact document span.
 *
 * @param {import('../text.js').SourceDoc[]} docs
 * @param {any} quote
 * @returns {import('../text.js').Span | null}
 */
export function spanForQuote(docs, quote) {
  if (typeof quote !== 'string' || !quote) return null;
  const q = quote.length > 500 ? quote.slice(0, 500) : quote;
  for (const doc of docs) {
    const at = doc.text.indexOf(q);
    if (at !== -1) return makeSpan(doc, at, at + q.length);
  }
  return null;
}

/**
 * @param {any} v
 * @returns {number | null}
 */
function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {any} v
 * @returns {string | null}
 */
function toText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Turn one model leaf into an ExtractedField.
 *
 * @param {string} name
 * @param {any} leaf
 * @param {import('../text.js').SourceDoc[]} docs
 * @param {(v: any) => any} normalize
 * @param {string} [absentNote]
 * @returns {import('../types.js').ExtractedField}
 */
function leafField(name, leaf, docs, normalize, absentNote = 'The model returned no value.') {
  const value = leaf && typeof leaf === 'object' ? normalize(leaf.value) : null;
  if (value == null) {
    return missingField(name, 0.4, absentNote, 'llm-miss');
  }
  const evidence = spanForQuote(docs, leaf.quote);
  const claimed =
    leaf && Number.isFinite(Number(leaf.confidence))
      ? Math.max(0, Math.min(1, Number(leaf.confidence)))
      : 0.85;
  if (!evidence) {
    return field(name, value, Math.min(claimed, 0.45), null, {
      note: 'The model cited text that does not occur verbatim in the documents, so the value is kept but distrusted.',
      method: 'llm-extract',
    });
  }
  return field(name, value, claimed, evidence, { method: 'llm-extract' });
}

/**
 * @param {import('../packets.js').Packet} packet
 * @param {any} profile
 * @returns {Promise<import('../types.js').ExtractionResult>}
 */
export async function llmExtract(packet, profile) {
  const inScope = packet.documents.filter((d) => profile.documents.includes(d.docId));
  const { model, messages } = buildPrompt(packet, profile);

  const out = await complete(model, messages);
  let parsed;
  try {
    parsed = JSON.parse(out.content);
  } catch {
    throw new Error(
      `Model ${model} returned unparseable JSON for ${packet.packetId} ` +
        `(cache ${out.cached ? 'hit' : 'miss'}). First 200 chars: ${out.content.slice(0, 200)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Model ${model} returned a non-object for ${packet.packetId}.`);
  }

  /** @type {string[]} */
  const notes = [
    `Model ${model} read ${inScope.length} document(s)${out.cached ? ' (cached response)' : ''}.`,
  ];
  const endorsementDoc = inScope.find((d) => d.docId === 'endorsement');
  if (endorsementDoc && !profile.readEndorsements) {
    notes.push(
      'The endorsement is read as context only; applying it stays a deterministic reconciliation behavior this version does not perform.',
    );
  }

  let unverified = 0;
  /** @param {import('../types.js').ExtractedField} f */
  const track = (f) => {
    if (f.value != null && !f.evidence) unverified++;
    return f;
  };

  const fields = {
    insuredName: track(leafField('insuredName', parsed.insuredName, inScope, toText)),
    receivedDate: track(leafField('receivedDate', parsed.receivedDate, inScope, toText)),
    requestedEffectiveDate: track(
      leafField('requestedEffectiveDate', parsed.requestedEffectiveDate, inScope, toText),
    ),
    statedTiv: track(leafField('statedTiv', parsed.statedTiv, inScope, toNumber)),
  };

  const locations = Array.isArray(parsed.locations) ? parsed.locations : [];
  const locationRecords = locations.map((row, i) => {
    const locId = `L${i + 1}`;
    const cell = (/** @type {string} */ name, /** @type {(v: any) => any} */ norm) =>
      track(leafField(name, row?.[name], inScope, norm));
    return {
      locId,
      fields: {
        address: cell('address', toText),
        city: cell('city', toText),
        state: cell('state', toText),
        zip: cell('zip', toText),
        buildingValue: cell('buildingValue', toNumber),
        contentsValue: cell('contentsValue', toNumber),
        biValue: cell('biValue', toNumber),
        constructionType: cell('constructionType', toText),
        yearBuilt: cell('yearBuilt', toNumber),
      },
      sourceSpan: null,
      isDuplicateOf: null,
    };
  });

  const losses = Array.isArray(parsed.losses) ? parsed.losses : [];
  let incurred = 0;
  let unreadableLoss = 0;
  const lossRecords = losses.map((row, i) => {
    const paid = toNumber(row?.paid);
    const reserved = toNumber(row?.reserved);
    if (paid == null) unreadableLoss++;
    else incurred += paid;
    if (reserved == null) unreadableLoss++;
    else incurred += reserved;
    /** @param {string} name @param {(v: any) => any} norm */
    const cell = (name, norm) => track(leafField(name, row?.[name], inScope, norm));
    const dateField = cell('lossDate', toText);
    return {
      lossId: `loss-llm-${i + 1}`,
      sourceSpan: dateField.evidence,
      fields: {
        lossDate: dateField,
        cause: cell('cause', toText),
        paid: paid == null ? missingField('paid', 0.4, 'The model returned no value.', 'llm-miss') : cell('paid', toNumber),
        reserved:
          reserved == null
            ? missingField('reserved', 0.4, 'The model returned no value.', 'llm-miss')
            : cell('reserved', toNumber),
        status: cell('status', toText),
      },
    };
  });

  if (unverified) {
    notes.push(
      `${unverified} value(s) cite text that does not occur verbatim and were kept at reduced confidence.`,
    );
  }

  fields.lossRunTotalIncurred = lossRecords.length
    ? field('lossRunTotalIncurred', incurred, unreadableLoss === 0 ? 0.95 : 0.6, lossRecords[0].sourceSpan, {
        note: unreadableLoss
          ? `${unreadableLoss} claim amount(s) could not be parsed and were treated as zero.`
          : null,
        method: 'sum:claim-rows',
      })
    : missingField('lossRunTotalIncurred', 0.2, 'No claim rows in scope', 'no-loss-rows');
  fields.lossCount = field('lossCount', lossRecords.length, lossRecords.length ? 0.97 : 0.4, null, {
    method: 'count:claim-rows',
  });

  const cost = {
    ...meterCost(model, out.usage),
    passes: 1,
    documentsRead: inScope.map((d) => d.docId),
  };
  const inputChars = inScope.reduce((sum, d) => sum + d.text.length, 0);

  return {
    fields,
    locations: locationRecords,
    losses: lossRecords,
    endorsements: [],
    notes,
    documentsRead: inScope.map((d) => d.docId),
    inputChars,
    passes: 1,
    outputTokensEstimate: out.usage.outputTokens,
    cost,
  };
}

/**
 * @param {import('../packets.js').Packet} packet
 * @returns {Promise<import('../types.js').ExtractionResult>}
 */
export function extract(packet) {
  return llmExtract(packet, V3_PROFILE);
}
