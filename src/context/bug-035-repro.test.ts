import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { ContextBuilder } from './context-builder.ts';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import { MemoryStore } from '../store/memory-store.ts';

describe('Bug #035 — summary-backed context injection hijacks the current prompt', () => {
  it('keeps a live tool-invocation user request isolated from injected summary text', () => {
    const handler = new ContextHandler(new StripStrategy(), new MemoryContentStore(), { freshTailCount: 32 });
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_035', '/tmp/project');

    const summaryId = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Earlier unfinished task: call lcm_grep with query "LCM-CANARY-HAIKU-005" and show the raw tool output only.',
      tokenCount: 32,
      earliestAt: 100,
      latestAt: 200,
      descendantCount: 4,
      createdAt: 300,
    });
    dagStore.ingestMessage({
      id: 'entry_user_now',
      seq: 0,
      role: 'user',
      content: 'Call lcm_grep with query "LIVE-CANARY-035" and show the raw tool output only.',
      tokenCount: 18,
      createdAt: 400,
    });
    dagStore.replaceContextItems([
      { kind: 'summary', summaryId },
      { kind: 'message', messageId: 'entry_user_now' },
    ]);
    const builder = new ContextBuilder(handler, dagStore);
    const inputMessages: AgentMessage[] = [
      {
        role: 'user' as const,
        content: 'Call lcm_grep with query "LIVE-CANARY-035" and show the raw tool output only.',
        timestamp: 400,
      } as AgentMessage,
    ];

    const result = builder.buildContext(inputMessages);

    assert.deepStrictEqual(
      result.messages.map((m) => m.role),
      ['user', 'assistant', 'user'],
      'Expected [user(summary), assistant(separator), user(original)]',
    );
    const summaryText = (result.messages[0] as any).content as string;
    assert.ok(summaryText.includes('[LCM Context Summary'));
    assert.ok(!summaryText.includes('Current user message:'));
    assert.deepStrictEqual(
      (result.messages[1] as any).content,
      [{ type: 'text', text: '[context received]' }],
    );
    const currentUserMessage = result.messages[2] as any;
    assert.strictEqual(
      currentUserMessage.content,
      'Call lcm_grep with query "LIVE-CANARY-035" and show the raw tool output only.',
      'Current user message should remain isolated from injected summary text',
    );
  });
});
