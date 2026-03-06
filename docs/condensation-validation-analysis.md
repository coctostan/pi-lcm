# Condensation Validation Analysis (2026-03-05)

## TL;DR

**Yes — condensation is working** in live runs.

It is not "never firing." In both aggressive and default configurations we observed:
- condensation entry (`condensation_summarize_start`)
- successful parent creation (`condensation_summary_created`)
- persisted depth-1 summaries in SQLite

The main limiter under default settings is **eligibility/fanout timing**, not condensation guard failure.

---

## Scope

This analysis is based on:

| Run | Config | Session ID |
|-----|--------|-----------|
| Aggressive | `freshTailCount=8`, `leafChunkTokens=5000`, `condensedMinFanout=3` | `0efb875e-a77c-4902-af20-0c774c258cd1` |
| Default | `freshTailCount=32`, `leafChunkTokens=20000`, `condensedMinFanout=4` | `32b3231a-d378-44eb-abf0-fac28dbce6af` |

Debug instrumentation was added to `src/compaction/engine.ts` and run with `PI_LCM_DEBUG=1`.

---

## Results

### 1) Aggressive Config Run

DB inspector output for session `0efb...`:

- Messages: **22**
- Summaries: **8** (d0 leaf: 6, d1 condensed: 2)
- Max depth: **1**
- SQLite integrity: **OK**
- FTS5: **functional**

Condensation is clearly active and persisted.

---

### 2) Default Config Run

DB inspector output for session `32b3...`:

- Messages: **54**
- Summaries: **12** (d0 leaf: 10, d1 condensed: 2)
- Context items: **36** (32 messages + 4 summaries)
- Max depth: **1**
- SQLite integrity: **OK**
- FTS5: **functional**

From captured debug screen (24-turn interactive cmux run, no config override):

| Event | Count |
|-------|-------|
| `condensation_summary_created` | 2 |
| `condensation_summarize_start` | 2 |
| `condensation_guard_not_smaller_than_input` | **0** |
| `leaf_guard_not_smaller_than_input` | 1 |
| `contiguous_run_below_min_fanout` skips | 15 |
| `eligibleEnd: 0` occurrences (pre-eligibility turns) | 20 |

---

## Why Condensation Appears Slow Under Defaults

Default settings are deliberately conservative:

1. **`freshTailCount=32`** — 32 messages must exist before *any* are eligible for leaf compaction. With 2 msgs/turn, that's 16 turns of no-ops.

2. **`condensedMinFanout=4`** — condensation only fires when there are ≥4 contiguous d0 summaries outside the fresh tail. With small short-answer turns, summaries accumulate slowly.

3. **No-action is safe, not broken.** The no-op reasons logged are `eligible_leaves_below_min` (pre-eligibility) and `contiguous_run_below_min_fanout` (pre-fanout). These are expected.

---

## Bugs / Risks Identified

### A) Leaf guard uses inflated input tokens (important)

In `src/compaction/engine.ts`, the leaf guard compares:

```
inputTokens = estimateTokens(priorSummaryContext + chunkContent)
outputTokens = estimateTokens(summaryContent)
```

But only the message chunk is replaced in context — `priorSummaryContext` is prompt scaffolding passed to the summarizer, not a context item being replaced.

**Effect:** A summary can pass `outputTokens < inputTokens` while still being larger than the actual replaced chunk. This can cause context token totals to increase after a "successful" leaf compression, which then trips the monotonic stop condition on the next sweep iteration.

**Signal seen:** We observed `leaf_summary_created` followed immediately by `leaf_sweep_stopped_context_not_decreasing` on the next iteration, consistent with this pattern.

---

### B) Sweep stop condition is too coarse

The `context_tokens_not_decreasing` guard stops the entire sweep when global total tokens don't decrease. This is a valid safety guard, but it fires even when:
- a structural replacement happened
- the increase is small (e.g., a verbose summary for a small chunk)

**Effect:** Reduces compaction throughput per `agent_end` call, especially in cases where summaries are verbose but structurally useful.

---

### C) Default behaviour appears inactive to operators

With `freshTailCount=32` and `condensedMinFanout=4`, real users experience many turns with no visible condensation. The status bar shows no summaries for a long time. This is correct behaviour but can look like failure.

---

## Recommended Improvements

| Priority | Area | Change |
|----------|------|--------|
| P1 | Correctness | Fix leaf guard: compare output against chunk token sum only, not full summarizer input |
| P1 | Tests | Add regression test: prior-context prefix inflates input beyond chunk size |
| P2 | Performance | Refine sweep stop: don't halt on coarse token total if a valid structural replacement just occurred |
| P3 | UX | Document/consider lower default tail or adaptive fanout for earlier visible condensation |
| P3 | Observability | Keep current `PI_LCM_DEBUG=1` structured events as standard troubleshooting hooks |

---

## Conclusion

Condensation is **operational** in real sessions.

The observed "not happening" symptom is entirely explained by eligibility timing and fanout gating under conservative defaults — not by bugs in the condensation path itself. The one notable issue is the leaf guard accounting bug (A above) which inflates the input token baseline and can cause false-positive compression wins.
