import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { TextContent, ImageContent } from '@mariozechner/pi-ai';
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

function makeAssistantMsg(text: string): AgentMessage {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'anthropic-messages' as const,
    provider: 'anthropic',
    model: 'claude-sonnet',
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  };
}

describe('End-to-end integration — 50 messages, freshTailCount=32 (AC 19)', () => {
  it('strips only toolResult messages in the first 18, populates store, leaves tail untouched', () => {
    const store = new MemoryContentStore();
    const strategy = new StripStrategy();
    const handler = new ContextHandler(strategy, store, { freshTailCount: 32 });

    // Build 50 mixed messages: repeating pattern of [user, assistant, toolResult]
    // Plus some extra to hit exactly 50
    const messages: AgentMessage[] = [];
    let toolResultCount = 0;
    const oldToolResultIds: string[] = [];
    const oldToolResultContents: Map<string, (TextContent | ImageContent)[]> = new Map();

    for (let i = 0; i < 50; i++) {
      const mod = i % 3;
      if (mod === 0) {
        messages.push(makeUserMsg(`user msg ${i}`));
      } else if (mod === 1) {
        messages.push(makeAssistantMsg(`assistant msg ${i}`));
      } else {
        const id = `call_${toolResultCount}`;
        const content: (TextContent | ImageContent)[] = [
          { type: 'text', text: `tool result content for call ${toolResultCount} with some data` },
        ];
        messages.push({
          role: 'toolResult' as const,
          toolCallId: id,
          toolName: 'read',
          content,
          isError: false,
          timestamp: Date.now(),
        });
        // Track which toolResults are in the old zone (first 18 messages = indices 0..17)
        if (i < 18) {
          oldToolResultIds.push(id);
          oldToolResultContents.set(id, content);
        }
        toolResultCount++;
      }
    }

    assert.strictEqual(messages.length, 50);

    const result = handler.process(messages);

    assert.strictEqual(result.messages.length, 50);

    // Fresh tail (last 32, indices 18-49) should be same references
    for (let i = 18; i < 50; i++) {
      assert.strictEqual(result.messages[i], messages[i], `Message at index ${i} should be same reference`);
    }

    // Old zone (indices 0-17): check toolResults are stripped
    let strippedInOld = 0;
    for (let i = 0; i < 18; i++) {
      const msg = result.messages[i] as any;
      if (msg.role === 'toolResult') {
        strippedInOld++;
        assert.strictEqual(msg.content.length, 1);
        assert.strictEqual(msg.content[0].type, 'text');
        assert.ok(
          msg.content[0].text.startsWith('[Content stripped by LCM.'),
          `Expected stripped placeholder, got: ${msg.content[0].text}`
        );
        assert.ok(
          msg.content[0].text.includes(msg.toolCallId),
          'Placeholder should contain the toolCallId'
        );
      } else {
        // user/assistant in old zone — deep-cloned (AC 6), not same reference but structurally equal
        assert.notStrictEqual(result.messages[i], messages[i], `Old non-toolResult at index ${i} should be deep-cloned`);
        assert.deepStrictEqual(result.messages[i], messages[i], `Old non-toolResult at index ${i} should be structurally equal`);
      }
    }
    assert.strictEqual(strippedInOld, oldToolResultIds.length, 'All old-zone toolResult messages should be stripped');

    // Verify store has all old toolResult content
    for (const id of oldToolResultIds) {
      assert.strictEqual(store.has(id), true, `Store should have key ${id}`);
      assert.deepStrictEqual(store.get(id), oldToolResultContents.get(id));
    }

    // Verify stats
    assert.strictEqual(result.stats.strippedCount, oldToolResultIds.length);
    assert.ok(result.stats.estimatedTokensSaved > 0, 'Should have saved some tokens');

    // Verify original messages not mutated
    for (let i = 0; i < 18; i++) {
      const orig = messages[i] as any;
      if (orig.role === 'toolResult') {
        // Original content should still be the original (not stripped)
        assert.ok(
          !orig.content[0].text.startsWith('[Content stripped'),
          `Original message at index ${i} should not be mutated`
        );
      }
    }

  });
});
