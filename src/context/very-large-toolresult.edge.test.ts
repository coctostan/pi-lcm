import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';

import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import { createExpandExecute } from '../tools/expand.ts';

describe('Edge — very large single TextContent toolResult (~50KB) (AC 14)', () => {
  it('strips it and lcm_expand retrieves the full original text when maxExpandTokens is high', async () => {
    const bigText = 'X'.repeat(50 * 1024);
    assert.strictEqual(bigText.length, 50 * 1024);

    const bigTool: AgentMessage = {
      role: 'toolResult' as const,
      toolCallId: 'call_big_50kb',
      toolName: 'read',
      content: [{ type: 'text' as const, text: bigText }],
      isError: false,
      timestamp: 1,
    };

    const freshUser: AgentMessage = { role: 'user' as const, content: 'fresh', timestamp: 2 };

    const store = new MemoryContentStore();
    const handler = new ContextHandler(new StripStrategy(), store, { freshTailCount: 1 });

    const result = handler.process([bigTool, freshUser]);
    assert.strictEqual(result.stats.strippedCount, 1);
    const stripped = result.messages[0] as any;
    const placeholder = (stripped.content[0] as TextContent).text;
    assert.ok(placeholder.startsWith('[Content stripped by LCM.'));

    assert.strictEqual(result.messages[1], freshUser);
    assert.deepStrictEqual(store.keys(), ['call_big_50kb']);

    const execute = createExpandExecute(store, { maxExpandTokens: 1_000_000 });
    const expanded = await execute('call_expand', { id: 'call_big_50kb' });
    const expandedText = (expanded.content[0] as TextContent).text;

    assert.strictEqual(expandedText.length, bigText.length);
    assert.strictEqual(expandedText, bigText);
  });
});
