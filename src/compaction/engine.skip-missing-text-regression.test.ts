import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import {
  SummarizationUnavailableError,
  type Summarizer,
} from '../summarizer/summarizer.ts';

describe('runCompaction summary_missing_text regression', () => {
  it('records exactly summary_missing_text with no extra no-op noise', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_missing_text_regression', '/tmp/project');
    // One message chunk that will trigger leaf summarization
    store.ingestMessage({ id: 'm0', seq: 0, role: 'user', content: 'First message', tokenCount: 50, createdAt: 1 });
    // Two pre-existing leaf summaries that qualify for condensation
    const s0 = store.insertSummary({
      depth: 0, kind: 'leaf',
      content: 'Prior summary alpha', tokenCount: 20,
      earliestAt: 0, latestAt: 0, descendantCount: 1, createdAt: 0,
    });
    const s1 = store.insertSummary({
      depth: 0, kind: 'leaf',
      content: 'Prior summary beta', tokenCount: 20,
      earliestAt: 0, latestAt: 0, descendantCount: 1, createdAt: 0,
    });

    store.replaceContextItems([
      { kind: 'summary', summaryId: s0 },
      { kind: 'summary', summaryId: s1 },
      { kind: 'message', messageId: 'm0' },
    ]);

    // Summarizer always throws missing_text — both leaf and condensed paths
    const summarizer: Summarizer = {
      async summarize() {
        throw new SummarizationUnavailableError('missing_text');
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
    assert.deepStrictEqual(result.noOpReasons, ['summary_missing_text']);
    assert.ok(
      !result.noOpReasons.includes('summary_rejected'),
      `Did not expect summary_rejected, got: ${result.noOpReasons.join(', ')}`,
    );
    assert.deepStrictEqual(store.getContextItems(), [
      { kind: 'summary', summaryId: s0 },
      { kind: 'summary', summaryId: s1 },
      { kind: 'message', messageId: 'm0' },
    ]);
    store.close();
  });
});
