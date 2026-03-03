import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { AgentMessage } from '@mariozechner/pi-agent-core';

import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';

describe('Edge — empty toolResult content is a no-op (AC 17)', () => {
  it('does not strip or store toolResults whose content is []', () => {
    // Ensure the toolResult is in the old zone by using a tiny freshTailCount.
    const store = new MemoryContentStore();
    const handler = new ContextHandler(new StripStrategy(), store, { freshTailCount: 1 });

    const emptyTool: AgentMessage = {
      role: 'toolResult' as const,
      toolCallId: 'call_empty_content',
      toolName: 'read',
      content: [],
      isError: false,
      timestamp: 1,
    };

    const freshUser: AgentMessage = { role: 'user' as const, content: 'fresh', timestamp: 2 };

    const result = handler.process([emptyTool, freshUser]);

    // ToolResult should be unchanged structurally (but will be deep-cloned due to old slice)
    const out0: any = result.messages[0];
    assert.strictEqual(out0.role, 'toolResult');
    assert.deepStrictEqual(out0.content, []);

    // Store should not be written
    assert.deepStrictEqual(store.keys(), []);

    // Stats: nothing stripped
    assert.deepStrictEqual(result.stats, { strippedCount: 0, estimatedTokensSaved: 0 });
  });
});
