# Stress Testing Process

Repeatable workflow for validating pi-lcm stability and correctness at high volume.

---

## Goals

Stress testing answers:

1. Can ingestion / search / compaction stay stable under high-volume traffic?
2. Do retrieval tools (`lcm_grep`, `lcm_expand`, `lcm_describe`) return correct results under load?
3. Does the SQLite store remain healthy (integrity + FTS5) after heavy writes?
4. Are performance envelopes within expected bounds?

---

## Test Surfaces

### 1) Code-level stress suite — `src/stress.test.ts` (primary)

Scenarios:

| ID | What it tests |
|----|--------------|
| S1 | Long conversation replay, compaction sweep, DAG integrity |
| S2 | High-volume ingestion (1000 messages), FTS5 search correctness |
| S3 | Tool round-trip correctness: `lcm_grep` → `lcm_describe` → `lcm_expand` |
| S4 | Edge cases: empty content, giant tool output, FTS5 hazard chars, persistence, rapid writes |

### 2) Harness-level load runs — `scripts/lcm-harness.sh` (secondary)

Long prompt sequences against a real pi process with an isolated session dir.  
Default mode: `batch` (one pi process for the full run) — best for async compaction observation.

### 3) DB health inspection — `scripts/inspect-live-db.ts` (post-run)

Verifies summary depth distribution, context composition, FTS5 function, and SQLite integrity.

---

## Prerequisites

```bash
# Node 22+, pi CLI installed
npm install
npm run build   # confirm clean compile before running
```

---

## Standard Stress Run

```bash
node --experimental-strip-types --test src/stress.test.ts
```

With log capture:

```bash
node --experimental-strip-types --test src/stress.test.ts \
  | tee /tmp/pi-lcm-stress-$(date +%Y%m%d-%H%M%S).log
```

**Expected outcome:** all tests pass, no assertion failures, no crashes from store or tool paths.

---

## Full Regression Run (recommended before merge/release)

```bash
npm test
```

Runs stress suite + all unit and integration tests together.

---

## Harness Stress Run (long session simulation)

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
- `--mode loop` runs one pi process per prompt (process-restart per turn) — use only for restart-resilience testing.
- Default `batch` mode is correct for async compaction and extension lifecycle testing.
- Set `-t 200+` for a more demanding run.

---

## DB Inspection (required after any harness or live run)

```bash
# specific session
node --experimental-strip-types scripts/inspect-live-db.ts ~/.pi/agent/lcm/<session-id>.db

# scan all session DBs
node --experimental-strip-types scripts/inspect-live-db.ts
```

### Must-pass checks

- `SQLite integrity: OK`
- `FTS5 functional: YES`
- Summary stats plausible (non-zero `tokenCount` on newly created summaries)

---

## What to Review in Output

From `stress.test.ts` report blocks and/or harness debug logs:

- Ingestion throughput and wall-clock timing
- Summary count and max depth achieved
- Tool correctness (grep → describe/expand round-trips)
- Edge-case survivability (empty, giant, special chars, persistence)
- No-op reasons distribution (`context_tokens_not_decreasing`, fanout skip reasons)

---

## Failure Triage

If stress fails, triage in this order:

1. **Build / types**
   ```bash
   npm run build
   ```

2. **Reproduce in isolation**
   ```bash
   node --experimental-strip-types --test src/stress.test.ts
   ```

3. **Find first failing scenario** — read first assertion failure in output (S1/S2/S3/S4).

4. **Check DB health for reproduced run**
   ```bash
   node --experimental-strip-types scripts/inspect-live-db.ts <db-path>
   ```

5. **Enable compaction tracing if compaction-related**
   ```bash
   PI_LCM_DEBUG=1 node --experimental-strip-types --test src/stress.test.ts
   ```
   Then inspect for:
   - `leaf_guard_not_smaller_than_input`
   - `condensation_depth_skip` + reason
   - `condensation_summary_created`

---

## Release Gate

Before release, all of the following must pass:

- [ ] `npm run build` clean
- [ ] `npm test` all green
- [ ] package.json version matches the roadmap milestone being released (current target: `0.3.0`)
- [ ] Direct runtime dependencies are declared in `package.json` (no transitive-only imports such as `@sinclair/typebox`)
- [ ] One harness long-session run (≥100 turns or equivalent prompt file)
- [ ] DB inspector shows `integrity: OK` + `FTS5: YES`

---

## Quick Reference

```bash
# stress suite only
node --experimental-strip-types --test src/stress.test.ts

# full suite
npm test

# harness long run (100 turns)
PI_LCM_DEBUG=1 bash scripts/lcm-harness.sh -s /tmp/pi-lcm-stress -t 100

# inspect DB
node --experimental-strip-types scripts/inspect-live-db.ts ~/.pi/agent/lcm/<session-id>.db
```
