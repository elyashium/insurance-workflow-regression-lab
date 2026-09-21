/**
 * Vercel serverless entry: every `/api/*` route runs through the same
 * `handleRequest` as the local `node:http` server, so the demo and the
 * deployment can never disagree about scoring.
 *
 * Static assets (`public/`) are served by Vercel's CDN, not by this function.
 * The human review log lives on the writable `/tmp` volume when `VERCEL` is
 * set (see `src/paths.js`) — reviews therefore survive warm invocations but
 * are not durable storage. That matches the lab's contract: runs are pure
 * functions of the corpus, reviews are local judgement calls.
 */

import { handleRequest } from '../src/server.js';

export default function handler(req, res) {
  return handleRequest(req, res);
}
