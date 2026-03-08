import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer, SummarizeOptions } from '../summarizer/summarizer.ts';

describe('runCompaction continuation after rejected condensed summaries', () => {
  it('continues to a later eligible condensed chunk after rejecting an earlier chunk', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_rejected_condensed_continue', '/tmp/project');

    const s0 = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'leaf alpha summary content for first rejected condensed chunk',
      tokenCount: 20,
      earliestAt: 1,
      latestAt: 1,
      descendantCount: 1,
      createdAt: 1,
    });
    const s1 = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'leaf beta summary content for first rejected condensed chunk',
      tokenCount: 20,
      earliestAt: 2,
      latestAt: 2,
      descendantCount: 1,
      createdAt: 2,
    });
    const barrier = store.insertSummary({
      depth: 1,
      kind: 'condensed',
      content: 'existing higher-depth barrier summary',
      tokenCount: 10,
      earliestAt: 0,
      latestAt: 0,
      descendantCount: 2,
      createdAt: 0,
    });
    const s2 = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'leaf gamma summary content for later valid condensed chunk',
      tokenCount: 20,
      earliestAt: 3,
      latestAt: 3,
      descendantCount: 1,
      createdAt: 3,
    });
    const s3 = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'leaf delta summary content for later valid condensed chunk',
      tokenCount: 20,
      earliestAt: 4,
      latestAt: 4,
      descendantCount: 1,
      createdAt: 4,
    });

    store.replaceContextItems([
      { kind: 'summary', summaryId: s0 },
      { kind: 'summary', summaryId: s1 },
      { kind: 'summary', summaryId: barrier },
      { kind: 'summary', summaryId: s2 },
      { kind: 'summary', summaryId: s3 },
    ]);

    const calls: SummarizeOptions[] = [];
    const summarizer: Summarizer = {
      async summarize(content: string, opts: SummarizeOptions) {
        calls.push(opts);
        if (opts.kind === 'condensed' && content.includes('first rejected condensed chunk')) {
          return 'Let me do that and then I will report back.';
        }
        if (opts.kind === 'condensed') {
          return 'Valid condensed technical summary for the later chunk.';
        }
        return 'unused leaf summary';
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

    assert.strictEqual(result.actionTaken, true);
    assert.strictEqual(result.summariesCreated, 1);
    assert.strictEqual(result.messagesSummarized, 0);
    assert.ok(
      result.noOpReasons.includes('summary_rejected'),
      `Expected summary_rejected, got: ${result.noOpReasons.join(', ')}`,
    );
    assert.strictEqual(calls.filter(call => call.kind === 'condensed').length, 2);

    const contextItems = store.getContextItems();
    assert.deepStrictEqual(contextItems.slice(0, 3), [
      { kind: 'summary', summaryId: s0 },
      { kind: 'summary', summaryId: s1 },
      { kind: 'summary', summaryId: barrier },
    ]);
    assert.strictEqual(contextItems[3]?.kind, 'summary');
    assert.notStrictEqual((contextItems[3] as { kind: 'summary'; summaryId: string }).summaryId, s2);
    assert.notStrictEqual((contextItems[3] as { kind: 'summary'; summaryId: string }).summaryId, s3);

    store.close();
  });
});
