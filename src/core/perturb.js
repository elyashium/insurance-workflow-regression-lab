/**
 * Document perturbations: synthetic PDF/OCR degradation for robustness runs.
 *
 * A clean corpus flatters strict parsers. These transforms simulate what
 * happens between a broker's PDF and our plain-text loader — OCR confusions,
 * dropped punctuation, reflowed lines, page furniture — so a version can be
 * scored on degraded input with the SAME ground truth. The values don't move;
 * only the ink does. A robustness drop therefore measures the reader, never
 * the packet.
 *
 * Deterministic by construction: the seed derives from (profile, packetId,
 * docId), so the same corpus always degrades identically. Profiles:
 * - `ocr-light`:   occasional confusions and dropped punctuation.
 * - `ocr-heavy`:   aggressive confusions, drops, and reflowed line breaks.
 * - `pdf-layout`:   page headers/footers, blank lines, split tables — layout
 *                   noise with the characters themselves intact.
 */

export const PERTURB_PROFILES = {
  'ocr-light': 'Occasional OCR confusions and dropped punctuation.',
  'ocr-heavy': 'Aggressive confusions, dropped punctuation, reflowed lines.',
  'pdf-layout': 'Page furniture and split tables; characters intact.',
};

/** Seeded PRNG (mulberry32) — deterministic per string seed. */
export function rngFor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0) || 1;
  }
  let a = h;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONFUSIONS = [
  ['0', 'O'], ['O', '0'], ['1', 'l'], ['l', '1'], ['I', '1'],
  ['5', 'S'], ['S', '5'], ['8', 'B'], ['B', '8'], ['6', 'G'],
  ['rn', 'm'], [',', ''], ['.', ''],
];

/**
 * Per-character transform applied at a fixed rate.
 *
 * @param {string} text
 * @param {() => number} rand
 * @param {number} rate
 * @param {(ch: string) => string} map
 */
function mapChars(text, rand, rate, map) {
  let out = '';
  for (const ch of text) {
    out += rand() < rate ? map(ch) : ch;
  }
  return out;
}

/**
 * @param {string} text
 * @param {() => number} rand
 * @param {number} charRate
 * @param {number} dropRate
 * @param {number} mergeRate
 */
function ocr(text, rand, charRate, dropRate, mergeRate) {
  const confused = mapChars(text, rand, charRate, (ch) => {
    const hit = CONFUSIONS.find(([f]) => f === ch && f.length === 1);
    return hit ? hit[1] : ch;
  });
  const dropped = mapChars(confused, rand, dropRate, (ch) => (/[.,;:]/.test(ch) ? '' : ch));
  if (!mergeRate) return dropped;
  // Reflow: join a fraction of line breaks, the way text-layer extraction
  // merges wrapped rows.
  return dropped
    .split('\n')
    .map((line, i, arr) => (i < arr.length - 1 && rand() < mergeRate ? `${line} ` : `${line}\n`))
    .join('')
    .replace(/\n$/, '');
}

/**
 * @param {string} text
 * @param {string} docId
 */
function pdfLayout(text, docId) {
  const lines = text.split('\n');
  const out = [];
  const perPage = 40;
  lines.forEach((line, i) => {
    if (i % perPage === 0) {
      const page = Math.floor(i / perPage) + 1;
      out.push(`Form ${docId.toUpperCase()} · Page ${page}`);
    }
    out.push(line);
    if (line.trim() === '') out.push('');
    if ((i + 1) % perPage === 0) out.push('— continued —');
  });
  return out.join('\n');
}

/**
 * @param {string} text
 * @param {string} profileId
 * @param {string} seedScope  packetId/docId — makes degradation deterministic
 */
export function perturbText(text, profileId, seedScope) {
  if (!PERTURB_PROFILES[profileId]) {
    throw new Error(`Unknown perturbation profile "${profileId}". Known: ${Object.keys(PERTURB_PROFILES).join(', ')}`);
  }
  const rand = rngFor(`${profileId}|${seedScope}`);
  if (profileId === 'ocr-light') return ocr(text, rand, 0.009, 0.02, 0);
  if (profileId === 'ocr-heavy') return ocr(text, rand, 0.02, 0.05, 0.04);
  return pdfLayout(text, seedScope.split('/')[1] ?? 'doc');
}

/**
 * @param {import('./packets.js').Packet} packet
 * @param {string} profileId
 * @returns {import('./packets.js').Packet} degraded copy (input untouched)
 */
export function perturbPacket(packet, profileId) {
  return {
    ...packet,
    documents: packet.documents.map((d) => ({
      ...d,
      text: perturbText(d.text, profileId, `${packet.packetId}/${d.docId}`),
    })),
  };
}
