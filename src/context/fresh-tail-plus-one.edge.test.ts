import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';

import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import { createExpandExecute } from '../tools/expand.ts';

describe('Edge — freshTailCount + 1 boundary (AC 11)', () => {
  it('treats exactly one message as old; strips it if it is a toolResult', async () => {
    const freshTailCount = 32;

    const store = new MemoryContentStore();
    const handler = new ContextHandler(new StripStrategy(), store, { freshTailCount });
    const execute = createExpandExecute(store, { maxExpandTokens: 200_000 });

    const oldToolResult: AgentMessage = {
      role: 'toolResult' as const,
      toolCallId: 'call_old_0',
      toolName: 'read',
      content: [{ type: 'text' as const, text: 'old tool text' }],
      isError: false,
      timestamp: 1,
    };

    const tail: AgentMessage[] = [];
    for (let i = 0; i < 32; i++) {
      tail.push({ role: 'user' as const, content: `tail ${i}`, timestamp: 100 + i });
    }

    const messages = [oldToolResult, ...tail];
    assert.strictEqual(messages.length, freshTailCount + 1);

    const result = handler.process(messages);

    // Tail must be untouched by reference
    for (let i = 1; i < messages.length; i++) {
      assert.strictEqual(result.messages[i], messages[i]);
    }

    // Old message must be stripped
    const stripped: any = result.messages[0];
    assert.strictEqual(stripped.role, 'toolResult');
    const placeholder = (stripped.content[0] as TextContent).text;
    assert.ok(placeholder.startsWith('[Content stripped by LCM.'));

    assert.strictEqual(result.stats.strippedCount, 1);

    const expanded = await execute('call_expand', { id: 'call_old_0' });
    const expandedText = (expanded.content[0] as TextContent).text;
    assert.strictEqual(expandedText, 'old tool text');
  });
});
