import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEntry } from '@mariozechner/pi-coding-agent';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { MemoryStore } from './store/memory-store.ts';
import { MemoryContentStore } from './context/content-store.ts';
import { ContextHandler } from './context/context-handler.ts';
import { ContextBuilder } from './context/context-builder.ts';
import { StripStrategy } from './context/strip-strategy.ts';
import { ingestNewMessages } from './ingestion/ingest.ts';
import { runCompaction } from './compaction/engine.ts';
import { formatStatusBar } from './status.ts';
import type { Summarizer, SummarizeOptions } from './summarizer/summarizer.ts';

// --- Helpers ---

function makeEntry(
  index: number,
  role: 'user' | 'assistant' | 'toolResult',
): { entry: SessionEntry; agentMessage: AgentMessage } {
  const id = `e_${index}`;
  const ts = 1_700_000_000_000 + index * 1000;

  if (role === 'user') {
    const content = `User message ${index}: discussing architecture decisions and implementation.`;
    return {
      entry: {
        type: 'message', id, parentId: index > 0 ? `e_${index - 1}` : null,
        timestamp: new Date(ts).toISOString(),
        message: { role: 'user', content, timestamp: ts },
      } as SessionEntry,
      agentMessage: { role: 'user', content, timestamp: ts, id } as any as AgentMessage,
    };
  }

  if (role === 'assistant') {
    const text = `Assistant response ${index}: providing technical analysis and code review.`;
    return {
      entry: {
        type: 'message', id, parentId: index > 0 ? `e_${index - 1}` : null,
        timestamp: new Date(ts).toISOString(),
        message: {
          role: 'assistant', content: [{ type: 'text', text }],
          api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop', timestamp: ts,
        },
      } as SessionEntry,
      agentMessage: {
        role: 'assistant', content: [{ type: 'text', text }],
        api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: ts, id,
      } as any as AgentMessage,
    };
  }

  // toolResult
  const text = `Tool output ${index}: source code with module imports and function definitions padding.`;
  return {
    entry: {
      type: 'message', id, parentId: index > 0 ? `e_${index - 1}` : null,
      timestamp: new Date(ts).toISOString(),
      message: {
        role: 'toolResult', toolCallId: id, toolName: 'read',
        content: [{ type: 'text', text }], isError: false, timestamp: ts,
      },
    } as SessionEntry,
    agentMessage: {
      role: 'toolResult', toolCallId: id, toolName: 'read',
      content: [{ type: 'text', text }], isError: false, timestamp: ts, id,
    } as any as AgentMessage,
  };
}

function buildPipelineSession(messageCount: number): {
  entries: SessionEntry[];
  agentMessages: AgentMessage[];
} {
  const entries: SessionEntry[] = [];
  const agentMessages: AgentMessage[] = [];
  const roles: Array<'user' | 'assistant' | 'toolResult'> = ['user', 'assistant', 'toolResult'];
  for (let i = 0; i < messageCount; i++) {
    const { entry, agentMessage } = makeEntry(i, roles[i % 3]!);
    entries.push(entry);
    agentMessages.push(agentMessage);
  }
  return { entries, agentMessages };
}

function createMockSummarizer(): Summarizer {
  return {
    async summarize(_content: string, _opts: SummarizeOptions): Promise<string> {
      return 'Test summary of conversation segment.';
    },
  };
}

function createBuilder(store: MemoryStore | null): ContextBuilder {
  const contentStore = new MemoryContentStore();
  const strategy = new StripStrategy();
  const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });
  return new ContextBuilder(handler, store);
}

// --- Tests ---

describe('Pipeline integration — short session (AC 9)', () => {
  it('10 messages with freshTailCount=32: no compaction, all messages returned, status bar undefined', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_short', '/tmp/project');

    const { entries, agentMessages } = buildPipelineSession(10);
    const mockCtx = { sessionManager: { getBranch: () => entries } } as any;
    ingestNewMessages(store, mockCtx);

    // Run compaction — should be a no-op since 10 < freshTailCount=32
    const compactionResult = await runCompaction(
      store,
      createMockSummarizer(),
      {
        freshTailCount: 32,
        leafChunkTokens: 200,
        leafTargetTokens: 100,
        condensedTargetTokens: 200,
        condensedMinFanout: 4,
      },
      new AbortController().signal,
    );
    assert.strictEqual(compactionResult.actionTaken, false);

    // Build context
    const builder = createBuilder(store);
    const result = builder.buildContext(agentMessages);

    // All messages should be returned unmodified (AC 9)
    assert.strictEqual(result.messages.length, agentMessages.length);
    assert.deepStrictEqual(result.messages, agentMessages);
    assert.strictEqual(result.stats.summaryCount, 0);
    assert.strictEqual(result.stats.maxDepth, undefined);

    // Status bar should return undefined
    const statusText = formatStatusBar(result.stats, undefined, 32);
    assert.strictEqual(statusText, undefined);

    store.close();
  });
});


