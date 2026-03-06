# pi-lcm Handoff

_Updated: 2026-03-06_

## What This Project Is

pi-lcm is a pi extension that manages context window noise in long coding sessions. It strips, summarizes, and indexes older conversation content so the model's context stays clean while all detail remains retrievable via tools.

**Implemented phases:**
- **Phase 1 (✅ working):** Strips tool results older than `freshTailCount` turns, stores them, retrieves via `lcm_expand`
- **Phase 2 (🟡 under live-debug):** Hierarchical SQLite DAG of summaries using a cheap model. Provides `lcm_grep`, `lcm_describe`, `lcm_expand`
- **Phase 3 (✅ backend mostly working):** Large-file interception, file cache, paginated `lcm_expand`

**Tech:** Node.js + TypeScript, built-in `node:sqlite`, pi extension API, `pi-ai` for summarization.

**Testing:** See [TESTING.md](./TESTING.md) and `docs/testing/handoff-2026-03-06-haiku-retest.md`.

---

## Most Important New Finding

Issue `#023` was traced to **authentication**, not SQLite and not the Haiku model name.

### Root cause
`PiSummarizer` was calling `pi-ai complete()` with:
- `maxTokens`
- `signal`

but **without** an `apiKey` / OAuth token.

That meant the extension-side summarizer was relying only on environment variables, while the real pi session was authenticated via pi's `AuthStorage` / `ModelRegistry` OAuth flow.

So the main chat model worked, but the summarizer helper failed auth.

### Exact live failure shape captured
In a fresh live cmux session, `complete()` returned an error-shaped assistant message:

```txt
stopReason: 'error'
errorMessage: 'Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted'
responseParts: 0
contentTypes: []
```

The old code then treated that as an empty summary and persisted it.

---

## Code Change Made Today

### Fix implemented
`PiSummarizer` now resolves auth from pi's model registry and passes it to `complete()`.

Changed files:
- `src/summarizer/summarizer.ts`
- `src/summarizer/summarizer.test.ts`
- `src/index.production-wiring.test.ts`

### What changed in behavior
Before:
- used `ctx.modelRegistry.find(...)`
- did **not** use `ctx.modelRegistry.getApiKey(...)`
- `complete()` got no auth token in live OAuth setups

Now:
- still resolves model via `find(...)`
- also resolves auth via `getApiKey(model)`
- passes that token as `options.apiKey` to `complete()`

### Validation
- `npm test` ✅
- `npm run build` ✅

---

## Current Debug Instrumentation

Temporary extra logging is still present in `src/summarizer/summarizer.ts` for live verification.

`summarize response` currently logs:
- `stopReason`
- `errorMessage`
- `usage`
- `responseParts`
- `contentTypes`
- `outputChars`
- `outputTokensEstimated`

Keep this for the next live retest. Remove it after confirming the fix.

---

## What Happened in the Last Live Retest

Fresh live session confirmed:
- summarizer model was `anthropic/claude-haiku-4-5`
- large-file interception worked
- compaction fired
- condensation path was reachable
- but summaries were empty because auth failed before text was produced

Relevant DBs:
- failing pre-fix session: `~/.pi/agent/lcm/b5a99f69-5bba-4861-9bae-36f6eae149cf.db`
- traced auth-failure session: `~/.pi/agent/lcm/63771fe7-301a-472b-9396-3ab31751a3a1.db`

---

## Recommended Next Step: Fresh Live OAuth Retest

Run a brand-new session:

```bash
PI_LCM_DEBUG=1 pi --no-extensions -e ./src/index.ts --session-dir /tmp/pi-lcm-haiku-retest-$(date +%s) --model anthropic/claude-haiku-4-5
```

Suggested flow:
1. Plant canary early:
   - `LCM-CANARY-HAIKU-003`
2. Read enough real files to trigger compaction:
   - `ROADMAP.md`
   - `PRD.md`
   - `TESTING.md`
   - `ARCHITECTURE.md`
   - `HANDOFF.md`
3. Watch for these logs:
   - `session_start ready`
   - `agent_end ingested`
   - `summarize start`
   - `summarize response`
   - `store insertSummary persisted`
   - `agent_end compaction result`
4. Then force tool use:
   - `lcm_grep`
   - `lcm_describe`
   - `lcm_expand`
5. Inspect the DB:

```bash
node --experimental-strip-types scripts/inspect-live-db.ts ~/.pi/agent/lcm/<uuid>.db
```

---

## Success Criteria for the Next Session

We should now see:
- `summarize response.stopReason` **not** equal to `error`
- `responseParts > 0`
- `contentTypes` includes `text`
- `outputChars > 0`
- `store insertSummary persisted.persistedContentLen > 0`
- `persistedTokenCount > 0`
- `lcm_describe` shows non-zero `tokenCount`
- `lcm_expand(<summary-id>)` returns non-empty summary content
- `lcm_grep` can find the canary from summary-backed retrieval

---

## Remaining Caveats / Likely Follow-ups

### 1. Empty-summary persistence should still be hardened
Even with auth fixed, the code should probably refuse to persist summaries when:
- `stopReason === 'error'`, or
- no text part exists

