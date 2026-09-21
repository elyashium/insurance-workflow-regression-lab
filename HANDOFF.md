# Handoff — Insurance Workflow Regression Lab

Everything you need to pick this up cold: what exists, what it proves, what it
is honestly good for, and how to take it to someone.

**Every packet, insured, address, loss, date and dollar figure in the repo is
invented.** That is not a disclaimer bolted on afterwards — it is a design
constraint that shaped the whole build, and it is asserted in the test suite.

---

## 1. Status

| | |
| --- | --- |
| Build | Complete. All deliverables on disk. |
| Tests | **199 total, passing, on Node 20 and 22.** (Was 170 at handoff; instruments + v3 + manifests + auth since.) |
| Runtime dependencies | Zero. `npm install` downloads nothing. |
| Verified on | Node v20.18.0, Windows 11 |
| Not yet done | `.claude/launch.json`; UI never rendered in a browser |

### The two failures, and what they were

Both failures were the same assertion in `test/pipeline.integration.test.js`:

```
actual:   [ 'NOT_READABLE', 'UNRECONCILED' ]
expected: [ 'NOT_READABLE' ]
```

**The pipeline was right and the test was wrong.** v1 on PKT-008 fails two
independent ways at once:

1. It cannot read `Insured Name (DBA):` (its aliases are `Named Insured` /
   `Applicant`) or `Bldg Val: 16700000` (its alias is `Building`, and its strict
   currency parser rejects bare digits) → `NOT_READABLE`.
2. Because v1 matches addresses by exact string, it never collapses
   `2900 Basalt Ridge Rd` and `2900 Basalt Ridge Road, Suite 100` into one
   building. Its schedule therefore foots to roughly **$167M** against a stated
   **$112.3M** — an unexplained gap, so `CF-001` fires at `high` severity →
   `UNRECONCILED`.

`route()` collects reasons in a fixed order (unreadable → blocking conflicts →
decisive adjustments), so `['NOT_READABLE', 'UNRECONCILED']` is deterministic
and correct. The reason list is a list *precisely* so a reviewer gets every
reason, not whichever one the router found first.

I corrected the two expectations and tightened them — the PKT-008 test now also
asserts that reason[0] names `L3.buildingValue` and reason[1] names `CF-001`.
**No pipeline code was changed.**

This is, incidentally, a small live demonstration of the thing the project
argues for: an assertion pinned by identity caught a wrong belief about the
system. A threshold on an average would have sailed past it.

### Re-run to confirm

```bash
node --test test/
```

Expect **180 passing**. If anything else fails, the test names the packet and
the field.

### Lab instruments (added 2026-09-21)

Four features that make it a lab rather than a scorecard, each with core +
API + UI + tests:

- **Slices** (`compare().slices`, scorecard table): movement grouped by planted
  edge-case tag. The v1→v2 MISSING_FIELD slice nets +5 (7 gains, 2 losses) —
  the release looked good on averages *within the very slice that regressed*.
- **Calibration** (`calibration()`, both suite payloads, scorecard bars):
  reported confidence vs. empirical accuracy. v2's sub-0.6 band is exactly the
  two back-filled inventions, 0/2.
- **Fault drills** (`src/core/drills.js`, `/api/drills`, scorecard card):
  single-field, blank-fill, and decoy-gains mutations against the candidate.
  All three must come back `caught: true`; decoy-gains is the thesis,
  executable.
- **What-if** (`runWhatIf`, `/api/whatif`, scorecard form): hypothetical
  guideline thresholds, actually re-run, never persisted. 400 on unknown or
  out-of-range keys. Try ceiling $40M on v2 and watch PKT-002 flip.

Mobile got a pass in the same change: cards become the scroll container under
860px so ledger tables stay usable on phones. No browser here — the small-screen
CSS is reasoned, not eyeballed; confirm on a real phone.

### Production pass (2026-09-21, second half)

Weaknesses closed, in order:

- **`npm test` on Node 22 was genuinely broken** — a bare `node --test test/`
  directory arg loads as a module on 22 (MODULE_NOT_FOUND). `scripts/test.mjs`
  now enumerates `test/*.test.js` explicitly (plus `fixtures.js`, whose
  self-test the old directory scan picked up implicitly — that explained the
  179-vs-180 counts). Green 199/199 on 20.18 and 22.19.
- **Typecheck is green.** `scripts/typecheck.mjs` installs `tsc` +
  `@types/node` into a temp dir per run (repo stays zero-dependency) and the
  remaining JSDoc drift was fixed — including new src errors, not just tests.
