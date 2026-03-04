import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer, SummarizeOptions } from '../summarizer/summarizer.ts';

function insertLeafSummary(store: MemoryStore, idSeed: number, content: string) {
  return store.insertSummary({
    depth: 0,
    kind: 'leaf',
    content,
    tokenCount: 10,
    earliestAt: idSeed,
    latestAt: idSeed,
    descendantCount: 1,
    createdAt: idSeed,
  });
}

describe('runCompaction condensation sweep', () => {
  it('condenses contiguous same-depth summaries and replaces children with one parent (AC 17, 18, 20)', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_condense', '/tmp/project');

    const preDepth1 = store.insertSummary({
      depth: 1,
      kind: 'condensed',
      content: 'already depth-1',
      tokenCount: 10,
      earliestAt: 0,
      latestAt: 0,
      descendantCount: 2,
      createdAt: 0,
    });

    const s0 = insertLeafSummary(store, 1, 'leaf-0');
    const s1 = insertLeafSummary(store, 2, 'leaf-1');
    const s2 = insertLeafSummary(store, 3, 'leaf-2');

    // oldest item is depth-1, but sweep must still process depth 0 first (ascending depth)
    store.replaceContextItems([
      { kind: 'summary', summaryId: preDepth1 },
      { kind: 'summary', summaryId: s0 },
      { kind: 'summary', summaryId: s1 },
      { kind: 'summary', summaryId: s2 },
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
        leafChunkTokens: 100,
        leafTargetTokens: 100,
        condensedTargetTokens: 100,
        condensedMinFanout: 3,
      },
      new AbortController().signal,
    );

    assert.strictEqual(result.actionTaken, true);
    assert.ok(result.summariesCreated >= 1);

    const condensedCall = calls.find(c => c.kind === 'condensed');
    assert.ok(condensedCall, 'expected at least one condensed summarize call');
    assert.strictEqual(condensedCall!.depth, 1);

    const contextItems = store.getContextItems();
    // pre-existing depth1 + newly created parent summary
    assert.strictEqual(contextItems.length, 2);
    assert.ok(contextItems.every(item => item.kind === 'summary'));

    const summaryParents = (store as any).summaryParents as Map<string, Set<string>>;
    assert.ok(summaryParents.size >= 1, 'expected linkSummaryParents to be recorded');
    const linkedChildSet = Array.from(summaryParents.values())[0]!;
    assert.strictEqual(linkedChildSet.size, 3);

    store.close();
  });
});
