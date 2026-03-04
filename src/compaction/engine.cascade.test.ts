import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer, SummarizeOptions } from '../summarizer/summarizer.ts';

function insertDepth0(store: MemoryStore, idx: number): string {
  return store.insertSummary({
    depth: 0,
    kind: 'leaf',
    content: `leaf-${idx}`,
    tokenCount: 6,
    earliestAt: idx,
    latestAt: idx,
    descendantCount: 1,
    createdAt: idx,
  });
}

describe('runCompaction condensation cascade', () => {
  it('restarts shallowest-first sweep after each condensation so new depth-1 nodes can condense to depth-2 (AC 19)', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_cascade', '/tmp/project');

    const s0 = insertDepth0(store, 0);
    const s1 = insertDepth0(store, 1);
    const s2 = insertDepth0(store, 2);
    const s3 = insertDepth0(store, 3);

    store.replaceContextItems([
      { kind: 'summary', summaryId: s0 },
      { kind: 'summary', summaryId: s1 },
      { kind: 'summary', summaryId: s2 },
      { kind: 'summary', summaryId: s3 },
    ]);

    const calls: SummarizeOptions[] = [];
    const summarizer: Summarizer = {
      async summarize(_content: string, opts: SummarizeOptions): Promise<string> {
        calls.push(opts);
        return 'ok';
      },
    };

    const result = await runCompaction(
      store,
      summarizer,
      {
        freshTailCount: 0,
        leafChunkTokens: 12,
        leafTargetTokens: 100,
        condensedTargetTokens: 100,
        condensedMinFanout: 2,
      },
      new AbortController().signal,
    );

    // expected: two depth-1 condensations from depth-0 pairs, then one depth-2 condensation
    const condensedCalls = calls.filter(c => c.kind === 'condensed');
    assert.strictEqual(condensedCalls.length, 3);
    assert.deepStrictEqual(condensedCalls.map(c => c.depth), [1, 1, 2]);

    assert.strictEqual(result.summariesCreated, 3);
    assert.deepStrictEqual(store.getContextItems().length, 1);

    const finalItem = store.getContextItems()[0]!;
    assert.strictEqual(finalItem.kind, 'summary');
    const finalSummary = store.getSummary(finalItem.summaryId)!;
    assert.strictEqual(finalSummary.depth, 2);

    store.close();
  });
});
