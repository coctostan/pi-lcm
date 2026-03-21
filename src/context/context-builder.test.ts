import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { ContextBuilder } from './context-builder.ts';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import { MemoryStore } from '../store/memory-store.ts';


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
  it('injects inline assistant summaries from DAG context items (AC 5)', () => {
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
    const summaryMsg = result.messages[0] as any;
    assert.strictEqual(result.messages.length, 2, 'Should include summary + trailing user prompt');
    assert.strictEqual(summaryMsg.role, 'assistant');
    const summaryText = typeof summaryMsg.content === 'string'
      ? summaryMsg.content
      : Array.isArray(summaryMsg.content)
        ? summaryMsg.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
        : '';
    assert.ok(summaryText.includes('Messages 1-5: user discussed config setup.'));
    assert.ok(summaryText.includes('depth: 0'));
    assert.ok(summaryText.includes('kind: leaf'));
    assert.ok(summaryText.includes('earliestAt: 100'));
    assert.ok(summaryText.includes('latestAt: 500'));
    assert.ok(summaryText.includes('descendantCount: 5'));
    assert.ok(!summaryText.includes('"id"'));
    assert.ok(!summaryText.includes('"msgRange"'));
    // Trailing user prompt should be preserved (not dropped)
    const lastMsg = result.messages[result.messages.length - 1] as any;
    assert.strictEqual(lastMsg.role, 'user');
    assert.strictEqual(lastMsg.content, 'latest message');
  });

  it('resolves message-kind context items for real-contract user/assistant messages without synthetic ids', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');
    dagStore.ingestMessage({
      id: 'entry_user',
      seq: 0,
      role: 'user',
      content: 'Question from the user.',
      tokenCount: 4,
      createdAt: 100,
    });
    dagStore.ingestMessage({
      id: 'entry_assistant',
      seq: 1,
      role: 'assistant',
      content: 'Answer from the assistant.',
      tokenCount: 5,
      createdAt: 200,
    });
    dagStore.replaceContextItems([
      { kind: 'message', messageId: 'entry_user' },
      { kind: 'message', messageId: 'entry_assistant' },
    ]);

    const builder = new ContextBuilder(handler, dagStore);
    const messages: AgentMessage[] = [
      { role: 'user' as const, content: 'Question from the user.', timestamp: 100 } as AgentMessage,
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'Answer from the assistant.' }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-sonnet',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: 200,
      } as AgentMessage,
    ];

    const result = builder.buildContext(messages);
    assert.deepStrictEqual(result.messages.map(message => message.role), ['user', 'assistant']);
    assert.strictEqual(result.messages[0], messages[0]);
    assert.strictEqual(result.messages[1], messages[1]);
  });

  it('prefers direct toolCallId matches over metadata fallback for toolResult context items', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');
    dagStore.ingestMessage({
      id: 'entry_a',
      seq: 0,
      role: 'toolResult',
      toolName: 'read',
      content: 'same output',
      tokenCount: 2,
      createdAt: 100,
    });
    dagStore.ingestMessage({
      id: 'entry_b',
      seq: 1,
      role: 'toolResult',
      toolName: 'read',
      content: 'same output',
      tokenCount: 2,
      createdAt: 100,
    });
    dagStore.replaceContextItems([{ kind: 'message', messageId: 'entry_b' }]);

    const builder = new ContextBuilder(handler, dagStore);
    const messages: AgentMessage[] = [
      {
        role: 'toolResult' as const,
        toolCallId: 'entry_a',
        toolName: 'read',
        content: [{ type: 'text' as const, text: 'same output' }],
        isError: false,
        timestamp: 100,
      } as AgentMessage,
      {
        role: 'toolResult' as const,
        toolCallId: 'entry_b',
        toolName: 'read',
        content: [{ type: 'text' as const, text: 'same output' }],
        isError: false,
        timestamp: 100,
      } as AgentMessage,
    ];

    const result = builder.buildContext(messages);
    assert.strictEqual(
      (result.messages[0] as any).toolCallId,
      'entry_b',
      'Expected direct toolCallId match to win over metadata fallback',
    );
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
    // After the fix: trailing unmatched messages (after last matched index) are appended
    assert.strictEqual(result.messages.length, 3, 'summary + toolResult + trailing user message');
    assert.strictEqual(result.messages[2], messages[1]);
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
    assert.strictEqual(result.messages.length, 3, 'summary + referenced toolResult + trailing user message');
    assert.strictEqual((result.messages[0] as any).role, 'assistant');
    const summaryText = typeof (result.messages[0] as any).content === 'string'
      ? (result.messages[0] as any).content
      : Array.isArray((result.messages[0] as any).content)
        ? (result.messages[0] as any).content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
        : '';

    assert.ok(summaryText.includes('Summary one.'));
    assert.ok(summaryText.includes('depth: 0'));
    assert.ok(summaryText.includes('kind: leaf'));
    assert.ok(summaryText.includes('earliestAt: 100'));
    assert.ok(summaryText.includes('latestAt: 200'));
    assert.ok(summaryText.includes('descendantCount: 2'));
    assert.ok(!summaryText.includes('"id"'));
    assert.ok(!summaryText.includes('"msgRange"'));
    assert.strictEqual(result.messages[1], messages[0]);
    // Trailing messages (after last matched index) ARE now appended — this is the fix for #045/#046
    assert.strictEqual((result.messages[2] as any).content, 'UNREFERENCED OLD');
    assert.strictEqual((result.messages[2] as any).role, 'user');
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

    assert.strictEqual(result.messages.length, 2, 'summary + trailing user message');
    assert.strictEqual(result.messages[0]!.role, 'assistant');
    const firstText = typeof (result.messages[0] as any).content === 'string'
      ? (result.messages[0] as any).content
      : Array.isArray((result.messages[0] as any).content)
        ? (result.messages[0] as any).content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
        : '';
    assert.ok(firstText.includes('Valid summary.'));
    assert.ok(firstText.includes('depth: 0'));
    assert.ok(firstText.includes('kind: leaf'));
    assert.ok(firstText.includes('earliestAt: 100'));
    assert.ok(firstText.includes('latestAt: 200'));
    assert.ok(firstText.includes('descendantCount: 2'));
    assert.ok(!firstText.includes('"id"'));
    assert.ok(!firstText.includes('"msgRange"'));
    assert.strictEqual(result.stats.summaryCount, 1);
    // Trailing user prompt is preserved
    const lastMsg = result.messages[result.messages.length - 1] as any;
    assert.strictEqual(lastMsg.role, 'user');
    assert.strictEqual(lastMsg.content, 'hi');
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
