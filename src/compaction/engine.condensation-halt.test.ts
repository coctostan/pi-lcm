import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer } from '../summarizer/summarizer.ts';
import { estimateTokens } from '../summarizer/token-estimator.ts';

describe('condensation per-chunk guard baseline (issue #18)', () => {
  it('rejects condensation output that exceeds sum of children tokenCounts even when smaller than joined input', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_guard_baseline', '/tmp/project');

    // Create 3 depth-0 leaf summaries, each with 35-char content (12 tokens each).
    // sum(children.tokenCount) = 36.
    // Joined with \n\n: 109 chars → condensationInputTokens = 38.
    // Gap between 36 and 38 is where the bug lives.
    const childContent = 'a'.repeat(35);
    const childTokenCount = estimateTokens(childContent); // 12
    assert.strictEqual(childTokenCount, 12, 'precondition: each child is 12 tokens');

    const summaryIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      summaryIds.push(store.insertSummary({
        depth: 0,
        kind: 'leaf',
        content: childContent,
        tokenCount: childTokenCount,
        earliestAt: i,
        latestAt: i,
        descendantCount: 1,
        createdAt: i,
      }));
    }

    store.replaceContextItems(
      summaryIds.map(id => ({ kind: 'summary' as const, summaryId: id })),
    );

    const totalBefore = store.getContextItems().length;

    // Summarizer returns 107 chars = 37 tokens.
    // 37 < 38 (condensationInputTokens) → current guard passes (bug).
    // 37 >= 36 (sum of children tokenCounts) → fixed guard rejects (correct).
    const summarizer: Summarizer = {
      async summarize(_content: string): Promise<string> {
        return 'v'.repeat(107);
      },
    } as any;

    const result = await runCompaction(
      store,
      summarizer,
      {
        freshTailCount: 0,
        leafChunkTokens: 40,
        leafTargetTokens: 100,
        condensedTargetTokens: 100,
        condensedMinFanout: 3,
      },
      new AbortController().signal,
    );

    // Fixed behavior: guard rejects the output, no condensation committed
    assert.strictEqual(
      result.actionTaken,
      false,
      'Condensation should not be committed when output exceeds sum of children tokenCounts',
    );
    assert.ok(
      result.noOpReasons.includes('condensation_not_smaller_than_input'),
      `Expected condensation_not_smaller_than_input, got: ${result.noOpReasons.join(', ')}`,
    );

    // Context should be unchanged — no inflation
    assert.strictEqual(
      store.getContextItems().length,
      totalBefore,
      'Context items should be unchanged after guard rejection',
    );

    store.close();
  });
});
