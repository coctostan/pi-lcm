import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { complete } from '@mariozechner/pi-ai';
import { Type } from '@sinclair/typebox';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import type { LCMConfig } from './config.ts';
import { runCompaction } from './compaction/engine.ts';
import { MemoryContentStore } from './context/content-store.ts';
import { ContextBuilder } from './context/context-builder.ts';
import { ContextHandler } from './context/context-handler.ts';
import { StripStrategy } from './context/strip-strategy.ts';
import { ingestNewMessages } from './ingestion/ingest.ts';
import { checkIntegrity } from './recovery/integrity.ts';
import { reconcile } from './recovery/reconcile.ts';
import { SqliteStore } from './store/sqlite-store.ts';
import type { Store } from './store/types.ts';
import { formatStatusBar } from './status.ts';
import { PiSummarizer } from './summarizer/summarizer.ts';
import type { CompleteFn, Summarizer } from './summarizer/summarizer.ts';
import { registerDescribeTool, createDescribeExecute } from './tools/describe.ts';
import { registerExpandTool, createExpandExecute } from './tools/expand.ts';
import { registerGrepTool, createGrepExecute } from './tools/grep.ts';
import { interceptLargeFile } from './large-files/interceptor.ts';
import { sessionLargeFileCacheDir, resetSessionLargeFileCache } from './large-files/cache-dir.ts';
import { debugLog } from './debug.ts';

/**
 * pi-lcm extension entry point.
 * Registers the context handler and lcm_expand tool with a shared ContentStore (AC 15).
 */

/** Internal options for testing — not part of the public API. */
export interface InternalOptions {
  dagStore?: Store;
  createDagStore?: () => Store;
  summarizer?: Summarizer;
  runCompactionFn?: typeof runCompaction;
  /** Override DB directory for testing the production SqliteStore path. */
  dbDir?: string;
  /** Override complete function for testing the production PiSummarizer path. */
  completeFn?: CompleteFn;
  /** Override large-file cache root for testing. */
  largeFileCacheRoot?: string;
}

