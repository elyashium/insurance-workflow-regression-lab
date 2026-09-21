/**
 * HTTP server: a JSON API over the lab, plus the static frontend.
 *
 * No framework and no runtime dependencies. The interesting part of this
 * project is the pipeline and the scorecard, and a reader should be able to
 * audit those without first auditing a dependency tree.
 *
 * One deliberate asymmetry lives here. The review queue is served WITHOUT
 * ground truth or accuracy figures, because a human reviewer working a real
 * queue does not have an answer key - they have the documents, the machine's
 * reasoning, and their own judgement. The scorecard views do have the answer
 * key, because that is what a scorecard is. Mixing the two would make the
 * review queue a demo of something that cannot exist.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve as resolvePath, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PUBLIC_DIR } from './paths.js';
import { loadAllPackets, loadPacket, loadGroundTruth, listPacketIds } from './core/packets.js';
import { VERSIONS, DEFAULT_COMPARISON, getVersion } from './core/versions.js';
import { runSuite, runWhatIf, runDrills } from './core/lab.js';
import { compare } from './core/scorecard.js';
import { PRICING } from './core/cost.js';
import {
  REVIEW_DECISIONS,
  BadReview,
  recordReview,
  loadReviews,
  latestByPacket,
  historyFor,
} from './store.js';

const PORT = Number(process.env.PORT ?? 5050);
const HOST = process.env.HOST ?? '127.0.0.1';

/** Reject anything larger than this on POST; the only body we accept is a short review. */
const MAX_BODY = 64 * 1024;

/* ------------------------------------------------------------------ *
 * Suite cache
 * ------------------------------------------------------------------ */

/**
 * Suites are memoised per version for the life of the process.
 *
 * Not for speed - the whole corpus runs in milliseconds - but for identity. A
 * run id is generated per run, so re-running the suite between the list request
 * and the detail request would hand the client a run id that no longer exists.
 * Cached suites also mean the comparison view and the trace view are looking at
 * the same runs, which is the entire premise of a replay.
 *
 * @type {Map<string, Promise<any>>}
 */
const suiteCache = new Map();

/**
 * @param {string} versionId
 * @returns {Promise<any>}
 */
function suiteFor(versionId) {
  getVersion(versionId); // throws for an unknown id before anything is cached

  let pending = suiteCache.get(versionId);
  if (!pending) {
    pending = (async () =>
      runSuite(versionId, {
        groundTruth: await loadGroundTruth(),
        // Each version gets its own copy of the corpus: reconciliation annotates
        // the rows it inspects, and a shared copy would let one version's
        // bookkeeping appear in another version's trace.
        packets: await loadAllPackets(),
      }))();

    // A failed load must not be cached as the permanent answer.
    pending.catch(() => suiteCache.delete(versionId));
    suiteCache.set(versionId, pending);
  }
  return pending;
}

/**
 * @param {string} versionId
 * @param {string} packetId
 */
