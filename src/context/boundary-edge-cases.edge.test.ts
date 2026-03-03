import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';

function makeToolResult(id: string, text: string): AgentMessage {
  return {
    role: 'toolResult' as const,
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text' as const, text }],
    isError: false,
    timestamp: 0,
  };
}

describe('ContextHandler — boundary/guard edge cases return complete zero stats (AC 10, 12, 13)', () => {
  it('messages.length === freshTailCount returns original array and complete zero stats', () => {
    const store = new MemoryContentStore();
    const handler = new ContextHandler(new StripStrategy(), store, { freshTailCount: 32 });

    const messages: AgentMessage[] = [];
    for (let i = 0; i < 32; i++) messages.push(makeToolResult(`call_${i}`, `content ${i}`));

    const result = handler.process(messages);

    assert.strictEqual(result.messages, messages);
    assert.deepStrictEqual(result.stats, { strippedCount: 0, estimatedTokensSaved: 0 });
    assert.deepStrictEqual(store.keys(), []);
  });

  it('empty array returns { messages: [], stats: { strippedCount: 0, estimatedTokensSaved: 0 } }', () => {
    const store = new MemoryContentStore();
    const handler = new ContextHandler(new StripStrategy(), store, { freshTailCount: 32 });

    const result = handler.process([]);

    assert.deepStrictEqual(result.messages, []);
    assert.deepStrictEqual(result.stats, { strippedCount: 0, estimatedTokensSaved: 0 });
    assert.deepStrictEqual(store.keys(), []);
  });

  it('undefined returns { messages: [], stats: { strippedCount: 0, estimatedTokensSaved: 0 } }', () => {
    const store = new MemoryContentStore();
    const handler = new ContextHandler(new StripStrategy(), store, { freshTailCount: 32 });

    const result = handler.process(undefined as unknown as AgentMessage[]);

    assert.deepStrictEqual(result.messages, []);
    assert.deepStrictEqual(result.stats, { strippedCount: 0, estimatedTokensSaved: 0 });
    assert.deepStrictEqual(store.keys(), []);
  });
});