That is a separate robustness fix and may still be worth doing.

### 2. Condensation behavior still needs a real retest
Now that auth should work, re-check whether condensation still has a real logic/guard problem, or whether the earlier evidence was contaminated by empty leaf summaries.

### 3. v0.3 UI/rendering caveat still open
Large-file interception backend worked in prior testing, but the user-facing read output may still have a separate interception/rendering issue.

## What We Verified After the Auth Fix

### Fresh live OAuth retest succeeded
A fresh cmux retest after the auth propagation fix confirmed that issue `#023` is resolved in live use.

Observed in a real session:
- `summarize response.stopReason: 'stop'`
- `errorMessage: undefined`
- `responseParts: 1`
- `contentTypes: ['text']`
- non-zero `outputChars`
- `store insertSummary persisted.persistedTokenCount > 0`
- `store insertSummary persisted.persistedContentLen > 0`
- `lcm_describe` worked on a real persisted summary ID
- `lcm_expand` returned non-empty DAG-backed content
- DB inspector reported healthy SQLite / FTS5 / large-file state

Relevant successful live DBs:
- OAuth fix retest with working summaries: `~/.pi/agent/lcm/b6eb2e2e-b93f-41a0-9a95-9fba548427b0.db`
- second successful cmux DAG-tool retest: `~/.pi/agent/lcm/05794d58-ca2e-4af3-9fac-8d9e1d23a3cd.db`

### Harness follow-up: backend looked healthy, prompt fidelity was weaker
A real-use harness run created a healthy DB and exercised the backend deeply, but the model's one-shot prompt following was weaker than interactive cmux.

Harness DB:
- `~/.pi/agent/lcm/693e8400-3eac-43c3-9b33-1c2e67b5df77.db`

What the harness confirmed:
- SQLite integrity ✅
- summaries persisted with non-zero content/token counts ✅
- condensation reached depth 2 ✅
- large-file entries created ✅
- canary text (`LCM-CANARY-ALPHA-001`) was preserved inside leaf and condensed summaries ✅

What the harness did **not** prove cleanly:
- reliable live tool-following for `lcm_grep` / `lcm_describe` / `lcm_expand` inside a single giant one-shot prompt

Interpretation:
- backend behavior looked good
- batch prompt fidelity was the weak link, not storage/summarization correctness

### Dedicated v0.3 live test: large-file interception and retrieval worked
A separate cmux session was used specifically to test the v0.3 large-file path.

Relevant v0.3 DB:
- `~/.pi/agent/lcm/f0ed7eb7-7448-4689-b1c3-c45914f08734.db`

Observed in live use:
- reading `TESTING.md` triggered `large file inspect`
- interception fired with:
  - `path: 'TESTING.md'`
  - `estimatedTokens: 3622`
  - `threshold: 500`
  - `fileId: '3c2e405f-d5ea-4f16-904a-2a3309b38c63'`
- user-facing tool output was replaced with the compact/truncated large-file view plus an `lcm_expand(...)` hint
- DB inspector showed the file cached in `large_files`
- `lcm_expand(fileId)` returned the stored file content successfully
- `lcm_expand(fileId, offset=1500)` appeared to return content from the middle of the file, so pagination/offset behavior looks functionally correct

Interpretation:
- v0.3 backend path is working
- user-facing interception/rendering worked in this run
- pagination appears to work, though we did not capture a perfectly clean debug line proving the offset value on-screen

### Practical assessment
With issue `#024` hardening done, this looks usable for real dogfooding and likely usable as a genuinely helpful tool in day-to-day sessions.

Current confidence level:
- **Usable now for personal / experimental use:** yes
- **Usable with much better confidence after #024:** yes
- remaining concerns are mostly robustness/polish, not core architecture failure
---

## Key Files

```text
src/index.ts                      — extension entry point
src/config.ts                     — DEFAULT_CONFIG, loadConfig
src/compaction/engine.ts          — runCompaction (leaf + condensation loops)
src/context/context-builder.ts    — buildContext
src/store/sqlite-store.ts         — SQLite DAG store + FTS5 + large file metadata
src/summarizer/summarizer.ts      — PiSummarizer + auth fix + debug logging
scripts/inspect-live-db.ts        — DB health inspector
TESTING.md                        — real-world test workflow
```

---

## Config Reference

| Setting | Default | Purpose |
|---------|---------|---------|
| freshTailCount | 32 | Messages kept at full resolution |
| contextThreshold | 0.75 | Context % triggering compaction |
| leafChunkTokens | 20000 | Max tokens per leaf chunk |
| leafTargetTokens | 1200 | Target tokens for leaf summaries |
| condensedTargetTokens | 2000 | Target tokens for condensed summaries |
| condensedMinFanout | 4 | Min children before condensation |
| incrementalMaxDepth | -1 | Max DAG depth (-1 = unlimited) |
| summaryModel | anthropic/claude-haiku-4-5 | Model for summarization |
| maxExpandTokens | 4000 | Token budget per lcm_expand call |

Config path: `~/.pi/agent/extensions/pi-lcm.config.json`
