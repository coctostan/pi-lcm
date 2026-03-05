# Real-World Testing Process (cmux + Live pi Session)

This document defines how to run **realistic, human-like** pi-lcm validation against a live pi process.

Unlike pure unit/stress tests, this validates behavior in the real extension lifecycle (`session_start`, `agent_end`, tool calls, status bar, DB persistence).

---

## Goals

Real-world testing should verify:

1. Compaction runs in real turns (not just tests)
2. Condensation can be reached and persisted when eligible
3. Tool chain works end-to-end (`lcm_grep` → `lcm_describe` → `lcm_expand`)
4. Context/status behavior is coherent for actual interactive traffic

---

## When to Run

Run this process after changing any of:
- `src/index.ts` extension lifecycle hooks
- `src/context/*`
- `src/compaction/*`
- `src/store/sqlite-store.ts`
- `src/tools/*`
- configuration defaults in `src/config.ts`

---

## Prerequisites

- Run from a **cmux-capable environment**
- `pi`, `cmux`, and `jq` available
- Project dependencies installed

Quick sanity check:

```bash
npm run build
```

---

## Profiles to Test

Run both profiles for confidence:

1. **Default profile** (no local config override)
2. **Aggressive profile** (for faster compaction/condensation observability)

Aggressive test config:

```json
{
  "freshTailCount": 8,
  "leafChunkTokens": 5000,
  "leafTargetTokens": 600,
  "condensedTargetTokens": 400,
  "condensedMinFanout": 3
}
```

---

## Config Safety (Backup/Restore)

Before default-profile testing, ensure no override config is active.

Backup existing config:

```bash
CONFIG="$HOME/.pi/agent/extensions/pi-lcm.config.json"
BACKUP="/tmp/pi-lcm.config.backup.$(date +%s).json"
[ -f "$CONFIG" ] && mv "$CONFIG" "$BACKUP" && echo "backup=$BACKUP"
```

Restore afterwards:

```bash
[ -f "$BACKUP" ] && mv "$BACKUP" "$CONFIG"
```

---

## Track A — Scripted Interactive cmux Run (Recommended)

Use `scripts/lcm-cmux-real-use.sh`.

### Default profile example

```bash
npm run harness:lcm:cmux -- \
  --session-dir /tmp/pi-lcm-real-default \
  --prompts-file scripts/prompts/lcm-real-use.txt \
  --model anthropic/claude-haiku-4-5
```

### Aggressive profile example

1) Write aggressive config file (`~/.pi/agent/extensions/pi-lcm.config.json`)

2) Run:

```bash
npm run harness:lcm:cmux -- \
  --session-dir /tmp/pi-lcm-real-aggressive \
  --prompts-file scripts/prompts/lcm-real-use.txt \
  --model anthropic/claude-haiku-4-5
```

### What this script does

- launches pi in a cmux split pane with `PI_LCM_DEBUG=1`
- sends prompts one-by-one with delay
- captures screen snapshots per turn
- attempts DB inspection at end via `scripts/inspect-live-db.ts`
- writes artifacts under `/tmp/pi-lcm-cmux/run-<timestamp>/`

---

## Track B — Manual Operator Flow (Good for debugging)

### 1) Open test pi session in split

```bash
cd /Users/maxwellnewman/pi/workspace/pi-lcm
SESSION_DIR=/tmp/pi-lcm-live-$(date +%s)
PI_LCM_DEBUG=1 pi --no-extensions -e ./src/index.ts --session-dir "$SESSION_DIR" --model anthropic/claude-haiku-4-5
```

### 2) Drive 15–30 turns

Use canary markers early and query later:
- "Remember marker LCM-CANARY-ALPHA-001"
- later: `lcm_grep` for `LCM-CANARY`
- then `lcm_describe` / `lcm_expand` on returned summary IDs

### 3) Observe debug signals

Look for:
- `agent_end ingested`
- `leaf_summarize_start` / `leaf_summary_created`
- `condensation_summarize_start` / `condensation_summary_created`
- skip reasons (`contiguous_run_below_min_fanout`, etc.)

### 4) Inspect DB after run

```bash
node --experimental-strip-types scripts/inspect-live-db.ts ~/.pi/agent/lcm/<session-id>.db
```

### 5) Exit session

Send `/exit` and confirm clean shutdown.

---

## Acceptance Checklist

A run is considered successful when all of the following are true:

- [ ] no crashes/stack traces in interactive run
- [ ] compaction runs (`agent_end` compaction logs present)
- [ ] summary count increases over time
- [ ] default profile eventually reaches condensation when eligibility/fanout conditions are met
- [ ] `lcm_grep` returns expected hits for known canaries
- [ ] `lcm_describe` returns valid metadata (`depth`, `kind`, `tokenCount`)
- [ ] `lcm_expand` returns non-empty content
- [ ] DB inspector reports `FTS5 functional: YES` and `SQLite integrity: OK`

---

## Interpreting Common Outcomes

## A) “Condensation not happening yet”
Usually expected under default profile due to:
- large fresh tail (`freshTailCount=32`)
- fanout requirement (`condensedMinFanout=4`)

Check logs for:
- repeated `eligibleEnd: 0`
- repeated `reason: 'contiguous_run_below_min_fanout'`

## B) Guard failures
If you see:
- `leaf_guard_not_smaller_than_input`
- `condensation_guard_not_smaller_than_input`

then summarizer output was not smaller than estimated input. Investigate prompt shape, target tokens, and token estimator assumptions.

## C) Integrity/tool failures
If DB inspector fails integrity or FTS5 checks, treat as blocker and stop release.

---

## Artifact Retention

Keep these artifacts for any failing or suspicious run:

- cmux capture directory: `/tmp/pi-lcm-cmux/run-<timestamp>/`
- session DB: `~/.pi/agent/lcm/<session-id>.db`
- inspector output: `inspect-live-db.txt`
- relevant run command used (exact command line)

---

## Recommended Cadence

- **Per major compaction change:** 1 default + 1 aggressive real-world run
- **Before release:** at least one full scripted cmux run + DB inspector clean
- **After bugfix:** rerun scenario that originally failed (same prompt file + same profile)
