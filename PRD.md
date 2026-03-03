# PRD: pi-lcm

**Version:** 0.1 (pre-implementation)
**Status:** Draft
**Related:** [VISION.md](./VISION.md), [ARCHITECTURE.md](./ARCHITECTURE.md), [ROADMAP.md](./ROADMAP.md)

---

## Problem Statement

Pi sessions accumulate context noise over time. As conversation length grows, the model's effective attention degrades because the full message history competes for a fixed context window. Pi's built-in one-shot compaction is lossy, unstructured, and irreversible. No extension in the pi ecosystem provides automated, lossless, hierarchical context management.

**The user experience cost:** Long sessions (50+ turns) produce measurably worse model outputs — repeated clarification requests, lost multi-step plan state, re-reading files already processed, failure to recall decisions made earlier in the session.

---

## Goals

1. **Eliminate coherence degradation** in sessions of arbitrary length
2. **Provide lossless recall** of any prior context via expand tools
3. **Zero overhead on short sessions** (zero-cost continuity invariant)
4. **Use cheap summarization models** — never bill the conversation model for context maintenance
5. **Be pi-native** — no external infrastructure, no new accounts, uses pi's model registry and API keys

## Non-Goals (v1)

- Cross-session context sharing (same project, different sessions) — Phase 4+
- Subagent-based expansion — only if pi extension API supports spawning subagents (Phase 4)
- Semantic/topic-aware context selection — Phase 4
- Configuration UI (`/lcm` slash command) — Phase 4

---

## User Stories

### Phase 1 (MVP — Context Filtering)

**US-01: Zero overhead below threshold**
> As a user on a short session, I want pi-lcm to have no visible effect on behavior or performance, so I don't pay any cost for a feature I don't need yet.

*Acceptance Criteria:*
- Sessions under `freshTailCount` messages: no filtering, no tool registration overhead, identical token usage
- `context` event returns early without modification when below threshold

**US-02: Automatic tool result stripping**
> As a user in a long session, I want verbose tool outputs from earlier turns to be automatically stripped from the context the model sees, so the model can focus on what's recent and relevant.

*Acceptance Criteria:*
- Tool results older than `freshTailCount` turns are replaced with `[Content available via lcm_expand("entry-id")]`
- Tool call structure (name, parameters) is preserved — only result content is stripped
- User messages and assistant messages are never stripped in Phase 1
- Stripping is applied in the `context` event — pi's session JSONL is never modified

**US-03: Expand stripped content on demand**
> As a user, when the model calls `lcm_expand`, I want to see the original content retrieved and available to the model, so no information is permanently lost.

*Acceptance Criteria:*
- `lcm_expand(entryId)` retrieves the original tool result content from the session
- Token count of returned content is capped at `maxExpandTokens` (default 4000)
- If content exceeds cap, a truncated version is returned with an indication
- Tool is only registered when at least one entry has been stripped

**US-04: Context health status bar**
> As a user, I want a visible indicator of context health in the pi status bar, so I can see when LCM is active and how much compression is in effect.

*Acceptance Criteria:*
- Status bar shows: `🟢/🟡/🔴 {pct}% | {N} stripped | tail: {freshTailCount}`
- Color thresholds: green < 50%, yellow 50–75%, red > 75%
- Status updates after every turn
- Status is absent when LCM is inactive (short sessions)

---

### Phase 2 (LLM Summarization + SQLite DAG)

**US-05: Automatic leaf summarization**
> As a user finishing a long turn, I want pi-lcm to automatically summarize older message spans using a cheap model, so my next turn starts with a leaner and more coherent context.

*Acceptance Criteria:*
- After each turn (`agent_end`), check if raw messages outside the fresh tail exceed `leafChunkTokens` (default 20K)
- If yes, trigger async leaf summarization using the configured cheap model (default: `google/gemini-2.5-flash`)
- Summary is stored in SQLite with: depth=0, kind=leaf, source message IDs, token counts, timestamps
- Summary metadata is persisted via `pi.appendEntry()` for crash recovery
- Active context for the next turn uses the summary node in place of the raw messages

