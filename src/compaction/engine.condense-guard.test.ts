import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer } from '../summarizer/summarizer.ts';
import { estimateTokens } from '../summarizer/token-estimator.ts';

function addLeafSummary(store: MemoryStore, id: number): string {
  const content = 'x'.repeat(35);
  const tokenCount = estimateTokens(content);
  assert.strictEqual(tokenCount, 12, 'precondition: guard fixture token count should be stable');
  return store.insertSummary({
    depth: 0,
    kind: 'leaf',
    content,
    tokenCount,
    earliestAt: id,
    latestAt: id,
    descendantCount: 1,
    createdAt: id,
  });
}

describe('runCompaction condensation convergence guard', () => {
  it('discards condensation output when not smaller and records no-op reason (AC 21, 24)', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_condense_guard', '/tmp/project');

    const s0 = addLeafSummary(store, 0);
    const s1 = addLeafSummary(store, 1);
    const s2 = addLeafSummary(store, 2);

    store.replaceContextItems([
      { kind: 'summary', summaryId: s0 },
      { kind: 'summary', summaryId: s1 },
      { kind: 'summary', summaryId: s2 },
    ]);

    const summarizer: Summarizer = {
      async summarize(content: string): Promise<string> {
        return content + content; // guarantee non-convergence
      },
    } as any;

    const before = store.getContextItems();

    const result = await runCompaction(
      store,
      summarizer,
      {
        freshTailCount: 0,
        leafChunkTokens: 100,
        leafTargetTokens: 100,
        condensedTargetTokens: 100,
        condensedMinFanout: 2,
      },
      new AbortController().signal,
    );

    assert.strictEqual(result.actionTaken, false);
    assert.ok(
      result.noOpReasons.includes('condensation_not_smaller_than_input'),
      `Expected condensation_not_smaller_than_input, got: ${result.noOpReasons.join(', ')}`,
    );

    assert.deepStrictEqual(store.getContextItems(), before);

    store.close();
  });
});
