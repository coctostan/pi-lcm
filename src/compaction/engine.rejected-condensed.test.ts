import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer } from '../summarizer/summarizer.ts';

describe('runCompaction rejected condensed summaries', () => {
  it('does not persist an invalid condensed summary and leaves child summaries in place', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_rejected_condensed', '/tmp/project');
    const s0 = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'leaf alpha summary content for condensation testing',
      tokenCount: 20,
      earliestAt: 1,
      latestAt: 1,
      descendantCount: 1,
      createdAt: 1,
    });
    const s1 = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'leaf beta summary content for condensation testing',
      tokenCount: 20,
      earliestAt: 2,
      latestAt: 2,
      descendantCount: 1,
      createdAt: 2,
    });
    store.replaceContextItems([
      { kind: 'summary', summaryId: s0 },
      { kind: 'summary', summaryId: s1 },
    ]);
    const summarizer: Summarizer = {
      async summarize(_content, opts) {
        if (opts.kind === 'condensed') {
          return 'Let me do that and then I will report back.';
        }
        return 'unused';
      },
    };
    const result = await runCompaction(
      store,
      summarizer,
      {
        freshTailCount: 0,
        leafChunkTokens: 100,
        leafTargetTokens: 50,
        condensedTargetTokens: 50,
        condensedMinFanout: 2,
      },
      new AbortController().signal,
    );
    assert.strictEqual(result.actionTaken, false);
    assert.strictEqual(result.summariesCreated, 0);
    assert.ok(
      result.noOpReasons.includes('summary_rejected'),
      `Expected summary_rejected, got: ${result.noOpReasons.join(', ')}`,
    );
    assert.deepStrictEqual(store.getContextItems(), [
      { kind: 'summary', summaryId: s0 },
      { kind: 'summary', summaryId: s1 },
    ]);
    store.close();
  });
});
