# AGENTS.md

Zero-dependency Node lab (ESM, `node:http`, no framework). Everything is synthetic; keep it labelled that way.

## Commands

- `npm install && npm start` — serve at `http://127.0.0.1:5050` (`PORT`/`HOST` env overrides). No runtime deps; install downloads nothing.
- `npm run dev` — same server with `node --watch`.
- `npm test` — full suite via `scripts/test.mjs`, which enumerates `test/*.test.js` explicitly (a bare `node --test test/` directory arg means different things on Node 20 vs 22 — the script exists because of that). No test framework. CI runs it on 20.x and 22.x.
- `npm run typecheck` — `scripts/typecheck.mjs` installs `tsc` + `@types/node` into a temp dir (network) and checks with `--typeRoots` pointed there, so the repo keeps zero dependencies of any kind. `strict` is off — only field-shape drift matters.
- No lint, format, build step. Frontend in `public/` is vanilla ES modules, no bundling. CI (`.github/workflows/ci.yml`) runs tests + typecheck + a server smoke test.

## Architecture

- One shared engine, versions are data: `src/core/extractors/engine.js` traverses profiles in `v1-regex.js` / `v2-heuristic.js` / `v3-llm.js`; `src/core/versions.js` pins each version (extractor profile + guideline config). Never create a second parser — add a profile entry instead. Version ids: `v1-regex`, `v2-heuristic`, `v2.1-no-backfill`, `v3-llm` (model-backed, needs `GROQ_API_KEY` or a seeded `data/.llm-cache/`).
- `runExtraction` stays synchronous for deterministic profiles (it throws for `engine: 'llm'`); `runExtractionAsync` branches to the model adapter. `runPacket` is async throughout — `await` it in `lab.js`-style callers.
- Pipeline order is fixed (`src/core/runner.js`): Extract → Reconcile → Apply guidelines → Detect conflicts → Route. Every run must emit all five trace steps in order with non-decreasing `startMs`.
- Shared entry for UI and tests: `src/core/lab.js` (`runSuite` / `runComparison`). API layer (`src/server.js`) must call these, not reimplement scoring.
- Runs are pure functions of corpus + version and are never persisted. Only human reviews are written to disk (`src/store.js` → `data/store/reviews.json`, gitignored, missing file = empty log; `/tmp` when `VERCEL` is set).
- Reviews are append-only; latest entry per (versionId, packetId) wins. `versionId` is required, `needs-info` requires a `note`; violations throw `BadReview` (400). Writes are atomic (tmp + rename) and serialised via `writeQueue`. When `LAB_API_KEY` is set, `POST /api/reviews` additionally requires a matching `x-api-key` header (401 otherwise); reads stay open.
- Fresh packet copies per suite: reconciliation annotates location rows, so sharing one loaded corpus across versions leaks state. `lab.runComparison` and the server's `suiteCache` both reload per version; preserve that. Server cache exists for run-id identity, not speed.

## Gotchas

- Scoring: ground-truth `null` means genuinely absent — reporting `null` is correct, inventing a value is wrong. This is what makes the v1→v2 regression (PKT-002 `L2.constructionType` + `L2.yearBuilt`, `context-backfill`, conf `0.50`) visible.
- Gate is `regressions.length === 0 ? 'clean' : 'regressed'` (`src/core/scorecard.js`). A higher average never buys back a lost field.
- Cost is simulated (`cost.simulated === true` always, token-estimate at an invented rate); latency is measured (`performance.now()`). Never present cost as real; UI badges it `SIMULATED`.
Exception: v3 runs are metered (tokens × Groq's published rate, `simulated: false`, model named) — never let metered spend wear the simulated label, and never invent a rate for an unlisted model (`meterCost` throws).
- Review queue (`GET /api/review-queue/:versionId`) must never include ground truth or accuracy — reviewer gets documents + machine reasoning only. Scorecard views may.
- Reviews are append-only; latest entry per (versionId, packetId) wins. `versionId` is required, `needs-info` requires a `note`; violations throw `BadReview` (400). Writes are atomic (tmp + rename) and serialised via `writeQueue`.
- Location scoring matches by normalised address, not position; `locationCount` is its own scored item (see `scorecard.js` before touching dedup logic).
- Lab instruments live next to the scorecard: per-edge-case slices (in `compare()` output), confidence calibration (`calibration()` in `scorecard.js`, bands aligned to the 0.6 floor / 0.50 back-fill), fault drills (`src/core/drills.js` — sabotage the candidate, assert the gate fires), what-if reruns (`runWhatIf` in `lab.js` — hypothetical thresholds, never persisted, 400 on unknown/out-of-range keys).
- Robustness (`src/core/perturb.js` + `runRobustness`, `/api/robustness`): seeded OCR/PDF degradation scored against unchanged ground truth; `ocr-heavy` must cost v1 accuracy, `pdf-layout` moves nothing. Manifests (`src/core/manifest.js`, on every suite): corpus hash of what actually ran, profile hash of the extractor config.
- Low-confidence floor is `0.6` (server + runner surface these); back-fill emits `0.50`.
- Every guideline check (`GL-001`…`GL-005`) must carry `GUIDELINE_DISCLAIMER` and a non-empty `detail`. Thresholds are invented — never describe them as underwriting guidance, never compare against real products, never reproduce ACORD text.

## Tests

- `test/pipeline.integration.test.js` pins the demo: exact per-packet decisions for all 3 versions, abstention sets/kinds, the two named regressions, clean v2→v2.1 diff, determinism (run twice = same answer), `abstained === (decision === 'referred')`. If a rule change moves one packet, this fails by design — update the matrix only if the new behaviour is intended.
- Unit tests use `test/fixtures.js` builders (`makeContext`/`evaluate`); defaults pass everything clean so each test moves one thing. `BASE_GUIDELINES` there is a frozen copy of v1 — don't "sync" it to `versions.js`.
