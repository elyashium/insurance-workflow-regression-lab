# 75-second demo script

For a screen recording or a live walkthrough. Timings are targets, not a
stopwatch. Everything on screen is synthetic; say so once, early, and move on.

**Before you start:** `npm start`, open <http://127.0.0.1:5050>, click **Load
evaluation data**, land on the Scorecard with **v1 → v2** selected. Have
PKT-002 ready in a second tab if you're worried about a slow click.

---

## 0:00 — 0:10 · The question

> "This is a lab for one question: when you change a document-extraction
> workflow, how do you find out what you broke?
>
> Eight synthetic insurance submissions. Two versions of the same pipeline.
> Everything you're about to see — the insureds, the addresses, the thresholds —
> is invented for this demo."

*On screen: the Scorecard, unscrolled.*

---

## 0:10 — 0:22 · The metrics say ship it

Point at the metric row.

> "v2 widened the label vocabulary, brought the broker email into scope, and
> normalised addresses. Accuracy is up. It refers fewer submissions to a human.
>
> Every number a dashboard would show you says ship it."

---

## 0:22 — 0:32 · The verdict disagrees

Point at the red **REGRESSED** banner.

> "The gate disagrees. Two fields that v1 read correctly, v2 now gets wrong.
>
> The gate here isn't a threshold on an average. It's: did any field that used to
> be right become wrong. A better average doesn't buy that back."

---

## 0:32 — 0:48 · What actually broke

Scroll to the regressions table. Click `PKT-002 / L2.constructionType`.

> "Cedar Mill Textiles. The broker left construction type blank — and said in
> writing they'd rather leave it blank than guess. The correct extraction is null.
>
> v2 fills it in anyway. 'Joisted Masonry', confidence 0.50, method
> `context-backfill` — inferred from a hedged sentence elsewhere in the packet."

Click the field row so the evidence highlights in the document pane.

> "Every value cites the characters it came from. That's how you can see this one
> didn't come from the schedule at all. Nothing errored, no check failed — only
> a field-level diff catches it."

---

## 0:48 — 0:58 · Even the slice looked shippable

Scroll to **Movement by edge case**.

> "Here's the part that should worry you. The missing-field slice — the family
> this regression belongs to — nets plus five. Seven gains against two losses.
>
> The release looked good on averages *inside the very slice that regressed.*
> Slice tables don't save you either. Only the named-field list does."

---

## 0:58 — 1:08 · The hypothetical, executed

Scroll to **What-if thresholds**. Type `40` into the ceiling box, hit **Re-run**.

> "Same pipeline, hypothetical rule: what if appetite were forty million?
> PKT-002 flips back to decline, live — re-run, not edited. That's the lab
> answering a question a meeting would otherwise argue about for an hour."

---

## 1:08 — 1:15 · The fix, proven

Back to the version selects. Change the candidate to **v2.1 — back-fill removed**.

> "v2.1 is v2 with that one heuristic switched off. Improvements kept,
> regression gone, verdict clean — and the per-packet table confirms nothing
> moved anywhere else.
>
> That's the whole argument: replay, diff at the field level, and don't let an
> average hide a regression."

---

## Numbers you can state on camera

Only these. Everything else, let the screen say it.

- **8** synthetic packets, **3** workflow versions (plus a model-backed fourth).
- **2** regressed fields in the v1 → v2 diff — both on PKT-002, location 2.
- Back-filled values carry confidence **0.50**, below the **0.60** floor.
- The model version reads the corpus at **226/226 for about a cent**, metered —
  costs marked `SIMULATED` are estimates, costs marked metered are real.
- **199** tests, green on Node 20 and 22. **0** runtime dependencies.

## Things not to say

- Don't call the simulated cost figures real. The UI marks estimates
  `Simulated` and model spend as metered — say which is which if cost comes up.
- Don't present any threshold as underwriting guidance. They're invented.
- Don't describe this as production insurance software, or imply domain
  experience it doesn't demonstrate. It's a harness, built to be checked.
- Don't frame it against anyone's product. It's a small version of a reliability
  problem, not a critique of somebody's tooling.

## If someone asks "why not an LLM?"

> "There is one — v3, in the version menu. Same pipeline, same guidelines, a
> chat model doing the reading with every quote resolved back to source
> characters, instructed to leave blanks blank. It reads 226 for 226. The
> harness doesn't change, which is exactly the claim: versions are config,
> including model-backed ones. Responses are cached, so its replays are as
> deterministic as the regex ones."

## If someone asks "what would this take in production?"

> "Three things this demo doesn't have: a labelled corpus of fifty to two
> hundred real documents — that's the actual asset and the actual work; a CI
> gate that replays it on every prompt, model, or rule change; and calibrated
> confidences instead of hand-set constants. The code here is scaffolding
> around those three. The null-as-claim scoring ports over unchanged, and
> that's the piece most harnesses are missing."
