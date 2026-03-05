import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer, SummarizeOptions } from '../summarizer/summarizer.ts';
import { estimateTokens } from '../summarizer/token-estimator.ts';

describe('leaf guard accounting bug', () => {
  it('rejects leaf summary that is larger than the replaced chunk even when smaller than full input with prior context', async () => {
    // Setup: two large prior summaries + a small message chunk.
    // The prior context prefix can inflate `inputTokens` so that a summary
    // larger than the chunk alone can still pass `outputTokens < inputTokens`.
    // But only the chunk is replaced — so context tokens should NOT decrease.

    const store = new MemoryStore();
    store.openConversation('sess_guard', '/tmp/project');

    // Insert two large prior summaries (~200 chars each → ~69 tokens each)
    const s0 = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'A'.repeat(200),
      tokenCount: 69,
      earliestAt: 1,
      latestAt: 1,
      descendantCount: 1,
      createdAt: 1,
    });
    const s1 = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'B'.repeat(200),
      tokenCount: 69,
      earliestAt: 2,
      latestAt: 2,
      descendantCount: 1,
      createdAt: 2,
    });

    // Insert a small message chunk (~40 chars → ~14 tokens)
    store.ingestMessage({
      id: 'm0',
      seq: 0,
      role: 'user',
      content: 'Small chunk content here.',
      tokenCount: 14,
      createdAt: 3,
    });
    store.ingestMessage({
      id: 'm1',
      seq: 1,
      role: 'assistant',
      content: 'Another small message.',
      tokenCount: 12,
      createdAt: 4,
    });

    store.replaceContextItems([
      { kind: 'summary', summaryId: s0 },
      { kind: 'summary', summaryId: s1 },
      { kind: 'message', messageId: 'm0' },
      { kind: 'message', messageId: 'm1' },
    ]);

    const tokensBefore = getTotalContextTokens(store);

    // The summarizer returns a summary that is:
    // - SMALLER than full input (prior context + chunk) → passes current guard
    // - LARGER than the chunk alone → should fail correct guard
    //
    // Prior context prefix adds [prior-summary-context], two 200-char summaries,
    // [chunk-to-summarize], plus formatting overhead. The full input is ~500+ chars.
    // The chunk alone (formatted) is roughly ~70 chars.
    // We return a summary of ~150 chars — bigger than the chunk but smaller than full input.
    const summarizer: Summarizer = {
      async summarize(_content: string, _opts: SummarizeOptions): Promise<string> {
        // ~150 chars → ~52 tokens. Bigger than chunk (~26 tokens) but smaller than full input (~180+ tokens)
        return 'Summary output that is intentionally larger than the small chunk it replaces but smaller than the full input including prior context.';
      },
    };

    const result = await runCompaction(
      store,
      summarizer,
      {
        freshTailCount: 0,
        leafChunkTokens: 100,
        leafTargetTokens: 200,
        condensedTargetTokens: 200,
        condensedMinFanout: 3,
      },
      new AbortController().signal,
    );

    const tokensAfter = getTotalContextTokens(store);

    // The correct behavior: the leaf guard should REJECT this summary because
    // the summary token count exceeds the chunk-only token count.
    // Context tokens should not inflate.
    assert.ok(
      tokensAfter <= tokensBefore,
      `Context tokens should not inflate: before=${tokensBefore}, after=${tokensAfter}`,
    );

    // If the guard worked correctly, it would have rejected the summary.
    // The noOpReasons should include 'leaf_not_smaller_than_input'.
    if (result.actionTaken) {
      // Bug: summary was accepted when it shouldn't have been
      assert.fail(
        `Leaf summary was accepted despite being larger than the replaced chunk. ` +
        `Context tokens inflated from ${tokensBefore} to ${tokensAfter}. ` +
        `noOpReasons: [${result.noOpReasons.join(', ')}]`,
      );
    }
  });
});

function getTotalContextTokens(store: MemoryStore): number {
  let total = 0;
  for (const item of store.getContextItems()) {
    if (item.kind === 'message') {
      total += (store as any).getMessage(item.messageId)?.tokenCount ?? 0;
    } else {
      total += (store as any).getSummary(item.summaryId)?.tokenCount ?? 0;
    }
  }
  return total;
}
