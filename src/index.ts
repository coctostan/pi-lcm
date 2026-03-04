import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config.ts";
import type { LCMConfig } from "./config.ts";
import { MemoryContentStore } from "./context/content-store.ts";
import { ContextHandler } from "./context/context-handler.ts";
import { StripStrategy } from "./context/strip-strategy.ts";
import { registerExpandTool } from "./tools/expand.ts";
import { formatStatusBar } from "./status.ts";
import { ingestNewMessages } from "./ingestion/ingest.ts";
import type { Store } from "./store/types.ts";
import { runCompaction } from './compaction/engine.ts';
import type { Summarizer } from './summarizer/summarizer.ts';

/**
 * pi-lcm extension entry point.
 * Registers the context handler and lcm_expand tool with a shared ContentStore (AC 15).
 */

/** Internal options for testing — not part of the public API. */
export interface InternalOptions {
	dagStore?: Store;
	summarizer?: Summarizer;
	runCompactionFn?: typeof runCompaction;
}
export default function (pi: ExtensionAPI, config?: LCMConfig, _internal?: InternalOptions): void {
	const resolvedConfig = config ?? loadConfig();
	const store = new MemoryContentStore();

	// DAG store for Phase 2 message ingestion (set in session_start or injected for tests)
	let dagStore: Store | null = _internal?.dagStore ?? null;
	const summarizer = _internal?.summarizer ?? null;
	const runCompactionFn = _internal?.runCompactionFn ?? runCompaction;

	// Wire ContextHandler with the shared store (AC 15)
	const strategy = new StripStrategy();
	const handler = new ContextHandler(strategy, store, {
		freshTailCount: resolvedConfig.freshTailCount,
	});

	// Register the lcm_expand tool with the SAME store (AC 15)
	registerExpandTool(pi, store, { maxExpandTokens: resolvedConfig.maxExpandTokens });

	pi.on("context", async (event, ctx) => {
		const result = handler.process(event.messages);
		event.messages = result.messages;
		// AC 11 + AC 12
		const text = formatStatusBar(result.stats, ctx.getContextUsage(), resolvedConfig.freshTailCount);
		ctx.ui.setStatus("lcm", text);
	});

	// Milestone 2.x: will initialize SQLite store and reconcile session JSONL
	pi.on("session_start", async (_event, _ctx) => {});

	// Milestone 2.3: ingest new messages after each agent turn (AC 31)
	pi.on('agent_end', async (_event, ctx) => {
		if (!dagStore) return;

		ingestNewMessages(dagStore, ctx);

		if (!summarizer) return;

		try {
			await runCompactionFn(
				dagStore,
				summarizer,
				{
					freshTailCount: resolvedConfig.freshTailCount,
					leafChunkTokens: resolvedConfig.leafChunkTokens,
					leafTargetTokens: resolvedConfig.leafTargetTokens,
					condensedTargetTokens: resolvedConfig.condensedTargetTokens,
					condensedMinFanout: resolvedConfig.condensedMinFanout,
					appendEntry(customType, data) {
						pi.appendEntry(customType, data);
					},
				},
				new AbortController().signal,
			);
		} catch (err) {
			console.error('pi-lcm: compaction error', err);
		}
	});

	// Milestone 3.x: will intercept large file reads
	pi.on("tool_result", async (_event, _ctx) => {});

	// Milestone 2.10: will override pi's built-in compaction with DAG-aware strategy
	pi.on("session_before_compact", async (_event, _ctx) => {});
}
