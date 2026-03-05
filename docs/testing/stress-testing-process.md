# Stress Testing Process

This document defines the repeatable **stress testing workflow** for pi-lcm.

---

## Goals

Stress testing should answer:

1. Can ingestion/search/compaction remain stable at high volume?
2. Do retrieval tools (`lcm_grep`, `lcm_expand`, `lcm_describe`) remain correct under load?
3. Does the SQLite store remain healthy (integrity + FTS5) after stress traffic?
4. Are performance envelopes still within expected bounds?

---

## Test Surfaces

## 1) Code-level stress suite (primary)

File: `src/stress.test.ts`

Scenarios:
- **S1** long conversation replay + compaction/DAG integrity
- **S2** high-volume ingestion (1000 messages) + FTS5 correctness
- **S3** tool round-trip + prior bug regressions (#012–#015)
- **S4** edge cases (empty content, giant tool output, FTS5 hazard chars, persistence, rapid writes)

## 2) Harness-level load runs (secondary)

File: `scripts/lcm-harness.sh`

Used for long prompt sequences against a real pi process with isolated session dir.

## 3) DB health inspection (post-run)

File: `scripts/inspect-live-db.ts`

Used to verify summary depth distribution, context composition, FTS5 function, and SQLite integrity.

---

## Prerequisites

- Node.js 22+
- `pi` CLI installed
- Dependencies installed:

```bash
npm install
```

Recommended pre-check:

```bash
npm run build
```

---

## Standard Stress Run (Required)

Run the dedicated stress suite:

```bash
node --experimental-strip-types --test src/stress.test.ts
```

Optional: capture a log artifact

```bash
node --experimental-strip-types --test src/stress.test.ts | tee /tmp/pi-lcm-stress-$(date +%Y%m%d-%H%M%S).log
```

### Expected outcome
- all stress tests pass
- no assertion failures
- no crashes/exceptions from store/tool paths

---

## Full Regression Run (Recommended)

```bash
npm test
```

Use before merge/release to ensure stress + unit/integration suites are all green together.

---

## Harness Stress Run (Long Session Simulation)

Use harness for larger end-to-end traffic patterns:

```bash
PI_LCM_DEBUG=1 bash scripts/lcm-harness.sh \
  -s /tmp/pi-lcm-stress-session \
  -t 120 \
  --start "begin stress run" \
  --turn-prefix "stress turn" \
  --pi-arg "--model" \
  --pi-arg "anthropic/claude-haiku-4-5"
```

Notes:
- Default mode is `batch` (single pi process), best for async compaction behavior.
- Use `--mode loop` only if you specifically want process-restart behavior each turn.

---

## Post-Run DB Inspection (Required for Harness/Live Runs)

Inspect target DB directly:

```bash
node --experimental-strip-types scripts/inspect-live-db.ts <db-path>
```

Or scan all DBs:

```bash
node --experimental-strip-types scripts/inspect-live-db.ts
```

### Must-pass checks
- `SQLite integrity: OK`
- `FTS5 functional: YES`
- no obviously broken summary stats (e.g., zero tokenCount across newly created summaries)

---

## What to Review in Stress Output

From `src/stress.test.ts` reports and/or harness logs:

- ingestion throughput and wall-clock timing
- number of created summaries and max depth
- tool correctness (grep → describe/expand round-trips)
- edge-case survivability (empty, giant, special chars, persistence)
- no-op reasons distribution (`context_tokens_not_decreasing`, fanout skip reasons, etc.)

---

## Failure Triage Playbook

If stress fails, triage in this order:

1. **Build/type sanity**
   ```bash
   npm run build
   ```

2. **Stress-only repro**
   ```bash
   node --experimental-strip-types --test src/stress.test.ts
   ```

3. **Find first failing scenario**
   - isolate S1/S2/S3/S4 by reading first assertion failure in output

4. **Check DB health for reproduced run**
   ```bash
   node --experimental-strip-types scripts/inspect-live-db.ts <db-path>
   ```

5. **Check compaction traces when needed**
   - rerun with `PI_LCM_DEBUG=1`
   - inspect for `leaf_guard_not_smaller_than_input`, `condensation_depth_skip`, `condensation_summary_created`

---

## Release Gate (Suggested)

Before release, require:

- ✅ `npm run build`
- ✅ `npm test`
- ✅ one harness long-session run (>= 100 turns or equivalent prompt-file run)
- ✅ DB inspector shows integrity/FTS5 OK

---

## Useful Commands (Quick Copy)

```bash
# stress suite only
node --experimental-strip-types --test src/stress.test.ts

# full suite
npm test

# long harness run
PI_LCM_DEBUG=1 bash scripts/lcm-harness.sh -s /tmp/pi-lcm-stress -t 120

# inspect specific DB
node --experimental-strip-types scripts/inspect-live-db.ts ~/.pi/agent/lcm/<session-id>.db
```
