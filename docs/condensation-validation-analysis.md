# Condensation Validation Analysis (2026-03-05)

## TL;DR

Yes — **condensation is working** in live runs.

It is not “never firing.” In both aggressive and default configurations, we observed:
- condensation entry (`condensation_summarize_start`)
- successful parent creation (`condensation_summary_created`)
- persisted depth-1 summaries in SQLite

The main limiter in default settings is **eligibility/fanout timing**, not condensation guard failure.

---

## Scope of This Analysis

This analysis is based on:

1. **Aggressive live cmux run**
   - Config: `freshTailCount=8`, `leafChunkTokens=5000`, `leafTargetTokens=600`, `condensedTargetTokens=400`, `condensedMinFanout=3`
   - Session ID: `0efb875e-a77c-4902-af20-0c774c258cd1`

2. **Clean default live cmux run**
   - Defaults: `freshTailCount=32`, `leafChunkTokens=20000`, `leafTargetTokens=1200`, `condensedTargetTokens=2000`, `condensedMinFanout=4`
   - Session ID: `32b3231a-d378-44eb-abf0-fac28dbce6af`

3. Debug instrumentation added to `src/compaction/engine.ts`
   - `PI_LCM_DEBUG=1`
   - explicit tracing for leaf and condensation eligibility, skips, guard checks, and summary creation

---

## Results

## 1) Aggressive Config Run

Inspector output (`scripts/inspect-live-db.ts`) for session `0efb...`:

- Messages: **22**
- Summaries: **8**
  - d0 leaf: **6**
  - d1 condensed: **2**
- Max depth: **1**
- SQLite integrity: **OK**
- FTS5: **functional**

Interpretation:
- Condensation is clearly active and persisted.
- Tool pipeline and storage integrity remained healthy.

---

## 2) Default Config Run

Inspector output for session `32b3...`:

- Messages: **54**
- Summaries: **12**
  - d0 leaf: **10**
  - d1 condensed: **2**
- Context items: **36** (32 messages + 4 summaries)
- Max depth: **1**
- SQLite integrity: **OK**
- FTS5: **functional**

From captured debug screen (`/tmp/pi-lcm-default-cmux-screen-1772730123-final.txt`):

- `condensation_summary_created`: **2**
- `condensation_summarize_start`: **2**
- `condensation_guard_not_smaller_than_input`: **0**
- `leaf_guard_not_smaller_than_input`: **1**
- `contiguous_run_below_min_fanout` skips: **15**
- `eligibleEnd: 0` occurrences: **20**

Interpretation:
- Condensation works under defaults.
- Most delay is from:
  - large fresh tail (32) delaying eligibility,
  - fanout requirement (4) delaying condensation until enough contiguous d0 summaries accumulate.

---

## Is Condensation Working?

**Yes.**

Not only does the code path run, but d1 summaries are created and persisted in real session DBs under both tested configurations.

---

## Bugs / Risks Identified

## A) Likely leaf compression accounting bug (important)

In `runCompaction`, leaf guard compares:
- `inputTokens = estimateTokens(priorSummaryContext + chunkContent)`
- `outputTokens = estimateTokens(summaryContent)`

But only the message chunk is replaced in context; `priorSummaryContext` is prompt-only scaffolding.

### Why this matters
A leaf summary can pass `outputTokens < inputTokens` while still being larger than the chunk it replaces, which can increase context token totals and reduce compaction efficiency.

### Signal seen in run
We observed a successful leaf summary creation immediately followed by `context_tokens_not_decreasing` in later sweep iteration(s), consistent with this risk pattern.

---

## B) Sweep stop condition can be too coarse

The monotonic guard (`context_tokens_not_decreasing`) works as a safety mechanism but can stop further work even when structural progress happened in the same pass.

Not a correctness break, but potentially reduces compaction throughput in verbose-summary cases.

---

## C) Default behavior may appear “inactive” to operators

With default `freshTailCount=32` and `condensedMinFanout=4`, real users can experience many turns without visible condensation.

This is expected behavior, but from a UX perspective it can look like failure.

---

## Improvements Recommended

## Priority 1 (correctness)
1. **Fix leaf guard accounting**
   - Compare leaf summary output against the token sum of the replaced chunk (not full summarizer input with prior-context prefix).

2. **Add regression test**
   - Case where prior summary context is large enough to mask non-compressive output.

## Priority 2 (performance/UX)
3. **Refine compaction progress criteria**
   - Avoid stopping solely on coarse total-token monotonic check when a valid structural replacement just occurred.

4. **Document/consider default tuning**
   - Keep defaults safe, but evaluate lower effective tail or adaptive fanout for earlier visible condensation in medium sessions.

## Priority 3 (observability)
5. Keep the current structured debug events (already added) as standard troubleshooting hooks.

---

## Final Conclusion

Condensation is operational in real runs.

The observed “not happening” symptom is primarily explained by **eligibility timing + fanout gating**, with one notable potential leaf-accounting bug that should be corrected to improve compaction efficiency and avoid false-positive compression wins.
