import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config.ts";
import type { LCMConfig } from "./config.ts";
import { MemoryContentStore } from "./context/content-store.ts";
import { ContextHandler } from "./context/context-handler.ts";
import { StripStrategy } from "./context/strip-strategy.ts";
import { registerExpandTool } from "./tools/expand.ts";
import { formatStatusBar } from "./status.ts";

/**
 * pi-lcm extension entry point.
 * Registers the context handler and lcm_expand tool with a shared ContentStore (AC 15).
 */
export default function (pi: ExtensionAPI, config?: LCMConfig): void {
	const resolvedConfig = config ?? loadConfig();
	const store = new MemoryContentStore();

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

	// Milestone 2.x: will trigger proactive leaf compaction pass
	pi.on("agent_end", async (_event, _ctx) => {});

	// Milestone 3.x: will intercept large file reads
	pi.on("tool_result", async (_event, _ctx) => {});

	// Milestone 2.10: will override pi's built-in compaction with DAG-aware strategy
	pi.on("session_before_compact", async (_event, _ctx) => {});
}