- **v3-llm, model-backed, live.** Groq `openai/gpt-oss-120b`, quotes resolved
  to exact spans, instructed null-when-absent. First live run: **226/226 for
  $0.011** — including PKT-002's blanks left blank. Responses cached under
  `data/.llm-cache/` (gitignored); cache hits need no key and no network, so
  replays are deterministic. Unknown models are refused, never costed.
  `GROQ_API_KEY` lives in env/`.env` only — never committed. The key used for
  seeding should be rotated (it appears in chat history).
- **Robustness** (`perturb.js`, `/api/robustness`, scorecard card): seeded OCR
  (`ocr-heavy` costs v1 ~5pts) and PDF layout noise (moves nothing — honest).
- **Manifests** on every suite: corpus hash of what actually ran (perturbed
  runs hash differently), profile hash, per-packet outcomes. Truncated hashes
  on the scorecard version cards.
- **Auth**: `LAB_API_KEY`, when set, gates `POST /api/reviews` (401, constant-
  time compare); reads stay open. No user accounts by design — see the README.
- **CI** (`.github/workflows/ci.yml`): Node 20.x + 22.x matrix, tests +
  typecheck + server smoke test.
- **Demo script** rewritten to 75 seconds, instruments included, with a
  production-readiness answer for "what would this take live" (labelled corpus,
  CI gate, calibration).

---

## 2. What was built

A local web app that ingests messy synthetic commercial-insurance submission
packets and, for each one:

1. **Extracts** structured data — every single value carrying a citation to the
   exact character range it came from, a confidence, and the method that
   produced it.
2. **Reconciles** — removes locations listed twice, applies late endorsements,
   foots the schedule to one insured value. Every adjustment is recorded, never
   applied silently.
3. **Applies five deterministic guideline checks** (GL-001…GL-005).
4. **Detects four kinds of conflict** (CF-001…CF-004) — reasons not to trust any
   answer yet, kept strictly separate from the checks that produce answers.
5. **Routes** to `quote`, `decline`, or `referred` to a human.

And then the part the whole thing exists for: **replays the entire corpus
through two versions of the workflow and diffs them field by field.**

### The corpus

Eight packets, each a folder of plain-text documents (application, schedule of
values, loss run, and where relevant an endorsement request and a broker email).
Five edge cases planted across them: missing field, duplicate location,
inconsistent dates, conflicting limits, late endorsement. PKT-001 is clean, to
prove the lab can leave a good packet alone. PKT-007 and PKT-008 stack defects,
because real submissions don't arrive one problem at a time.

### The versions

| | v1 — strict regex | v2 — tolerant heuristic | v2.1 — back-fill removed |
| --- | --- | --- | --- |
| Label vocabulary | standard only | widened aliases | widened aliases |
| Currency | written in full | bare digits, K/M/B | same as v2 |
| Docs in scope | app, schedule, loss run | + email, endorsements | + email, endorsements |
| Address matching | exact string | normalised + fuzzy | normalised + fuzzy |
| Blank fields | left blank | **inferred from prose** | left blank |
| Appetite ceiling | $40M | $50M | $50M |

A version is **data, not code** — an extraction profile plus a guideline config,
walked by one shared engine. There is no separate v1 parser and v2 parser to
drift apart, so a difference in the scorecard is attributable to a named config
value rather than to two implementations that were never quite the same.

### File map

```
data/packets/PKT-00N/*.txt   synthetic source documents
data/ground-truth.json       hand-labelled correct answer for every packet
data/store/reviews.json      append-only log of human review decisions (gitignored)

src/core/extractors/         one config-driven engine, three profiles
src/core/                    resolve → checks → conflicts → abstain → runner
src/core/scorecard.js        scoring and the version diff  ← the centrepiece
src/server.js                node:http JSON API + static frontend
public/                      vanilla ES-module frontend, no build step
test/                        unit tests per module + one integration test
```

---

## 3. The problem it solves

**When you change a document-extraction workflow, how do you find out what you
broke?**

The concrete failure the lab dramatises: v2 bundles seven changes into one
release. Six are genuine improvements. The seventh fills blank fields by
inferring from nearby prose.

On PKT-002, a broker deliberately left construction type and year built blank for
one location and said so in writing: *"I would rather leave it blank than
guess."* v2 guesses anyway. It reads "looks like older masonry" out of the
broker's hedged email and emits `Joisted Masonry`. It reads "L2 was acquired in
Q4 2025" off a schedule note and emits `yearBuilt: 2025` — a building
"constructed" the year it was *bought*.

