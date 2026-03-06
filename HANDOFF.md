# pi-lcm Handoff — Real-World Testing (v0.3)

**Branch:** `docs/condensation-analysis-and-testing-process`  
**Tests:** all 346 passing  
**Last session:** condensation debug instrumentation + live validation

---

## What Just Happened

We did the first structured live validation of the compaction pipeline:

1. **Added debug instrumentation** to `src/compaction/engine.ts`
   - Enabled by `PI_LCM_DEBUG=1`
   - Logs detailed events for both leaf and condensation paths
   - Events include: eligibility checks, skip reasons, guard failures, token comparisons, summary creation

2. **Validated condensation in live runs** — two configs:
   - Aggressive (`freshTailCount=8`, `condensedMinFanout=3`): condensation fires readily
   - Default (`freshTailCount=32`, `condensedMinFanout=4`): condensation fires correctly after ~20 turns

3. **Wrote 3 docs**, committed to the branch:
   - `docs/condensation-validation-analysis.md` — analysis + bugs found
   - `docs/testing/stress-testing-process.md`
   - `docs/testing/real-world-testing-process.md`

---

## Bugs Found

### A) Leaf guard uses inflated input token count (P1 — not fixed yet)

`src/compaction/engine.ts` leaf guard:

```
inputTokens = estimateTokens(priorSummaryContext + chunkContent)
outputTokens = estimateTokens(summaryContent)
```

`priorSummaryContext` is passed to the summarizer as scaffolding, but only the
`chunkContent` messages are actually replaced in context. So the guard can pass
even when the summary is larger than the replaced chunk, causing context total
tokens to increase after a nominally successful leaf compression.

**Signal:** `leaf_summary_created` followed by `leaf_sweep_stopped_context_not_decreasing` on the very next iteration.

**Fix needed:** compare `outputTokens` against chunk-only token sum, not full summarizer input.

### B) Monotonic stop can halt too early (P2 — minor)

`context_tokens_not_decreasing` stops the sweep even when structural progress
was made and the increase is small. Reduces compaction throughput per turn.

---

## What v0.3 Added (Test This Session)

v0.3 added the **large file interception pipeline**. None of this has had live testing:

| Feature | Files |
|---------|-------|
| `tool_result` hook — intercepts `read` tool results > `largeFileTokenThreshold` | `src/large-files/interceptor.ts` |
| Structural explorer — generates compact summary of file contents | `src/large-files/explorer.ts` |
| `large_files` SQLite table — caches full file content | `src/store/sqlite-store.ts` |
| `lcm_expand` pagination — `offset` param for large files | `src/tools/expand.ts` |

**How it works end-to-end:**
1. Agent reads a large file via the `read` tool
2. If result > `largeFileTokenThreshold` tokens (~25K), interception fires
3. Full content saved to `~/.pi/agent/lcm-files/<uuid>.txt` + `large_files` table
4. Context sees a compact structural summary instead (for .ts/.js: exports list; other: line count + first ~60 lines)
5. `lcm_expand("<file-id>")` retrieves paginated content; `lcm_expand("<file-id>", offset=4000)` for page 2

**Key config:**
```json
{
  "largeFileTokenThreshold": 25000
}
```
Default is 25000 tokens. For testing, set lower (e.g. 500) to trigger on any file read.

---

## Real-World Testing Goal This Session

Test **all three layers together** in a real interactive pi session:
1. Compaction/condensation (already partially validated — confirm still clean)
2. v0.3 large file interception and pagination
3. Full tool chain: `lcm_grep` → `lcm_describe` → `lcm_expand` for both summaries and large files

---

## Suggested Test Protocol

### Setup

```bash
cd /Users/maxwellnewman/pi/workspace/pi-lcm
```

Write an aggressive test config to trigger everything faster:

```json
{
  "freshTailCount": 8,
  "leafChunkTokens": 5000,
  "leafTargetTokens": 600,
  "condensedTargetTokens": 400,
  "condensedMinFanout": 3,
  "largeFileTokenThreshold": 500
}
```

Save to `~/.pi/agent/extensions/pi-lcm.config.json`.

> The low `largeFileTokenThreshold` (500 tokens ≈ ~1750 chars) means any medium-sized file read will trigger interception. Good for testing. Restore original config after.

### Launch

```bash
SESSION_DIR=/tmp/pi-lcm-v03-test-$(date +%s)
PI_LCM_DEBUG=1 pi \
  --no-extensions \
  -e ./src/index.ts \
  --session-dir "$SESSION_DIR" \
  --model anthropic/claude-haiku-4-5
```

### Turn Sequence (suggested)

