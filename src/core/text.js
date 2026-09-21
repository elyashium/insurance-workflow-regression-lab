/**
 * Document text indexing and evidence-span helpers.
 *
 * Every value the pipeline extracts must be able to point back at the exact
 * characters it came from. That is what a `Span` is: a document id, a line
 * number, absolute character offsets into the document, and the snippet itself
 * so the UI can render it without re-reading the file.
 */

/**
 * @typedef {Object} Line
 * @property {number} n     1-based line number
 * @property {string} text  line content, without the newline
 * @property {number} start absolute char offset of the first char of the line
 * @property {number} end   absolute char offset one past the last char
 */

/**
 * @typedef {Object} SourceDoc
 * @property {string} docId   stable id, e.g. "sov"
 * @property {string} name    display name, e.g. "sov.txt"
 * @property {string} text    full document text
 * @property {Line[]} lines
 * @property {string} [label] human label assigned by packets.js after indexing
 */

/**
 * @typedef {Object} Span
 * @property {string} docId
 * @property {string} docName
 * @property {number} line
 * @property {number} start
 * @property {number} end
 * @property {string} snippet
 */

/**
 * Build a line index over a raw document.
 *
 * @param {string} docId
 * @param {string} name
 * @param {string} text
 * @returns {SourceDoc}
 */
export function indexDocument(docId, name, text) {
  const normalized = text.replace(/\r\n/g, '\n');
  /** @type {Line[]} */
  const lines = [];
  let offset = 0;
  const parts = normalized.split('\n');
  for (let i = 0; i < parts.length; i++) {
    const lineText = parts[i];
    lines.push({ n: i + 1, text: lineText, start: offset, end: offset + lineText.length });
    offset += lineText.length + 1; // +1 for the newline we split on
  }
  return { docId, name, text: normalized, lines };
}

/**
 * Locate the line containing an absolute offset.
 *
 * @param {SourceDoc} doc
 * @param {number} offset
 * @returns {Line}
 */
export function lineAtOffset(doc, offset) {
  for (const line of doc.lines) {
    if (offset >= line.start && offset <= line.end) return line;
  }
  return doc.lines[doc.lines.length - 1];
}

/**
 * Build a span from absolute offsets into a document.
 *
 * @param {SourceDoc} doc
 * @param {number} start
 * @param {number} end
 * @returns {Span}
 */
export function makeSpan(doc, start, end) {
  const line = lineAtOffset(doc, start);
  return {
    docId: doc.docId,
    docName: doc.name,
    line: line.n,
    start,
    end,
    snippet: doc.text.slice(start, end),
  };
}

/**
 * Span covering a whole line.
 *
 * @param {SourceDoc} doc
 * @param {Line} line
 * @returns {Span}
 */
export function spanForLine(doc, line) {
  return {
    docId: doc.docId,
    docName: doc.name,
    line: line.n,
    start: line.start,
    end: line.end,
    snippet: line.text,
  };
}

/**
 * Run a regex against a document and return the first match plus a span
 * covering capture group 1 (falling back to the whole match).
 *
 * The regex must carry the `m` flag if it uses `^`/`$` line anchors. It is
 * cloned before use so a caller passing a `/g` regex does not leak lastIndex
 * state between calls.
 *
 * @param {SourceDoc} doc
 * @param {RegExp} re
 * @returns {{ value: string, span: Span } | null}
 */
export function matchWithSpan(doc, re) {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const rx = new RegExp(re.source, flags);
  const m = rx.exec(doc.text);
  if (!m) return null;

  const captured = m[1] !== undefined ? m[1] : m[0];
  // Offset of the capture inside the overall match. indexOf is sufficient here
  // because our capture groups are distinctive value text, not single chars.
  const withinMatch = m[1] !== undefined ? m[0].indexOf(m[1]) : 0;
  const start = m.index + (withinMatch >= 0 ? withinMatch : 0);
  return { value: captured, span: makeSpan(doc, start, start + captured.length) };
}

/**
 * All lines in a document whose text starts with the given prefix, after
 * trimming leading whitespace.
 *
 * @param {SourceDoc} doc
 * @param {string} prefix
 * @returns {Line[]}
 */
export function linesStartingWith(doc, prefix) {
  return doc.lines.filter((l) => l.text.trimStart().startsWith(prefix));
}

/**
 * Split a pipe-delimited record line into cells, preserving each cell's
 * absolute offsets so values inside a cell can still be span-linked.
 *
 * @param {SourceDoc} doc
 * @param {Line} line
 * @returns {{ text: string, start: number, end: number }[]}
 */
export function splitCells(doc, line) {
  const cells = [];
  let cursor = line.start;
  for (const raw of line.text.split('|')) {
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    cells.push({
      text: trimmed,
      start: cursor + leading,
      end: cursor + leading + trimmed.length,
    });
    cursor += raw.length + 1; // +1 for the pipe we split on
  }
  return cells;
}
