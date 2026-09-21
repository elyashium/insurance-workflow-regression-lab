/**
 * The simulated cost model.
 *
 * READ THIS BEFORE QUOTING A NUMBER FROM IT. Both extractors in this lab are
 * deterministic local code. They cost nothing to run. If the scorecard
 * reported true spend it would read $0.00 against $0.00, which is accurate and
 * tells you nothing about whether the more thorough version is worth paying
 * for.
 *
 * So cost here is modelled, not measured: the documents each version reads are
 * converted to a token count and priced at a made-up rate. The rate is
 * invented for this demo and is not any vendor's pricing. What the number is
 * good for is the RATIO - v2 reads two more documents and makes two passes, so
 * it costs meaningfully more per submission, and the scorecard makes that
 * trade-off visible against the accuracy it buys. What it is not good for is
 * forecasting a budget.
 *
 * Latency, by contrast, is really measured. See runner.js.
 */

/** Illustrative rate, in dollars per thousand tokens. Not a real price. */
export const PRICING = {
  inputPer1k: 0.003,
  outputPer1k: 0.015,
  label: 'Illustrative rate for the demo. Not any vendor\'s pricing.',
};

/** Four characters per token, the usual rough English approximation. */
const CHARS_PER_TOKEN = 4;

/**
 * @typedef {Object} CostEstimate
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} usd
 * @property {number} passes
 * @property {string[]} documentsRead
 * @property {boolean} simulated  always true for estimates, false for metered calls
 * @property {string | null} model  the metered model, or null for estimates
 */

/**
 * Price one extraction.
 *
 * @param {import('./types.js').ExtractionResult} extraction
 * @returns {CostEstimate}
 */
export function estimateCost(extraction) {
  const passes = Math.max(1, extraction.passes || 1);
  const inputTokens = Math.ceil(extraction.inputChars / CHARS_PER_TOKEN) * passes;
  const outputTokens = extraction.outputTokensEstimate;

  const usd =
    (inputTokens / 1000) * PRICING.inputPer1k + (outputTokens / 1000) * PRICING.outputPer1k;

  return {
    inputTokens,
    outputTokens,
    usd: Math.round(usd * 1e6) / 1e6,
    passes,
    documentsRead: extraction.documentsRead,
    simulated: true,
    model: null,
  };
}

/**
 * Format a simulated cost for display. Always carries enough precision to show
 * a difference between versions on a single packet.
 *
 * @param {number} usd
 * @returns {string}
 */
export function formatCost(usd) {
  return `$${usd.toFixed(4)}`;
}
