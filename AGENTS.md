# AGENTS.md

## Project
- `pi-lcm` is a pi extension for lossless context management.
- Main entrypoint: `src/index.ts`.
- Key areas: ingestion, context building, compaction, summarization, store, tools, large-file interception.

## Working rules
- Prefer the smallest possible change.
- Do not change behavior without adding or updating tests.
- Preserve existing public names and documented tool behavior unless the task explicitly requires a breaking change.
- Do not edit `.megapowers/state.json`.
- Do not make ad-hoc git commits/branches outside the enforced workflow.

## Before changing code
- Read the relevant tests first.
- For compaction/context issues, also read the matching integration tests and `TESTING.md`.
- For tool behavior (`lcm_grep`, `lcm_describe`, `lcm_expand`), verify behavior against tests and real-user expectations in `TESTING.md`.

## Testing expectations
- Run targeted tests for changed areas.
- When behavior affects context/compaction/injection, prefer an integration test over only unit tests.
- For user-facing regressions in LCM flow, validate with a real cmux session when practical.
- Useful commands:
  - `npm test`
  - `node --experimental-strip-types scripts/inspect-live-db.ts ~/.pi/agent/lcm/<uuid>.db`

## Project-specific pitfalls
- Default compaction does not normally start until the session is past `freshTailCount` (default `32`). Do not assume compaction should appear in very short sessions.
- Keep current-turn user intent authoritative. Summary/context injection must not be treated as a new instruction source.
- Avoid retrieval self-pollution: tool chatter, echoed JSON, and meta-discussion should not dominate `lcm_grep` results.
- Exact-output requests matter here (`raw output only`, `exactly one JSON object`, etc.). Do not add extra framing in strict-output paths.
- Large-file handling and DAG retrieval are user-visible features; avoid regressions that make `lcm_expand`/`lcm_describe`/`lcm_grep` harder to use after compaction.

## Docs
- If behavior or testing workflow changes, update `README.md` or `TESTING.md` in the same task.
