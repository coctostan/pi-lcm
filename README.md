# pi-lcm

## What It Does

Long coding sessions accumulate context noise: tool results from hours ago inflate the context window without helping the model. pi-lcm manages this automatically:

- **Phase 1 (active):** Strips tool results older than `freshTailCount` turns and makes them retrievable via `lcm_expand`
- **Phase 2 (implemented, wiring in progress):** Summarizes older message spans into a hierarchical SQLite DAG using a cheap model (Gemini Flash). The model sees structured summaries instead of placeholders. Includes `lcm_grep` for searching history and `lcm_describe` for inspecting summary nodes.

Sessions shorter than `freshTailCount` turns see zero behavioral difference from vanilla pi.

---

## How It Works

```
context event fires
  │
  ├─ below freshTailCount messages?
  │    └─ return unchanged (zero cost)
  │
  └─ above threshold?
       ├─ Phase 2 (DAG available): inject XML summary nodes for older spans
       │    └─ summaries created async in agent_end via Gemini Flash
       │
       └─ Phase 1 (no DAG): strip old tool results (replace with placeholder)
            └─ register lcm_expand tool for retrieval
```

---

## Install

```bash
pi install git:github.com/your-org/pi-lcm
```

Then enable the extension in pi settings (`~/.pi/agent/settings.json`):

```json
{
  "packages": ["git:github.com/your-org/pi-lcm"]
}
```

Restart pi to apply.

---

## Configuration

| Field | Default | Description |
|---|---|---|
| `freshTailCount` | `32` | Number of most-recent turns treated as "fresh" — never stripped or summarized |
| `maxExpandTokens` | `4000` | Token budget returned by a single `lcm_expand` call |
| `contextThreshold` | `0.75` | Context usage fraction (0–1) at which stripping/summarization activates |
| `leafChunkTokens` | `20000` | Max source tokens per leaf summary chunk |
| `leafTargetTokens` | `1200` | Target size for leaf summaries |
| `condensedTargetTokens` | `2000` | Target size for condensed summaries |
| `condensedMinFanout` | `4` | Min summaries per condensed node before triggering condensation |
| `summaryModel` | `google/gemini-2.5-flash` | Model used for summarization (cheap model recommended) |

Config file path: `~/.pi/agent/extensions/pi-lcm.config.json`

Example — tighten the threshold and reduce expand budget:

```json
{
  "contextThreshold": 0.65,
  "maxExpandTokens": 2000
}
```

---

## Condensation Timing

With default settings, compaction activates gradually as your session grows:

**Leaf summaries** begin once messages exist beyond the `freshTailCount` boundary. With the default `freshTailCount=32`, leaf summaries start being created around turn ~33. Each leaf summary covers up to `leafChunkTokens` (default 20,000) tokens of raw messages.

**Condensation** (merging leaf summaries into higher-depth nodes) requires at least `condensedMinFanout` (default 4) leaf summaries to accumulate outside the fresh tail. This typically means **many turns** before condensation is visible — the exact number depends on the token density of your messages (tool results with large file reads accumulate faster than short conversational turns).

**Why this matters:** In sessions under ~50 turns, you'll see leaf summaries but no condensation. This is expected behavior, not a bug. The system is conservative by design — condensation only triggers when there's enough summarized material to meaningfully compress.

### Tuning for earlier activation

| Change | Effect |
|--------|--------|
| Lower `freshTailCount` (e.g., 16) | Leaf summaries start sooner; more messages eligible for summarization |
| Lower `condensedMinFanout` (e.g., 2) | Condensation triggers with fewer leaf summaries |
| Lower `leafChunkTokens` (e.g., 10000) | More leaf summaries created per span of messages, reaching condensation threshold faster |

**Caution:** Lowering `freshTailCount` below ~16 may strip context the model still needs for the current task. Test with your typical session patterns before committing to aggressive settings.

## Debug Harness (isolated target sessions)

When pi-lcm is disabled in your normal settings (controller session), you can still run reproducible test sessions that load only pi-lcm:

```bash
bash scripts/lcm-harness.sh -s /tmp/pi-lcm-test-1 -t 50
```

The harness launches `pi` with `--no-extensions -e src/index.ts --session-dir <dir>` so it doesn't depend on your global extension state. It also writes a timestamped log file into the session directory.
By default it runs in **batch mode** (one `pi` process with many prompts), which is better for debugging async compaction behavior. Use `--mode loop` to run one process per turn when you specifically want cold-start/restart behavior.
Use `--resume` to keep testing an existing session without creating a new initial turn.

If you also want `pi-cmux` tools available in the target session, add `--with-cmux`:

```bash
npm run harness:lcm:with-cmux -- \
  --prompts-file scripts/prompts/cmux-tool-check.txt
```

Quick validation command (JSON mode, confirms `cmux_workspace` can be called):

```bash
npm run harness:lcm:cmux-tool-check
```

For more realistic scripted traffic, use a prompt file:

```bash
npm run harness:lcm:real-use -- \
  -s /tmp/pi-lcm-real-use \
  --pi-arg "--model" --pi-arg "anthropic/claude-haiku-4-5"
```

To run the same real-use sequence with both `pi-lcm` and `pi-cmux` loaded in the target session:

```bash
npm run harness:lcm:real-use:with-cmux
```

For human-like interactive testing inside **cmux**, use:

```bash
npm run harness:lcm:cmux
```

This launches `pi` in a cmux split, sends prompts from `scripts/prompts/lcm-real-use.txt`, captures screen snapshots, and runs `scripts/inspect-live-db.ts` at the end.
By default, `scripts/lcm-cmux-real-use.sh` now loads both `pi-lcm` and `pi-cmux` extensions in the launched target `pi` process. Use `--without-cmux` if you need an lcm-only run.

## Tools

### `lcm_expand(id)`

Retrieves the full content of a stripped tool result or summary node. When content is summarized, the model sees a placeholder or XML summary node with an ID. Call `lcm_expand` to fetch the original content, up to `maxExpandTokens` tokens.

### `lcm_grep(pattern)` *(Phase 2)*

Searches across all messages and summaries in the session using FTS5 full-text search or regex. Use to find when something was mentioned, decided, or modified earlier.

### `lcm_describe(summaryId)` *(Phase 2)*

Inspects a summary node's metadata (depth, kind, time range, message count, token count) without retrieving full content. Use before `lcm_expand` to check relevance.

---

## Status Bar

The status bar is **hidden when no entries have been stripped or summarized**.

Phase 1 format (no DAG):
```
🟢 42% | 3 stripped | tail: 32
```

Phase 2 format (DAG active):
```
🟢 45% | 8 summaries (d1) | tail: 32
```

Color thresholds:
- 🟢 below 50%
- 🟡 50–80%
- 🔴 above 80%

---

## Architecture

- **SQLite store** uses `node:sqlite` (`DatabaseSync`) — built into Node.js 22.5+, no native dependencies
- **Summary DAG** with leaf (depth 0) and condensed (depth 1+) nodes
- **Three-level escalation** guarantees convergence: detail-preserving → aggressive → deterministic truncation
- **Depth-aware prompts** for leaf vs. condensed summaries at each depth tier
- **Session crash recovery** via `session_start` reconciliation of SQLite ↔ session JSONL

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full details.

---

## Current Status

- **Phase 1:** ✅ Complete — zero-cost context filtering
- **Phase 2:** ✅ Implemented and tested (297 tests) — not yet wired for production use (see [#011](https://github.com/your-org/pi-lcm/issues/11))
- **Phase 3:** Planned — large file interception

See [ROADMAP.md](./ROADMAP.md) for the full plan.
