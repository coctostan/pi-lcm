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

describe('Bug #039 — flattened summary preamble replaces inline ordered summary messages', () => {
  it('keeps interleaved summaries inline/in order instead of collapsing them into one preamble', () => {
    const handler = new ContextHandler(new StripStrategy(), new MemoryContentStore(), { freshTailCount: 32 });
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_039', '/tmp/project');

    const summaryA = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Older summary A.',
      tokenCount: 12,
      earliestAt: 100,
      latestAt: 110,
      descendantCount: 1,
      createdAt: 120,
    });

    dagStore.ingestMessage({
      id: 'mid_assistant',
      seq: 0,
      role: 'assistant',
      content: 'Midpoint assistant reply.',
      tokenCount: 4,
      createdAt: 150,
    });

    const summaryB = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Later summary B.',
      tokenCount: 12,
      earliestAt: 200,
      latestAt: 210,
      descendantCount: 1,
      createdAt: 220,
    });

    dagStore.ingestMessage({
      id: 'live_user',
      seq: 1,
      role: 'user',
      content: 'Live user turn.',
      tokenCount: 3,
      createdAt: 300,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId: summaryA },
      { kind: 'message', messageId: 'mid_assistant' },
      { kind: 'summary', summaryId: summaryB },
      { kind: 'message', messageId: 'live_user' },
    ]);

    const assistantMid = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'Midpoint assistant reply.' }],
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
      timestamp: 150,
    } as AgentMessage;

    const liveUser = {
      role: 'user' as const,
      content: 'Live user turn.',
      timestamp: 300,
    } as AgentMessage;

    const result = new ContextBuilder(handler, dagStore).buildContext([assistantMid, liveUser]);

    assert.deepStrictEqual(
      result.messages.map((message) => message.role),
      ['assistant', 'assistant', 'assistant', 'user'],
      'Expected summary items to stay inline around the preserved assistant and final live user turn',
    );

    const rendered = result.messages.map(textOf);
    assert.ok(!rendered.some((text) => text.includes('[LCM Context Summary')));
    assert.ok(!rendered.some((text) => text.includes('Summary 1:')));
    assert.strictEqual(rendered[0], 'Older summary A.');
    assert.strictEqual(rendered[1], 'Midpoint assistant reply.');
    assert.strictEqual(rendered[2], 'Later summary B.');
    assert.strictEqual(rendered[3], 'Live user turn.');
  });
});
