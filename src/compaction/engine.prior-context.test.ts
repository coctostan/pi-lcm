import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer, SummarizeOptions } from '../summarizer/summarizer.ts';

function makeSummarizer(capturedInputs: string[]): Summarizer {
  return {
    async summarize(content: string, _opts: SummarizeOptions): Promise<string> {
      capturedInputs.push(content);
      return 'compact summary';
    },
  };
}

describe('runCompaction prior summary context', () => {
  it('prepends up to two preceding summary contents before chunk content (AC 15)', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_prior', '/tmp/project');

    const s0 = store.insertSummary({ depth: 0, kind: 'leaf', content: 'Earlier summary A', tokenCount: 5, earliestAt: 1, latestAt: 1, descendantCount: 1, createdAt: 1 });
    const s1 = store.insertSummary({ depth: 0, kind: 'leaf', content: 'Earlier summary B', tokenCount: 5, earliestAt: 2, latestAt: 2, descendantCount: 1, createdAt: 2 });

    store.ingestMessage({ id: 'm0', seq: 0, role: 'user', content: 'Current message 0', tokenCount: 5, createdAt: 3 });
    store.ingestMessage({ id: 'm1', seq: 1, role: 'assistant', content: 'Current message 1', tokenCount: 5, createdAt: 4 });

    store.replaceContextItems([
      { kind: 'summary', summaryId: s0 },
      { kind: 'summary', summaryId: s1 },
      { kind: 'message', messageId: 'm0' },
      { kind: 'message', messageId: 'm1' },
    ]);

    const capturedInputs: string[] = [];
    await runCompaction(
      store,
      makeSummarizer(capturedInputs),
      {
        freshTailCount: 0,
        leafChunkTokens: 100,
        leafTargetTokens: 100,
        condensedTargetTokens: 100,
        condensedMinFanout: 3,
      },
      new AbortController().signal,
    );

    assert.ok(capturedInputs.length > 0);
    const firstInput = capturedInputs[0]!;
    assert.ok(firstInput.includes('[prior-summary-context]'));
    assert.ok(firstInput.includes('Earlier summary A'));
    assert.ok(firstInput.includes('Earlier summary B'));
    assert.ok(firstInput.includes('[chunk-to-summarize]'));
    assert.ok(firstInput.includes('Current message 0'));

    store.close();
  });

  it('sends only chunk content when no preceding summaries exist (AC 16)', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_no_prior', '/tmp/project');

    store.ingestMessage({ id: 'm0', seq: 0, role: 'user', content: 'Only message content', tokenCount: 5, createdAt: 1 });
    store.replaceContextItems([{ kind: 'message', messageId: 'm0' }]);

    const capturedInputs: string[] = [];
    await runCompaction(
      store,
      makeSummarizer(capturedInputs),
      {
        freshTailCount: 0,
        leafChunkTokens: 100,
        leafTargetTokens: 100,
        condensedTargetTokens: 100,
        condensedMinFanout: 3,
      },
      new AbortController().signal,
    );

    const firstInput = capturedInputs[0]!;
    assert.ok(!firstInput.includes('[prior-summary-context]'));
    assert.ok(firstInput.includes('Only message content'));

    store.close();
  });
});
