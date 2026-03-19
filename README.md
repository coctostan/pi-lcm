# pi-lcm

A [pi](https://github.com/mariozechner/pi) extension that implements **Lossless Context Management (LCM)** — keeping long coding sessions coherent without blowing up the context window.

---

## What It Does

Long sessions accumulate context noise: tool results from hours ago, file reads of files that have since changed, completed subtasks. This all inflates the context window while helping the model less and less over time.

`pi-lcm` manages this automatically across three complementary layers:

| Layer | Mechanic | Cost |
|-------|----------|------|
| **Phase 1** — Context filtering | Strips tool results older than `freshTailCount` turns; retrievable via `lcm_expand` | Zero |
| **Phase 2** — LLM summarization | Summarizes older message spans into a hierarchical SQLite DAG using Claude Haiku 4.5; model sees structured summaries instead of placeholders | ~$0.001–0.005/session |
| **Phase 3** — Large file interception | Intercepts oversized `read` results, replaces with structural exploration summary, caches full content for paginated retrieval via `lcm_expand` | Zero |

Sessions shorter than `freshTailCount` turns see **zero behavioral difference** from vanilla pi.

---

## How It Works

```
context event fires
  │
  ├─ below freshTailCount messages?
  │    └─ return unchanged (zero cost)
  │
  └─ above threshold?
       ├─ Phase 2 (DAG available): inject labeled summary memory objects for older spans
       │    └─ summaries created async in agent_end via Claude Haiku 4.5
       │
       └─ Phase 1 (no DAG): strip old tool results (replace with placeholder)
            └─ register lcm_expand tool for retrieval

tool_result event fires
  │
  └─ read tool result exceeds largeFileTokenThreshold?
       ├─ yes: replace with exploration summary, cache to ~/.pi/agent/lcm-files/
       │    └─ lcm_expand("<fileId>") retrieves paginated content
       └─ no: pass through unchanged
```

---

## Install

```bash
pi install git:github.com/coctostan/pi-lcm
```

Then enable in pi settings (`~/.pi/agent/settings.json`):

```json
{
  "packages": ["git:github.com/coctostan/pi-lcm"]
}
```

Restart pi to apply.

> **Requires:** Node.js 22.5+ (uses built-in `node:sqlite`)

---

## Configuration

Config file: `~/.pi/agent/extensions/pi-lcm.config.json`

| Field | Default | Description |
|-------|---------|-------------|
| `freshTailCount` | `32` | Most-recent turns treated as "fresh" — never stripped or summarized |
| `maxExpandTokens` | `4000` | Token budget per `lcm_expand` call |
| `contextThreshold` | `0.75` | Context usage fraction (0–1) at which stripping/summarization activates |
| `largeFileTokenThreshold` | `2000` | Token threshold above which `read` results are intercepted and cached |
| `leafChunkTokens` | `20000` | Max source tokens per leaf summary chunk |
| `leafTargetTokens` | `1200` | Target size for leaf summaries |
| `condensedTargetTokens` | `2000` | Target size for condensed summaries |
| `condensedMinFanout` | `4` | Min summaries per condensed node before triggering condensation |
| `summaryModel` | `anthropic/claude-haiku-4-5` | Model used for summarization (cheap model recommended) |

Example — tighter threshold, smaller expand budget, higher large-file bar:

```json
{
  "contextThreshold": 0.65,
  "maxExpandTokens": 2000,
  "largeFileTokenThreshold": 5000
}
```

---

## Tools

### `lcm_expand(id, offset?)`

Retrieves full content of a stripped tool result, summary node, or cached large file.

- **`id`** — the ID from an LCM placeholder or exploration summary
- **`offset`** *(optional, default `0`)* — token-based offset for paginated large-file retrieval

When called on a cached large file, returns a chunk with pagination metadata:

```json
{
  "id": "abc123",
  "source": "large_file",
  "content": "export function foo() { ... }",
  "hasMore": true,
  "nextOffset": 57,
  "totalTokens": 3200
}
```

Call `lcm_expand(id, nextOffset)` to fetch the next page. When the file has changed since it was cached, the response includes `stale: true` and a note to re-read.

### `lcm_grep(pattern)`

Searches across all messages and summaries in the session using FTS5 full-text search or regex. Use to find when something was mentioned, decided, or modified earlier in the session.

### `lcm_describe(summaryId)`
Inspects a summary node's metadata without fetching full content. Returns the same metadata surfaced in injected summaries: `summaryId`, `depth`, `kind`, `earliestAt`, `latestAt`, `descendantCount`, and `childIds` when available. Use before `lcm_expand` to check relevance.

Injected summary format in context:

```
[LCM Context Summary — this summarizes earlier parts of the conversation]

Summary 1: Earlier turns covered setup, config, and deployment tradeoffs.
summaryId: 123e4567-e89b-12d3-a456-426614174000
depth: 1
kind: condensed
earliestAt: 100
latestAt: 500
descendantCount: 8
childIds: sum_a, sum_b
```

---

## Large File Interception

When the model reads a large file (above `largeFileTokenThreshold` tokens), `pi-lcm` automatically:

1. Replaces the full content with a structural exploration summary (exported names, function signatures, types for TypeScript/JavaScript; file stats + preview for other formats)
2. Caches the full content to `~/.pi/agent/lcm-files/<uuid>.txt`
3. Appends an instruction: `Use lcm_expand("<fileId>") to retrieve content`

**Deduplication:** If the same file is read again with the same `mtime`, the existing cache entry is reused. If the file has changed, the old cache entry is evicted and a fresh one is created.

**Safety guarantee:** If the cache write fails for any reason, the original content is passed through unchanged — the model never loses access to a file.

---

## Status Bar

Hidden when no entries have been stripped or summarized. Appears automatically once LCM activates.

Phase 1 format:
```
🟢 42% | 3 stripped | tail: 32
```

Phase 2 format (DAG active):
```
🟢 45% | 8 summaries (d1) | tail: 32
```

Color thresholds: 🟢 < 60% · 🟡 60–84% · 🔴 ≥ 85%

---

## Architecture

- **SQLite store** uses `node:sqlite` (`DatabaseSync`) — built into Node.js 22.5+, zero native dependencies
- **Summary DAG** with leaf (depth 0) and condensed (depth 1+) nodes
- **Three-level escalation** guarantees convergence: detail-preserving → aggressive → deterministic truncation
- **Depth-aware prompts** for leaf vs. condensed summaries at each depth tier
- **Session crash recovery** via `session_start` reconciliation of SQLite ↔ session JSONL
- **Large file cache** at `~/.pi/agent/lcm-files/` with mtime-based invalidation

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full details.

---

## Development

```bash
# Install dependencies
npm install

# Type-check
npm run build

# Run tests
npm test
```
For interactive regression checks, use the cmux workflow in [`TESTING.md`](./TESTING.md). Include strict-output prompts such as `Reply with exactly one short sentence, nothing else: hello.`, `Output exactly one JSON object, nothing else: {"ok":true}`, and `raw output only` tool passthrough checks as part of the supported surface.

When launching with explicit `--model` (for example `--model anthropic/claude-haiku-4-5`), startup should reflect that active model and should not show unrelated stale `enabledModels` warnings like `No models match pattern ...`.

346 tests, zero dependencies beyond `zod` and the pi peer package.

---

## Current Status

| Phase | Feature | Status |
|-------|---------|--------|
| **v0.1** | Zero-cost context filtering + `lcm_expand` | ✅ Done |
| **v0.2** | LLM summarization + SQLite DAG + `lcm_grep` + `lcm_describe` | ✅ Done |
| **v0.3** | Large file interception + `lcm_expand` pagination | ✅ Done |
| **v1.0** | Full LCM feature parity | Planned |

See [ROADMAP.md](./ROADMAP.md) for the full plan.
