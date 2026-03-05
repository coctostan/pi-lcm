# pi-lcm Handoff

## What This Project Is

pi-lcm is a pi extension that manages context window noise in long coding sessions. It strips, summarizes, and indexes older conversation content so the model's context stays clean while all detail remains retrievable via tools.

**Two phases implemented:**
- **Phase 1 (✅ working):** Strips tool results older than `freshTailCount` turns, stores them, retrieves via `lcm_expand`
- **Phase 2 (✅ partially working):** Hierarchical SQLite DAG of summaries using a cheap model. Provides `lcm_grep` (FTS5 search), `lcm_describe` (summary metadata), `lcm_expand` (full content retrieval)

**Tech:** Node.js + TypeScript, built-in `node:sqlite` (no native deps), Gemini Flash or Haiku for summarization, pi extension API.

---

## Current Status: What Works, What Doesn't

### ✅ Working Well
- **Leaf compaction** fires reliably on every `agent_end` call
- **FTS5 full-text search** via `lcm_grep` — functional in live sessions
- **DAG tool chain** `lcm_grep → lcm_describe → lcm_expand` — validated end-to-end
- **SQLite integrity** — all checks passing across all DBs
- **Phase 1 strip/expand** — lossless recovery of stripped content
- **Status bar** — updates correctly showing summary count and context %
- **297 unit/integration tests** passing

### 🔴 Condensation Never Fires in Real Sessions

**This is the main issue.** The multi-depth DAG (d1+ summaries) has never successfully produced a condensed summary in any real session with proper content. Only early test sessions with empty/trivial content show d1 summaries.

**Evidence:** Forensic analysis of ALL DBs in `~/.pi/agent/lcm/`:
- Session `d28531a0` (55 messages, our interactive test): 41 d0 summaries, 0 d1+
- Session `2c369295` (160 messages, largest): 10 d0 summaries, 0 d1+
- Sessions with d1+ summaries all have `tokenCount=0, contentLen=0` — from when pi-lcm was broken

**Root cause analysis (two possible failure modes, unclear which):**

1. **Guard blocks it** — `condensedTargetTokens=2000` is too close to typical condensation input size (~2500 tokens for 11 eligible summaries). The summarizer fills its 2000-token budget, and `estimateTokens` (which uses `chars/3.5*1.2`) may measure the output as ≥ input, triggering the `condensation_not_smaller_than_input` guard.

2. **Code never reaches condensation** — Each compaction run happens per `agent_end`. At the moment condensation checks eligibility, context items may be ≤ `freshTailCount` (32) after leaf compaction just consumed messages. The 43-item final state is accumulated across 29 separate runs; no single run may have had >32 items with enough eligible summaries.

**The math (from session d28531a0):**
```
11 eligible d0 summaries, joined content = 7335 chars
estimateTokens(input) = 2515
condensedTargetTokens (maxOutputTokens to LLM) = 2000
Guard: estimateTokens(output) must be < 2515

If LLM outputs 2000 real tokens at ~3.5 chars/tok = 7000 chars → estimateTokens = 2400 → PASSES
If LLM outputs 2000 real tokens at ~4.0 chars/tok = 8000 chars → estimateTokens = 2743 → BLOCKED
```

**Fix options (not yet implemented):**
- Dynamic target: `condensedTargetTokens = Math.floor(inputTokens * 0.5)` — always 50% compression
- Lower default: `condensedTargetTokens = 600`
- Higher fanout: `condensedMinFanout = 8` — more input material for compression
- Or add debug tracing to determine which failure mode is actually occurring

### 🟡 No System Prompt Augmentation

ARCHITECTURE.md specifies appending LCM guidance to the system prompt (tool usage instructions) when summaries are present. This isn't implemented. Models don't know how/when to use `lcm_grep`/`lcm_describe`/`lcm_expand` unless explicitly told by the user. In testing, Haiku refused to call `lcm_grep` unprompted — it tried to answer from memory instead.

### 🟡 Context Format Mismatch

`context-builder.ts:54` injects summaries as `JSON.stringify(block)` in `assistant` role messages. ARCHITECTURE.md specifies `<lcm-summary>` XML nodes. The model may not recognize these well as structured summaries.

