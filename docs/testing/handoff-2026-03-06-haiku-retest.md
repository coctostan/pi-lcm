# Handoff — Fresh Haiku Retest

Date: 2026-03-06
Branch: `docs/condensation-analysis-and-testing-process`

## What changed just now
- Default `summaryModel` changed to `anthropic/claude-haiku-4-5`
- Removed Gemini references from code/docs/tests
- Added `PI_LCM_DEBUG=1` logging in:
  - `src/debug.ts`
  - `src/index.ts`
  - `src/summarizer/summarizer.ts`
  - `src/compaction/engine.ts`
  - `src/store/sqlite-store.ts`
  - `src/tools/expand.ts`
  - `src/large-files/interceptor.ts`
- `npm run build` passes

## Open bug being investigated
- Issue: `#023 v0.2 summaries are created with empty content and zero tokenCount in live cmux runs`

## Most important finding from logging
In live runs, summaries are already empty **before** SQLite persistence:
- `pi-lcm: debug: summarize response { responseParts: 0, textFound: false, outputChars: 0, outputTokensEstimated: 0 }`
- then store logs show:
  - `contentChars: 0`
  - `persistedContentLen: 0`
  - `persistedTokenCount: 0`

This means the problem is likely in:
- summarizer response shape handling, or
- `complete()` return shape under live runtime,
not just DB write logic.

## Fresh-session retest goal
Re-run v0.2 live cmux tests in a **fresh session** now that the default summarizer model is Haiku.

## Recommended retest command
```bash
PI_LCM_DEBUG=1 pi --no-extensions -e ./src/index.ts --session-dir /tmp/pi-lcm-haiku-retest-$(date +%s) --model anthropic/claude-haiku-4-5
```

## Recommended live test flow
1. Start fresh isolated pi session in cmux
2. Plant canary early:
   - `LCM-CANARY-HAIKU-003`
3. Drive 6–10 turns with real file reads:
   - `ROADMAP.md`
   - `testing.md`
   - `PRD.md`
   - `ARCHITECTURE.md`
4. Watch debug logs for:
   - `session_start ready`
   - `agent_end ingested`
   - `summarize start`
   - `summarize response`
   - `store insertSummary persisted`
   - `agent_end compaction result`
5. Force tool use after compaction:
   - `lcm_grep`
   - `lcm_describe`
   - `lcm_expand`
6. Inspect DB with:
```bash
node --experimental-strip-types scripts/inspect-live-db.ts ~/.pi/agent/lcm/<uuid>.db
```

## What success looks like
- `summarize response` shows:
  - `responseParts > 0`
  - `textFound: true`
  - `outputChars > 0`
- `store insertSummary persisted` shows:
  - `persistedContentLen > 0`
  - `persistedTokenCount > 0`
- `lcm_describe` returns non-zero `tokenCount`
- `lcm_expand(<summary-id>)` returns non-empty DAG content
- `lcm_grep` can find canary in summary-backed retrieval, not only raw messages

## If it still fails
Capture these exact debug lines from the live session:
- `summarize start`
- `summarize response`
- `store insertSummary preparing`
- `store insertSummary persisted`
- `store expandSummary hit`

## Related v0.3 findings from today
- Large-file caching and paginated `lcm_expand` worked
- stale detection worked after file modification
- but live user-facing read output still appeared to show raw/truncated file output despite interception logs
- possible second bug for v0.3 interception/rendering path still open informally

## Useful DBs from today
- `~/.pi/agent/lcm/c7b5860e-8455-4af1-bc13-cdf81aba2e2a.db`
- `~/.pi/agent/lcm/319caff5-6f19-4ccc-8774-1e16fa7c33b7.db`
- `~/.pi/agent/lcm/77917ee3-ed56-4fdb-a733-c6392fa29540.db`
