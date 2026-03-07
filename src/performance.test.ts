import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { MemoryStore } from './store/memory-store.ts';
import { MemoryContentStore } from './context/content-store.ts';
import { ContextHandler } from './context/context-handler.ts';
import { ContextBuilder } from './context/context-builder.ts';
import { StripStrategy } from './context/strip-strategy.ts';
import { runCompaction } from './compaction/engine.ts';
import type { Summarizer, SummarizeOptions } from './summarizer/summarizer.ts';

function makeMessages(count: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const roles: Array<'user' | 'assistant' | 'toolResult'> = ['user', 'assistant', 'toolResult'];
  for (let i = 0; i < count; i++) {
    const role = roles[i % 3]!;
    const id = `msg_${i}`;

    if (role === 'user') {
      messages.push({
        role: 'user',
        content: `User message ${i}: detailed question about system architecture.`,
        timestamp: i * 1000,
      } as any as AgentMessage);
    } else if (role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: `Assistant response ${i}: here is a thorough technical answer.` }],
        api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop', timestamp: i * 1000,
      } as any as AgentMessage);
    } else {
      messages.push({
        role: 'toolResult',
        toolCallId: id,
        toolName: 'read',
        content: [{ type: 'text', text: `Tool output ${i}: file contents with code and documentation.` }],
        isError: false, timestamp: i * 1000,
      } as any as AgentMessage);
    }
  }
  return messages;
}

describe('Performance fixtures — real AgentMessage contract', () => {
  it('makeMessages emits user and assistant messages without synthetic ids', () => {
    const [user, assistant, toolResult] = makeMessages(3) as any[];

    assert.strictEqual(user.role, 'user');
    assert.ok(!('id' in user), 'User fixture should not expose synthetic id');

    assert.strictEqual(assistant.role, 'assistant');
    assert.ok(!('id' in assistant), 'Assistant fixture should not expose synthetic id');

    assert.strictEqual(toolResult.role, 'toolResult');
    assert.strictEqual(toolResult.toolCallId, 'msg_2');
  });
});