describe('Pipeline integration — medium session (AC 10)', () => {
  it('50 messages with freshTailCount=8 and low leafChunkTokens: leaf summaries created in store', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_medium', '/tmp/project');

    const { entries } = buildPipelineSession(50);
    const mockCtx = { sessionManager: { getBranch: () => entries } } as any;
    ingestNewMessages(store, mockCtx);

    // Verify 50 messages ingested
    assert.strictEqual(store.getContextItems().length, 50);

    // Run compaction with low leafChunkTokens to trigger leaf pass
    // condensedMinFanout=100 prevents condensation
    const compactionResult = await runCompaction(
      store,
      createMockSummarizer(),
      {
        freshTailCount: 8,
        leafChunkTokens: 200,
        leafTargetTokens: 100,
        condensedTargetTokens: 200,
        condensedMinFanout: 100,
      },
      new AbortController().signal,
    );

    assert.strictEqual(compactionResult.actionTaken, true);
    assert.ok(compactionResult.summariesCreated >= 1, `Expected at least 1 summary, got ${compactionResult.summariesCreated}`);
    assert.ok(compactionResult.messagesSummarized >= 1, `Expected at least 1 message summarized, got ${compactionResult.messagesSummarized}`);

    // Verify context_items now contains summary items
    const contextItems = store.getContextItems();
    const summaryItems = contextItems.filter(item => item.kind === 'summary');
    assert.ok(summaryItems.length >= 1, `Expected at least 1 summary in context_items, got ${summaryItems.length}`);

    // Verify each summary exists in the store at depth 0
    for (const item of summaryItems) {
      if (item.kind === 'summary') {
        const summary = store.getSummary(item.summaryId);
        assert.ok(summary, `Summary ${item.summaryId} not found in store`);
        assert.strictEqual(summary!.depth, 0);
        assert.strictEqual(summary!.kind, 'leaf');
      }
    }

    // Verify fresh tail messages (last 8) are still message items
    const lastN = contextItems.slice(-8);
    for (const item of lastN) {
      assert.strictEqual(item.kind, 'message', 'Fresh tail items should be message kind');
    }

    store.close();
  });
});


describe('Pipeline integration — medium session ContextBuilder + status bar (AC 11, 12)', () => {
  it('after leaf compaction, buildContext output contains summary messages and raw fresh tail', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_medium_ctx', '/tmp/project');

    const { entries, agentMessages } = buildPipelineSession(50);
    const mockCtx = { sessionManager: { getBranch: () => entries } } as any;
    ingestNewMessages(store, mockCtx);

    // Run compaction with leaf pass only (high condensedMinFanout prevents condensation)
    await runCompaction(
      store,
      createMockSummarizer(),
      {
        freshTailCount: 8,
        leafChunkTokens: 200,
        leafTargetTokens: 100,
        condensedTargetTokens: 200,
        condensedMinFanout: 100,
      },
      new AbortController().signal,
    );

    // Build context
    const builder = createBuilder(store);
    const result = builder.buildContext(agentMessages);

    // Should contain at least one summary-injected assistant message
    const summaryMessages = result.messages.filter((m: any) => {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) return false;
      const first = m.content[0];
      if (!first || first.type !== 'text') return false;
      try {
        const parsed = JSON.parse(first.text);
        return parsed.kind === 'leaf' && typeof parsed.depth === 'number';
      } catch { return false; }
    });
    assert.ok(summaryMessages.length >= 1,
      `Expected at least 1 summary-injected assistant message, got ${summaryMessages.length}`);

    // Should contain raw message items for the fresh tail in store state
    const contextItems = store.getContextItems();
    const freshTailItems = contextItems.slice(-8);
    for (const item of freshTailItems) {
      assert.strictEqual(item.kind, 'message');
    }

    // AC 11: buildContext output must include the 8 raw fresh-tail messages
    const freshTailIds = entries.slice(-8).map(e => e.id);
    const freshTailInOutput = result.messages.filter((m: any) =>
      freshTailIds.includes(m.toolCallId ?? m.id),
    );
    assert.strictEqual(
      freshTailInOutput.length,
      8,
      `Expected 8 fresh-tail raw messages in buildContext output, got ${freshTailInOutput.length}`,
    );

    // summaryCount should match number of summary items
    const summaryItemCount = contextItems.filter(item => item.kind === 'summary').length;
    assert.strictEqual(result.stats.summaryCount, summaryItemCount);
    assert.ok(result.stats.summaryCount! >= 1);

    // maxDepth should be 0 (leaf-only)
    assert.strictEqual(result.stats.maxDepth, 0);

    // formatStatusBar should contain "summaries (d0)"
    const statusText = formatStatusBar(result.stats, { tokens: 1000, contextWindow: 2000, percent: 50 }, 8);
    assert.ok(statusText !== undefined, 'Status bar should not be undefined when summaries exist');
    assert.ok(statusText!.includes('summaries (d0)'),
      `Expected status bar to contain 'summaries (d0)', got: ${statusText}`);
    assert.ok(statusText!.includes('50%'),
      `Expected status bar to contain '50%', got: ${statusText}`);
    assert.ok(statusText!.includes('tail: 8'),
      `Expected status bar to contain 'tail: 8', got: ${statusText}`);

    store.close();
  });
});


