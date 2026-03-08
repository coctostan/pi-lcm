import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer } from '../summarizer/summarizer.ts';

describe('runCompaction rejected leaf summaries', () => {
  it('does not persist an invalid leaf summary and leaves raw messages in place', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_rejected_leaf', '/tmp/project');

    store.ingestMessage({ id: 'm0', seq: 0, role: 'user', content: 'First message', tokenCount: 50, createdAt: 1 });
    store.ingestMessage({ id: 'm1', seq: 1, role: 'assistant', content: 'Second message', tokenCount: 50, createdAt: 2 });
    store.replaceContextItems([
      { kind: 'message', messageId: 'm0' },
      { kind: 'message', messageId: 'm1' },
    ]);

    const summarizer: Summarizer = {
      async summarize() {
        return 'I apologize, but I need to read the file before I can summarize it.';
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
    assert.strictEqual(result.messagesSummarized, 0);
    assert.ok(
      result.noOpReasons.includes('summary_rejected'),
      `Expected summary_rejected, got: ${result.noOpReasons.join(', ')}`,
    );
    assert.deepStrictEqual(store.getContextItems(), [
      { kind: 'message', messageId: 'm0' },
      { kind: 'message', messageId: 'm1' },
    ]);

    store.close();
  });
});
