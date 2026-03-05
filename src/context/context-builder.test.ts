import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { ContextBuilder } from './context-builder.ts';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import { MemoryStore } from '../store/memory-store.ts';
import { SummaryBlockSchema } from '../schemas.ts';

describe('ContextBuilder — no DAG Store', () => {
  it('delegates to ContextHandler.process() and returns its result unchanged', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });
    const builder = new ContextBuilder(handler, null);

    const messages: AgentMessage[] = [
      { role: 'user' as const, content: 'hello', timestamp: 1 } as AgentMessage,
      { role: 'user' as const, content: 'world', timestamp: 2 } as AgentMessage,
    ];

    const result = builder.buildContext(messages);

    assert.strictEqual(result.messages.length, 2);
    assert.strictEqual(result.stats.strippedCount, 0);
    assert.strictEqual(result.stats.estimatedTokensSaved, 0);
  });

  it('delegates with undefined messages', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });
    const builder = new ContextBuilder(handler, null);

    const result = builder.buildContext(undefined);

    assert.deepStrictEqual(result.messages, []);
    assert.strictEqual(result.stats.strippedCount, 0);
  });
});


describe('ContextBuilder — with DAG Store', () => {
  it('injects summary blocks as assistant messages containing valid SummaryBlock JSON (AC 7)', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    const summaryId = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Messages 1-5: user discussed config setup.',
      tokenCount: 50,
      earliestAt: 100,
      latestAt: 500,
      descendantCount: 5,
      createdAt: 600,
    });

    dagStore.replaceContextItems([{ kind: 'summary', summaryId }]);

    const builder = new ContextBuilder(handler, dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'latest message', timestamp: 1000 } as AgentMessage,
    ]);

    const summaryMsg = result.messages.find((m: any) => {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) return false;
      const first = m.content[0];
      if (!first || first.type !== 'text') return false;
      try {
        return SummaryBlockSchema.safeParse(JSON.parse(first.text)).success;
      } catch {
        return false;
      }
    });

    assert.ok(summaryMsg, 'Should contain an assistant message with valid SummaryBlock JSON');
    const parsed = JSON.parse((summaryMsg as any).content[0].text);
    assert.strictEqual(parsed.id, summaryId);
    assert.strictEqual(parsed.depth, 0);
    assert.strictEqual(parsed.kind, 'leaf');
  });

  it('resolves message-kind context items to original messages from input (AC 8)', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    const summaryId = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Leaf summary.',
      tokenCount: 30,
      earliestAt: 50,
      latestAt: 90,
      descendantCount: 3,
      createdAt: 200,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId },
      { kind: 'message', messageId: 'entry_1' },
    ]);

    const builder = new ContextBuilder(handler, dagStore);
    const messages: AgentMessage[] = [
      {
        role: 'toolResult' as const,
        toolCallId: 'entry_1',
        toolName: 'read',
        content: [{ type: 'text' as const, text: 'file content here' }],
        isError: false,
        timestamp: 100,
      } as AgentMessage,
      { role: 'user' as const, content: 'UNREFERENCED OLD', timestamp: 101 } as AgentMessage,
    ];

    const result = builder.buildContext(messages);
    const hasToolResult = result.messages.some(
      (m: any) => m.role === 'toolResult' && m.toolCallId === 'entry_1',
    );
    assert.ok(hasToolResult, 'Should include referenced message from context_items');
    assert.strictEqual(result.messages[1], messages[0]);
  });

  it('keeps strict context_items order and does not append unreferenced messages (AC 9 regression)', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    const summaryId = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Summary one.',
      tokenCount: 20,
      earliestAt: 100,
      latestAt: 200,
      descendantCount: 2,
      createdAt: 300,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId },
      { kind: 'message', messageId: 'msg_1' },
    ]);

    const builder = new ContextBuilder(handler, dagStore);
    const messages: AgentMessage[] = [
      {
        role: 'toolResult' as const,
        toolCallId: 'msg_1',
        toolName: 'read',
        content: [{ type: 'text' as const, text: 'referenced message' }],
        isError: false,
        timestamp: 250,
      } as AgentMessage,
      { role: 'user' as const, content: 'UNREFERENCED OLD', timestamp: 251 } as AgentMessage,
    ];

    const result = builder.buildContext(messages);
    assert.strictEqual(result.messages.length, 2);
    assert.strictEqual((result.messages[0] as any).role, 'assistant');
    const parsed = JSON.parse((result.messages[0] as any).content[0].text);
    assert.strictEqual(parsed.id, summaryId);
    assert.ok(
      !result.messages.some((m: any) => m.role === 'user' && m.content === 'UNREFERENCED OLD'),
      'Unreferenced old messages must not be appended',
    );
  });

  it('silently skips context items referencing nonexistent summaries (AC 10)', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    const validId = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Valid summary.',
      tokenCount: 20,
      earliestAt: 100,
      latestAt: 200,
      descendantCount: 2,
      createdAt: 300,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId: 'missing' },
      { kind: 'summary', summaryId: validId },
    ]);

    const builder = new ContextBuilder(handler, dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'hi', timestamp: 1 } as AgentMessage,
    ]);

    const summaryAssistantMessages = result.messages.filter((m: any) => m.role === 'assistant');
    assert.strictEqual(summaryAssistantMessages.length, 1);
  });

  it('returns ContextHandlerResult with stats including strippedCount and estimatedTokensSaved (AC 11)', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    const summaryId = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Summary.',
      tokenCount: 20,
      earliestAt: 100,
      latestAt: 200,
      descendantCount: 3,
      createdAt: 300,
    });

    dagStore.replaceContextItems([{ kind: 'summary', summaryId }]);

    const builder = new ContextBuilder(handler, dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'hi', timestamp: 1 } as AgentMessage,
    ]);

    assert.ok(Array.isArray(result.messages));
    assert.strictEqual(typeof result.stats.strippedCount, 'number');
    assert.strictEqual(typeof result.stats.estimatedTokensSaved, 'number');
  });

  it('populates summaryCount with the count of resolved summaries (AC 3)', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    const sid1 = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Summary one.',
      tokenCount: 20,
      earliestAt: 100,
      latestAt: 200,
      descendantCount: 2,
      createdAt: 300,
    });
    const sid2 = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Summary two.',
      tokenCount: 20,
      earliestAt: 300,
      latestAt: 400,
      descendantCount: 3,
      createdAt: 500,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId: sid1 },
      { kind: 'summary', summaryId: sid2 },
      { kind: 'message', messageId: 'msg_1' },
    ]);

    const builder = new ContextBuilder(handler, dagStore);
    const result = builder.buildContext([
      {
        role: 'toolResult' as const,
        toolCallId: 'msg_1',
        toolName: 'read',
        content: [{ type: 'text' as const, text: 'file content' }],
        isError: false,
        timestamp: 500,
      } as AgentMessage,
    ]);

    assert.strictEqual(result.stats.summaryCount, 2);
  });

  it('populates maxDepth with the maximum depth among resolved summaries (AC 4)', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    const sid1 = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Leaf summary.',
      tokenCount: 20,
      earliestAt: 100,
      latestAt: 200,
      descendantCount: 2,
      createdAt: 300,
    });
    const sid2 = dagStore.insertSummary({
      depth: 1,
      kind: 'condensed',
      content: 'Condensed summary.',
      tokenCount: 30,
      earliestAt: 50,
      latestAt: 400,
      descendantCount: 5,
      createdAt: 500,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId: sid2 },
      { kind: 'summary', summaryId: sid1 },
    ]);

    const builder = new ContextBuilder(handler, dagStore);
    const result = builder.buildContext([]);

    assert.strictEqual(result.stats.maxDepth, 1);
  });

  it('sets maxDepth to 0 for leaf-only summaries', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    const sid1 = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Leaf only.',
      tokenCount: 20,
      earliestAt: 100,
      latestAt: 200,
      descendantCount: 2,
      createdAt: 300,
    });

    dagStore.replaceContextItems([{ kind: 'summary', summaryId: sid1 }]);

    const builder = new ContextBuilder(handler, dagStore);
    const result = builder.buildContext([]);

    assert.strictEqual(result.stats.maxDepth, 0);
  });

  it('does not set maxDepth when there are no summaries in context_items', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    dagStore.replaceContextItems([{ kind: 'message', messageId: 'msg_1' }]);

    const builder = new ContextBuilder(handler, dagStore);
    const result = builder.buildContext([
      {
        role: 'toolResult' as const,
        toolCallId: 'msg_1',
        toolName: 'read',
        content: [{ type: 'text' as const, text: 'content' }],
        isError: false,
        timestamp: 100,
      } as AgentMessage,
    ]);

    assert.strictEqual(result.stats.summaryCount, 0);
    assert.strictEqual(result.stats.maxDepth, undefined);
  });
});
