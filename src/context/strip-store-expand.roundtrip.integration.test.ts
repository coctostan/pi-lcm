import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { TextContent } from '@mariozechner/pi-ai';

import { buildSession } from '../test-fixtures/sessions.ts';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import { createExpandExecute } from '../tools/expand.ts';

describe('Integration — strip → store → expand round-trip (AC 5)', () => {
  it('stores stripped toolResult content and lcm_expand returns exact original text', async () => {
    const store = new MemoryContentStore();
    const handler = new ContextHandler(new StripStrategy(), store, { freshTailCount: 32 });

    const messages = buildSession(15, { contentSize: 'large', toolTypes: ['read'] });
    const tailStart = messages.length - 32;
    assert.ok(tailStart > 0, 'Test requires messages.length > freshTailCount');

    // Snapshot original text for toolResults in the old zone
    const expectedById = new Map<string, string>();
    for (let i = 0; i < tailStart; i++) {
      const msg: any = messages[i];
      if (msg.role === 'toolResult') {
        expectedById.set(msg.toolCallId, (msg.content[0] as TextContent).text);
      }
    }
    assert.ok(expectedById.size > 0, 'Need at least one old-zone toolResult');

    const result = handler.process(messages);

    // Old-zone toolResults should be placeholders
    for (let i = 0; i < tailStart; i++) {
      const msg: any = result.messages[i];
      if (msg.role === 'toolResult') {
        const placeholder = (msg.content[0] as TextContent).text;
        assert.ok(placeholder.startsWith('[Content stripped by LCM.'), 'Expected LCM placeholder');
        assert.ok(placeholder.includes(`lcm_expand("${msg.toolCallId}")`), 'Placeholder should contain toolCallId');
      }
    }

    const execute = createExpandExecute(store, { maxExpandTokens: 200_000 });
    for (const [id, expectedText] of expectedById) {
      const expanded = await execute('call_expand', { id });
      const expandedText = (expanded.content[0] as TextContent).text;
      assert.strictEqual(expandedText, expectedText);
    }
  });
});