Now watch what does **not** happen:

- Nothing errors.
- No guideline check fails — in fact the data-completeness flag that would have
  sent this packet to a human **stops firing**, because the blanks are now full.
- The routing decision does not change.
- The only runtime trace is `CF-004`, deliberately `low` severity, which halts
  nothing.
- Aggregate accuracy goes **up**. Abstention rate goes **down**. Latency is flat.

**Every number a dashboard would show you says ship it.** The only thing that
catches it is a field-level diff against ground truth — because an invented value
renders identically to a read one unless you show the method.

v2.1 is the proof of fix: v2 with that one heuristic switched off and nothing
else touched. Improvements kept, regression gone, verdict clean, and the
per-packet table confirms nothing moved anywhere else.

---

## 4. What is actually novel here

Be precise about this, because overclaiming is the fastest way to lose a
technical reader. Sorted from "standard practice" to "genuinely uncommon":

**Not novel (and don't pretend otherwise).** Replaying a fixed corpus through two
versions and diffing them is what every eval harness does. Citing source spans
for extracted values is table stakes in document AI. Confidence scores are
universal.

**Uncommon in practice, and the load-bearing idea:**

> **`null` is a claim, and the lab scores it as one.**

Most extraction evals score the values a model produced and quietly skip the ones
it didn't. That makes hallucinating into a blank field *invisible to the eval* —
you can only lose points for a wrong value, never for inventing one where the
right answer was "nothing here." This lab inverts that: a ground-truth `null`
means genuinely absent, so **reporting `null` is correct and inventing a value is
wrong.** Most of the rest of the project is downstream of that single decision.

It also refuses to collapse the three different things `null` can mean:

| Method | Conf. | Means |
| --- | --- | --- |
| `explicit-blank` | 0.90 | The label is on the form and the value after it is empty. Confidently absent. |
| `label-miss` | 0.20 | No alias matched. Might be there under a name this profile doesn't know. |
| `currency-parse-fail` / `year-parse-fail` | 0.25 | Found the label, couldn't read the value. |

"I looked and it's blank" and "I don't know where to look" are different facts
about the world and should never share a representation.

**Genuinely uncommon — `ADJUSTMENT_DECISIVE`.** Three reasons to send a case to a
human:

| Kind | Whose fault | Meaning |
| --- | --- | --- |
| `NOT_READABLE` | the extractor's | A required value couldn't be read confidently. |
| `UNRECONCILED` | the packet's | The documents contradict each other and nothing explains it. |
| `ADJUSTMENT_DECISIVE` | **nobody's** | The run's own cleanup step is what decided the outcome. |

The third is the one worth having, and I have not seen it elsewhere. It is
computed by **counterfactually re-running the decision rules against the
un-reconciled input**: remove the duplicate row, or apply the endorsement, and if
the appetite answer *flips*, the workflow escalates — even though nothing went
wrong and every step was correct. A pipeline that silently deduplicates its way
into a different answer should say so out loud.

**The gate.** The verdict is not "did the average go up":

```js
verdict: regressions.length === 0 ? 'clean' : 'regressed'
```

A regression is any scored item the baseline got right and the candidate gets
wrong. A better average does not buy back a field that used to be correct. This
is the no-regression rule from compiler and performance testing, applied at field
granularity to a probabilistic pipeline — old idea, unfashionable place.

**Measured vs. simulated, enforced.** Latency is real `performance.now()` wall
clock. Cost is a token-equivalent estimate at an invented rate, and it carries
`simulated: true` through the API and a `SIMULATED` badge in the UI — with a test
asserting that it does. Most demos blur this line. This one can't.

---

## 5. How this could really be used

Honest framing: **this is a harness, not a product.** Nobody is going to buy it.
What has legs is the technique, in four descending tiers of realism.

**Tier 1 — as a regression gate in a real extraction pipeline (very real).** Swap
the synthetic corpus for ~50–200 real labelled documents and the config profiles
for real model/prompt versions. The scorecard, the null taxonomy and the
`regressions.length === 0` gate port over essentially unchanged. This is a
believable week-one contribution to any team that ships document AI: they almost
certainly have an aggregate eval number and almost certainly do not have a
field-level no-regression gate.

**Tier 2 — as a spec for the null taxonomy (very real, very portable).** The
three-kinds-of-null idea and "ground-truth null means reporting null is correct"
can be dropped into an existing eval harness in an afternoon and will immediately
start catching a class of failure the harness was blind to. This is the single
most transferable idea in the repo.

**Tier 3 — as the shape of a human-review queue (real, needs domain input).** The
queue is served **without ground truth and without accuracy figures**, on
purpose: a human working a real queue has the documents and the machine's
reasoning, not an answer key. Handing the reviewer the answer would make the
queue a demo of something that cannot exist. The three abstention kinds are a
genuinely useful triage taxonomy — "we couldn't read it" / "the docs disagree" /
"our own cleanup decided it" route to different people with different urgency.

**Tier 4 — as a portfolio and interview artifact (its actual current job).** It
is small enough to read in twenty minutes, it runs with zero dependencies, every
claim it makes is asserted by a test, and it contains a defensible opinion. It
demonstrates reliability engineering judgement rather than framework familiarity.

**What it is not usable for, today:** anything touching a real submission. No
auth, no multi-tenancy, no durability beyond a flat JSON file, no rate limiting,
binds to localhost, expects one trusted user, no integration with any policy
admin system or form vendor, and both extractors are deterministic local code
rather than models.

---

## 6. How to approach FurtherAI

### The framing that works

**"Here is my own small version of the reliability problem your Eval Studio /
governance layer solves."**

Not "here is a gap in your product." You do not know their roadmap, you have not
used their product, and a stranger opening with a diagnosis of your product is
a stranger you stop reading. The artifact is strong enough to carry itself; the
framing only has to not get in the way.

### Three rules, non-negotiable

1. **Never claim they lack this.** You have no visibility into what they've built.
2. **Never overstate your experience.** You have not shipped insurance software
   in production. The README says so in plain words and you should too — it
   converts your biggest liability into evidence that you are careful, which is
   the exact trait the artifact is arguing you have.
3. **Say "synthetic" early and once.** Then move on. Leading with it signals you
   understand why it matters; dwelling on it signals anxiety.

### What to send

A link and a paragraph. Not an essay, not a deck. The repo README does the work.

The strongest single line you have is the one-sentence result:

> A version that is more accurate on every headline metric, refers fewer cases to
> humans, and is still not shippable — because it invents values for fields a
> broker deliberately left blank, and no runtime signal catches it.

That sentence is the whole pitch. Everything else is supporting material.

### Draft — yours to edit and send yourself

**I have not sent anything and will not.** This is a draft for you.

> Subject: A small regression-gate lab for document-extraction workflows
>
> Hi [name],
>
> I built a small synthetic lab around a question I find interesting: when you
> change a document-extraction workflow, how do you find out what you broke?
>
> It replays eight invented insurance submission packets through two versions of
> the same pipeline and diffs them field by field. The result it's built to show:
> v2 is more accurate on every headline metric and refers fewer cases to a human
> — and is still not shippable, because it fills in two fields a broker
> deliberately left blank, inferring them from prose elsewhere in the packet.
> Nothing errors, no check fails, the decision doesn't change, and the
> data-completeness flag that would have caught it stops firing *because* the
> blanks are now full. Only a field-level diff against ground truth surfaces it.
>
> The load-bearing design decision is that a ground-truth `null` means genuinely
> absent, so reporting `null` is correct and inventing a value is wrong — which
> makes "hallucinated into a blank" a scoreable regression rather than an
> invisible one.
>
> Zero runtime dependencies, runs in one command, ~170 tests. Everything in it is
> synthetic — no real submission, policyholder, carrier or broker. I haven't
> shipped insurance software in production; the domain modelling is a careful
> outsider's reading, which is why every extracted value in the UI cites the exact
> characters it came from.
>
> [link]
>
> Happy to walk through it if it's useful.
>
> — Ashish

### Before you send

- [ ] Re-run `node --test test/` and confirm 170 passing.
- [ ] Start the server, click through all four views, confirm the evidence
      highlighting works. **This has never been rendered in a browser.**
- [ ] Record the 90-second demo (`DEMO_SCRIPT.md`) — a link to a screen recording
      converts far better than a link to a repo.
- [ ] Push to a public repo with the README as the landing page.
- [ ] Read the "Things not to say" section of `DEMO_SCRIPT.md` once more.

### If they ask "why not an LLM?"

> Deliberate. The subject is the harness, not the extractor — and a harness you
> can only exercise by paying for nondeterministic calls is harder to reason about
> and impossible to unit-test at this size. The engine is config-driven, so a
> model-backed profile is a fourth entry in `versions.js` and the scorecard
> doesn't change. And the regression I'm demonstrating is one LLM extractors make
> constantly: filling a blank with something plausible.

That answer is strong. Don't be defensive about it.

---

## 7. Known gaps

**Never rendered in a browser.** `public/app.js` is ~700 lines of vanilla ES
modules that no browser has ever loaded. It is statically consistent with every
API shape it consumes (verified by reading `scorecard.js`, `runner.js`,
`types.js`, `packets.js`), but that is not the same as working. **Do this
first.**

Update 2026-09-21: still no interactive browser available in this environment,
but the next-best verification is done — server started, all 8 routes
(`meta`, `packets`, `packets/:id` via runs view, `suites/:v`, `runs/:v/:p`,
`compare`, `review-queue/:v`, `reviews`, `/`) return 200, `node --check`
passes on `app.js`, and every field the frontend reads was traced to the
server shape that provides it (span `{docId, docName, line, start, end}` =
`makeSpan`; `cost.passes`/`PRICING.label`; `doc.label` from `packets.js`;
`packetSide.versionId`; review-queue `flags`/`lowConfidence`/`reasons`). All
CSS classes referenced exist in `styles.css`. No breaks found; first real
click-through should still be a human with a browser.

**`.claude/launch.json` is missing.** `.gitignore` already has the
`!.claude/launch.json` negation ready for it. Contents:

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "lab", "runtimeExecutable": "node", "runtimeArgs": ["src/server.js"], "port": 5050 }
  ]
}
```

Update 2026-09-21: **added.** `.claude/launch.json` now exists with exactly
these contents.

**`npm run typecheck` fetches from the network.** It shells out to
`npx -y -p typescript@5 -p @types/node@22 tsc --noEmit` rather than adding a
devDependency, to preserve the zero-dependency property. `strict` is off — the
source is plain JS with JSDoc annotations, not TypeScript.

Update 2026-09-21: typecheck was red and is still red, but for a smaller
reason. Fixed since: real JSDoc drift in `src/` and `public/` — `CheckResult`
was missing `disclaimer` (9 errors), `Resolution` was missing
`unreadableSummands`, `SourceDoc` was missing `label`, `LocationRecord`
declared `isDuplicateOf: boolean` while the code assigns a locId string,
`engine.js` had a wrong type-import path (`../core/packets.js`), and `app.js`
had a mistagged `@param`. All comment/typedef-only, zero runtime effect, tests
still 170/170. What remains is (a) ~50 `Cannot find module 'node:*'` /
`process` / `Buffer` errors — the script as written can never resolve
`@types/node`, because `tsc` only searches ancestor `node_modules/@types`
dirs, not the npx cache, and the repo has no local `node_modules` by design;
and (b) 5 test-file-only narrowing gripes (`extractors.test.js:311`,
`scorecard.test.js:91-94`). Fixing (a) properly needs either a local install
(breaks the zero-dep property) or script surgery; left as-is deliberately.

**Eight packets is a demo, not an eval set.** Enough to plant five edge cases and
prove a mechanism; nowhere near enough to measure anything.

**The review log is a flat JSON file.** Append-only and atomic-renamed, but it is
one file and there is no concurrency story.

### If you keep building, in order

1. Render the UI and fix whatever breaks. Nothing else matters until this is done.
2. A fourth version backed by an actual model, as a profile in `versions.js`. The
   scorecard doesn't change — that's the claim, and shipping it would prove it.
3. Confidence *calibration*, not just confidence: does 0.5 actually mean wrong
   half the time? Right now confidences are hand-assigned constants.
4. Feed the review log back in — a reviewer who overturns the same guideline five
   times is telling you the guideline is wrong.

---

## 8. Commands

```bash
npm start
```

Then open <http://127.0.0.1:5050>.

```bash
node --test test/
```

```bash
npm run typecheck
```

---

## 9. One-paragraph version, for when someone asks

> A self-contained lab that replays eight synthetic insurance submission packets
> through two versions of an extraction workflow and diffs them field by field.
> It exists to demonstrate one result: a version can improve on every headline
> metric — accuracy up, human referrals down, latency flat — and still be
> unshippable, because it invents plausible values for fields a broker
> deliberately left blank. Nothing errors, no check fails, the decision doesn't
> change, and the completeness flag that would have caught it stops firing
> because the blanks are now full. The gate isn't a threshold on an average; it's
> "did any field that used to be right become wrong." Zero runtime dependencies,
> 170 tests, everything synthetic.
