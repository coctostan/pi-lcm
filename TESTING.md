# pi-lcm Real-World Testing Guide

This document describes how to test pi-lcm in realistic conditions. There are two methods: a **bash harness** for non-interactive batch testing, and **cmux interactive testing** where you (the agent) drive a live pi session through a split pane.

---

## Why Two Methods

You can't debug pi-lcm while running inside pi-lcm if it's broken. Both methods launch a **separate pi process** with the lcm extension loaded:

- **Bash harness** — pipes a list of prompts into a separate pi process. No interactivity. Good for when lcm might be completely broken — if it crashes, your session is fine and you get a log file.
- **cmux interactive** — you create a terminal split pane, launch pi there, and drive it using `cmux_send` / `cmux_read_screen`. You can read what the agent said, react to it, follow up naturally, and exercise tools contextually. Much more realistic.

---

## Method 1: Bash Harness

### Quick start

```bash
# Real-use scenario: 14 prompts, exercises compaction + all 3 DAG tools
npm run harness:lcm:real-use -- \
  -s /tmp/pi-lcm-test-$(date +%s) \
  --pi-arg "--model" --pi-arg "anthropic/claude-haiku-4-5" \
  --quiet

# Quick tool smoke: 6 prompts, forces lcm_grep → lcm_describe → lcm_expand
npm run harness:lcm -- \
  --prompts-file scripts/prompts/lcm-tool-smoke.txt \
  -s /tmp/pi-lcm-smoke-$(date +%s) \
  --pi-arg "--model" --pi-arg "anthropic/claude-haiku-4-5" \
  --quiet
```

### Inspecting results

After a harness run, find the session UUID in the log output and inspect the DB:

```bash
npm run inspect-db -- ~/.pi/agent/lcm/<session-uuid>.db
```

The inspector checks: SQLite integrity, schema version, message/summary counts, depth distribution, context composition, FTS5 functionality, and large file entries.

### Harness options

```
bash scripts/lcm-harness.sh [options]

  -s, --session-dir <path>   Isolated session directory
  -t, --turns <n>            Number of generated turns (default: 50)
  --prompts-file <path>      Use prompts from file (one per line, # = comment)
  --pi-arg <arg>             Extra pi arg (repeatable)
  --mode <batch|loop>        batch = one pi process (default), loop = one per prompt
  --quiet                    Suppress live output
  --resume                   Continue existing session
```

### Prompt fixtures

- `scripts/prompts/lcm-real-use.txt` — 14 prompts: file reads, canary markers, all 3 tools
- `scripts/prompts/lcm-tool-smoke.txt` — 6 prompts: minimal, forces the tool chain

---

## Method 2: cmux Interactive Testing

This is the more powerful method. You use cmux tools to launch a separate pi instance in a **new terminal split pane** and drive it like a real user.

### Critical rule: create a new pane, then use its `surface:*` ID everywhere

For this workflow, the thing you interact with is the **pane surface**, not a workspace.

- ✅ Do: `cmux_split(...)` and use the returned `surface:NN`
- ✅ Do: pass that same `surface:NN` to `cmux_send` and `cmux_read_screen`
- ❌ Do not create a separate workspace just to run this test
- ❌ Do not send commands to your current chat pane
- ❌ Do not use a `workspace:*` ID where a `surface:*` ID is required

### Step 1: Create a split pane

```js
cmux_split({ direction: "right", type: "terminal" })
```

This returns something like:

```txt
OK surface:8 workspace:1
```

**Write down the `surface` value immediately.** In this example, every later cmux call must use `surface:8`.

### Step 2: Launch pi with lcm in that new pane

Use the exact `surface` returned above.

```js
cmux_send({
  surface: "surface:8",
  text: "cd /Users/maxwellnewman/pi/workspace/pi-lcm && PI_LCM_DEBUG=1 pi --no-extensions -e ./src/index.ts --session-dir /tmp/pi-lcm-interactive-$(date +%s) --model anthropic/claude-haiku-4-5"
})
cmux_send({ surface: "surface:8", key: "enter" })
```
The key flags:
- `PI_LCM_DEBUG=1` — enables debug logging (compaction results, ingestion counts)
- `--no-extensions` — don't load any other extensions
- `-e ./src/index.ts` — load pi-lcm specifically
- `--session-dir /tmp/...` — isolate from real sessions
- `--model anthropic/claude-haiku-4-5` — cheap model for testing
### Step 2.5: If `cmux_send` says "Surface is not a terminal"

