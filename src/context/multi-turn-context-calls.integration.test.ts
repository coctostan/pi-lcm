import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';

import { buildSession } from '../test-fixtures/sessions.ts';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import { createExpandExecute } from '../tools/expand.ts';

describe('Integration — multi-turn context calls (AC 6, AC 7)', () => {
  it('keeps all stripped toolResults retrievable after every turn and does not accumulate duplicate keys', async () => {
    const freshTailCount = 32;
    const store = new MemoryContentStore();
    const handler = new ContextHandler(new StripStrategy(), store, { freshTailCount });
    const execute = createExpandExecute(store, { maxExpandTokens: 200_000 });

    // 20 turns = 60 messages. Simulate sequential context calls over a growing session,
    // feeding each processed output into the next call.
    const fullSession = buildSession(20, { contentSize: 'small', toolTypes: ['read', 'bash', 'grep'] });

    let current: AgentMessage[] = [];

    for (let turns = 1; turns <= 20; turns++) {
      const nextTurn = fullSession.slice((turns - 1) * 3, turns * 3);
      const input = [...current, ...nextTurn];

      const originalPrefix = fullSession.slice(0, turns * 3);
      const tailStart = Math.max(0, originalPrefix.length - freshTailCount);

      const expectedOldById = new Map<string, string>();
      for (let i = 0; i < tailStart; i++) {
        const msg: any = originalPrefix[i];
        if (msg.role === 'toolResult') {
          expectedOldById.set(msg.toolCallId, (msg.content[0] as TextContent).text);
        }
      }

      // Capture store size before processing to measure freshly stripped entries this call.
      const storeBeforeProcess = store.keys().length;
      const result = handler.process(input);
      current = result.messages;

      if (originalPrefix.length <= freshTailCount) {
        // Below threshold: zero-cost invariant for this call
        assert.strictEqual(result.messages, input);
        assert.strictEqual(result.stats.strippedCount, 0);
        assert.strictEqual(result.stats.estimatedTokensSaved, 0);
        assert.deepStrictEqual(store.keys(), []);
        continue;
      }

      // AC 7: key count equals unique stripped toolCallIds (Map overwrite, no duplicates)
      assert.strictEqual(store.keys().length, expectedOldById.size);

      // strippedCount must equal the number of entries freshly added to the store this call.
      // Messages already stripped in a prior call (idempotency path) must NOT be double-counted.
      const freshlyStripped = store.keys().length - storeBeforeProcess;
      assert.strictEqual(
        result.stats.strippedCount,
        freshlyStripped,
        `Turn ${turns}: strippedCount should be ${freshlyStripped}, got ${result.stats.strippedCount}`,
      );

      // AC 6: every stripped entry remains expandable to exact original text
      for (const [id, expectedText] of expectedOldById) {
        const expanded = await execute('call_expand', { id });
        const expandedText = (expanded.content[0] as TextContent).text;
        assert.strictEqual(expandedText, expectedText);
      }
    }
  });
});
