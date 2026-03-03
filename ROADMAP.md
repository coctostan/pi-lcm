# ROADMAP: pi-lcm

**Related:** [VISION.md](./VISION.md), [PRD.md](./PRD.md), [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Release Philosophy

Each milestone is a **shippable, useful artifact** — not a partial implementation. Phase 1 ships something a real user would install today. Each subsequent phase makes it more powerful, more reliable, more integrated.

The zero-cost continuity invariant must hold at every milestone: a user who installs `pi-lcm` on a 5-turn session should see zero behavioral difference from vanilla pi.

---

## Phase 1: MVP — Zero-Cost Context Filtering

**Goal:** Ship something useful with no LLM summarization costs and no SQLite dependency.

**Effort:** 2–3 days  
**Value:** Immediate improvement for sessions over 32 turns. No infrastructure required.

### What Ships

**Core mechanic:** The `context` event strips verbose tool result content from messages older than `freshTailCount`, replacing it with a `[Content available via lcm_expand("entry-id")]` placeholder. The model sees a leaner context. The full content is still in the pi session and retrievable on demand.

**Tools:**
- `lcm_expand(entryId)` — retrieves original tool result content from pi session entries
- Available only when at least one entry has been stripped

**Status bar:** `🟢/🟡/🔴 {pct}% | {N} stripped | tail: {freshTailCount}`

**Config:** `freshTailCount` (default 32), `maxExpandTokens` (default 4000)

### What Doesn't Ship

- SQLite — no database dependency yet
- LLM summarization — zero model calls for context management
- `lcm_grep`, `lcm_describe` — Phase 2

### Milestones

| # | Task |
|---|------|
| 1.1 | ~~Extension scaffold: `package.json`, `tsconfig.json`, pi extension entry point~~ ✅ |
| 1.2 | Config system: defaults, schema validation, hot reload |
| 1.3 | `context` event handler: fresh tail protection, threshold check, strip logic |
| 1.4 | `lcm_expand` tool: session entry lookup, token cap, tool registration |
| 1.5 | Status bar integration: `ctx.ui.setStatus()` per-turn |
| 1.6 | Tests: session fixtures, context builder unit tests, expand tool tests |
| 1.7 | README: install instructions, config reference, usage examples |

### Exit Criteria

- Installing on a fresh session: zero behavioral difference
- Installing on a 50-turn session: tool results older than turn 32 are stripped; `lcm_expand` retrieves them correctly
- Status bar visible and accurate
- All tests passing

---

## Phase 2: LLM Summarization + SQLite DAG

**Goal:** True lossless context management. The model sees summaries of old turns, not stripped placeholders.

**Effort:** 5–7 days  
**Value:** Long sessions stay coherent with model-readable, hierarchically organized history.

### What Ships

**SQLite DAG:** Summary nodes with parent-child relationships. Leaf nodes (depth 0) cover ≤ `leafChunkTokens` of raw messages. Condensed nodes (depth 1+) cover ≤ `condensedMinFanout` summary nodes.

**Proactive compaction:** After each turn (`agent_end`), automatically generate leaf summaries for eligible message spans using `google/gemini-2.5-flash`. Cascade condensation when fanout thresholds are met.

**Three-level escalation:** Guaranteed convergence regardless of content.

**Depth-aware prompts:** Different prompt strategies for leaf vs. condensed nodes at each depth.

**`session_before_compact` override:** Custom reactive compaction when pi's context limit triggers.

**Tools:**
- `lcm_grep(pattern)` — FTS5 search across messages and summaries
- `lcm_describe(summaryId)` — inspect summary metadata without full expansion
- `lcm_expand` — upgraded to handle both Phase 1 session entries and Phase 2 SQLite summary nodes

**Session crash recovery:** `session_start` reconciles SQLite ↔ session JSONL.

**`appendEntry` persistence:** Every summary creation writes a recovery record to the pi session.

### Milestones

| # | Task |
|---|------|
| 2.1 | SQLite schema + `better-sqlite3` integration |
| 2.2 | `Store` interface + SQLite and in-memory implementations |
| 2.3 | Message ingestion pipeline (`agent_end` → SQLite) |
| 2.4 | Summarizer interface + pi-ai implementation (`complete()`) |
| 2.5 | Token estimator (char-based with safety margin) |
| 2.6 | Leaf compaction pass (detect threshold, chunk, summarize, store) |
| 2.7 | Condensation pass (fanout detection, depth-aware prompts, cascade) |
| 2.8 | Three-level escalation (Level 1 → 2 → 3 with convergence guarantee) |
| 2.9 | `ContextBuilder` upgrade: read context_items, inject XML summary nodes |
| 2.10 | `session_before_compact` override for reactive compaction |
| 2.11 | `lcm_grep` tool (FTS5 queries) |
| 2.12 | `lcm_describe` tool |
| 2.13 | `lcm_expand` upgrade: DAG node retrieval, DAG walk for full reconstruction |
| 2.14 | `session_start` reconciliation: JSONL ↔ SQLite sync |
| 2.15 | Status bar upgrade: `🟢/🟡/🔴 {pct}% | {N} summaries (d{D}) | tail: {freshTailCount}` |
| 2.16 | Integration tests with real session fixtures |
| 2.17 | Performance tests: context event overhead, compaction latency |

### Exit Criteria

- 100-turn session: model output quality equivalent to 20-turn session (observed user testing)
- Compaction latency: leaf summary ≤ 5s async for 20K token chunk
- Context event overhead: ≤ 1ms when below threshold, ≤ 10ms with active summaries
- Three-level escalation: all three levels exercised in tests, all converge
- Crash recovery: delete SQLite, restart — LCM gracefully rebuilds from session JSONL
- Zero regressions on Phase 1 tests

---

## Phase 3: Large File Handling

**Goal:** Prevent single oversized file reads from consuming the entire context budget.

**Effort:** 2–3 days  
**Value:** Eliminates the most common acute context crisis — reading a large codebase file.

### What Ships

**`tool_result` interception:** Detect file-reading operations (`read` tool, `bash cat`, etc.) that return content exceeding `largeFileTokenThreshold` (default ~25K tokens). Replace with structural exploration summary.

**Structural exploration summary:** Top-level declarations, module structure, key exports, function signatures, line count, size stats. ~200–500 tokens instead of 25K+.

**File cache:** Full content stored in SQLite `large_files` table + filesystem cache at `~/.pi/agent/lcm-files/`. Cache-invalidated on file modification time change.

**`lcm_expand` pagination:** Large files returned in token-capped chunks with offset support. `lcm_expand("file_abc", offset=4000)` for page 2.

### Milestones

| # | Task |
|---|------|
| 3.1 | `tool_result` event handler: detect file reads, estimate token count |
| 3.2 | Structural explorer: parse common file types, generate exploration summary |
| 3.3 | File cache: SQLite `large_files` table, filesystem storage, mtime invalidation |
| 3.4 | `lcm_expand` pagination for file content |
| 3.5 | Integration tests: large file interception + retrieval |

### Exit Criteria

- Reading a 50K-token file: tool result replaced with ≤500-token exploration summary
- `lcm_expand` returns correct paginated content
- Cache invalidation: modified file returns fresh content on next read
- Non-file tool results: no interception, no overhead

---

## Phase 4: Advanced Features

**Goal:** Polish, integration, and power-user features.

**Effort:** Ongoing (individual sub-features are 1–3 days each)

### 4.1 — Megapowers Phase-Aware Strategies

**Detect active megapowers phase** from `.megapowers/state.json` or a shared context API. Apply phase-specific compaction strategies:

| Phase | Strategy |
|-------|----------|
| `brainstorm` | Periodic checkpoint injection as attention anchors; preserve creative tangents; soft threshold raised |
| `implement` | Aggressive compaction of completed tasks; full resolution for current task only |
| `review` | Full resolution for review criteria + plan; summarize iteration history |
| `verify` | Full resolution for failing tests + current fix attempt; summarize passing runs |

**Effort:** 2 days

### 4.2 — Context Budget Visualization Widget

Richer status widget via `ctx.ui.setWidget()`:

```
┌─ LCM Context Budget ──────────────────────────┐
│ [████████████░░░░░░░░] 62%  (124K / 200K tok) │
│ 8 summaries: d0×5  d1×2  d2×1                 │
│ Fresh tail: 32 msgs  Last compaction: 2 min ago│
│ Cost so far: ~$0.004 (Gemini Flash)            │
└───────────────────────────────────────────────┘
```

**Effort:** 1 day

### 4.3 — Cross-Session Context Sharing

For long-lived projects, carry forward summary DAG state across sessions:

- DAG keyed by project root (git repo root), not session ID
- `session_start` loads prior session's depth-2+ summaries as "project context" nodes
- Project context nodes appear at top of active context as orientation
- Opt-in via config (default: off)

**Effort:** 3 days

### 4.4 — Configuration Command

`/lcm` slash command providing:
- Live config display and editing
- Summary DAG stats (depth distribution, total summaries, coverage)
- Manual compaction trigger
- Cache management (clear large file cache, reset DAG)

**Effort:** 2 days

### 4.5 — Subagent-Based Expansion

If pi's extension API supports spawning subagents: implement `lcm_expand_query` that spawns a subagent to answer questions about expanded content, preventing the parent context from absorbing large expansions.

**Prerequisite:** Verify pi extension API supports `ctx.spawnSubagent()` or equivalent.
**Effort:** 3 days (+ investigation)

### 4.6 — Lazy Backfill for Existing Sessions

Users installing `pi-lcm` on an existing long session need a backfill path:

- `session_start` detects: existing session > freshTailCount turns, no LCM history
- Offers lazy backfill: "Detected 120-turn session with no LCM index. Backfill? (This will cost ~$0.02 in Gemini Flash calls)"
- If accepted: processes session in background, builds full DAG from JSONL

**Effort:** 2 days

---

## Version Summary

| Version | Phase | Key Feature | Estimated Ship |
|---------|-------|-------------|----------------|
| **v0.1** | Phase 1 | Zero-cost context filtering + `lcm_expand` | Week 1 |
| **v0.2** | Phase 2 | LLM summarization + SQLite DAG + `lcm_grep` | Week 2–3 |
| **v0.3** | Phase 3 | Large file interception | Week 3–4 |
| **v1.0** | Phase 3 complete | Full LCM feature parity with Volt/lossless-claw | Week 4 |
| **v1.1** | Phase 4.1 | Megapowers phase-aware strategies | Week 5 |
| **v1.2** | Phase 4.2–4.4 | Widget, cross-session, `/lcm` command | Week 6 |
| **v2.0** | Phase 4.5–4.6 | Subagent expansion + backfill | TBD |

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Summarization latency > 5s on slow connections | Medium | UX friction between turns | Fire async in `agent_end`, not blocking; show "compacting..." in status bar |
| SQLite corruption on crash | Low | Loss of DAG (not session data) | WAL mode; `appendEntry` as recovery record; lazy rebuild path |
| Context event correctness: corrupted message list | Low | Model failures | Strict validation before return; integration tests with known-good sessions |
| Gemini Flash quality on technical summaries | Medium | Missed detail in leaf summaries | Depth-aware prompts calibrated for technical content; Level 2/3 as fallback |
| Pi extension API changes | Low | Compatibility break | Pin to tested pi version; document API surface used |
| `tool_result` event missing for some tools | Unknown | Large file interception gaps | Test all common file-reading tools; document known gaps |

---

## Open Questions (Blocking or Near-Blocking)

1. **Does `agent_end` fire after every model response, including mid-tool-chain responses?** — Affects leaf compaction timing. Test in Phase 1.

2. **What is the `appendEntry` payload size limit?** — Affects how much summary metadata can be stored for crash recovery. Check pi source.

3. **Is `ctx.getContextUsage().contextWindow` available in the `context` event?** — Needed for budget-constrained context trimming. Verify in Phase 1.

4. **Does `session_start` fire on branch navigation?** — Affects cache invalidation for tree-based sessions. Test in Phase 2.
