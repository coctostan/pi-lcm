import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer, SummarizeOptions } from '../summarizer/summarizer.ts';

describe('runCompaction continuation after rejected summaries', () => {
  it('continues to a later eligible leaf chunk after rejecting an earlier chunk', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_rejected_continue', '/tmp/project');
    store.ingestMessage({ id: 'm0', seq: 0, role: 'user', content: 'First message in rejected chunk', tokenCount: 30, createdAt: 1 });
    store.ingestMessage({ id: 'm1', seq: 1, role: 'assistant', content: 'Second message in rejected chunk', tokenCount: 30, createdAt: 2 });
    store.ingestMessage({ id: 'm2', seq: 2, role: 'user', content: 'First message in valid chunk', tokenCount: 30, createdAt: 3 });
    store.ingestMessage({ id: 'm3', seq: 3, role: 'assistant', content: 'Second message in valid chunk', tokenCount: 30, createdAt: 4 });
    const barrierSummaryId = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Existing summary barrier',
      tokenCount: 10,
      earliestAt: 0,
      latestAt: 0,
      descendantCount: 1,
      createdAt: 0,
    });
    store.replaceContextItems([
      { kind: 'message', messageId: 'm0' },
      { kind: 'message', messageId: 'm1' },
      { kind: 'summary', summaryId: barrierSummaryId },
      { kind: 'message', messageId: 'm2' },
      { kind: 'message', messageId: 'm3' },
    ]);
    const calls: SummarizeOptions[] = [];
    const summarizer: Summarizer = {
      async summarize(content: string, opts: SummarizeOptions) {
        calls.push(opts);
        if (content.includes('First message in rejected chunk')) {
          return 'I apologize, but I need to read the file before I can summarize it.';
        }
        return 'Valid technical summary for the later chunk.';
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
        condensedMinFanout: 3,
      },
      new AbortController().signal,
    );
    assert.strictEqual(result.actionTaken, true);
    assert.strictEqual(result.summariesCreated, 1);
    assert.strictEqual(result.messagesSummarized, 2);
    assert.ok(
      result.noOpReasons.includes('summary_rejected'),
      `Expected summary_rejected, got: ${result.noOpReasons.join(', ')}`,
    );
    assert.strictEqual(calls.filter(call => call.kind === 'leaf').length, 2);
    const contextItems = store.getContextItems();
    assert.deepStrictEqual(contextItems.slice(0, 3), [
      { kind: 'message', messageId: 'm0' },
      { kind: 'message', messageId: 'm1' },
      { kind: 'summary', summaryId: barrierSummaryId },
    ]);
    assert.strictEqual(contextItems[3]?.kind, 'summary');
    store.close();
  });
});
