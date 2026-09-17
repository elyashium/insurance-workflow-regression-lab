/**
 * The store: human review decisions.
 *
 * Everything else in this lab is derived. Runs, traces, checks and scores are a
 * pure function of the corpus plus a version, so persisting them would be
 * caching a computation rather than recording a fact - and a stale cache of a
 * run is worse than no cache, because it can disagree with the code that claims
 * to have produced it. Re-running the corpus takes milliseconds.
 *
 * A reviewer's judgement is the one thing here that cannot be recomputed, so it
 * is the one thing written to disk. The log is append-only: a decision is never
 * edited in place, and changing your mind about a packet adds a row rather than
 * rewriting one. That is the behaviour you want from anything that is supposed
 * to explain, later, why a machine's answer was overridden.
 *
 * Flat JSON on purpose. The whole point of the store is that a reader can open
 * it and check it against what the UI claims.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { STORE_DIR } from './paths.js';

const REVIEWS_FILE = join(STORE_DIR, 'reviews.json');

/** What a reviewer can say about a referred submission. */
export const REVIEW_DECISIONS = ['approve', 'decline', 'needs-info'];

/** Free-text fields are bounded so a stray paste cannot make the file unreadable. */
const MAX_NOTE = 2_000;
const MAX_REVIEWER = 120;

/**
 * @typedef {Object} Review
 * @property {string} id
 * @property {string} packetId
 * @property {string} versionId    the version whose output was reviewed
 * @property {string|null} runId
 * @property {string} decision
 * @property {string} reviewer
 * @property {string} note
 * @property {string} recordedAt   ISO timestamp
 */

/**
 * Writes are serialised through this chain.
 *
 * Two reviewers clicking at the same moment is not a realistic load problem,
 * but a read-modify-write race silently drops one of their decisions, and a
 * store that loses a human judgement is not worth having.
 *
 * @type {Promise<any>}
 */
let writeQueue = Promise.resolve();

/**
 * Read the append-only log.
 *
 * A missing file is an empty log, not an error - the store is created on the
 * first decision, so a fresh clone has nothing to read.
 *
 * @returns {Promise<Review[]>}
 */
export async function loadReviews() {
  let raw;
  try {
    raw = await readFile(REVIEWS_FILE, 'utf8');
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return [];
    throw err;
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.reviews) ? parsed.reviews : [];
  } catch {
    throw new Error(
      `${REVIEWS_FILE} is not readable JSON. It is an append-only log of human decisions, so it is not overwritten automatically - inspect or remove it by hand.`,
    );
  }
}

/**
 * Append one decision.
 *
 * @param {{packetId: string, versionId: string, runId?: string|null, decision: string, reviewer?: string, note?: string}} input
 * @returns {Promise<Review>}
 */
export function recordReview(input) {
  const review = validate(input);

  // Chain onto the queue so the read-modify-write below cannot interleave.
  writeQueue = writeQueue.then(async () => {
    const reviews = await loadReviews();
    reviews.push(review);
    await persist(reviews);
    return review;
  });

  return writeQueue;
}

/**
 * The current standing of every packet a version referred, latest decision wins.
 *
 * @param {string} versionId
 * @returns {Promise<Record<string, Review>>}
 */
export async function latestByPacket(versionId) {
  const reviews = await loadReviews();

  /** @type {Record<string, Review>} */
  const latest = {};
  for (const review of reviews) {
    if (review.versionId !== versionId) continue;
    // The log is appended in order, so the last one seen is the current one.
    latest[review.packetId] = review;
  }
  return latest;
}

/**
 * Every decision recorded against one packet, oldest first.
 *
 * Kept separate from `latestByPacket` because the history is the interesting
 * part: a packet that was approved, then declined, then approved again is
 * telling you something about the guideline, not about the packet.
 *
 * @param {string} packetId
 * @returns {Promise<Review[]>}
 */
export async function historyFor(packetId) {
  return (await loadReviews()).filter((r) => r.packetId === packetId);
}

/**
 * Drop the log. Used by tests; never called by the server.
 *
 * @returns {Promise<void>}
 */
export async function clearReviews() {
  writeQueue = writeQueue.then(() => persist([]));
  await writeQueue;
}

/**
 * @param {any} input
 * @returns {Review}
 */
function validate(input) {
  const packetId = String(input?.packetId ?? '').trim();
  const versionId = String(input?.versionId ?? '').trim();
  const decision = String(input?.decision ?? '').trim();

  if (!packetId) throw new BadReview('A review has to name the packet it is about.');
  if (!versionId) {
    // A decision made about v1's output says nothing about v2's output for the
    // same packet, so a review that does not name a version cannot be filed.
    throw new BadReview('A review has to name the workflow version whose output was reviewed.');
  }
  if (!REVIEW_DECISIONS.includes(decision)) {
    throw new BadReview(`Decision must be one of: ${REVIEW_DECISIONS.join(', ')}.`);
  }

  const note = String(input?.note ?? '').trim().slice(0, MAX_NOTE);
  if (decision === 'needs-info' && !note) {
    // "Needs info" without saying what information is missing sends the packet
    // back to the broker with no question attached.
    throw new BadReview('Asking for more information requires a note saying what is missing.');
  }

  return {
    id: randomUUID(),
    packetId,
    versionId,
    runId: input?.runId ? String(input.runId) : null,
    decision,
    reviewer: String(input?.reviewer ?? '').trim().slice(0, MAX_REVIEWER) || 'unattributed',
    note,
    recordedAt: new Date().toISOString(),
  };
}

/**
 * @param {Review[]} reviews
 */
async function persist(reviews) {
  await mkdir(STORE_DIR, { recursive: true });

  const body = {
    _about:
      'Human review decisions recorded in the Insurance Workflow Regression Lab. Append-only: the last entry for a (versionId, packetId) pair is the current one. All packets referenced are synthetic.',
    reviews,
  };

  // Write beside the target and rename, so an interrupted write cannot leave a
  // half-written log where a complete one used to be.
  const tmp = `${REVIEWS_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await rename(tmp, REVIEWS_FILE);
}

/** A rejected review is the caller's fault, and the server answers 400 for it. */
export class BadReview extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'BadReview';
    this.status = 400;
  }
}
