import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { ContextBuilder } from './context-builder.ts';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import { MemoryStore } from '../store/memory-store.ts';

/**
 * Bug #045/#046 regression tests:
 *
 * After compaction, ContextBuilder.buildContext() iterates only over stored
 * context items and matches each against input messages. The latest user
 * prompt has not been ingested yet (ingestion happens in agent_end, after
 * the model responds), so it has no matching context item and is silently
 * dropped from the assembled output.
 *
 * This causes:
 * - claude-sonnet-4-6: 400 "assistant message prefill not supported"
 *   (conversation ends with assistant role)
 * - Other models: confused/echoed responses (silent prefill)
 */
describe('Bug #045/#046: post-compaction message assembly drops latest user prompt', () => {
  it('should include the latest user prompt even when it has no matching context item', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    // Simulate post-compaction state: a summary covering old messages,
    // plus one retained assistant message
    const summaryId = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Messages 1-5: user discussed project setup and config.',
      tokenCount: 50,
      earliestAt: 100,
      latestAt: 500,
      descendantCount: 5,
      createdAt: 600,
    });

    // Retained assistant message that was the last ingested turn
    dagStore.ingestMessage({
      id: 'entry_assistant_6',
      seq: 6,
      role: 'assistant',
      content: 'Here is the config file you requested.',
      tokenCount: 8,
      createdAt: 700,
    });

    // Context items: summary + the retained assistant message
    dagStore.replaceContextItems([
      { kind: 'summary', summaryId },
      { kind: 'message', messageId: 'entry_assistant_6' },
    ]);

    const builder = new ContextBuilder(handler, dagStore);

    // Input messages include the retained assistant message (matched)
    // and the latest user prompt (NOT yet ingested, no context item)
    const messages: AgentMessage[] = [
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'Here is the config file you requested.' }],
        timestamp: 700,
      } as AgentMessage,
      {
        role: 'user' as const,
        content: 'Now please explain how the config works.',
        timestamp: 800,
      } as AgentMessage,
    ];

    const result = builder.buildContext(messages);

    // The assembled messages should be:
    // 1. Summary (assistant role) — from context item
    // 2. Retained assistant message — from context item
    // 3. Latest user prompt — NOT in context items but must be preserved
    const lastMessage = result.messages[result.messages.length - 1] as any;

    assert.strictEqual(
      lastMessage.role,
      'user',
      'Assembled messages must end with the latest user prompt, not an assistant message',
    );
    assert.strictEqual(
      lastMessage.content,
      'Now please explain how the config works.',
      'Latest user prompt content must be preserved',
    );
    assert.ok(
      result.messages.length >= 3,
      `Expected at least 3 messages (summary + assistant + user prompt), got ${result.messages.length}`,
    );
  });

  it('should preserve the latest user prompt when context items contain only summaries', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    const summaryId = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Entire conversation summarized.',
      tokenCount: 40,
      earliestAt: 100,
      latestAt: 500,
      descendantCount: 10,
      createdAt: 600,
    });

    dagStore.replaceContextItems([{ kind: 'summary', summaryId }]);

    const builder = new ContextBuilder(handler, dagStore);
    const messages: AgentMessage[] = [
      {
        role: 'user' as const,
        content: 'What is the meaning of life?',
        timestamp: 700,
      } as AgentMessage,
    ];

    const result = builder.buildContext(messages);

    // Should have: summary (assistant) + user prompt
    const lastMessage = result.messages[result.messages.length - 1] as any;
    assert.strictEqual(
      lastMessage.role,
      'user',
      'Must end with user prompt, not assistant summary',
    );
    assert.strictEqual(
      lastMessage.content,
      'What is the meaning of life?',
    );
    assert.ok(
      result.messages.length >= 2,
      `Expected at least 2 messages (summary + user prompt), got ${result.messages.length}`,
    );
  });

  it('assembled messages must not end with assistant role (causes 400 on sonnet-4-6)', () => {
    const contentStore = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    // Typical post-compaction: summary + retained fresh-tail messages + new user prompt
    const summaryId = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'User asked about file structure.',
      tokenCount: 30,
      earliestAt: 100,
      latestAt: 300,
      descendantCount: 3,
      createdAt: 400,
    });

    dagStore.ingestMessage({
      id: 'entry_user_4',
      seq: 4,
      role: 'user',
      content: 'Show me the main file.',
      tokenCount: 5,
      createdAt: 500,
    });
    dagStore.ingestMessage({
      id: 'entry_assistant_5',
      seq: 5,
      role: 'assistant',
      content: 'Here is the main file content.',
      tokenCount: 6,
      createdAt: 600,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId },
      { kind: 'message', messageId: 'entry_user_4' },
      { kind: 'message', messageId: 'entry_assistant_5' },
    ]);

    const builder = new ContextBuilder(handler, dagStore);

    // All 3 input messages: the 2 retained ones + the NEW user prompt
    const messages: AgentMessage[] = [
      {
        role: 'user' as const,
        content: 'Show me the main file.',
        timestamp: 500,
      } as AgentMessage,
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'Here is the main file content.' }],
        timestamp: 600,
      } as AgentMessage,
      {
        role: 'user' as const,
        content: 'Now explain the exports.',
        timestamp: 700,
      } as AgentMessage,
    ];

    const result = builder.buildContext(messages);
    const roles = result.messages.map((m: any) => m.role);
    const lastRole = roles[roles.length - 1];

    assert.strictEqual(
      lastRole,
      'user',
      `Conversation must end with user role for API compatibility. ` +
      `Got roles: [${roles.join(', ')}]. ` +
      `claude-sonnet-4-6 returns 400 "assistant message prefill not supported" when it ends with assistant.`,
    );

    // Verify the actual latest prompt content is present
    const lastMsg = result.messages[result.messages.length - 1] as any;
    assert.strictEqual(lastMsg.content, 'Now explain the exports.');
  });
});