### 🟡 Context Items Grow Unbounded

Without condensation working, context_items grows linearly. One session has 151 items. This is manageable now (~10K tokens of summaries) but won't scale to 500+ message sessions.

---

## How to Test pi-lcm (cmux Interactive Method)

### The Key Idea

You can't debug pi-lcm from inside a broken pi-lcm. So we launch a **separate pi instance** in a cmux split pane and drive it interactively using cmux tools. This gives realistic multi-turn testing without risking your own session.

### Step-by-Step Procedure

**1. Create a split pane:**
```
cmux_split({ direction: "right", type: "terminal" })
→ Returns surface:N (remember this ID)
```

**2. Launch pi with lcm in the split pane:**
```
cmux_send({
  surface: "surface:N",
  text: "cd /Users/maxwellnewman/pi/workspace/pi-lcm && PI_LCM_DEBUG=1 pi --no-extensions -e ./src/index.ts --session-dir /tmp/pi-lcm-test-$(date +%s) --model anthropic/claude-haiku-4-5"
})
cmux_send({ surface: "surface:N", key: "enter" })
```

**3. Wait for startup (~5 seconds), then verify:**
```
cmux_read_screen({ surface: "surface:N" })
```
Look for: `dagReady: true`, `hasSummarizer: true`, the pi prompt with extension loaded.

**4. Send prompts and read responses:**
```
cmux_send({ surface: "surface:N", text: "your prompt here" })
cmux_send({ surface: "surface:N", key: "enter" })
# Wait 10-20 seconds for response
cmux_read_screen({ surface: "surface:N" })
```

**5. What to look for in screen output:**
- `agent_end ingested { ingested: N, totalMessages: M }` — messages being tracked
- `agent_end compaction result { actionTaken: true, summariesCreated: N }` — compaction firing
- Status bar: `🟢 X% | N summaries (d0) | tail: 2` — summary count growing
- No errors or stack traces

**6. Exercise the DAG tools (after 5+ turns):**
- Ask the agent: "Call the lcm_grep tool with query 'TERM'" (be explicit — haiku may resist)
- Then: "Call lcm_describe on summary ID <id-from-grep-results>"
- Then: "Call lcm_expand on ID <same-id>"

**7. Inspect the DB directly:**
```bash
# Find the DB path from the debug output at startup
node --experimental-strip-types scripts/inspect-live-db.ts <db-path>
```

**8. Exit the test session:**
```
cmux_send({ surface: "surface:N", text: "/exit" })
cmux_send({ surface: "surface:N", key: "enter" })
```

### Canary Marker Pattern

Plant known strings in early prompts ("Remember marker LCM-CANARY-ALPHA-001") then later use `lcm_grep` to search for them. This validates that conversation content survives ingestion → summarization → FTS5 indexing → retrieval.

### Custom Config for Stress Testing

To force more aggressive compaction (useful for testing condensation):
```bash
cat > ~/.pi/agent/extensions/pi-lcm.config.json << 'EOF'
{
  "freshTailCount": 8,
  "leafChunkTokens": 5000,
  "leafTargetTokens": 600,
  "condensedTargetTokens": 400,
  "condensedMinFanout": 3
}
EOF
```
**Remember to restore/delete this file after testing** — it affects all pi-lcm sessions.

### DB Forensics Queries

Check condensation status across all DBs:
```bash
for db in ~/.pi/agent/lcm/*.db; do
  echo "=== $(basename $db) ==="
  node --experimental-strip-types -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('$db');
    try {
      const rows = db.prepare('SELECT depth, kind, COUNT(*) as cnt, AVG(tokenCount) as avgTok FROM summaries GROUP BY depth, kind').all();
      console.log(JSON.stringify(rows));
    } catch(e) { console.log('Error:', e.message); }
    db.close();
  " 2>/dev/null
done
```

