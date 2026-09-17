# Insurance Workflow Regression Lab

A small, self-contained lab for one question:

> When you change a document-extraction workflow, how do you find out what you broke?

The lab ingests messy commercial-insurance submission packets, extracts structured
data with a citation for every value, runs deterministic guideline checks, routes
the cases it isn't sure about to a human review queue — and then **replays the same
corpus through two versions of the workflow and diffs them**, field by field.

The interesting result it is built to demonstrate: **a version can get better on
every headline metric and still be unshippable.** The v1 → v2 diff shows accuracy
up and more packets cleared automatically. It also shows two fields that v1 read
correctly and v2 now gets wrong — v2 invents plausible values for fields a broker
deliberately left blank. Nothing errors. No check fails. The values look exactly
like read values. Only a field-level diff against ground truth surfaces it.

**Everything in this repository is synthetic.** See [What this is not](#what-this-is-not).

---

## Run it

Requires Node.js 20.9 or newer. There are no runtime dependencies, so `npm install`
downloads nothing.

```bash
npm install && npm start
```

Then open <http://127.0.0.1:5050>.

```bash
npm test
```

Runs the full suite with the built-in Node test runner — no test framework.

An optional typecheck of the JSDoc annotations (this one does need the network,
because it fetches `tsc` on demand):

```bash
npm run typecheck
```

---

## The 60-second tour

1. **Scorecard** — v1 vs v2 across the whole corpus. Read the verdict banner first,
   then the regressions table.
2. Click a regressed field to open **PKT-002**. The row for `L2.constructionType`
   shows the value, confidence `0.50`, and method `context-backfill`. The ground
   truth column says the correct answer is `null`. The broker left it blank; v2
   guessed "Joisted Masonry" from a sentence elsewhere in the packet.
3. **Trace** tab — the five stages of that run, timed, with what each one did.
4. **Review queue** — the submissions v2 refused to decide, with the machine's
   reasons and the values it was unsure about. No accuracy figures here, on purpose.
5. Back to the **Scorecard**, switch the candidate to **v2.1**. Same improvements,
   regression gone, verdict CLEAN. That is what a release gate looks like.

---

## How it works

```
data/packets/PKT-00N/*.txt     synthetic source documents (plain text)
data/ground-truth.json         hand-labelled correct answer for every packet
data/store/reviews.json        append-only log of human review decisions

src/core/extractors/           one config-driven engine, three profiles
src/core/                      resolve → checks → conflicts → abstain → runner
src/core/scorecard.js          scoring and the version diff
src/server.js                  node:http JSON API + static frontend
public/                        vanilla-ES-module frontend, no build step
test/                          unit tests per module + one integration test
```

### The pipeline

Each run is five stages, each of which appears in the trace:

| Stage | What it does |
| --- | --- |
| **Extract** | Walks every in-scope document once, matching field labels against the profile's alias vocabulary. Every value carries a span (document, line, character offsets), a confidence, and the method that produced it. |
| **Reconcile** | Deduplicates the location schedule, applies endorsements, and foots the schedule to a computed total insured value. |
| **Apply guidelines** | Five deterministic checks, evaluated in code. |
| **Detect conflicts** | Four checks for the documents disagreeing with each other. |
| **Route** | `quote`, `decline`, or `referred` to a human. |

### Checks vs. conflicts

These are different things and the lab keeps them apart.

A **guideline check** produces an answer:

| | |
| --- | --- |
| `GL-001` | Total insured value within appetite |
| `GL-002` | Submission data complete enough to rate |
| `GL-003` | Requested effective date within a workable window |
| `GL-004` | Loss history proportionate to insured value |
| `GL-005` | Each location listed once |

A **conflict** is a reason not to trust any answer yet:

| | | |
| --- | --- | --- |
| `CF-001` | Stated insured value does not match the schedule | high |
| `CF-002` | Loss run contains a claim dated after the submission | medium |
| `CF-003` | Duplicated locations carry different values | low |
| `CF-004` | Values inferred from prose, not read from the schedule | low |

`CF-004` is deliberately **low** severity, so an inferred value never halts a run.
That is precisely why the back-fill regression slips past routing and has to be
caught by the field diff instead. If a governance layer could catch this by
refusing to run, it wouldn't be an interesting regression.

### Three ways to say "I don't know"

Reporting `null` is a claim, and the lab distinguishes three of them:

| Method | Confidence | Means |
| --- | --- | --- |
| `explicit-blank` | 0.90 | The label is on the form and the value after it is empty. Confidently absent. |
| `label-miss` | 0.20 | No alias matched. Might be there under a name this profile doesn't know. |
| `currency-parse-fail` / `year-parse-fail` | 0.25 | Found the label, couldn't read the value. |

**In scoring, a ground-truth `null` means genuinely absent, so reporting `null` is
correct and inventing a value is wrong.** Most of this project is downstream of
that one decision.

### Three kinds of abstention

| Kind | Whose fault | Meaning |
| --- | --- | --- |
| `NOT_READABLE` | the extractor's | A required value couldn't be read confidently. |
| `UNRECONCILED` | the packet's | The documents contradict each other and nothing explains the gap. |
| `ADJUSTMENT_DECISIVE` | nobody's | The run's own reconciliation decided the outcome — remove the duplicate or apply the endorsement and the answer flips. |

The third is the one worth having. When a workflow's own cleanup step is what
tipped a decision, a human should look, even though nothing went wrong.

### The regression gate

The scorecard's verdict is **not** "did the average go up". It is:

```js
verdict: regressions.length === 0 ? 'clean' : 'regressed'
```

A regression is a scored item the baseline got right and the candidate gets wrong.
A higher average does not buy back a field that used to be correct.

---

## The corpus

Eight packets, each a directory of plain-text documents: a simplified application,
a schedule of values, a loss run, and — where relevant — an endorsement request
and a broker email.

| Packet | Insured (invented) | Planted edge case |
| --- | --- | --- |
| PKT-001 | Harborline Cold Storage LLC | *(clean baseline — no defect)* |
| PKT-002 | Cedar Mill Textiles, Inc. | missing field |
| PKT-003 | Ridgeway Logistics Group | duplicate location |
| PKT-004 | Sunhollow Grocers Co-op | inconsistent dates |
| PKT-005 | Ironvale Manufacturing Partners | conflicting limits |
| PKT-006 | Blue Terrace Hospitality Group | late endorsement |
| PKT-007 | Pinnacle Rail Services | inconsistent dates + high TIV + heavy losses |
| PKT-008 | Quarry Point Data Centers | duplicate location + missing field + high TIV |

PKT-001 exists to prove the lab can leave a clean packet alone. PKT-007 and
PKT-008 stack defects, because real submissions do not arrive with one problem at
a time.

Each packet's ground-truth entry carries a `notes` field explaining what was
planted and why — visible in the UI at the bottom of the packet view.

---

## The versions

| | v1 — strict regex | v2 — tolerant heuristic | v2.1 — back-fill removed |
| --- | --- | --- | --- |
| Label vocabulary | standard labels only | widened aliases | widened aliases |
| Currency | must be written in full | bare digits, K/M/B shorthand | same as v2 |
| Documents in scope | application, schedule, loss run | + broker email, endorsements | + broker email, endorsements |
| Address matching | exact string | normalised + fuzzy in-postcode | normalised + fuzzy in-postcode |
| Blank fields | left blank | **inferred from nearby prose** | left blank |
| Appetite ceiling | $40M | $50M | $50M |

v2 bundles seven changes into one release — which is the realistic failure mode.
Six of them are improvements. The seventh invents data. Because they shipped
together, the aggregate metrics net out in v2's favour and the release looks good.

v2.1 is the fix: v2 with back-fill switched off and nothing else touched.

A version is **data, not code** — an extraction profile plus a guideline config,
traversed by one shared engine. There is no separate v1 parser and v2 parser to
drift apart, so a difference in the scorecard is attributable to the configuration
rather than to two implementations that were never quite the same.

---

## Tests

```bash
npm test
```

Unit tests per module — address normalisation, currency and date parsing, each
guideline check, routing, both extractor profiles, and the scorecard maths — plus
`test/pipeline.integration.test.js`, which replays the entire corpus through all
three versions and pins the behaviour the lab is actually claiming:

- the exact decision for all 8 packets under each version;
- which packets abstain, and with which abstention kind;
- that `abstained` and `decision === 'referred'` never disagree;
- that the trace is always the same five stages in non-decreasing time order;
- that running a version twice produces identical results;
- that the v1 → v2 diff reports **exactly** `PKT-002/L2.constructionType` and
  `PKT-002/L2.yearBuilt` as regressions, with `expected: null`, method
  `context-backfill`, confidence `0.50`;
- that the v2 → v2.1 diff is **clean** and moves nothing outside PKT-002.

That last pair is the point. The regression is asserted by identity, not by a
threshold on an average, so the test fails if the lab ever stops catching it.

---

## Measured vs. simulated

The UI labels these differently everywhere, and so does this README.

**Latency is measured.** Each stage is timed with `performance.now()`. The numbers
are real wall-clock time for this machine and this corpus, and they are small
because both extractors are local deterministic code.

**Cost is simulated.** Nothing here calls a model, so nothing here costs anything.
The dollar figures are a token-equivalent estimate (characters read ÷ 4, priced at
an invented rate) shown so the accuracy/cost trade-off is *visible* in the diff —
more passes over more documents costs more. Every cost carries
`simulated: true` in the API and a `SIMULATED` badge in the UI.
**It is not any vendor's pricing and should not be read as a cost estimate for
anything.**

---

## What this is not

- **Not real data.** Every insured, address, broker, loss, date and dollar figure
  is invented for this project. No real submission, policyholder, carrier or
  broker is represented anywhere in this repository.
- **Not ACORD forms.** The application documents are simplified equivalents
  written from scratch, with the same *kinds* of fields. No ACORD form text or
  layout is reproduced.
- **Not underwriting guidance.** Every threshold — the appetite ceiling, the loss
  ratio limit, the date window — is invented to make the demonstration legible.
  Real appetite is a carrier-specific, regulated, continuously negotiated thing.
  Nothing here is authoritative and no underwriting decision should rest on it.
- **Not production software.** No authentication, no multi-tenancy, no billing, no
  durability story beyond a flat JSON file, no rate limiting. It binds to
  localhost and expects one trusted user.
- **Not integrated with anything.** No policy administration system, no form
  vendor, no data provider. There is no integration layer and no stub pretending
  to be one.
- **Not an LLM system.** Both extractors are deterministic local code. That is a
  deliberate scope choice — the subject here is the *harness*, and a harness you
  can only test by paying for nondeterministic calls is a harder thing to reason
  about. The engine is config-driven, so a model-backed profile is where a fourth
  version would go.
- **Not a claim about anyone else's product.** This is one person's small version
  of a reliability problem worth caring about — replay, field-level diffing, and a
  gate that doesn't let an average hide a regression. It is not a commentary on
  any company's tooling, and no company's marks or product surfaces are reproduced
  here.
- **Not evidence of production insurance-domain experience.** I have not shipped
  insurance software in production. The domain modelling here is a careful
  outsider's reading, built to be checked rather than trusted — which is why every
  extracted value in the UI cites the exact characters it came from.

---

## Design decisions worth defending

**Runs are not persisted; only human decisions are.** A run is a pure function of
the corpus and a version, so storing one would cache a computation that can drift
out of agreement with the code that claims to produce it. The whole corpus replays
in milliseconds. A reviewer's judgement is the only fact in the system that cannot
be recomputed, so it is the only thing written to disk.

**The review log is append-only.** Changing your mind about a packet adds a row
rather than rewriting one. A packet that was approved, then declined, then
approved again is telling you something about the guideline.

**The review queue is served without ground truth or accuracy figures.** A human
working a real queue has the documents and the machine's reasoning, not an answer
key. Handing the reviewer the answer would make the queue a demo of something that
cannot exist.

**A review names a version.** A decision about v1's output says nothing about v2's
output for the same packet, so a review that doesn't name a version is rejected.

**Confidence and method are shown on every field, including the nulls.** The
regression this lab exists to catch is invisible precisely because an inferred
value renders identically to a read one — unless you show the method.

---

## API

| | |
| --- | --- |
| `GET /api/meta` | versions, default comparison, pricing label, disclaimer |
| `GET /api/packets` | corpus index |
| `GET /api/packets/:id` | one packet with full document text |
| `GET /api/suites/:versionId` | whole corpus replayed through one version |
| `GET /api/runs/:versionId/:packetId` | one run: extraction, checks, trace, score |
| `GET /api/compare?baseline=&candidate=` | the diff |
| `GET /api/review-queue/:versionId` | abstained packets, no answer key |
| `GET /api/reviews[?packet=]` | the append-only log |
| `POST /api/reviews` | record one decision |

---

## Licence

MIT. The synthetic corpus is free to reuse; please keep it labelled as synthetic.