async function scoredRun(versionId, packetId) {
  const suite = await suiteFor(versionId);
  const found = suite.scored.find((/** @type {any} */ s) => s.run.packetId === packetId);
  if (!found) throw new NotFound(`${versionId} has no run for packet "${packetId}".`);
  return found;
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/**
 * @param {URL} url
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{status?: number, data: any} | null>} null if no route matched
 */
async function route(url, req) {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/api/meta') {
    return {
      data: {
        versions: VERSIONS.map((v) => ({
          id: v.id,
          name: v.name,
          summary: v.summary,
          changes: v.changes,
          guidelines: v.guidelines,
        })),
        defaultComparison: DEFAULT_COMPARISON,
        reviewDecisions: REVIEW_DECISIONS,
        pricing: PRICING,
        disclaimer:
          'Every packet, threshold and figure in this application is synthetic and invented for demonstration. Nothing here is underwriting guidance, and no real submission, insured or carrier is represented.',
      },
    };
  }

  if (method === 'GET' && path === '/api/packets') {
    const packets = await loadAllPackets();
    return {
      data: packets.map((p) => ({
        packetId: p.packetId,
        label: p.label,
        edgeCases: p.edgeCases,
        documents: p.documents.map((d) => ({
          docId: d.docId,
          name: d.name,
          label: /** @type {any} */ (d).label,
          chars: d.text.length,
          lines: d.lines.length,
        })),
      })),
    };
  }

  let m = match(path, '/api/packets/:packetId');
  if (method === 'GET' && m) {
    const ids = await listPacketIds();
    if (!ids.includes(m.packetId)) throw new NotFound(`No packet "${m.packetId}" in the corpus.`);

    const packet = await loadPacket(m.packetId, await loadGroundTruth());
    return {
      data: {
        packetId: packet.packetId,
        label: packet.label,
        edgeCases: packet.edgeCases,
        documents: packet.documents.map((d) => ({
          docId: d.docId,
          name: d.name,
          label: /** @type {any} */ (d).label,
          text: d.text,
        })),
      },
    };
  }

  m = match(path, '/api/suites/:versionId');
  if (method === 'GET' && m) {
    const suite = await suiteFor(m.versionId);
    const reviews = await latestByPacket(m.versionId);
    return {
      data: {
        versionId: suite.versionId,
        versionName: suite.versionName,
        versionSummary: suite.versionSummary,
        changes: suite.changes,
        guidelines: suite.guidelines,
        summary: suite.summary,
        calibration: suite.calibration,
        packets: suite.scored.map((/** @type {any} */ s) => ({
          ...packetRow(s),
          correct: s.score.correct,
          total: s.score.total,
          accuracy: s.score.accuracy,
          review: reviews[s.run.packetId] ?? null,
        })),
      },
    };
  }

  m = match(path, '/api/runs/:versionId/:packetId');
  if (method === 'GET' && m) {
    const { run, score } = await scoredRun(m.versionId, m.packetId);
    const groundTruth = (await loadGroundTruth())[m.packetId] ?? null;
    return {
      data: {
        run,
        score,
        groundTruth,
        review: (await latestByPacket(m.versionId))[m.packetId] ?? null,
        history: await historyFor(m.packetId),
      },
    };
  }

  if (method === 'GET' && path === '/api/compare') {
    const baselineId = url.searchParams.get('baseline') ?? DEFAULT_COMPARISON.baseline;
    const candidateId = url.searchParams.get('candidate') ?? DEFAULT_COMPARISON.candidate;

    const baseline = await suiteFor(baselineId);
    const candidate = await suiteFor(candidateId);

    return {
      data: {
        baseline: suiteHeader(baseline),
        candidate: suiteHeader(candidate),
        diff: compare(baseline.scored, candidate.scored),
      },
    };
  }

  m = match(path, '/api/review-queue/:versionId');
  if (method === 'GET' && m) {
    const suite = await suiteFor(m.versionId);
    const reviews = await latestByPacket(m.versionId);

    return {
      data: {
        versionId: suite.versionId,
        versionName: suite.versionName,
        // Deliberately no accuracy and no ground truth: see the note at the top
        // of this file. The reviewer gets the machine's reasoning, not the key.
        items: suite.scored
          .filter((/** @type {any} */ s) => s.run.routing.abstained)
          .map((/** @type {any} */ s) => ({
            ...packetRow(s),
            reasons: s.run.routing.reasons,
            flags: s.run.checks
              .filter((/** @type {any} */ c) => c.status !== 'pass')
              .map((/** @type {any} */ c) => ({
                id: c.id,
                title: c.title,
                status: c.status,
                detail: c.detail,
                disclaimer: c.disclaimer,
              })),
            conflicts: s.run.conflicts,
            lowConfidence: lowConfidenceFields(s.run),
            computedTiv: s.run.fields.computedTiv?.value ?? null,
            statedTiv: s.run.fields.statedTiv?.value ?? null,
            review: reviews[s.run.packetId] ?? null,
          })),
        cleared: suite.scored.filter((/** @type {any} */ s) => !s.run.routing.abstained).length,
      },
    };
  }

  if (method === 'GET' && path === '/api/reviews') {
    const packetId = url.searchParams.get('packet');
    return { data: packetId ? await historyFor(packetId) : await loadReviews() };
  }

  if (method === 'POST' && path === '/api/reviews') {
    const review = await recordReview(await readJsonBody(req));
    return { status: 201, data: { review } };
  }

  if (method === 'GET' && path === '/api/drills') {
    const baselineId = url.searchParams.get('baseline') ?? DEFAULT_COMPARISON.baseline;
    const candidateId = url.searchParams.get('candidate') ?? DEFAULT_COMPARISON.candidate;
    return { data: await runDrills(baselineId, candidateId) };
  }

  if (method === 'GET' && path === '/api/whatif') {
    const versionId = url.searchParams.get('version') ?? DEFAULT_COMPARISON.candidate;
    /** @type {Record<string, any>} */
    const overrides = {};
    for (const key of ['tivCeiling', 'lossRatioCeilingPct', 'maxMonthsAhead']) {
      const raw = url.searchParams.get(key);
      if (raw != null && raw !== '') overrides[key] = Number(raw);
    }
    return { data: await runWhatIf(versionId, overrides) };
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Response shaping
 * ------------------------------------------------------------------ */

/** @param {any} scored */
function packetRow(scored) {
  const { run } = scored;
  return {
    packetId: run.packetId,
    packetLabel: run.packetLabel,
    edgeCases: run.edgeCases,
    runId: run.runId,
    versionId: run.versionId,
    decision: run.routing.decision,
    abstained: run.routing.abstained,
    flagCount: run.checks.filter((/** @type {any} */ c) => c.status === 'flag').length,
    conflictCount: run.conflicts.length,
    durationMs: run.durationMs,
    costUsd: run.cost.usd,
    costIsSimulated: run.cost.simulated,
  };
}

/** @param {any} suite */
function suiteHeader(suite) {
  return {
    versionId: suite.versionId,
    versionName: suite.versionName,
    versionSummary: suite.versionSummary,
    changes: suite.changes,
    guidelines: suite.guidelines,
    summary: suite.summary,
    calibration: suite.calibration,
  };
}

/**
 * Every value the run was unsure about, so a reviewer sees the machine's own
 * doubts before they see its conclusion.
 *
 * @param {any} run
 */
function lowConfidenceFields(run) {
  /** @type {{key: string, value: any, confidence: number, method: string, note: string|null}[]} */
  const out = [];

  for (const [name, f] of Object.entries(/** @type {Record<string, any>} */ (run.fields))) {
    if (f.confidence < 0.6) {
      out.push({ key: name, value: f.value, confidence: f.confidence, method: f.method, note: f.note });
    }
  }
  for (const loc of run.resolution.locations) {
    for (const [name, f] of Object.entries(/** @type {Record<string, any>} */ (loc.fields))) {
      if (f.confidence < 0.6) {
        out.push({
          key: `${loc.locId}.${name}`,
          value: f.value,
          confidence: f.confidence,
          method: f.method,
          note: f.note,
        });
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

/**
 * Match a path against a `/a/:b/c` pattern.
 *
 * @param {string} path
 * @param {string} pattern
 * @returns {Record<string, string> | null}
 */
function match(path, pattern) {
  const parts = path.split('/');
  const shape = pattern.split('/');
  if (parts.length !== shape.length) return null;

  /** @type {Record<string, string>} */
  const params = {};
  for (let i = 0; i < shape.length; i++) {
    if (shape[i].startsWith(':')) {
      if (!parts[i]) return null;
      params[shape[i].slice(1)] = decodeURIComponent(parts[i]);
    } else if (shape[i] !== parts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        rejectBody(new BadReview('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', rejectBody);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(new BadReview('Request body is not valid JSON.'));
      }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * @param {string} pathname
 * @param {import('node:http').ServerResponse} res
 */
async function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolvePath(join(PUBLIC_DIR, relative));

  // Anything that resolves outside public/ is a traversal attempt, not a typo.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
    return send(res, 403, { error: 'Forbidden.' });
  }

  let body;
  try {
    body = await readFile(target);
  } catch {
    return send(res, 404, { error: `Not found: ${pathname}` });
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
    // The corpus is read from disk on every request and the suites are rebuilt
    // on restart, so a cached asset would just hide an edit during a demo.
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} body
 */
function send(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

/** Route matched no handler. */
class NotFound extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'NotFound';
    this.status = 404;
  }
}

/**
 * The request handler, exported for serverless targets (see `api/index.js`).
 * Locally it serves both the JSON API and the static frontend; on Vercel the
 * static assets come from the CDN and only the `/api/*` branch runs.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      const result = await route(url, req);
      if (!result) {
        return send(res, 404, { error: `No API route for ${req.method} ${url.pathname}` });
      }
      return send(res, result.status ?? 200, result.data);
    }

    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
    return await serveStatic(url.pathname, res);
  } catch (err) {
    const status = /** @type {any} */ (err)?.status ?? 500;
    const message = /** @type {any} */ (err)?.message ?? 'Unknown error.';
    if (status >= 500) console.error(err);
    return send(res, status, { error: message });
  }
}

export const server = createServer(handleRequest);

/**
 * Default export for Vercel: `src/server.js` is auto-detected as the server
 * entrypoint and must default-export the server (or a handler). Local `npm
 * start` behaviour is unchanged — the listen guard below still applies.
 */
export default server;

// Only listen when started directly, so tests can import the server and drive
// it on an ephemeral port without a second process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, HOST, () => {
    console.log(`Insurance Workflow Regression Lab - http://${HOST}:${PORT}`);
    console.log('All data is synthetic. Nothing here is underwriting guidance.');
  });
}
