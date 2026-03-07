/**
 * Reproduction test for issue #026.
 * This test FAILS until ContextBuilder can resolve user/assistant message-kind
 * context items from context-event AgentMessage objects that do not expose
 * session entry IDs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEntry } from '@mariozechner/pi-coding-agent';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { ContextBuilder } from './context-builder.ts';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import { MemoryStore } from '../store/memory-store.ts';
import { ingestNewMessages } from '../ingestion/ingest.ts';

function createBuilder(store: MemoryStore): ContextBuilder {
  const contentStore = new MemoryContentStore();
  const strategy = new StripStrategy();
  const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });
  return new ContextBuilder(handler, store);
}

describe('Bug #026 — ContextBuilder drops user/assistant context_items without entry ids', () => {
  it('should preserve user/assistant messages referenced by context_items after summary injection', () => {
    const store = new MemoryStore();
    store.openConversation('sess_bug_026', '/tmp/project');

    const branch: SessionEntry[] = [
      {
        type: 'message',
        id: 'entry_user',
        parentId: null,
        timestamp: new Date(1000).toISOString(),
        message: { role: 'user', content: 'User asks for a bug reproduction.', timestamp: 1000 },
      } as SessionEntry,
      {
        type: 'message',
        id: 'entry_assistant',
        parentId: 'entry_user',
        timestamp: new Date(2000).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Assistant acknowledges and asks for details.' }],
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
          timestamp: 2000,
        },
      } as SessionEntry,
    ];

    const ingested = ingestNewMessages(store, { sessionManager: { getBranch: () => branch } } as any);
    assert.strictEqual(ingested, 2);
    assert.deepStrictEqual(store.getContextItems(), [
      { kind: 'message', messageId: 'entry_user' },
      { kind: 'message', messageId: 'entry_assistant' },
    ]);

    const storedUser = store.getMessage('entry_user');
    assert.ok(storedUser, 'Expected entry_user to be retrievable from the store');
    assert.strictEqual(storedUser!.role, 'user');
    assert.strictEqual(storedUser!.content, 'User asks for a bug reproduction.');
    assert.strictEqual(storedUser!.createdAt, 1000);

    const storedAssistant = store.getMessage('entry_assistant');
    assert.ok(storedAssistant, 'Expected entry_assistant to be retrievable from the store');
    assert.strictEqual(storedAssistant!.role, 'assistant');
    assert.strictEqual(storedAssistant!.content, 'Assistant acknowledges and asks for details.');
    assert.strictEqual(storedAssistant!.createdAt, 2000);

    const summaryId = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Summary for prior condensed context.',
      tokenCount: 12,
      earliestAt: 1000,
      latestAt: 2000,
      descendantCount: 2,
      createdAt: 3000,
    });

    store.replaceContextItems([
      { kind: 'summary', summaryId },
      { kind: 'message', messageId: 'entry_user' },
      { kind: 'message', messageId: 'entry_assistant' },
    ]);

    const eventMessages: AgentMessage[] = [
      {
        role: 'user',
        content: 'User asks for a bug reproduction.',
        timestamp: 1000,
      } as AgentMessage,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Assistant acknowledges and asks for details.' }],
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
        timestamp: 2000,
      } as AgentMessage,
    ];

    const result = createBuilder(store).buildContext(eventMessages);
    const summaryMessage = result.messages[0] as any;
    assert.strictEqual(summaryMessage.role, 'user');
    const summaryText = typeof summaryMessage.content === 'string'
      ? summaryMessage.content
      : Array.isArray(summaryMessage.content)
        ? summaryMessage.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
        : '';

    assert.ok(summaryText.startsWith('[LCM Context Summary \u2014 this summarizes earlier parts of the conversation]'));
    assert.ok(summaryText.includes('Summary 1: Summary for prior condensed context.'));
    assert.ok(summaryText.includes('Current user message: User asks for a bug reproduction.'));
    assert.ok(!summaryText.includes('"id"'));
    assert.ok(!summaryText.includes('"msgRange"'));
    assert.strictEqual(result.messages[1], eventMessages[1]);
    assert.deepStrictEqual(
      result.messages.map(message => message.role),
      ['user', 'assistant'],
      `Expected framed summary + referenced assistant, got roles: ${result.messages.map(message => message.role).join(', ')}`,
    );
  });
});
