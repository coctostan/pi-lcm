# ARCHITECTURE: pi-lcm

**Version:** 0.3
**Related:** [VISION.md](./VISION.md), [PRD.md](./PRD.md), [ROADMAP.md](./ROADMAP.md)

---

## Overview

`pi-lcm` is a pi extension that implements Lossless Context Management (LCM). It intercepts pi's event stream to maintain a compressed-but-recoverable view of conversation history, ensuring the model always sees a coherent, budget-constrained working set regardless of total session length.

The design is informed by two reference implementations:
- **[Volt](https://github.com/voltropy/volt)** — SQLite DAG, three-level escalation, `lcm_expand`, `llm_map`, `agentic_map`
- **[lossless-claw](https://github.com/Martian-Engineering/lossless-claw)** — LCM as an OpenClaw plugin; depth-aware prompts, subagent-based expansion, large file interception

Both use SQLite for the summary DAG. Pi's extension API is a better host than OpenClaw's plugin system for this purpose.

---

## System Layers

```
┌─────────────────────────────────────────────────────────────────┐
│  Pi (Host)                                                      │
│  Session JSONL (append-only, immutable store)                   │
│  Model registry + API keys                                      │
│  Extension event bus                                            │
└────────────────────────┬────────────────────────────────────────┘
                         │  events: context, session_before_compact,
                         │  tool_result, before_agent_start,
                         │  session_start, agent_end, turn_end
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  pi-lcm Extension                                               │
│                                                                 │
│  ┌─────────────┐  ┌──────────────────┐  ┌───────────────────┐  │
│  │ContextBuilder│  │CompactionEngine  │  │ToolRegistry       │  │
│  │             │  │                  │  │  lcm_expand       │  │
│  │ Reads DAG   │  │ Three-level esc  │  │  lcm_grep         │  │
│  │ Builds      │  │ Depth-aware      │  │  lcm_describe     │  │
│  │ active ctx  │  │ prompts          │  │                   │  │
│  └──────┬──────┘  └────────┬─────────┘  └──────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  LargeFileInterceptor (tool_result hook)                 │   │
│  │  Intercepts read results > largeFileTokenThreshold       │   │
│  │  Cache: ~/.pi/agent/lcm-files/<uuid>.txt                 │   │
│  │  Dedup: path + mtime; lcm_expand pagination via offset   │   │
│  └──────────────────────────────────────────────────────────┘   │
│         │                  │                                    │
│  ┌──────▼──────────────────▼──────────────────────────────────┐ │
│  │  Store (SQLite DAG + in-memory cache)                      │ │
│  │  ~/.pi/agent/lcm.db                                        │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Summarizer (injected LLM client via pi-ai complete())   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## State Model

Four distinct state layers with clearly defined persistence and ownership:

```
┌─────────────────────────────────────────────────────────────────┐
│  Pi Session (JSONL)  ← IMMUTABLE STORE                          │
│    Raw messages, tool results, custom entries (lcm metadata)    │
│    Never modified by LCM. Source of truth for crash recovery.   │
│    Written by: pi + pi.appendEntry()                            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  SQLite DAG  ← SUMMARY INDEX                                    │
│    Hierarchical summaries, parent links, context_items order    │
│    Path: ~/.pi/agent/lcm.db                                     │
│    Written by: CompactionEngine                                 │
│    Reconstructible: yes (expensive — requires LLM calls)        │
│    Lost on: DB deletion (mitigated by appendEntry redundancy)   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  In-Memory Cache  ← EPHEMERAL                                   │
│    Token counts, summary content, threshold state               │
│    Built from SQLite on session_start                           │
│    Lost on: restart (fine — rebuilt cheaply from SQLite)        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Active Context  ← EPHEMERAL (built per-turn)                   │
│    Recent turns at full resolution + summary nodes for older    │
│    Built by ContextBuilder on every context event               │
│    Never persisted. Discarded after each LLM call.              │
└─────────────────────────────────────────────────────────────────┘
```

---

## SQLite Schema

Database: `~/.pi/agent/lcm.db`

```sql
-- One conversation per pi session
CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,  -- pi session ID
  projectRoot TEXT NOT NULL,
  createdAt   INTEGER NOT NULL
);

-- All raw messages ingested from pi session JSONL
CREATE TABLE messages (
  id             TEXT PRIMARY KEY,  -- pi entry ID
  conversationId TEXT NOT NULL REFERENCES conversations(id),
  seq            INTEGER NOT NULL,  -- position in session
  role           TEXT NOT NULL,     -- 'user' | 'assistant' | 'tool_result'
  toolName       TEXT,              -- for tool_result entries
  content        TEXT NOT NULL,     -- full serialized content
  tokenCount     INTEGER NOT NULL,
  createdAt      INTEGER NOT NULL,
  UNIQUE(conversationId, seq)
);

-- Summary nodes (leaf and condensed)
CREATE TABLE summaries (
  summaryId       TEXT PRIMARY KEY,
  conversationId  TEXT NOT NULL REFERENCES conversations(id),
  depth           INTEGER NOT NULL,  -- 0=leaf, 1+=condensed
  kind            TEXT NOT NULL,     -- 'leaf' | 'condensed'
  content         TEXT NOT NULL,     -- summary text
  tokenCount      INTEGER NOT NULL,
  earliestAt      INTEGER NOT NULL,  -- timestamp of earliest covered message
  latestAt        INTEGER NOT NULL,  -- timestamp of latest covered message
  descendantCount INTEGER NOT NULL,  -- total raw messages covered
  createdAt       INTEGER NOT NULL
);

-- Leaf → raw message links
CREATE TABLE summary_messages (
  summaryId TEXT NOT NULL REFERENCES summaries(summaryId),
  messageId TEXT NOT NULL REFERENCES messages(id),
  PRIMARY KEY (summaryId, messageId)
);

-- Condensed → child summary links (DAG edges)
CREATE TABLE summary_parents (
  childSummaryId  TEXT NOT NULL REFERENCES summaries(summaryId),
  parentSummaryId TEXT NOT NULL REFERENCES summaries(summaryId),
  PRIMARY KEY (childSummaryId, parentSummaryId)
);

-- Ordered active context items (what the model sees each turn)
CREATE TABLE context_items (
  conversationId TEXT NOT NULL REFERENCES conversations(id),
  ordinal        INTEGER NOT NULL,
  messageId      TEXT REFERENCES messages(id),
  summaryId      TEXT REFERENCES summaries(summaryId),
  PRIMARY KEY (conversationId, ordinal),
  CHECK ((messageId IS NULL) != (summaryId IS NULL))  -- exactly one set
);

-- Intercepted large file content
CREATE TABLE large_files (
  fileId            TEXT PRIMARY KEY,
  conversationId    TEXT NOT NULL REFERENCES conversations(id),
  path              TEXT NOT NULL,
  explorationSummary TEXT NOT NULL,  -- structural summary shown in context
  tokenCount        INTEGER NOT NULL,
  storagePath       TEXT NOT NULL,   -- path to cached full content
  capturedAt        INTEGER NOT NULL,
  fileMtime         INTEGER NOT NULL  -- used for cache invalidation
);

-- Full-text search across messages and summaries
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');
CREATE VIRTUAL TABLE summaries_fts USING fts5(content, content='summaries', content_rowid='rowid');
```

---

## Event Flow

### `session_start`
```
1. Open SQLite connection
2. Load or create conversation record for current session ID
3. Scan pi session JSONL for messages not yet in SQLite → ingest
4. Verify summary metadata from appendEntry records against SQLite
5. Rebuild in-memory cache (token counts, context_items snapshot)
6. Log: "LCM ready: {N} messages, {M} summaries (max depth {D})"
```

### `context` event (per-turn, critical path)
```
1. Check: message count ≤ freshTailCount? → return messages unchanged (zero cost)
2. Read context_items from SQLite (fast indexed read)
3. For each item in context_items:
   - message item → pass through raw message from event.messages
   - summary item → inject XML summary node:
     <lcm-summary id="{summaryId}" depth="{D}" covers="{N} messages" time="{range}">
       {content}
       Expand for details about: {footer}
     </lcm-summary>
4. Protect fresh tail: always include last freshTailCount raw messages at full resolution
5. Budget-constrain: if total tokens > contextThreshold × contextWindow,
   drop oldest evictable context_items (summaries before raw messages)
6. If summaries are present in output:
   - Append LCM guidance to system prompt (tool usage instructions)
7. Return curated message list
```

### `tool_result` event (Phase 3 — large file interception)
```
1. Check: is this a file-reading tool? (bash cat, read tool, etc.)
2. Estimate tokens in result content
3. If > largeFileTokenThreshold:
   a. Generate structural exploration summary (declarations, exports, size)
   b. Store full content to filesystem cache
   c. Insert into large_files table
   d. Return modified tool result with exploration summary + expand hint
   e. Store full content in result details (not shown in context)
```

### `agent_end` / between-turn hook
```
1. Ingest new messages from this turn into SQLite
2. Update token counts in cache
3. Check: eligible messages outside fresh tail > leafChunkTokens?
   - YES: trigger async leaf compaction pass
     a. Select span: oldest uncompacted messages outside fresh tail
     b. Call Summarizer.summarize(messages, depth=0, target=leafTargetTokens, signal)
     c. Insert summary node + summary_messages links
     d. Update context_items: replace message items with summary item
     e. pi.appendEntry("lcm-store", { type: "summary", summaryId, ... })
     f. Check: eligible for condensation? (≥ condensedMinFanout leaf nodes)
        - YES: trigger condensation pass (depth 0→1, 1→2, etc., cascade)
   - NO: do nothing
4. Update status bar: 🟢/🟡/🔴 {pct}% | {N} summaries (d{D}) | tail: {freshTailCount}
```

### `session_before_compact` (reactive overflow)
```
1. Extract messages to summarize from preparation.messagesToSummarize
2. Call summarizeWithEscalation() — three-level escalation
3. Return custom compaction result with LCM-structured summary
4. Update SQLite to reflect the reactive compaction
```

---

## Compaction Engine

### Three-Level Escalation

```typescript
async function summarizeWithEscalation(
  content: string,
  depth: number,
  targetTokens: number,
  signal: AbortSignal
): Promise<string> {
  const prompts = DEPTH_PROMPTS[Math.min(depth, 3)];

  // Level 1: Detail-preserving summary
  let summary = await callSummarizationModel(prompts.normal, content, targetTokens, signal);
  if (estimateTokens(summary) <= targetTokens) return summary;

  // Level 2: Aggressive compression
  summary = await callSummarizationModel(
    prompts.aggressive,
    content,
    Math.floor(targetTokens / 2),
    signal
  );
  if (estimateTokens(summary) <= targetTokens) return summary;

  // Level 3: Deterministic truncation (no LLM, guaranteed convergence)
  return deterministicTruncate(content, targetTokens) +
    "\n[Truncated for context management — use lcm_expand for full content]";
}
```

### Depth-Aware Prompt Strategies

| Depth | Kind | Prompt Focus |
|-------|------|--------------|
| 0 | Leaf | Narrative with timestamps, file tracking, tool call chains, preserves operational detail. "Write as if the reader will work from this without the original." |
| 1 | Condensed | Chronological session summary. Deduplicates against previous context. What was decided, what was built, what changed. |
| 2 | Condensed | Arc-focused: goals, approaches tried, outcomes, what carries forward. Self-contained — assume no other context. |
| 3+ | Condensed | Durable context only: key architectural decisions, relationship discoveries, lessons learned, open questions. Not a timeline. |

All summaries end with:
```
Expand for details about: {key topics covered, comma-separated}
Use lcm_expand("{summaryId}") to retrieve full content.
```

---

## Tools Registered

### `lcm_expand`
```typescript
pi.registerTool({
  name: "lcm_expand",
  description: `Retrieve full content of a summarized section or intercepted file.
Use when you need the complete detail behind a summary node shown in context.
Returns content up to ${maxExpandTokens} tokens. Use offset parameter for pagination.`,
  parameters: Type.Object({
    id: Type.String({ description: "Summary ID or file ID from the summary shown in context" }),
    offset: Type.Optional(Type.Number({ description: "Token offset for paginated retrieval" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const result = await store.expand(params.id, params.offset, maxExpandTokens);
    return { content: [{ type: "text", text: result }] };
  },
});
```

### `lcm_grep`
```typescript
pi.registerTool({
  name: "lcm_grep",
  description: `Search across all messages and summaries in this session.
Use to find when something was mentioned, decided, or modified earlier.
Supports regex and full-text search.`,
  parameters: Type.Object({
    pattern: Type.String({ description: "Search pattern (regex or plain text)" }),
    mode: Type.Optional(Type.Enum({ fulltext: "fulltext", regex: "regex" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const results = await store.grep(params.pattern, params.mode ?? "fulltext");
    return { content: [{ type: "text", text: formatGrepResults(results) }] };
  },
});
```

### `lcm_describe`
```typescript
pi.registerTool({
  name: "lcm_describe",
  description: `Inspect a summary node's metadata without retrieving full content.
Use before lcm_expand to check if a summary is what you're looking for.`,
  parameters: Type.Object({
    summaryId: Type.String({ description: "Summary ID to inspect" }),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const meta = await store.describeSummary(params.summaryId);
    return { content: [{ type: "text", text: formatSummaryMeta(meta) }] };
  },
});
```

---

## Context Item XML Format

Summary nodes injected into the context event output use a structured XML format the model can parse and reference:

```xml
<lcm-summary
  id="sum_a1b2c3"
  depth="0"
  kind="leaf"
  covers="14 messages"
  time="14:23–14:47"
  tokens="1180">
  
  [summary content...]
  
  Expand for details about: rate limiter implementation, TokenBucket class, Redis integration test failures
  Use lcm_expand("sum_a1b2c3") to retrieve full content.
</lcm-summary>
```

Deeper nodes additionally include child summary IDs:
```xml
<lcm-summary
  id="sum_d4e5f6"
  depth="2"
  kind="condensed"
  covers="87 messages"
  children="sum_a1b2, sum_c3d4, sum_e5f6, sum_g7h8"
  time="13:00–15:30">
  ...
</lcm-summary>
```

---

## Module Structure

```
src/
  index.ts              # Extension entry point — registers events and tools
  config.ts             # Config schema, defaults, loader
  schemas.ts            # Zod schemas for store types
  status.ts             # Status bar formatting
  types.ts              # Re-exports for public API
  store/
    index.ts            # Store barrel export
    types.ts            # Store interface + types
    schema.ts           # SQLite schema (embedded as string)
    sqlite-store.ts     # SQLite implementation via node:sqlite (DatabaseSync)
    memory-store.ts     # In-memory implementation for tests
    store-contract.test-helper.ts  # Shared contract tests for Store implementations
  context/
    content-store.ts    # In-memory content store for Phase 1 stripped entries
    context-builder.ts  # ContextBuilder — assembles active context per turn
    context-handler.ts  # ContextHandler — Phase 1 strip logic
    strip-strategy.ts   # Strip strategy interface + implementation
  compaction/
    engine.ts           # CompactionEngine — leaf + condensation orchestration
    chunk-selector.ts   # Chunk selection logic for leaf + condensation passes
    types.ts            # Compaction types
  summarizer/
    summarizer.ts       # Summarizer interface + PiSummarizer implementation
    prompts.ts          # Depth-aware prompt templates
    format.ts           # Summary formatting utilities
    token-estimator.ts  # Fast token count estimation (char / 3.5 with safety margin)
  ingestion/
    ingest.ts           # Message ingestion from pi session to SQLite
  recovery/
    reconcile.ts        # session_start reconciliation logic
    integrity.ts        # Post-reconciliation integrity checks
  tools/
    expand.ts           # lcm_expand tool
    grep.ts             # lcm_grep tool
    describe.ts         # lcm_describe tool
    truncate.ts         # Token truncation utility
  test-fixtures/
    sessions.ts         # Pi session JSONL test fixtures
tests/
  (test files colocated with source as *.test.ts)
```

---

## Key Design Decisions

### SQLite over alternatives
SQLite is the right choice for the summary DAG because:
- Transactional: no partial writes survive a crash
- Indexed: fast range queries for context_items, parent lookups
- FTS5: built-in full-text search for `lcm_grep`
- Zero infrastructure: single file, works in any environment
- Both reference implementations (Volt, lossless-claw) confirmed this choice

### `node:sqlite` over native bindings
Pi runs on Node.js 22.5+, which includes `node:sqlite` with `DatabaseSync` — a built-in synchronous SQLite binding. This eliminates the need for native dependencies like `better-sqlite3`. Synchronous is appropriate here because:
- `context` event is performance-critical; async overhead adds up
- SQLite operations are fast (microseconds for cached reads)
- Avoids event loop complexity in the tight per-turn loop
- Zero native compilation — no `node-gyp`, works everywhere Node 22.5+ runs

### Session JSONL as ground truth
Pi's session JSONL is append-only and never modified by extensions. `pi-lcm` treats it as the immutable store. SQLite is a derived index over the session, not a replacement. If SQLite is deleted, it can be rebuilt (expensively). If the session is lost, everything is lost — but that's pi's domain, not ours.

### `appendEntry` for summary metadata
Every summary creation writes a `pi.appendEntry()` record with the summary ID and essential metadata. This creates a redundant recovery path: even if SQLite is deleted, the session JSONL contains enough metadata to identify which spans were summarized, enabling lazy reconstruction without full re-summarization.

### No subagent expansion (v1)
lossless-claw uses subagents for `lcm_expand_query` to prevent expansion from consuming the parent context. Pi's extension API support for spawning subagents is unclear. V1 uses direct tool-based expansion with a `maxExpandTokens` cap. Subagent expansion is a Phase 4 investigation if context consumption from expand becomes a problem in practice.

### Token estimation
Exact tokenization requires running the model's tokenizer (expensive). `pi-lcm` uses a character-based approximation (`chars / 3.5` for English text) with a 20% safety margin. This is sufficient for threshold decisions. Actual token counts are tracked after summarization using the LLM's reported usage.

---

## Open Questions

> All questions from the original design have been resolved during implementation. See ROADMAP.md "Open Questions" section for resolution details.