**US-06: Condensed summaries for deep history**
> As a user in a very long session, I want older leaf summaries to be condensed into higher-level summaries, so the model retains structural understanding of work done hours ago without paying the token cost of keeping all leaf summaries.

*Acceptance Criteria:*
- When a depth-N tier has ≥ `condensedMinFanout` (default 4) un-condensed nodes, trigger a condensation pass
- Condensed node covers all child nodes, storing child summary IDs as parent links
- Depth-aware prompts applied: depth-0 = detail-preserving, depth-1 = chronological session summary, depth-2 = arc/outcome focused, depth-3+ = durable context only
- Condensation cascades automatically up the hierarchy

**US-07: Three-level escalation guarantee**
> As a user, I want context management to always converge, so I never hit a situation where the context window overflows and pi panics.

*Acceptance Criteria:*
- Level 1: LLM-generated detail-preserving summary within `leafTargetTokens`
- Level 2: LLM-generated aggressive summary within `leafTargetTokens / 2` if Level 1 is over budget
- Level 3: Deterministic truncation (no LLM call) with `[Truncated for context management]` suffix
- Level 3 is always guaranteed to fit within any token budget
- All three levels are exercised in tests

**US-08: Search summarized history**
> As a user, when the model needs to find something from earlier in the session, I want it to be able to search across all messages and summaries using natural language or regex, so it can locate relevant content without expanding everything.

*Acceptance Criteria:*
- `lcm_grep(pattern)` searches across both raw messages and summary content in SQLite FTS5
- Returns matching excerpts with summary IDs and message IDs
- Results are capped to prevent excessive context consumption
- Regex and full-text search modes supported

**US-09: Summary inspection**
> As a user or developer, I want the model to be able to inspect any summary node's metadata without incurring the cost of full expansion, so it can decide whether to expand before committing the token cost.

*Acceptance Criteria:*
- `lcm_describe(summaryId)` returns: depth, kind, covered time range, descendant count, token count, first 200 chars of content
- Fast: direct SQLite lookup, no LLM calls
- Available whenever any summaries exist

**US-10: Session crash recovery**
> As a user, if I restart pi or the session crashes, I want the LCM state to be recovered from persistent storage, so I don't lose the context management structure built up over a long session.

*Acceptance Criteria:*
- On `session_start`, LCM reads SQLite and pi session JSONL
- Reconciles: any messages in JSONL not in SQLite are ingested
- Any summary metadata in `appendEntry` records is verified against SQLite; divergences are flagged and reconstructed
- "Cold start" path (SQLite deleted): rebuilds from session JSONL without resynthesizing summaries (lazy rebuild)

---

### Phase 3 (Large File Interception)

**US-11: Oversized file read interception**
> As a user reading a large file, I want pi-lcm to intercept the tool result before it enters context and replace it with a structural summary, so a single file read doesn't consume the entire context budget.

*Acceptance Criteria:*
- `tool_result` event intercepts responses where `content[0].text.length` exceeds `largeFileTokenThreshold` (default: ~25K tokens estimated)
- Full content stored in SQLite `large_files` table + filesystem cache
- Tool result replaced with structural exploration summary: top-level declarations, module structure, key exports, size stats
- `lcm_expand(fileId)` retrieves full content with configurable token cap

**US-12: File content retrieval**
> As a user, when the model needs the full content of an intercepted file, I want `lcm_expand` to retrieve it efficiently, so the model can work with the full file without it permanently occupying context.

*Acceptance Criteria:*
- Same `lcm_expand` tool handles both summary nodes and file objects
- File content returned in chunks if > `maxExpandTokens`; pagination via `lcm_expand(fileId, offset=N)`
- Storage path is cache-invalidated when file modification time changes

---

### Phase 4 (Advanced Features)

**US-13: Megapowers phase-aware compaction**
> As a megapowers user, I want pi-lcm to apply different context strategies per workflow phase, so it keeps the most relevant content at full resolution for the current phase.

*Acceptance Criteria:*
- `implement` phase: aggressive compaction of completed task results, full resolution for current task
- `review` phase: full resolution for review criteria + current plan, summarize iteration history
- `brainstorm` phase: attach periodic checkpoints as attention anchors; do not compact active creative thread
- `verify` phase: full resolution for failing tests + current fix, summarize passing test runs