describe('Performance — buildContext', () => {
  it('100 messages with no summaries in store completes in under 50ms (AC 16)', () => {
    const store = new MemoryStore();
    store.openConversation('perf_no_summaries', '/tmp/perf');
    for (let i = 0; i < 100; i++) {
      store.ingestMessage({
        id: `msg_${i}`,
        seq: i,
        role: (i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'toolResult') as any,
        toolName: i % 3 === 2 ? 'read' : undefined,
        content: i % 3 === 0
          ? `User message ${i}: detailed question about system architecture.`
          : i % 3 === 1
            ? `Assistant response ${i}: here is a thorough technical answer.`
            : `Tool output ${i}: file contents with code and documentation.`,
        tokenCount: 20,
        createdAt: i * 1000,
      });
    }

    // Set context_items to 100 message items (no summaries)
    store.replaceContextItems(
      Array.from({ length: 100 }, (_, i) => ({ kind: 'message' as const, messageId: `msg_${i}` })),
    );

    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });
    const builder = new ContextBuilder(handler, store);
    const messages = makeMessages(100);

    // Warm-up run
    builder.buildContext(messages);

    const start = performance.now();
    const result = builder.buildContext(messages);
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 50, `buildContext took ${elapsed.toFixed(2)}ms, expected < 50ms`);
    assert.strictEqual(result.messages.length, 100);
    assert.strictEqual(result.stats.summaryCount, 0);
    store.close();
  });

  it('100 messages with 10 pre-seeded summaries completes in under 100ms (AC 17)', () => {
    const store = new MemoryStore();
    store.openConversation('perf_with_summaries', '/tmp/perf');

    // Ingest 100 messages
    for (let i = 0; i < 100; i++) {
      store.ingestMessage({
        id: `msg_${i}`,
        seq: i,
        role: (i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'toolResult') as any,
        toolName: i % 3 === 2 ? 'read' : undefined,
        content: i % 3 === 0
          ? `User message ${i}: detailed question about system architecture.`
          : i % 3 === 1
            ? `Assistant response ${i}: here is a thorough technical answer.`
            : `Tool output ${i}: file contents with code and documentation.`,
        tokenCount: 20,
        createdAt: i * 1000,
      });
    }

    // Insert 10 summaries covering the first 80 messages (8 messages each)
    const summaryIds: string[] = [];
    for (let s = 0; s < 10; s++) {
      const sid = store.insertSummary({
        depth: 0,
        kind: 'leaf',
        content: `Summary ${s}: covers messages ${s * 8} to ${s * 8 + 7}.`,
        tokenCount: 30,
        earliestAt: s * 8 * 1000,
        latestAt: (s * 8 + 7) * 1000,
        descendantCount: 8,
        createdAt: Date.now(),
      });
      summaryIds.push(sid);
    }

    // Build context_items: 10 summaries + 20 fresh tail messages
    const contextItems = [
      ...summaryIds.map(summaryId => ({ kind: 'summary' as const, summaryId })),
      ...Array.from({ length: 20 }, (_, i) => ({
        kind: 'message' as const,
        messageId: `msg_${80 + i}`,
      })),
    ];
    store.replaceContextItems(contextItems);

    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });
    const builder = new ContextBuilder(handler, store);

    const messages = makeMessages(100);

    // Warm-up run
    builder.buildContext(messages);

    // Timed run
    const start = performance.now();
    const result = builder.buildContext(messages);
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 100, `buildContext took ${elapsed.toFixed(2)}ms, expected < 100ms`);
    assert.strictEqual(result.stats.summaryCount, 10);
    assert.strictEqual(result.stats.maxDepth, 0);
    assert.strictEqual(result.messages.length, 21); // 1 framed summary user message + 20 raw messages

    const expectedTail = messages.slice(80);
    const tailInOutput = expectedTail.filter(message => result.messages.includes(message));
    assert.strictEqual(tailInOutput.length, 20);
    store.close();
  });
});


describe('Performance — runCompaction', () => {
  it('leaf pass on 50 messages with 50ms mock summarizer completes in under 2 seconds (AC 18)', async () => {
    // AC 18 performance envelope for mocked 50ms summarizer latency
    const store = new MemoryStore();
    store.openConversation('perf_compaction', '/tmp/perf');

    // Ingest 50 messages
    for (let i = 0; i < 50; i++) {
      store.ingestMessage({
        id: `msg_${i}`,
        seq: i,
        role: (i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'toolResult') as any,
        toolName: i % 3 === 2 ? 'read' : undefined,
        content: `Message content ${i} with some padding text for token estimation.`,
        tokenCount: 25,
        createdAt: i * 1000,
      });
    }

    // Set context_items: all 50 messages
    store.replaceContextItems(
      Array.from({ length: 50 }, (_, i) => ({ kind: 'message' as const, messageId: `msg_${i}` })),
    );

    // Mock summarizer with 50ms fixed delay
    const slowSummarizer: Summarizer = {
      async summarize(_content: string, _opts: SummarizeOptions): Promise<string> {
        await new Promise(resolve => setTimeout(resolve, 50));
        return 'Compacted summary of conversation segment.';
      },
    };

    const start = performance.now();
    const result = await runCompaction(
      store,
      slowSummarizer,
      {
        freshTailCount: 8,
        leafChunkTokens: 200,
        leafTargetTokens: 100,
        condensedTargetTokens: 200,
        condensedMinFanout: 100, // prevent condensation
      },
      new AbortController().signal,
    );
    const elapsed = performance.now() - start;

    assert.ok(result.actionTaken, 'Expected compaction to take action');
    assert.ok(result.summariesCreated >= 1, `Expected at least 1 summary, got ${result.summariesCreated}`);
    assert.ok(elapsed < 2000, `runCompaction took ${elapsed.toFixed(0)}ms, expected < 2000ms`);

    store.close();
  });
});
