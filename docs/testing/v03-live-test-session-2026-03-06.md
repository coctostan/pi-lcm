# v0.3 Live Test Session — 2026-03-06

Branch: `docs/condensation-analysis-and-testing-process`
Config: `~/.pi/agent/extensions/pi-lcm.config.json`
Test DBs: `~/.pi/agent/lcm/97ea1185-…` (session 1), `~/.pi/agent/lcm/747f5ffd-…` (session 2)

---

## Setup

- Added `largeFileTokenThreshold: 500` and `summaryModel: "anthropic/claude-haiku-4-5"` to config
- Created `scripts/inspect-live-db.ts` — verifies integrity, schema version, message/summary counts, FTS5, `large_files` table
- Test method: `pi --no-extensions -e ./src/index.ts --print --continue` with 11+ turns per session

---

## Results

### ✅ Working

| Layer | Evidence |
|---|---|
| Extension loads | Schema `v0.3-large-files-1` present on startup |
| Message ingestion | DB row count grows correctly each turn |
| Large file interception | `engine.ts` (2676 tokens > 500 threshold) intercepted, cached to `~/.pi/agent/lcm-files/`, recorded in `large_files` table |
| `lcm_expand` page 1 | Returned real source code content |
| `lcm_expand` page 2 (offset=600) | Returned distinct second page — pagination works |
| `lcm_grep` canary recall | Found user message + assistant ack for `LCM-V3-ALPHA-001` as `kind: "message"` hits |
| Compaction fires | 8 summaries created (6 leaf + 2 condensed), correct DAG linkage written to JSONL |
| `inspect-live-db.ts` | Created and validated against live DBs |

### 🔴 Not Yet Tested

- `lcm_describe` (blocked by Bug 2 — no summary content to describe)
- `lcm_grep` returning `kind: "summary"` hits (blocked by Bug 2)
- Canary recall *through* summaries (blocked by Bug 2)

---

## Bugs Found

### Bug 1 — Missing `summaryModel` in default config ✅ Fixed

**Symptom:** First test session (97ea1185) produced 0 summaries despite compaction firing.
Debug log showed the configured summary model was unavailable in the environment on every turn.

**Root cause:** Default `summaryModel` was set to a model unavailable in the test environment.

**Fix:** Added `"summaryModel": "anthropic/claude-haiku-4-5"` to the extension config file.

---

### Bug 2 — Summary content stored empty 🔴 Open

**Symptom:** Session 2 (747f5ffd) compaction creates the right number of summaries with correct
DAG structure but every row has `content = ''` and `tokenCount = 0`:

```
depth=0  kind=leaf       tokenCount=0  contentLen=0   (×6)
depth=1  kind=condensed  tokenCount=0  contentLen=0   (×2)
```

The JSONL `custom` entries correctly record DAG linkage (`summaryId` → `messageIds`/`childIds`),
so the structure is intact. Only the text content is missing.

**Root cause (hypothesis):** `PiSummarizer.summarize` calls `complete()` from `@mariozechner/pi-ai`
and returns `''` when the response has no text part:

```typescript
const textPart = response.content.find((c: any) => c.type === 'text');
return textPart && 'text' in textPart ? textPart.text : '';
```

The guard `estimateTokens('') = 0 < inputTokens` then passes, so the empty string is stored
without error. The `complete()` call itself does not throw — meaning it returns a response,
just one with no text content. Likely cause: `complete()` behaves differently when invoked from
`agent_end` (outside the main agent loop) vs. from inside a normal turn.

**Not yet confirmed.** Needs a targeted test: log the raw return value of `completeFn` inside
`PiSummarizer.summarize` during `agent_end`.

---

### Bug 3 — Integrity warnings on every post-compaction turn (minor)

**Symptom:**
```
pi-lcm: integrity: context_items position gap: message seq jumped from 17 to 20
```
Logged on every turn after the first compaction, once per summary boundary.

**Root cause:** The integrity checker treats any seq gap as suspicious. After compaction, gaps are
*expected* (summaries replaced message pairs). The checker doesn't distinguish between unexpected
corruption gaps and expected compaction gaps.

**Severity:** Cosmetic / noisy — no functional impact. The checker should be taught that gaps
covered by a summary range are valid.

---

## Environment Notes

- `anthropic/claude-haiku-4-5` is **not** in `settings.json` `enabledModels` — pi accepts it
  via `--model` flag override but it may not be visible in `ctx.modelRegistry` the same way
  as an enabled model. This is worth checking as a contributing factor to Bug 2.
- `scripts/inspect-live-db.ts` timestamps: `conversations.createdAt` and `messages.createdAt`
  are stored in **milliseconds** (`Date.now()`); `schema_version.createdAt` is in **seconds**
  (`strftime('%s','now')`). Inspector handles both.

---

## Next Steps

1. **Diagnose Bug 2** — add temporary logging to `PiSummarizer.summarize` to capture the raw
   `complete()` return value during `agent_end`
2. Fix and rerun compaction with real content
3. Test `lcm_describe` tool
4. Test `lcm_grep` → `lcm_describe` → `lcm_expand` full tool chain
5. Test canary recall through summaries (markers that were in compacted messages)
6. Final DB health snapshot via `inspect-live-db.ts`
