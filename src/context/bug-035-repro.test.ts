import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { ContextBuilder } from './context-builder.ts';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import { MemoryStore } from '../store/memory-store.ts';

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

describe('Bug #035 — summary-backed context injection hijacks the current prompt', () => {
  it('emits the persisted summary as a standalone assistant message before the live user turn', () => {
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
      ['assistant', 'user'],
      'Historical summary should be emitted as a standalone assistant message before the live user turn',
    );

    const summaryText = textOf(result.messages[0]!);
    assert.strictEqual(
      summaryText,
      'Earlier unfinished task: call lcm_grep with query "LCM-CANARY-HAIKU-005" and show the raw tool output only.',
      'Historical summary should be emitted as a standalone assistant message before the live user turn',
    );
    assert.ok(!summaryText.includes('[LCM Context Summary'));
    assert.ok(!summaryText.includes('Summary 1:'));
    assert.ok(!summaryText.includes('[context received]'));

    const currentUserText = textOf(result.messages[1]!);
    assert.strictEqual(
      currentUserText,
      'Call lcm_grep with query "LIVE-CANARY-035" and show the raw tool output only.',
      'Live user text should remain the final message unchanged',
    );
  });
});