export default function (pi: ExtensionAPI, config?: LCMConfig, _internal?: InternalOptions): void {
  const resolvedConfig = config ?? loadConfig();
  const store = new MemoryContentStore();

  // DAG store for Phase 2 message ingestion (set in session_start or injected for tests)
  let dagStore: Store | null = _internal?.dagStore ?? null;
  let summarizer: Summarizer | null = _internal?.summarizer ?? null;
  const runCompactionFn = _internal?.runCompactionFn ?? runCompaction;
  const createDagStore = _internal?.createDagStore;
  let dagReady = false;

  // Wire ContextHandler with the shared store (AC 15)
  const strategy = new StripStrategy();
  const handler = new ContextHandler(strategy, store, {
    freshTailCount: resolvedConfig.freshTailCount,
  });

  // AC 24: Wire ContextBuilder with the handler and optional DAG Store
  let builder = new ContextBuilder(handler, dagStore);

  // AC 7: Register all three DAG tools eagerly, gated by dagReady for grep/describe.
  // When _internal.dagStore is available at init, use direct wiring (dagReady set later in session_start).
  if (dagStore) {
    // _internal path: dagStore is already available, register with direct references
    registerExpandTool(pi, store, { maxExpandTokens: resolvedConfig.maxExpandTokens }, dagStore);
    registerGrepTool(pi, dagStore);
    registerDescribeTool(pi, dagStore);
  } else {
    // Production path: register all tools eagerly with dagReady gate.
    // lcm_expand: Phase 1 mode when !dagReady, Phase 2 mode when dagReady
    pi.registerTool({
      name: 'lcm_expand',
      label: 'LCM Expand',
      description:
        'Retrieve original content that was stripped from old messages by LCM context management. Use the ID from the LCM placeholder text to recover the full content.',
      parameters: Type.Object({
        id: Type.String({ description: 'The ID from the LCM placeholder (e.g., the tool call ID).' }),
        offset: Type.Optional(Type.Number({ description: 'Token-based offset for paginated large file retrieval (default: 0).' })),
      }),
      async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
        const currentDagStore = dagReady ? dagStore : undefined;
        const exec = createExpandExecute(store, { maxExpandTokens: resolvedConfig.maxExpandTokens }, currentDagStore);
        return exec(toolCallId, params as { id: string; offset?: number });
      },
    });

    // lcm_grep: gated on dagReady
    pi.registerTool({
      name: 'lcm_grep',
      label: 'LCM Grep',
      description:
        'Search across archived messages and summaries using full-text search. Returns matching snippets with IDs for further inspection via lcm_describe or lcm_expand.',
      parameters: Type.Object({
        query: Type.String({ description: 'Search query string.' }),
      }),
      async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
        if (!dagReady || !dagStore) {
          return { content: [{ type: 'text' as const, text: 'LCM initializing — the DAG store is not yet available.' }], details: undefined };
        }
        const exec = createGrepExecute(dagStore);
        return exec(_toolCallId, _params);
      },
    });

    // lcm_describe: gated on dagReady
    pi.registerTool({
      name: 'lcm_describe',
      label: 'LCM Describe',
      description:
        'Inspect summary metadata (depth, kind, token count, time range, descendant count) without expanding the full content. Use with summary IDs from lcm_grep results.',
      parameters: Type.Object({
        id: Type.String({ description: 'Summary ID to describe.' }),
      }),
      async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
        if (!dagReady || !dagStore) {
          return { content: [{ type: 'text' as const, text: 'LCM initializing — the DAG store is not yet available.' }], details: undefined };
        }
        const exec = createDescribeExecute(dagStore);
        return exec(_toolCallId, _params);
      },
    });
  }

  pi.on('context', async (event, ctx) => {
    // AC 24: Use ContextBuilder instead of direct handler.process()
    const result = builder.buildContext(event.messages);
    event.messages = result.messages;
    const text = formatStatusBar(result.stats, ctx.getContextUsage(), resolvedConfig.freshTailCount);
    ctx.ui.setStatus('lcm', text);
    return { messages: result.messages };
  });

  pi.on('session_start', async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    resetSessionLargeFileCache(largeFileCacheRoot, sessionId);
    largeFileCacheDir = sessionLargeFileCacheDir(largeFileCacheRoot, sessionId);
    const runIntegrity = (activeStore: Store) => {
      const warnings = checkIntegrity(activeStore);
      for (const w of warnings) {
        console.warn('pi-lcm: integrity:', w);
      }
    };
    // Production path: create SqliteStore + PiSummarizer when no _internal.dagStore
    if (!dagStore) {
      try {
        // AC 2: Auto-create directory
        const dbDir = _internal?.dbDir ?? join(homedir(), '.pi', 'agent', 'lcm');
        mkdirSync(dbDir, { recursive: true });
        dagStore = new SqliteStore(join(dbDir, `${sessionId}.db`));
        if (!summarizer) {
          const completeFn: CompleteFn = _internal?.completeFn ?? (complete as unknown as CompleteFn);
          summarizer = new PiSummarizer({
            modelRegistry: ctx.modelRegistry,
            summaryModel: resolvedConfig.summaryModel,
            completeFn,
          });
        }
        // AC 5: Open conversation
        dagStore.openConversation(sessionId, ctx.cwd);
        debugLog('session_start openConversation', {
          sessionId,
          cwd: ctx.cwd,
          dbPath: join(dbDir, `${sessionId}.db`),
        });
        reconcile(dagStore, branch);
        runIntegrity(dagStore);
        // AC 6: dagReady = true only after all succeed
        dagReady = true;
        debugLog('session_start ready', {
          dagReady,
          contextItems: dagStore.getContextItems().length,
          messages: dagStore.getMessagesAfter(-1).length,
        });
        builder = new ContextBuilder(handler, dagStore);
      } catch (err) {
        // AC 10, 11, 12: Graceful degradation
        console.error('pi-lcm: DAG initialization failed, falling back to Phase 1', err);
        if (dagStore) {
          try {
            dagStore.close();
          } catch {}
        }
        dagStore = null;
        summarizer = null;
        dagReady = false;
        builder = new ContextBuilder(handler, null);
      }
      return;
    }
    // _internal path: dagStore already exists
    dagReady = true; // Tools can now operate against the _internal store
    try {
      dagStore.openConversation(sessionId, ctx.cwd);
      reconcile(dagStore, branch);
      runIntegrity(dagStore);
      builder = new ContextBuilder(handler, dagStore);
      return;
    } catch (err) {
      console.error('pi-lcm: session_start reconciliation error', err);
    }

    try {
      if (!createDagStore) throw new Error('no createDagStore factory configured');
      const recoveredStore = createDagStore();
      recoveredStore.openConversation(sessionId, ctx.cwd);
      reconcile(recoveredStore, branch);
      runIntegrity(recoveredStore);
      dagStore = recoveredStore;
      builder = new ContextBuilder(handler, dagStore);
    } catch (recoveryErr) {
      console.error('pi-lcm: session_start recovery failed', recoveryErr);
      dagStore = null;
      dagReady = false;
      builder = new ContextBuilder(handler, null);
    }
  });

  pi.on('agent_end', async (_event, ctx) => {
    if (!dagStore) return;

    ingestNewMessages(dagStore, ctx);
    debugLog('agent_end ingested', {
      ingested: dagStore.getLastIngestedSeq() + 1,
      totalMessages: dagStore.getMessagesAfter(-1).length,
    });

    if (!summarizer) return;

    try {
      const compactionResult = await runCompactionFn(
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
      debugLog('agent_end compaction result', compactionResult);
    } catch (err) {
      console.error('pi-lcm: compaction error', err);
    }
  });

  const largeFileCacheRoot = _internal?.largeFileCacheRoot ?? join(homedir(), '.pi', 'agent', 'lcm-files');
  let largeFileCacheDir = largeFileCacheRoot;
  pi.on('tool_result', async (event, _ctx) => {
    if (!dagStore) return undefined;
    const result = await interceptLargeFile(
      event as any,
      dagStore,
      {
        largeFileTokenThreshold: resolvedConfig.largeFileTokenThreshold,
        maxExpandTokens: resolvedConfig.maxExpandTokens,
      },
      largeFileCacheDir,
    );
    debugLog('tool_result interception result', {
      toolName: (event as any).toolName,
      intercepted: Boolean(result),
    });
    return result;
  });
  pi.on('session_before_compact', async (event, _ctx) => {
    if (!dagStore) return undefined;
    try {
      if (summarizer) {
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
          event.signal,
          true,
        );
      }
      return { cancel: true };
    } catch (err) {
      console.error('pi-lcm: session_before_compact error', err);
      return undefined;
    }
  });
  pi.on('session_tree', async (_event, ctx) => {
    if (!dagStore) return;
    try {
      reconcile(dagStore, ctx.sessionManager.getBranch(), { rebuild: true });
    } catch (err) {
      console.error('pi-lcm: session_tree error', err);
    }
  });
  pi.on('session_shutdown', async (_event, _ctx) => {
    try {
      const sessionId = _ctx?.sessionManager?.getSessionId?.();
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        resetSessionLargeFileCache(largeFileCacheRoot, sessionId);
      }
    } catch (err) {
      console.error('pi-lcm: session_shutdown cache cleanup error', err);
    }

    if (!dagStore) return;

    try {
      dagStore.close();
    } catch (err) {
      console.error('pi-lcm: session_shutdown close error', err);
    }
  });
}
