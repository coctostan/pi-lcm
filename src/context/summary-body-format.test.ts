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

describe('Summary body fits memory-object wrapper (AC 7)', () => {
  it('structured four-section body composes correctly with metadata header', () => {
    const handler = new ContextHandler(new StripStrategy(), new MemoryContentStore(), { freshTailCount: 32 });
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_body', '/tmp/project');

    // Simulate a summary with the new four-section structured body
    const structuredBody = [
      'Facts:',
      '- User requested config documentation.',
      '- Assistant read config.ts and listed 5 options.',
      '',
      'Decisions:',
      '- Decided to use JSON format for config file.',
      '',
      'Open threads at end of covered span:',
      '- Documentation PR had been drafted but not yet submitted.',
      '',
      'Key artifacts / identifiers:',
      '- src/config.ts, pi-lcm.config.json, freshTailCount',
    ].join('\n');

    const summaryId = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: structuredBody,
      tokenCount: 40,
      earliestAt: 100,
      latestAt: 500,
      descendantCount: 4,
      createdAt: 600,
    });

    dagStore.ingestMessage({
      id: 'user_body_test',
      seq: 0,
      role: 'user',
      content: 'next question',
      tokenCount: 3,
      createdAt: 1000,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId },
      { kind: 'message', messageId: 'user_body_test' },
    ]);

    const builder = new ContextBuilder(handler, dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'next question', timestamp: 1000 } as AgentMessage,
    ]);

    assert.strictEqual(result.messages.length >= 2, true, 'Should have at least summary + user');
    const summaryText = textOf(result.messages[0]!);

    // Verify structured body sections are present
    assert.ok(summaryText.includes('Facts:'), 'Should contain Facts section');
    assert.ok(summaryText.includes('Decisions:'), 'Should contain Decisions section');
    assert.ok(summaryText.includes('Open threads at end of covered span:'), 'Should contain Open threads section');
    assert.ok(summaryText.includes('Key artifacts / identifiers:'), 'Should contain Key artifacts section');

    // Verify metadata header is also present
    assert.ok(summaryText.includes(`summaryId: ${summaryId}`), 'Should contain summaryId');
    assert.ok(summaryText.includes('depth: 0'), 'Should contain depth');
    assert.ok(summaryText.includes('kind: leaf'), 'Should contain kind');
    assert.ok(summaryText.includes('earliestAt: 100'), 'Should contain earliestAt');
    assert.ok(summaryText.includes('latestAt: 500'), 'Should contain latestAt');
    assert.ok(summaryText.includes('descendantCount: 4'), 'Should contain descendantCount');

    // Verify body comes first, then metadata (current formatSummaryText layout)
    const factsIdx = summaryText.indexOf('Facts:');
    const summaryIdIdx = summaryText.indexOf('summaryId:');
    assert.ok(factsIdx < summaryIdIdx, 'Body should come before metadata in the formatted text');

    // Live user turn is last
    const lastMsg = result.messages[result.messages.length - 1]!;
    assert.strictEqual(lastMsg.role, 'user');
    assert.strictEqual(textOf(lastMsg), 'next question');
  });
});
