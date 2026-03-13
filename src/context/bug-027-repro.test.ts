import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { ContextBuilder } from './context-builder.ts';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import { MemoryStore } from '../store/memory-store.ts';

function makeBuilder(dagStore: MemoryStore): ContextBuilder {
  const contentStore = new MemoryContentStore();
  const strategy = new StripStrategy();
  const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });
  return new ContextBuilder(handler, dagStore);
}

function textOf(message: AgentMessage): string {
  const content = (message as any).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join('\n');
  }
  return '';
}

describe('Bug 027 — emit assistant summaries for short leading summary runs', () => {
  it('emits two leading summaries as standalone assistant messages before the live user turn', () => {
    const store = new MemoryStore();
    store.openConversation('sess_027_merge', '/tmp/project');

    const sid1 = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'The marker word is BANANA.',
      tokenCount: 20,
      earliestAt: 100,
      latestAt: 200,
      descendantCount: 2,
      createdAt: 300,
    });

    const sid2 = store.insertSummary({
      depth: 1,
      kind: 'condensed',
      content: 'The assistant asked follow-up questions about configuration.',
      tokenCount: 25,
      earliestAt: 100,
      latestAt: 250,
      descendantCount: 4,
      createdAt: 350,
    });

    store.ingestMessage({
      id: 'msg_user',
      seq: 0,
      role: 'user',
      content: 'What was the marker word?',
      tokenCount: 5,
      createdAt: 400,
    });

    store.replaceContextItems([
      { kind: 'summary', summaryId: sid1 },
      { kind: 'summary', summaryId: sid2 },
      { kind: 'message', messageId: 'msg_user' },
    ]);

    const messages: AgentMessage[] = [
      { role: 'user', content: 'What was the marker word?', timestamp: 400 } as AgentMessage,
      { role: 'user', content: 'UNREFERENCED OLD', timestamp: 401 } as AgentMessage,
    ];

    const result = makeBuilder(store).buildContext(messages);

    assert.deepStrictEqual(
      result.messages.map((m) => m.role),
      ['assistant', 'assistant', 'user'],
      'Historical summaries should be emitted as standalone assistant messages before the live user turn',
    );

    assert.strictEqual(textOf(result.messages[0]!), 'The marker word is BANANA.');
    assert.strictEqual(
      textOf(result.messages[1]!),
      'The assistant asked follow-up questions about configuration.',
    );
    assert.strictEqual(textOf(result.messages[2]!), 'What was the marker word?');

    const renderedTexts = result.messages.map((m) => textOf(m));
    for (const text of renderedTexts) {
      assert.ok(!text.includes('[LCM Context Summary'));
      assert.ok(!text.includes('Summary 1:'));
      assert.ok(!text.includes('[context received]'));
    }

    assert.ok(!result.messages.some((m) => textOf(m).includes('UNREFERENCED OLD')));
    assert.strictEqual(result.stats.summaryCount, 2);
    assert.strictEqual(result.stats.maxDepth, 1);
  });

  it('emits two leading summaries as standalone assistant messages before a referenced toolResult', () => {
    const store = new MemoryStore();
    store.openConversation('sess_027_tool', '/tmp/project');

    const sid1 = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Tool read output contained tsconfig updates.',
      tokenCount: 18,
      earliestAt: 100,
      latestAt: 180,
      descendantCount: 2,
      createdAt: 200,
    });

    const sid2 = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'The user requested a focused patch.',
      tokenCount: 15,
      earliestAt: 181,
      latestAt: 220,
      descendantCount: 2,
      createdAt: 230,
    });

    store.ingestMessage({
      id: 'msg_tool',
      seq: 0,
      role: 'toolResult',
      toolName: 'read',
      content: 'tsconfig content',
      tokenCount: 6,
      createdAt: 300,
    });

    store.replaceContextItems([
      { kind: 'summary', summaryId: sid1 },
      { kind: 'summary', summaryId: sid2 },
      { kind: 'message', messageId: 'msg_tool' },
    ]);

    const messages: AgentMessage[] = [
      {
        role: 'toolResult',
        toolCallId: 'msg_tool',
        toolName: 'read',
        content: [{ type: 'text', text: 'tsconfig content' }],
        isError: false,
        timestamp: 300,
      } as AgentMessage,
      { role: 'user', content: 'UNREFERENCED USER', timestamp: 301 } as AgentMessage,
    ];

    const result = makeBuilder(store).buildContext(messages);

    assert.deepStrictEqual(result.messages.map((m) => m.role), ['assistant', 'assistant', 'toolResult']);
    assert.strictEqual(textOf(result.messages[0]!), 'Tool read output contained tsconfig updates.');
    assert.strictEqual(textOf(result.messages[1]!), 'The user requested a focused patch.');
    assert.strictEqual(result.messages[2], messages[0]);

    const renderedTexts = result.messages.map((m) => textOf(m));
    for (const text of renderedTexts) {
      assert.ok(!text.includes('[LCM Context Summary'));
      assert.ok(!text.includes('Summary 1:'));
      assert.ok(!text.includes('[context received]'));
    }

    assert.ok(!result.messages.some((m) => textOf(m).includes('UNREFERENCED USER')));
    assert.strictEqual(result.stats.summaryCount, 2);
    assert.strictEqual(result.stats.maxDepth, 0);
  });

  it('emits one leading summary as a standalone assistant message before a referenced assistant message', () => {
    const store = new MemoryStore();
    store.openConversation('sess_027_assistant', '/tmp/project');

    const sid = store.insertSummary({
      depth: 1,
      kind: 'condensed',
      content: 'Assistant already proposed a migration plan.',
      tokenCount: 22,
      earliestAt: 100,
      latestAt: 250,
      descendantCount: 3,
      createdAt: 300,
    });

    store.ingestMessage({
      id: 'msg_assistant',
      seq: 0,
      role: 'assistant',
      content: 'I can now apply the patch.',
      tokenCount: 6,
      createdAt: 400,
    });

    store.replaceContextItems([
      { kind: 'summary', summaryId: sid },
      { kind: 'message', messageId: 'msg_assistant' },
    ]);

    const assistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'I can now apply the patch.' }],
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
      timestamp: 400,
    } as AgentMessage;

    const result = makeBuilder(store).buildContext([
      assistantMessage,
      {
        role: 'toolResult',
        toolCallId: 'unref',
        toolName: 'read',
        content: [{ type: 'text', text: 'UNREF' }],
        isError: false,
        timestamp: 401,
      } as AgentMessage,
    ]);

    assert.deepStrictEqual(result.messages.map((m) => m.role), ['assistant', 'assistant']);
    assert.strictEqual(textOf(result.messages[0]!), 'Assistant already proposed a migration plan.');
    assert.strictEqual(result.messages[1], assistantMessage);

    const renderedTexts = result.messages.map((m) => textOf(m));
    for (const text of renderedTexts) {
      assert.ok(!text.includes('[LCM Context Summary'));
      assert.ok(!text.includes('Summary 1:'));
      assert.ok(!text.includes('[context received]'));
    }

    assert.ok(!result.messages.some((m) => textOf(m).includes('UNREF')));
    assert.strictEqual(result.stats.summaryCount, 1);
    assert.strictEqual(result.stats.maxDepth, 1);
  });
});
