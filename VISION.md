# VISION: pi-lcm

> *Every pi session — regardless of length — stays coherent, complete, and cost-efficient.*

---

## The Problem

Long coding sessions with pi degrade. Not because the model gets worse, but because the context window fills with noise:

- Verbose bash outputs from explorations two hours ago
- Full file reads whose relevance has long passed
- Completed task chains that now occupy 20K tokens of attention
- Tool result streams that dwarfed the actual insights they contained

The model didn't forget. It was never allowed to forget — every token from the first message competes for the same fixed-size window as the last one. When the window fills, pi's default compaction fires a one-shot summarize-all, discarding structure permanently.

**The model handles context management through improvisation.** It tries to attend to what matters. Sometimes it succeeds. Often, in sessions over ~50 turns, coherence visibly degrades — repeated questions, re-read files, lost thread of multi-step plans.

This is the `GOTO` problem applied to context. Maximally flexible, but unpredictable. The model improvises everything. The engine enforces nothing.

---

## The Insight

Pi's extension API has **every primitive needed** to move context management from model improvisation to engine guarantees. This was the key finding of the 2026-02-28 feasibility analysis:

| LCM Layer | Pi Primitive |
|---|---|
| Immutable store | Session JSONL (append-only) + `appendEntry` |
| Active context assembly | `context` event (deep copy, full control) |
| Compaction trigger + override | `session_before_compact` + `ctx.compact()` |
| Summarization model calls | `complete()` + model registry + API keys |
| Token threshold monitoring | `ctx.getContextUsage()` |
| The expand operation | `pi.registerTool()` → `lcm_expand` |
| Large file interception | `tool_result` event |
| Status visualization | `ctx.ui.setStatus()` |
| Session crash recovery | `session_start` + `appendEntry` |

**Zero gaps.** No upstream pi changes required. The extension API is, in fact, better suited to LCM than OpenClaw's plugin system — because the `context` event gives direct per-turn control over the message list the model sees, which is the exact operation LCM's active context builder needs.

Nobody in the 408-package pi ecosystem has done this yet.

---

## The Solution

**`pi-lcm`** is a pi extension that implements Lossless Context Management (LCM) as described in the academic literature and reference implementations (Volt, lossless-claw), adapted specifically to pi's architecture.

The core thesis: **the context window is a structured artifact, not a scroll.** Recent turns appear at full resolution. Older turns are compressed into summary nodes stored in a SQLite DAG. The model sees a curated working set every turn — never the raw stream of everything that ever happened.

Key properties:

- **Zero-cost continuity** — Below the soft threshold, nothing happens. No overhead on short sessions.
- **Lossless** — Every summarized turn is stored. The model can call `lcm_expand` to retrieve full content of any summary node.
- **Hierarchical** — Summaries of summaries. Leaf nodes (depth 0) preserve operational detail. Condensed nodes (depth 1–3+) compress progressively toward durable decisions and lessons learned.
- **Three-level escalation** — Detail-preserving → aggressive → deterministic truncation. Always converges. Never hangs.
- **Depth-aware prompting** — Different prompt strategies per depth tier. A depth-3 summary doesn't try to preserve tool call order — it captures the decision that matters three months from now.
- **Cheap** — Summarization uses Gemini Flash or Haiku. The conversation model is never billed for context maintenance.

---

## The North Star

A user runs pi on a complex multi-day refactoring. Sessions span 200+ turns. The model is told it changed a function signature in a turn from yesterday's session. It says "let me check" and calls `lcm_expand` on the relevant summary node. Full context restored in one tool call. It correctly identifies every downstream impact.

The user never hits the "sorry, I've lost track of what we were doing" response.

**That's the north star: sessions of arbitrary length with no coherence degradation.**

---

## Design Philosophy

1. **Engine handles boring logistics, model handles hard reasoning.** The model shouldn't spend attention deciding what to remember. It should spend attention on the actual problem.

2. **Structured over improvisational.** A guaranteed-to-converge three-level escalation beats hoping the model summarized well. Deterministic beats clever.

3. **Lossless by default, lossy by choice.** The full session is always recoverable. Summaries are views over stored originals, not replacements.

4. **Zero-cost continuity is non-negotiable.** A 5-turn session should have identical performance to vanilla pi. LCM is invisible below threshold.

5. **Pi-native.** Uses pi's own model registry, API keys, session format, and extension API. No separate infrastructure, no new accounts, no alternative pipelines.

---

## Relationship to Megapowers

LCM manages context within a session (minutes to hours). Megapowers manages context across a project lifecycle (days to months). They're solving the same problem at different timescales.

In V4 (Phase 4), `pi-lcm` will become phase-aware: aggressive compaction on completed tasks in `implement`, full-resolution retention of review criteria in `review`, creative-tangent retention during `brainstorm`. The two systems integrate naturally because they share the same structural intuitions about what context is worth keeping and at what resolution.

---

## Who This Is For

- **Pi power users** running long sessions (50+ turns) on complex tasks
- **Megapowers users** where multi-step plans create long implementation sessions
- **Anyone** who has watched pi lose the thread of a multi-file refactoring and had to re-orient it manually

---

*Reference implementations: [Volt](https://github.com/voltropy/volt) (Martian-Engineering), [lossless-claw](https://github.com/Martian-Engineering/lossless-claw)*
*Theoretical basis: [LCM: What If the Engine Managed Context Instead of the Model?](https://academy.dair.ai/blog/lossless-context-management)*