**US-14: Context budget visualization widget**
> As a user, I want a richer context budget widget showing DAG structure, not just raw percentage, so I can understand *how* my context is being managed.

*Acceptance Criteria:*
- Widget shows: token budget bar, summary node count by depth, fresh tail count, last compaction time
- Accessible via `ctx.ui.setWidget()`
- Toggleable (default: collapsed status bar item, expandable on click)

**US-15: Cross-session context sharing**
> As a user working on the same project across multiple sessions, I want summaries from previous sessions to be available for expansion in new sessions, so long-lived project context is never lost.

*Acceptance Criteria:*
- DAG is keyed by project root, not session ID
- `session_start` loads prior session summaries for the same project
- Cross-session summaries are marked differently in context (depth offset by session count)
- User can configure opt-in (default: off in v1, default: on in v2)

---

## Non-Functional Requirements

**NFR-01: Summarization latency**
- Leaf summarization (async, `agent_end`) must complete within 5 seconds for chunks ≤ 20K tokens using Gemini Flash
- Summarization must not block the model's response display — fires after the response is shown

**NFR-02: Zero-cost continuity**
- Sessions below `freshTailCount` messages: `context` event overhead ≤ 1ms
- No SQLite connection opened until first threshold crossing

**NFR-03: Context event correctness**
- The `context` event must never corrupt the message list: role alternation preserved, tool_call/tool_result pairing preserved, no message IDs changed
- Messages returned are always a contiguous prefix of the original list + the fresh tail

**NFR-04: Configurability**
- All thresholds configurable via `pi-lcm.config.ts` or extension config API
- Configuration is hot-reloadable between turns (no restart required)

**NFR-05: Testability**
- All SQLite operations are wrapped in a `Store` interface that can be swapped for an in-memory implementation in tests
- All LLM calls go through an injectable `Summarizer` interface
- Integration tests use real pi session fixtures (not mocks)

**NFR-06: Pi extension compatibility**
- Must use only the stable pi extension API (no internal hooks, no monkey-patching)
- Must not break when installed alongside other extensions
- Package name: `@mariozechner/pi-lcm` (or community namespace if published externally)

---

## Configuration Schema

```typescript
interface LCMConfig {
  // Compaction triggers
  contextThreshold: number;      // 0.75 — fraction of context window triggering reactive compaction
  freshTailCount: number;        // 32 — recent messages always at full resolution
  leafChunkTokens: number;       // 20000 — max source tokens per leaf chunk

  // Summary targets
  leafTargetTokens: number;      // 1200 — target size for leaf summaries
  condensedTargetTokens: number; // 2000 — target size for condensed summaries

  // Expansion limits
  maxExpandTokens: number;       // 4000 — token cap for expansion results

  // Large files
  largeFileTokenThreshold: number; // 25000 — files above this are intercepted

  // Model selection
  summaryModel: string;           // "google/gemini-2.5-flash"

  // Condensation
  incrementalMaxDepth: number;    // -1 = unlimited cascading

  // Fanout thresholds
  leafMinFanout: number;          // 8 — min raw messages per leaf before summarizing
  condensedMinFanout: number;     // 4 — min summaries per condensed node

  // Phase 4
  megapowersAware: boolean;       // false — enable phase-aware strategies
  crossSession: boolean;          // false — enable cross-session context sharing
}
```

---

## Success Metrics

| Metric | Target |
|---|---|
| Coherence in 100-turn sessions | No "I've lost track" responses in user-observed testing |
| Summarization cost per session | < $0.01 using Gemini Flash (100-turn session estimate) |
| Context event overhead (below threshold) | < 1ms p99 |
| Summarization latency (async) | < 5s p95 for 20K token chunks |
| Expand latency | < 100ms (SQLite lookup, no LLM call) |
| Zero-cost invariant | Sessions ≤ 32 turns: 0 SQLite queries |
| Three-level escalation coverage | 100% of test cases converge at Level 3 |
