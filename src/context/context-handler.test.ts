import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { TextContent, ImageContent } from '@mariozechner/pi-ai';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import type { ContextStrategy } from './strip-strategy.ts';

function makeToolResult(id: string, text: string): AgentMessage {
  return {
    role: 'toolResult' as const,
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text' as const, text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function makeUserMsg(text: string): AgentMessage {
  return {
    role: 'user' as const,
    content: text,
    timestamp: Date.now(),
  };
}

describe('ContextHandler — passthrough cases', () => {
  it('returns original array when messages.length <= freshTailCount (AC 1)', () => {
    const store = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, store, { freshTailCount: 32 });

    const messages: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeToolResult(`call_${i}`, `content ${i}`));
    }

    const result = handler.process(messages);
    assert.strictEqual(result.messages, messages); // same reference
    assert.strictEqual(result.stats.strippedCount, 0);
    assert.strictEqual(result.stats.estimatedTokensSaved, 0);
  });

  it('returns original array when messages.length === freshTailCount (AC 1)', () => {
    const store = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, store, { freshTailCount: 32 });

    const messages: AgentMessage[] = [];
    for (let i = 0; i < 32; i++) {
      messages.push(makeToolResult(`call_${i}`, `content ${i}`));
    }

    const result = handler.process(messages);
    assert.strictEqual(result.messages, messages);
  });

  it('returns original array when messages is empty (AC 2)', () => {
    const store = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, store, { freshTailCount: 32 });

    const result = handler.process([]);
    assert.deepStrictEqual(result.messages, []);
    assert.strictEqual(result.stats.strippedCount, 0);
  });

  it('returns original array when messages is undefined (AC 2)', () => {
    const store = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, store, { freshTailCount: 32 });

    const result = handler.process(undefined as unknown as AgentMessage[]);
    assert.strictEqual(result.stats.strippedCount, 0);
  });
});

describe('ContextHandler — split and reassemble', () => {
  it('splits old/fresh and delegates only old to strategy; fresh tail preserved by reference (AC 3, 4)', () => {
    const store = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, store, { freshTailCount: 3 });

    const messages: AgentMessage[] = [
      makeToolResult('call_0', 'old content 0'),
      makeUserMsg('old user msg'),
      makeToolResult('call_1', 'old content 1'),
      makeUserMsg('fresh 1'),
      makeToolResult('call_2', 'fresh content 2'),
      makeUserMsg('fresh 3'),
    ];

    const result = handler.process(messages);

    // Fresh tail (last 3) should be untouched — same references
    assert.strictEqual(result.messages[3], messages[3]);
    assert.strictEqual(result.messages[4], messages[4]);
    assert.strictEqual(result.messages[5], messages[5]);

    // Old toolResult messages should be stripped
    const msg0 = result.messages[0] as { role: string; content: (TextContent | ImageContent)[] };
    assert.strictEqual(msg0.role, 'toolResult');
    assert.strictEqual(
      (msg0.content[0] as TextContent).text,
      '[Content stripped by LCM. Use lcm_expand("call_0") to retrieve.]'
    );

    // Old user message — deep-cloned, not same reference (AC 6)
    assert.notStrictEqual(result.messages[1], messages[1]);
    assert.deepStrictEqual(result.messages[1], messages[1]);

    const msg2 = result.messages[2] as { role: string; content: (TextContent | ImageContent)[] };
    assert.strictEqual(
      (msg2.content[0] as TextContent).text,
      '[Content stripped by LCM. Use lcm_expand("call_1") to retrieve.]'
    );

    // Total 6 messages preserved
    assert.strictEqual(result.messages.length, 6);
  });

  it('does not mutate original message objects (AC 6)', () => {
    const store = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, store, { freshTailCount: 2 });

    const originalContent: (TextContent | ImageContent)[] = [
      { type: 'text', text: 'original text' },
    ];
    const toolMsg: AgentMessage = {
      role: 'toolResult' as const,
      toolCallId: 'call_mut',
      toolName: 'read',
      content: originalContent,
      isError: false,
      timestamp: 1000,
    };
    const freshMsg = makeUserMsg('fresh');
    const freshMsg2 = makeUserMsg('fresh2');
    const messages = [toolMsg, freshMsg, freshMsg2];

    // Deep copy for comparison
    const originalToolMsg = JSON.parse(JSON.stringify(toolMsg));

    handler.process(messages);

    // Original message must not be mutated
    assert.deepStrictEqual(toolMsg, originalToolMsg);
    assert.strictEqual((toolMsg as any).content, originalContent); // same reference
  });

  it('returns stats with stripped count and estimated tokens saved (AC 7)', () => {
    const store = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, store, { freshTailCount: 2 });

    // 'abcdefghijklmnop' = 16 chars => 16/4 = 4 estimated tokens
    const messages: AgentMessage[] = [
      {
        role: 'toolResult' as const,
        toolCallId: 'call_s1',
        toolName: 'read',
        content: [{ type: 'text' as const, text: 'abcdefghijklmnop' }], // 16 chars
        isError: false,
        timestamp: 1000,
      },
      {
        role: 'toolResult' as const,
        toolCallId: 'call_s2',
        toolName: 'bash',
        content: [{ type: 'text' as const, text: '12345678' }], // 8 chars
        isError: false,
        timestamp: 2000,
      },
      makeUserMsg('fresh 1'),
      makeUserMsg('fresh 2'),
    ];

    const result = handler.process(messages);
    assert.strictEqual(result.stats.strippedCount, 2);
    // (16 + 8) / 4 = 6
    assert.strictEqual(result.stats.estimatedTokensSaved, 6);
  });
});

describe('ContextHandler — error recovery', () => {
  it('returns original unmodified messages if strategy throws (AC 5)', () => {
    const store = new MemoryContentStore();
    const throwingStrategy: ContextStrategy = {
      transformOldMessages: () => {
        throw new Error('strategy exploded');
      },
    };
    const handler = new ContextHandler(throwingStrategy, store, { freshTailCount: 2 });
    const messages: AgentMessage[] = [
      makeToolResult('call_err1', 'content 1'),
      makeToolResult('call_err2', 'content 2'),
      makeUserMsg('fresh 1'),
      makeUserMsg('fresh 2'),
    ];

    const result = handler.process(messages);
    assert.strictEqual(result.messages, messages); // same reference
    assert.strictEqual(result.stats.strippedCount, 0);
    assert.strictEqual(result.stats.estimatedTokensSaved, 0);
  });
});
