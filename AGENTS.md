# AGENTS.md

Zero-dependency Node lab (ESM, `node:http`, no framework). Everything is synthetic; keep it labelled that way.

## Commands

- `npm install && npm start` — serve at `http://127.0.0.1:5050` (`PORT`/`HOST` env overrides). No runtime deps; install downloads nothing.
- `npm run dev` — same server with `node --watch`.
- `npm test` — full suite via built-in runner: `node --test test/`. No test framework.
- `npm run typecheck` — `tsc --noEmit` over JSDoc; needs network (`npx` fetches typescript). `strict` is off deliberately — only field-shape drift matters.
- No lint, format, build step, or CI. Frontend in `public/` is vanilla ES modules, no bundling.

## Architecture

- One shared engine, versions are data: `src/core/extractors/engine.js` traverses profiles in `v1-regex.js` / `v2-heuristic.js`; `src/core/versions.js` pins each version (extractor profile + guideline config). Never create a second parser — add a profile entry instead. Version ids: `v1-regex`, `v2-heuristic`, `v2.1-no-backfill`.
- Pipeline order is fixed (`src/core/runner.js`): Extract → Reconcile → Apply guidelines → Detect conflicts → Route. Every run must emit all five trace steps in order with non-decreasing `startMs`.
- Shared entry for UI and tests: `src/core/lab.js` (`runSuite` / `runComparison`). API layer (`src/server.js`) must call these, not reimplement scoring.
- Runs are pure functions of corpus + version and are never persisted. Only human reviews are written to disk (`src/store.js` → `data/store/reviews.json`, gitignored, missing file = empty log).
- Fresh packet copies per suite: reconciliation annotates location rows, so sharing one loaded corpus across versions leaks state. `lab.runComparison` and the server's `suiteCache` both reload per version; preserve that. Server cache exists for run-id identity, not speed.

## Gotchas

- Scoring: ground-truth `null` means genuinely absent — reporting `null` is correct, inventing a value is wrong. This is what makes the v1→v2 regression (PKT-002 `L2.constructionType` + `L2.yearBuilt`, `context-backfill`, conf `0.50`) visible.
- Gate is `regressions.length === 0 ? 'clean' : 'regressed'` (`src/core/scorecard.js`). A higher average never buys back a lost field.
- Cost is simulated (`cost.simulated === true` always, token-estimate at an invented rate); latency is measured (`performance.now()`). Never present cost as real; UI badges it `SIMULATED`.
- Review queue (`GET /api/review-queue/:versionId`) must never include ground truth or accuracy — reviewer gets documents + machine reasoning only. Scorecard views may.
- Reviews are append-only; latest entry per (versionId, packetId) wins. `versionId` is required, `needs-info` requires a `note`; violations throw `BadReview` (400). Writes are atomic (tmp + rename) and serialised via `writeQueue`.
- Location scoring matches by normalised address, not position; `locationCount` is its own scored item (see `scorecard.js` before touching dedup logic).
- Low-confidence floor is `0.6` (server + runner surface these); back-fill emits `0.50`.
- Every guideline check (`GL-001`…`GL-005`) must carry `GUIDELINE_DISCLAIMER` and a non-empty `detail`. Thresholds are invented — never describe them as underwriting guidance, never compare against real products, never reproduce ACORD text.

## Tests

- `test/pipeline.integration.test.js` pins the demo: exact per-packet decisions for all 3 versions, abstention sets/kinds, the two named regressions, clean v2→v2.1 diff, determinism (run twice = same answer), `abstained === (decision === 'referred')`. If a rule change moves one packet, this fails by design — update the matrix only if the new behaviour is intended.
- Unit tests use `test/fixtures.js` builders (`makeContext`/`evaluate`); defaults pass everything clean so each test moves one thing. `BASE_GUIDELINES` there is a frozen copy of v1 — don't "sync" it to `versions.js`.
