import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { loadConfig } from './config.ts';
import type { LCMConfig } from './config.ts';
import { MemoryContentStore } from './context/content-store.ts';
import { ContextBuilder } from './context/context-builder.ts';
import { ContextHandler } from './context/context-handler.ts';
import { StripStrategy } from './context/strip-strategy.ts';
import { registerDescribeTool } from './tools/describe.ts';
import { registerExpandTool } from './tools/expand.ts';
import { registerGrepTool } from './tools/grep.ts';
import { formatStatusBar } from './status.ts';
import { ingestNewMessages } from './ingestion/ingest.ts';
import type { Store } from './store/types.ts';
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

  // AC 24: Wire ContextBuilder with the handler and optional DAG Store
  const builder = new ContextBuilder(handler, dagStore);

  // AC 25 + AC 26: Register tools conditionally based on DAG store availability.
  if (dagStore) {
    registerExpandTool(pi, store, { maxExpandTokens: resolvedConfig.maxExpandTokens }, dagStore);
    registerGrepTool(pi, dagStore);
    registerDescribeTool(pi, dagStore);
  } else {
    // Keep legacy Phase 1 plain-text expand behavior when DAG store is absent.
    registerExpandTool(pi, store, { maxExpandTokens: resolvedConfig.maxExpandTokens });
  }

  pi.on('context', async (event, ctx) => {
    // AC 24: Use ContextBuilder instead of direct handler.process()
    const result = builder.buildContext(event.messages);
    event.messages = result.messages;
    const text = formatStatusBar(result.stats, ctx.getContextUsage(), resolvedConfig.freshTailCount);
    ctx.ui.setStatus('lcm', text);
  });

  pi.on('session_start', async (_event, _ctx) => {});

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

  pi.on('tool_result', async (_event, _ctx) => {});
  pi.on('session_before_compact', async (_event, _ctx) => {});
}
