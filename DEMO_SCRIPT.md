# 90-second demo script

For a screen recording or a live walkthrough. Timings are targets, not a
stopwatch. Everything on screen is synthetic; say so once, early, and move on.

**Before you start:** `npm start`, open <http://127.0.0.1:5050>, land on the
Scorecard with **v1 → v2** selected. Have PKT-002 already loaded in a second tab
if you're worried about a slow click.

---

## 0:00 — 0:12 · The question

> "This is a lab for one question: when you change a document-extraction
> workflow, how do you find out what you broke?
>
> Eight synthetic insurance submissions. Two versions of the same pipeline.
> Everything you're about to see — the insureds, the addresses, the thresholds —
> is invented for this demo."

*On screen: the Scorecard, unscrolled. The synthetic banner is visible at the top.*

---

## 0:12 — 0:28 · The metrics say ship it

Point at the metric row.

> "v2 widened the label vocabulary, brought the broker email into scope, and
> normalised addresses. Accuracy is up. It refers fewer submissions to a human.
> Latency is measured and basically flat.
>
> Every number a dashboard would show you says ship it."

*Let the accuracy delta and the abstention delta sit on screen for a beat.*

---

## 0:28 — 0:40 · The verdict disagrees

Point at the red **REGRESSED** banner above the metrics.

> "The gate disagrees. Two fields that v1 read correctly, v2 now gets wrong.
>
> The gate here isn't a threshold on an average. It's: did any field that used to
> be right become wrong. A better average doesn't buy that back."

---

## 0:40 — 1:00 · What actually broke

Scroll to the regressions table. Click `PKT-002 / L2.constructionType`.

> "Cedar Mill Textiles. On location 2, the broker left construction type and year
> built blank — they declined to guess. The correct extraction is null.
>
> v2 fills them in. 'Joisted Masonry', confidence 0.50, method `context-backfill`
> — it inferred them from a sentence elsewhere in the packet."

Click the field row so the evidence highlights in the document pane.

> "Every value in this lab cites the characters it came from. That's how you can
> see this one didn't come from the schedule at all.
>
> Nothing errored. No check failed. The decision didn't change. The only thing
> that catches this is a field-level diff against ground truth — because an
> invented value renders exactly like a read one unless you show the method."

---

## 1:00 — 1:15 · Abstention and review

Jump to **Review queue**.

> "The submissions v2 wouldn't decide on its own, with the machine's reasons
> attached. Three kinds: couldn't read it, the documents contradict each other,
> or — the interesting one — the workflow's *own* cleanup step is what decided the
> outcome. Dedupe the schedule and the appetite answer flips. Nobody's at fault,
> and a human should still look.
>
> No accuracy numbers on this screen, on purpose. A real reviewer doesn't have an
> answer key."

---

## 1:15 — 1:30 · The fix, proven

Back to **Scorecard**. Change the candidate to **v2.1 — back-fill removed**.

> "v2.1 is v2 with that one heuristic switched off and nothing else touched.
>
> Improvements kept. Regression gone. Verdict clean — and the per-packet table
> confirms nothing moved anywhere else, which is the part you actually need before
> you ship a fix.
>
> That's the whole argument: replay, diff at the field level, and don't let an
> average hide a regression."

---

## Numbers you can state on camera

Only these. Everything else, let the screen say it.

- **8** synthetic packets, **5** planted edge cases, **3** workflow versions.
- **2** regressed fields in the v1 → v2 diff — both on PKT-002, location 2.
- Back-filled values carry confidence **0.50**, below the **0.60** abstention floor.
- **0** runtime dependencies; the whole corpus replays in milliseconds.

## Things not to say

- Don't call the cost figures real. They're a simulated token-equivalent at an
  invented rate, and the UI badges them `SIMULATED` — say that out loud if cost
  comes up at all.
- Don't present any threshold as underwriting guidance. They're invented.
- Don't describe this as production insurance software, or imply domain
  experience it doesn't demonstrate. It's a harness, built to be checked.
- Don't frame it against anyone's product. It's a small version of a reliability
  problem, not a critique of somebody's tooling.

## If someone asks "why not an LLM?"

> "Deliberate. The subject here is the harness, not the extractor — and a harness
> you can only exercise by paying for nondeterministic calls is harder to reason
> about and impossible to unit-test at this size. The engine is config-driven, so
> a model-backed profile is a fourth entry in `versions.js` and the scorecard
> doesn't change. The regression I'm demonstrating is one LLM extractors make
> constantly: filling a blank with something plausible."