**Turns 1–3: Plant markers + check baseline**
```
Remember marker LCM-V3-ALPHA-001 and reply with 'acknowledged'.
```
```
Remember marker LCM-V3-BETA-002. In two sentences, what is the purpose of a DAG in a summarization system?
```
```
Remember marker LCM-V3-GAMMA-003. Briefly explain how SQLite WAL mode helps with crash safety.
```

**Turns 4–10: Generate token mass (gets leaf compaction going)**
```
Turn N: remember marker LCM-V3-DELTA-00N and give one sentence about [any technical topic].
```
Repeat for turns 4–10 with incrementing numbers.

**Turn 11+: Trigger large file interception**
```
Read the file /Users/maxwellnewman/pi/workspace/pi-lcm/src/compaction/engine.ts and summarize what it does.
```
> With `largeFileTokenThreshold=500` this should intercept and return a structural summary instead of full content.

Watch debug output for:
- `tool_result` interception log
- `large_files` table entry
- Context shows structural summary, not full file

**Verify file ID from the structural summary shown in context, then:**
```
Call lcm_expand with the file ID shown in the summary above and return the first page of content.
```
```
Now call lcm_expand with the same ID and offset=600 to get the second page.
```

**Test summary tool chain:**
```
Call lcm_grep with query "LCM-V3-ALPHA-001" and return the raw JSON.
```
```
Call lcm_describe with the summary ID returned above and show all metadata fields.
```
```
Call lcm_expand with that summary ID and return the content.
```

**Validate canary recall:**
```
What were all the LCM-V3 markers you've been asked to remember in this session?
```
> If condensation is working, some markers will be in summaries; model should still enumerate them.

### Post-Run DB Inspection

Get session ID from startup debug output, then:

```bash
node --experimental-strip-types scripts/inspect-live-db.ts ~/.pi/agent/lcm/<session-id>.db
```

> **Note:** `scripts/` directory does not exist on the current branch. You'll need the db path from
> the startup log and the `inspect-live-db.ts` script. Check if `scripts/inspect-live-db.ts` exists;
> if not, inspect manually with sqlite3 or recreate it.

---

## Acceptance Criteria

All of these should pass for a clean v0.3 live validation:

- [ ] No crashes or stack traces during session
- [ ] Compaction fires (`leaf_summary_created` in debug output)
- [ ] Condensation fires with aggressive config (`condensation_summary_created`)
- [ ] Large file interception fires when reading `engine.ts` (`largeFileTokenThreshold=500`)
- [ ] Intercepted result shows structural summary (export list), not full file
- [ ] `lcm_expand("<file-id>")` returns first page of file content correctly
- [ ] `lcm_expand("<file-id>", offset=600)` returns second page (different content)
- [ ] `lcm_grep` returns hits for planted canary markers
- [ ] `lcm_describe` returns valid metadata for a summary ID
- [ ] `lcm_expand` on a summary ID returns non-empty content
- [ ] Canary markers from early turns are still recalled after compaction
- [ ] DB inspector shows: integrity OK, FTS5 functional, `large_files` table has entries

---

## Known Gaps (Don't Go Down These Rabbit Holes)

- **Leaf guard bug (P1):** Known — not fixed yet. Watch for it in debug output
  (`leaf_summary_created` then immediately `leaf_sweep_stopped_context_not_decreasing`)
  but don't fix it this session unless it breaks acceptance criteria.
- **`explore()` only handles .ts/.js and generic:** Other file types get line count + preview.
  That's expected for v0.3.
- **No `scripts/` dir on this branch:** The harness scripts existed in a prior working tree
  context, not committed. They're documented in `docs/testing/` but not present.

---

## Files to Know

| File | What |
|------|------|
| `src/index.ts` | Extension entry — all event hooks wired here |
| `src/compaction/engine.ts` | Compaction + condensation + debug events |
| `src/large-files/interceptor.ts` | tool_result interception for large files |
| `src/large-files/explorer.ts` | Structural file summary generator |
| `src/tools/expand.ts` | `lcm_expand` — handles both summary IDs and file IDs |
| `src/tools/grep.ts` | `lcm_grep` — FTS5 search |
| `src/tools/describe.ts` | `lcm_describe` — summary metadata |
| `docs/condensation-validation-analysis.md` | Analysis of compaction validation from last session |
| `docs/testing/real-world-testing-process.md` | Full real-world testing process doc |

---

## Config Reference

```json
{
  "freshTailCount": 32,
  "leafChunkTokens": 20000,
  "leafTargetTokens": 1200,
  "condensedTargetTokens": 2000,
  "condensedMinFanout": 4,
  "largeFileTokenThreshold": 25000,
  "maxExpandTokens": 4000,
  "summaryModel": "anthropic/claude-haiku-4-5"
}
```

Config file: `~/.pi/agent/extensions/pi-lcm.config.json`  
Enable debug: `PI_LCM_DEBUG=1` env var