describe('Pipeline integration — long session (AC 13, 14)', () => {
  it('100+ messages with condensedMinFanout=4: depth-1 condensed summary exists, status bar shows d1', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_long', '/tmp/project');

    const { entries, agentMessages } = buildPipelineSession(105);
    const mockCtx = { sessionManager: { getBranch: () => entries } } as any;
    ingestNewMessages(store, mockCtx);

    // Run compaction with low leafChunkTokens AND condensedMinFanout=4
    const compactionResult = await runCompaction(
      store,
      createMockSummarizer(),
      {
        freshTailCount: 8,
        leafChunkTokens: 200,
        leafTargetTokens: 100,
        condensedTargetTokens: 200,
        condensedMinFanout: 4,
      },
      new AbortController().signal,
    );

    assert.strictEqual(compactionResult.actionTaken, true);

    // Verify at least one depth-1 condensed summary exists in the store
    const contextItems = store.getContextItems();
    let hasDepth1OrHigher = false;
    for (const item of contextItems) {
      if (item.kind === 'summary') {
        const summary = store.getSummary(item.summaryId);
        if (summary && summary.depth >= 1) {
          hasDepth1OrHigher = true;
          assert.strictEqual(summary.kind, 'condensed');
        }
      }
    }
    assert.ok(hasDepth1OrHigher,
      'Expected at least one depth >= 1 condensed summary in context_items');

    // Build context and verify stats
    const builder = createBuilder(store);
    const result = builder.buildContext(agentMessages);

    assert.ok(result.stats.summaryCount! >= 1,
      `Expected summaryCount >= 1, got ${result.stats.summaryCount}`);
    assert.ok(result.stats.maxDepth! >= 1,
      `Expected maxDepth >= 1, got ${result.stats.maxDepth}`);

    // formatStatusBar should contain "(d1)" or higher
    const statusText = formatStatusBar(result.stats, { tokens: 1500, contextWindow: 2000, percent: 75 }, 8);
    assert.ok(statusText !== undefined);
    assert.ok(
      /\(d[1-9]\d*\)/.test(statusText!),
      `Expected status bar to contain '(d1)' or higher depth, got: ${statusText}`,
    );
    assert.ok(statusText!.includes('summaries'),
      `Expected status bar to contain 'summaries', got: ${statusText}`);
    assert.ok(statusText!.includes('tail: 8'),
      `Expected status bar to contain 'tail: 8', got: ${statusText}`);

    store.close();
  });
});

describe('Pipeline integration — Phase 1 fallback (AC 15)', () => {
  it('ContextBuilder with null dagStore produces identical output to ContextHandler.process()', () => {
    const contentStore1 = new MemoryContentStore();
    const strategy1 = new StripStrategy();
    const handler1 = new ContextHandler(strategy1, contentStore1, { freshTailCount: 8 });

    const contentStore2 = new MemoryContentStore();
    const strategy2 = new StripStrategy();
    const handler2 = new ContextHandler(strategy2, contentStore2, { freshTailCount: 8 });
    const builder = new ContextBuilder(handler2, null);

    // Build 35 messages (enough to trigger stripping in old zone)
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 35; i++) {
      if (i % 3 === 0) {
        messages.push({
          role: 'toolResult' as const,
          toolCallId: `toolu_${i}`,
          toolName: 'read',
          content: [{ type: 'text' as const, text: `Tool result content for call ${i} with extra padding text.` }],
          isError: false,
          timestamp: i * 1000,
        } as AgentMessage);
      } else if (i % 3 === 1) {
        messages.push({
          role: 'user' as const,
          content: `User message ${i}`,
          timestamp: i * 1000,
        } as AgentMessage);
      } else {
        messages.push({
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: `Assistant response ${i}` }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'claude-sonnet',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: i * 1000,
        } as AgentMessage);
      }
    }

    // Get Phase 1 result directly from ContextHandler
    const handlerResult = handler1.process(messages);

    // Get ContextBuilder result with null dagStore
    const builderResult = builder.buildContext(messages);

    // AC 15: output must be identical to Phase 1 fallback behavior
    assert.deepStrictEqual(builderResult, handlerResult);
  });
});