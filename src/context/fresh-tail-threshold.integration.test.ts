import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { TextContent } from '@mariozechner/pi-ai';

import { buildSession } from '../test-fixtures/sessions.ts';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';

describe('Integration — fresh tail protection near threshold (AC 9)', () => {
  it('strips only toolResults in the old zone; fresh tail messages are the same references', () => {
    const freshTailCount = 32;
    const store = new MemoryContentStore();
    const handler = new ContextHandler(new StripStrategy(), store, { freshTailCount });

    const messages = buildSession(35, { contentSize: 'small', toolTypes: ['read', 'bash'] });
    assert.ok(messages.length > freshTailCount);

    const tailStart = messages.length - freshTailCount;

    const expectedStripped = messages
      .slice(0, tailStart)
      .filter((m: any) => m.role === 'toolResult')
      .length;

    const result = handler.process(messages);

    // Fresh tail: reference-equal
    for (let i = tailStart; i < messages.length; i++) {
      assert.strictEqual(result.messages[i], messages[i], `Tail index ${i} should be untouched by reference`);

      // Tail toolResults should not be stripped
      const tailMsg: any = result.messages[i];
      if (tailMsg.role === 'toolResult') {
        const text = (tailMsg.content[0] as TextContent).text;
        assert.ok(!text.startsWith('[Content stripped by LCM.'), 'Fresh-tail toolResults must not be stripped');
      }
    }

    // Old zone: toolResults should be stripped placeholders
    let strippedSeen = 0;
    for (let i = 0; i < tailStart; i++) {
      const oldMsg: any = result.messages[i];
      if (oldMsg.role === 'toolResult') {
        strippedSeen++;
        const text = (oldMsg.content[0] as TextContent).text;
        assert.ok(text.startsWith('[Content stripped by LCM.'), 'Old-zone toolResults must be stripped');
      }
    }

    assert.strictEqual(strippedSeen, expectedStripped);
    assert.strictEqual(result.stats.strippedCount, expectedStripped);
  });
});
