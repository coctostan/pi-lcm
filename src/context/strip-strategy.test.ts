import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { TextContent, ImageContent } from '@mariozechner/pi-ai';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import type { ContextStrategy } from './strip-strategy.ts';
import type { ContentStore } from './content-store.ts';

describe('ContextStrategy interface', () => {
  it('StripStrategy implements ContextStrategy (AC 17)', () => {
    const strategy: ContextStrategy = new StripStrategy();
    assert.ok(strategy);
    assert.strictEqual(typeof strategy.transformOldMessages, 'function');
  });
});

describe('StripStrategy — toolResult replacement', () => {
  it('replaces toolResult content with placeholder containing toolCallId (AC 8)', () => {
    const strategy = new StripStrategy();
    const store = new MemoryContentStore();
    const messages: AgentMessage[] = [
      {
        role: 'toolResult' as const,
        toolCallId: 'call_abc123',
        toolName: 'read',
        content: [{ type: 'text' as const, text: 'file contents here' }],
        isError: false,
        timestamp: 1000,
      },
    ];
    const result = strategy.transformOldMessages(messages, store);
    assert.strictEqual(result.length, 1);
    const msg = result[0] as { role: string; content: (TextContent | ImageContent)[] };
    assert.strictEqual(msg.role, 'toolResult');
    assert.strictEqual(msg.content.length, 1);
    assert.strictEqual(msg.content[0].type, 'text');
    assert.strictEqual(
      (msg.content[0] as TextContent).text,
      '[Content stripped by LCM. Use lcm_expand("call_abc123") to retrieve.]'
    );
  });

  it('stores original content in ContentStore keyed by toolCallId before replacing (AC 9)', () => {
    const strategy = new StripStrategy();
    const store = new MemoryContentStore();
    const originalContent: (TextContent | ImageContent)[] = [
      { type: 'text', text: 'original data' },
      { type: 'image', data: 'imgdata', mimeType: 'image/png' },
    ];
    const messages: AgentMessage[] = [
      {
        role: 'toolResult' as const,
        toolCallId: 'call_xyz',
        toolName: 'bash',
        content: originalContent,
        isError: false,
        timestamp: 2000,
      },
    ];
    strategy.transformOldMessages(messages, store);
    assert.strictEqual(store.has('call_xyz'), true);
    assert.deepStrictEqual(store.get('call_xyz'), originalContent);
  });
});

describe('StripStrategy — passthrough and edge cases', () => {
  it('passes through user messages unmodified (AC 10)', () => {
    const strategy = new StripStrategy();
    const store = new MemoryContentStore();
    const userMsg: AgentMessage = {
      role: 'user' as const,
      content: 'hello',
      timestamp: 1000,
    };
    const result = strategy.transformOldMessages([userMsg], store);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], userMsg); // same reference
  });

  it('passes through assistant messages unmodified (AC 10)', () => {
    const strategy = new StripStrategy();
    const store = new MemoryContentStore();
    const assistantMsg: AgentMessage = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'response' }],
      api: 'anthropic-messages' as const,
      provider: 'anthropic',
      model: 'claude-sonnet',
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop' as const,
      timestamp: 2000,
    };
    const result = strategy.transformOldMessages([assistantMsg], store);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], assistantMsg); // same reference
  });

  it('skips stripping when ContentStore.set returns false (AC 11)', () => {
    const strategy = new StripStrategy();
    const failingStore: ContentStore = {
      set: () => false,
      get: () => undefined,
      has: () => false,
      keys: () => [],
    };
    const originalContent: (TextContent | ImageContent)[] = [
      { type: 'text', text: 'should stay' },
    ];
    const messages: AgentMessage[] = [
      {
        role: 'toolResult' as const,
        toolCallId: 'call_fail',
        toolName: 'read',
        content: originalContent,
        isError: false,
        timestamp: 3000,
      },
    ];
    const result = strategy.transformOldMessages(messages, failingStore);
    const msg = result[0] as { content: (TextContent | ImageContent)[] };
    assert.deepStrictEqual(msg.content, originalContent);
  });

  it('handles toolResult with empty content array as no-op (AC 12)', () => {
    const strategy = new StripStrategy();
    const store = new MemoryContentStore();
    const messages: AgentMessage[] = [
      {
        role: 'toolResult' as const,
        toolCallId: 'call_empty',
        toolName: 'read',
        content: [],
        isError: false,
        timestamp: 4000,
      },
    ];
    const result = strategy.transformOldMessages(messages, store);
    const msg = result[0] as { content: (TextContent | ImageContent)[] };
    assert.deepStrictEqual(msg.content, []);
    assert.strictEqual(store.has('call_empty'), false); // no store write
  });
});