Check context item ordering (summaries should be contiguous at start):
```bash
DB="path-to-db"
node --experimental-strip-types -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('$DB');
  const items = db.prepare('SELECT ordinal, messageId, summaryId FROM context_items ORDER BY ordinal LIMIT 30').all();
  items.forEach(i => console.log('ord=' + i.ordinal + ' ' + (i.summaryId ? 'SUMMARY' : 'MESSAGE')));
  db.close();
" 2>/dev/null
```

---

## Three-Tier Testing Routine

### Tier 1: Quick Smoke (2 min, after any code change)
```bash
npm test
```
Runs 297 unit + stress tests. All should pass.

### Tier 2: cmux Interactive (5 min, after integration changes)
Follow the procedure above. 6 turns minimum. Verify:
- [ ] Compaction fires (`actionTaken: true`)
- [ ] Summaries accumulate (status bar shows count)
- [ ] `lcm_grep` returns results for known terms
- [ ] `lcm_describe` returns proper metadata (depth, kind, tokenCount)
- [ ] `lcm_expand` returns full content from DAG store
- [ ] DB inspector shows FTS5 functional, integrity OK

### Tier 3: Deep Stress (15 min, before releases)
- 20+ turns with tool-heavy conversation (file reads, code explanations)
- Use aggressive config (`freshTailCount: 8`) to test condensation
- Verify d1+ summaries appear (currently broken with default config)
- Kill and restart pi — verify session reconciliation from JSONL
- Push context past 50% to test threshold behavior

---

## Existing Test Infrastructure

### Unit/Integration Tests
- `src/**/*.test.ts` — 297 tests covering all modules
- `src/stress.test.ts` — S1-S4 scenarios (bulk ingest, canary search, DAG tools, edge cases)

### Bash Harness (scripts/)
- `scripts/lcm-harness.sh` — batch/loop test with extension injection, non-interactive
- `scripts/lcm-cmux-real-use.sh` — cmux-based script (dry-run validated, needs live cmux)
- `scripts/prompts/` — fixture prompt files for smoke tests
- `scripts/inspect-live-db.ts` — SQLite DB health inspector
- `scripts/smoke-summarizer.ts` — standalone summarizer validation

### Key Files
```
src/index.ts              — Extension entry point (extensionSetup)
src/config.ts             — DEFAULT_CONFIG, loadConfig, validation
src/compaction/engine.ts  — runCompaction (leaf loop + condensation loop)
src/compaction/chunk-selector.ts — selectLeafChunk, selectCondensationChunk
src/context/context-builder.ts — buildContextItems (summary injection)
src/store/sqlite-store.ts — SQLite DAG store with FTS5
src/summarizer/summarizer.ts — PiSummarizer (LLM-based)
src/summarizer/token-estimator.ts — estimateTokens (chars/3.5*1.2)
```

---

## What to Work on Next

**Priority order:**

1. **Debug condensation** — Add tracing to the condensation path in `engine.ts` to determine which failure mode is happening (guard blocking vs. code never reached). Then fix it.

2. **System prompt augmentation** — When summaries exist in context, append instructions telling the model about `lcm_grep`/`lcm_describe`/`lcm_expand` and when to use them.

3. **Context format** — Switch from `JSON.stringify` to `<lcm-summary>` XML format in `context-builder.ts` as specified in ARCHITECTURE.md.

4. **Open issues** — #001 (config dependency injection for tests), #010 (Zod schemas). These are technical debt, not user-facing.

---

## Config Reference

Default values (from `src/config.ts`):

| Setting | Default | Purpose |
|---------|---------|---------|
| freshTailCount | 32 | Messages kept at full resolution |
| contextThreshold | 0.75 | Context % that triggers compaction |
| leafChunkTokens | 20000 | Max tokens per leaf chunk |
| leafTargetTokens | 1200 | Target tokens for leaf summaries |
| condensedTargetTokens | 2000 | Target tokens for condensed summaries |
| condensedMinFanout | 4 | Min children before condensation |
| incrementalMaxDepth | -1 | Max DAG depth (-1 = unlimited) |
| summaryModel | anthropic/claude-haiku-4-5 | Model for summarization |
| maxExpandTokens | 4000 | Token budget per lcm_expand call |

Config file: `~/.pi/agent/extensions/pi-lcm.config.json`