You are targeting the wrong thing.

Fix it by:
1. creating a fresh pane with `cmux_split({ direction: "right", type: "terminal" })`
2. copying the new `surface:NN`
3. re-running `cmux_send` against that new `surface:NN`

Do **not** try to recover by switching workspaces. Just create a new pane and use its surface ID.

### Step 3: Verify startup
Wait ~5 seconds, then read the pane:

```js
// e.g. use bash sleep if you want a pause between send/read
cmux_read_screen({ surface: "surface:8", lines: 80 })
```

**What to look for:**

```txt
pi-lcm: debug: session_start openConversation { ... dbPath: '.../<uuid>.db' }
pi-lcm: debug: session_start ready { dagReady: true, contextItems: 0, messages: 0 }
```

If you see `dagReady: true` and the pi prompt, you're good.

Also capture the DB path / UUID now. You'll need it later for `inspect-live-db.ts`.

If you see initialization errors, stop and fix those before continuing.

### Step 4: Drive the conversation
Send one prompt at a time:

```js
cmux_send({ surface: "surface:8", text: "your prompt here" })
cmux_send({ surface: "surface:8", key: "enter" })
```

Then wait 10-20 seconds and read the same pane:

```js
cmux_read_screen({ surface: "surface:8", lines: 120 })
```

**Golden rule:** every send/read in this test uses the **same pane surface ID** until you intentionally create a replacement pane.
**What to look for in the debug output after each turn:**
- `agent_end ingested { ingested: N, totalMessages: M }` — messages being tracked
- `summarize start` — summarization path actually running
- `summarize response` — check `stopReason`, `errorMessage`, `responseParts`, `contentTypes`, `outputChars`
- `store insertSummary persisted` — summary actually written with non-zero content/token counts
- `agent_end compaction result { actionTaken: true, summariesCreated: N }` — compaction firing
- Status bar at bottom: `🟢 X% | N summaries (d0/d1/...) | tail: 8`

For issue #023 specifically, success means `summarize response` is **not** an auth/error shape and `store insertSummary persisted` shows non-zero lengths.

### Step 5: Exercise the DAG tools
After enough turns for compaction to create summaries, force explicit tool usage. Cheaper models may ignore vague requests, so use very direct prompts.

Recommended sequence:

```txt
Remember this marker exactly for later retrieval tests: LCM-CANARY-HAIKU-003. Reply with exactly: stored.
Use the read tool on ROADMAP.md and give me the top priorities you see in 5 bullets.
Use the read tool on PRD.md and give me 4 bullets on the product goals and non-goals.
You MUST call the lcm_grep tool now with query 'LCM-CANARY'. Show the raw tool output only.
Call lcm_describe on summary ID <paste-id-here> and show the raw tool output only.
Call lcm_expand on ID <paste-id-here> and show the first 10 lines only.
```

Notes:
- `lcm_grep` may return a message hit before it returns a summary hit; that's still useful signal
- once compaction has persisted summaries, use one of those summary IDs for `lcm_describe` / `lcm_expand`
- the assistant may still add commentary even when told `raw output only`; judge success by whether the tool call happened and the output is valid

### Step 6: Inspect the DB
From your own terminal (not the split pane), run the inspector using the DB path captured at startup:
```bash
node --experimental-strip-types scripts/inspect-live-db.ts ~/.pi/agent/lcm/<uuid>.db
```

For #023-style debugging, verify all of these:
- `integrity_check: ok`
- summaries exist
- summary `tokenCount` values are non-zero
- FTS5 checks pass
- large-file entries exist if you exercised large-file interception

### Step 7: Clean up

```js
cmux_send({ surface: "surface:8", text: "/exit" })
cmux_send({ surface: "surface:8", key: "enter" })
```

If the pane got into a bad state, create a new pane and repeat from Step 1. Do not recycle a broken/non-terminal surface.

---

## Canary Marker Pattern

Plant known strings in early prompts:

```
"Remember this marker exactly: LCM-CANARY-ALPHA-001"
```

