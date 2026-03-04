import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer, SummarizeOptions } from '../summarizer/summarizer.ts';

describe('runCompaction abort behavior', () => {
  it('halts gracefully when summarization aborts and keeps already-committed summaries (AC 27)', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_abort', '/tmp/project');

    for (let i = 0; i < 4; i++) {
      store.ingestMessage({
        id: `m${i}`,
        seq: i,
        role: 'user',
        content: `msg-${i}`,
        tokenCount: 10,
        createdAt: i + 1,
      });
    }

    store.replaceContextItems([
      { kind: 'message', messageId: 'm0' },
      { kind: 'message', messageId: 'm1' },
      { kind: 'message', messageId: 'm2' },
      { kind: 'message', messageId: 'm3' },
    ]);

    const ac = new AbortController();
    let callCount = 0;

    const summarizer: Summarizer = {
      async summarize(_content: string, _opts: SummarizeOptions): Promise<string> {
        callCount += 1;
        if (callCount === 2) {
          ac.abort();
          const err = new Error('aborted');
          (err as Error & { name: string }).name = 'AbortError';
          throw err;
        }
        return 'short';
      },
    };

    const result = await runCompaction(
      store,
      summarizer,
      {
        freshTailCount: 0,
        leafChunkTokens: 20,
        leafTargetTokens: 100,
        condensedTargetTokens: 100,
        condensedMinFanout: 2,
      },
      ac.signal,
    );

    assert.strictEqual(result.summariesCreated, 1);
    assert.strictEqual(callCount, 2);

    const contextItems = store.getContextItems();
    assert.strictEqual(contextItems.length, 3);
    assert.strictEqual(contextItems[0]!.kind, 'summary');
    assert.strictEqual(contextItems[1]!.kind, 'message');
    assert.strictEqual(contextItems[2]!.kind, 'message');

    store.close();
  });
});
