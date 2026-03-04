import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer } from '../summarizer/summarizer.ts';

describe('runCompaction monotonic guard', () => {
  it('terminates when total context tokens do not decrease between iterations (AC 22)', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_monotonic', '/tmp/project');

    store.ingestMessage({
      id: 'm0',
      seq: 0,
      role: 'user',
      content: 'repeat me '.repeat(200),
      tokenCount: 100,
      createdAt: 1,
    });

    store.replaceContextItems([{ kind: 'message', messageId: 'm0' }]);

    // simulate a broken write path where context_items never actually shrink
    (store as any).replaceContextItems = function (_items: any[]) {
      // no-op on purpose
    };

    const summarizer: Summarizer = {
      async summarize(_content: string): Promise<string> {
        await new Promise(resolve => setTimeout(resolve, 0));
        return 'small summary';
      },
    } as any;

    const ac = new AbortController();
    const runPromise = runCompaction(
      store,
      summarizer,
      {
        freshTailCount: 0,
        leafChunkTokens: 1000,
        leafTargetTokens: 100,
        condensedTargetTokens: 100,
        condensedMinFanout: 2,
      },
      ac.signal,
    );

    const raced = await Promise.race([
      runPromise,
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 250)),
    ]);

    if (raced === 'timeout') {
      ac.abort();
      await Promise.race([
        runPromise,
        new Promise(resolve => setTimeout(resolve, 250)),
      ]);
    }

    assert.notStrictEqual(
      raced,
      'timeout',
      'runCompaction should terminate instead of looping forever when tokens do not decrease',
    );

    const result = raced as Awaited<typeof runPromise>;
    assert.ok(
      result.noOpReasons.includes('context_tokens_not_decreasing'),
      `Expected context_tokens_not_decreasing reason, got: ${result.noOpReasons.join(', ')}`,
    );

    store.close();
  });
});
