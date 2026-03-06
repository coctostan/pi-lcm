# Real-World Testing Process

How to validate pi-lcm in a **live pi session** with realistic interactive traffic.

Unlike unit/stress tests, this validates the full extension lifecycle:
`session_start` → real turns → `agent_end` compaction → tool calls → DB persistence.

---

## When to Run

Run after any change to:

- `src/index.ts` (extension hooks)
- `src/context/*`
- `src/compaction/*`
- `src/store/sqlite-store.ts`
- `src/tools/*`
- Config defaults in `src/config.ts`

---

## Prerequisites

```bash
npm run build   # must be clean before running
pi --version    # pi CLI available
```

For scripted cmux runs: `cmux` must be available and a cmux session must be active.

---

## Test Profiles

Run both profiles for full confidence.

### Profile A — Default (no config override)

Tests real production behaviour. Condensation will take longer to appear.

### Profile B — Aggressive (faster compaction / condensation visibility)

Write to `~/.pi/agent/extensions/pi-lcm.config.json`:

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

## Config Safety: Backup/Restore

Before default-profile testing, confirm no override config is active.

**Backup:**
```bash
CONFIG="$HOME/.pi/agent/extensions/pi-lcm.config.json"
BACKUP="/tmp/pi-lcm.config.backup.$(date +%s).json"
[ -f "$CONFIG" ] && mv "$CONFIG" "$BACKUP" && echo "backed up to $BACKUP"
```

**Restore:**
```bash
[ -f "$BACKUP" ] && mv "$BACKUP" "$CONFIG" && echo "restored"
```

---

## Track A — Scripted cmux Run (recommended)

Uses `scripts/lcm-cmux-real-use.sh` to drive a real pi session automatically.

### Default profile

```bash
bash scripts/lcm-cmux-real-use.sh \
  --session-dir /tmp/pi-lcm-real-default \
  --prompts-file scripts/prompts/lcm-real-use.txt \
  --model anthropic/claude-haiku-4-5
```

### Aggressive profile

1. Write aggressive config (see above)
2. Run:

```bash
bash scripts/lcm-cmux-real-use.sh \
  --session-dir /tmp/pi-lcm-real-aggressive \
  --prompts-file scripts/prompts/lcm-real-use.txt \
  --model anthropic/claude-haiku-4-5
```

### What this does

- Launches pi in a cmux split pane with `PI_LCM_DEBUG=1`
- Sends prompts one-by-one with inter-turn delay
- Captures screen snapshots per turn
- Attempts DB inspection via `scripts/inspect-live-db.ts` at end

---

## Track B — Manual Interactive Run (good for debugging)

### 1) Start a fresh pi session

```bash
cd /Users/maxwellnewman/pi/workspace/pi-lcm

SESSION_DIR=/tmp/pi-lcm-live-$(date +%s)
PI_LCM_DEBUG=1 pi \
  --no-extensions \
  -e ./src/index.ts \
  --session-dir "$SESSION_DIR" \
  --model anthropic/claude-haiku-4-5
```

### 2) Drive 15–30 turns

Plant canary markers early:

```
Remember marker LCM-CANARY-ALPHA-001 and reply with 'acknowledged'.
```

Continue with substantive content turns to generate token mass. Then query:

```
Call lcm_grep with query "LCM-CANARY-ALPHA-001" and return the raw JSON result.
```

Then test expand/describe on returned summary IDs.

### 3) Watch debug output

Key signals to look for:

| Signal | Meaning |
|--------|---------|
| `agent_end ingested` | messages stored successfully |
| `leaf_summarize_start` | compaction attempted |
| `leaf_summary_created` | leaf summary written |
| `condensation_summarize_start` | condensation attempted |
| `condensation_summary_created` | d1 summary written |
| `condensation_depth_skip` | fanout/budget gate |
| `leaf_guard_not_smaller_than_input` | guard rejection |

### 4) Inspect DB after run

```bash
node --experimental-strip-types scripts/inspect-live-db.ts ~/.pi/agent/lcm/<session-id>.db
```

### 5) Exit cleanly

```
/exit
```

---

## Acceptance Checklist

A run passes when all of the following are true:

- [ ] No crashes or stack traces during the session
- [ ] `agent_end` compaction logs appear each turn
- [ ] Summary count increases over time (check DB inspector)
- [ ] Aggressive profile: condensation (`condensation_summary_created`) fires within the run
- [ ] Default profile: condensation fires eventually (may take 20+ turns) or skip reasons are `contiguous_run_below_min_fanout` / `eligibleEnd: 0` (expected, not bugs)
- [ ] `lcm_grep` returns hits for planted canary markers
- [ ] `lcm_describe` returns valid metadata (`depth`, `kind`, `tokenCount`)
- [ ] `lcm_expand` returns non-empty content
- [ ] DB inspector: `FTS5 functional: YES`, `SQLite integrity: OK`

---

## Interpreting Common Outcomes

### "Condensation not happening"

Expected under default profile until:
- `contextItems > freshTailCount` (32 by default — 16+ turns at 2 msgs/turn)
- ≥ `condensedMinFanout` (4) contiguous d0 summaries exist outside fresh tail

Check debug logs for `eligibleEnd: 0` and `contiguous_run_below_min_fanout`. If that's all you see, behaviour is correct.

### Guard failures

If you see `leaf_guard_not_smaller_than_input` or `condensation_guard_not_smaller_than_input`:
- Summarizer output was not smaller than estimated input
- Investigate prompt shape, target token settings, and token estimator assumptions

### Integrity / FTS5 failures

Treat as **release blocker** — do not proceed until resolved.

---

## Artifact Retention

Keep for any failing or suspicious run:

| Artifact | Location |
|----------|---------|
| Session DB | `~/.pi/agent/lcm/<session-id>.db` |
| cmux run directory | `/tmp/pi-lcm-cmux/run-<timestamp>/` |
| Debug log | wherever `--log-file` was pointed |
| Exact command used | document before discarding terminal |

---

## Recommended Cadence

| When | What |
|------|------|
| After any compaction/store change | 1 default + 1 aggressive interactive run |
| Before release | Full scripted cmux run + DB inspector clean |
| After a bugfix | Rerun scenario that originally triggered the bug |