Then later use `lcm_grep` to search for `LCM-CANARY`. If the marker appears in summary results, the entire pipeline works: message ingestion → leaf summarization → FTS5 indexing → search retrieval. In our validated test run, the canary was preserved inside a leaf summary and successfully found by grep.

---

## Custom Config for Stress Testing

The default config (`freshTailCount: 32`, `condensedTargetTokens: 2000`) makes condensation very unlikely to fire. To test condensation specifically, install an aggressive config:

```bash
mkdir -p ~/.pi/agent/extensions
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

**Delete this file after testing** — it affects ALL pi-lcm sessions system-wide.

```bash
rm ~/.pi/agent/extensions/pi-lcm.config.json
```

---

## DB Forensics

### Check condensation status across all sessions

```bash
for db in ~/.pi/agent/lcm/*.db; do
  echo "=== $(basename $db) ==="
  node --experimental-strip-types -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('$db');
    try {
      const rows = db.prepare('SELECT depth, kind, COUNT(*) as cnt, AVG(tokenCount) as avgTok FROM summaries GROUP BY depth, kind').all();
      console.log(JSON.stringify(rows));
    } catch(e) { console.log(e.message); }
    db.close();
  " 2>/dev/null
done
```

Look for `depth > 0` entries. If all summaries are `depth: 0, kind: leaf`, condensation hasn't fired.

### Check context item ordering

Summaries should be contiguous at the start, messages at the end:

```bash
DB="$HOME/.pi/agent/lcm/<uuid>.db"
node --experimental-strip-types -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('$DB');
  const items = db.prepare('SELECT ordinal, messageId, summaryId FROM context_items ORDER BY ordinal LIMIT 30').all();
  items.forEach(i => console.log('ord=' + i.ordinal + ' ' + (i.summaryId ? 'SUMMARY' : 'MESSAGE')));
  db.close();
" 2>/dev/null
```

### Simulate condensation eligibility

Check whether a specific DB has enough eligible summaries for condensation and what the token math looks like:

```bash
DB="$HOME/.pi/agent/lcm/<uuid>.db"
node --experimental-strip-types -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('$DB');
  function estimateTokens(t) { return t.length === 0 ? 0 : Math.ceil((t.length / 3.5) * 1.2); }
  const items = db.prepare('SELECT summaryId FROM context_items WHERE summaryId IS NOT NULL ORDER BY ordinal').all();
  const contents = items.map(i => db.prepare('SELECT content, tokenCount FROM summaries WHERE summaryId = ?').get(i.summaryId));
  const input = contents.map(c => c.content).join('\n\n');
  const total = db.prepare('SELECT COUNT(*) as n FROM context_items').get();
  const eligibleEnd = Math.max(0, total.n - 32);
  console.log('Total context items:', total.n);
  console.log('Eligible (outside freshTail=32):', eligibleEnd);
  console.log('Eligible summaries:', Math.min(items.length, eligibleEnd));
  console.log('Input tokens (estimated):', estimateTokens(input));
  console.log('condensedTargetTokens default:', 2000);
  console.log('Guard passes if LLM output <', estimateTokens(input), 'estimated tokens');
  db.close();
" 2>/dev/null
```

---

## Three-Tier Routine

| Tier | When | Time | What |
|------|------|------|------|
| **Quick Smoke** | After any code change | 2 min | `npm test` — 297 unit + stress tests |
| **Interactive** | After integration changes | 5 min | cmux split, 6+ turns, compaction check, tool chain |
| **Deep Stress** | Before releases | 15 min | 20+ turns, aggressive config, condensation, recovery |

### Interactive checklist
- [ ] Compaction fires (`actionTaken: true` in debug output)
- [ ] Summaries accumulate (status bar count increases)
- [ ] `lcm_grep` returns results for planted canary markers
- [ ] `lcm_describe` returns valid metadata (depth, kind, tokenCount > 0)
- [ ] `lcm_expand` returns non-empty content from DAG store (`source: "dag"`)
- [ ] DB inspector: FTS5 functional ✅, integrity OK ✅

### Deep stress additions
- [ ] Push past 50 messages
- [ ] Check for d1+ summaries (condensation) — currently broken with defaults
- [ ] Kill and restart pi — verify reconciliation rebuilds state
- [ ] Verify context_items ordering (summaries contiguous at start)
