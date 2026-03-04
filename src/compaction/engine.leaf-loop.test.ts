import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer, SummarizeOptions } from '../summarizer/summarizer.ts';

describe('runCompaction leaf loop', () => {
  it('repeats leaf passes, inserts summaries, links messages, and replaces context_items (AC 11, 12, 13, 23)', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/project');

    for (let i = 0; i < 4; i++) {
      store.ingestMessage({
        id: `m${i}`,
        seq: i,
        role: 'user',
        content: `message ${i} `.repeat(20),
        tokenCount: 10,
        createdAt: i + 1,
      });
    }

    store.replaceContextItems([
      { kind: 'message', messageId: 'm0' },
      { kind: 'message', messageId: 'm1' },
      { kind: 'message', messageId: 'm2' },
      { kind: 'message', messageId: 'm3' },
    ]);

    const summarizeCalls: SummarizeOptions[] = [];
    const summarizer: Summarizer = {
      async summarize(_content: string, opts: SummarizeOptions): Promise<string> {
        summarizeCalls.push(opts);
        return 'short leaf summary';
      },
    };

    const result = await runCompaction(
      store,
      summarizer,
      {
        freshTailCount: 0,
        leafChunkTokens: 20,
        leafTargetTokens: 200,
        condensedTargetTokens: 200,
        condensedMinFanout: 3,
      },
      new AbortController().signal,
    );

    assert.strictEqual(result.actionTaken, true);
    assert.strictEqual(result.summariesCreated, 2);
    assert.strictEqual(result.messagesSummarized, 4);

    assert.ok(summarizeCalls.length >= 2, 'expected multiple leaf summarize calls');
    for (const call of summarizeCalls) {
      assert.strictEqual(call.depth, 0);
      assert.strictEqual(call.kind, 'leaf');
    }

    const contextItems = store.getContextItems();
    assert.strictEqual(contextItems.length, 2);
    assert.ok(contextItems.every(item => item.kind === 'summary'));

    const summaryMessages = (store as any).summaryMessages as Map<string, Set<string>>;
    assert.strictEqual(summaryMessages.size, 2);
    for (const set of summaryMessages.values()) {
      assert.strictEqual(set.size, 2);
    }

    store.close();
  });

  it('skips leaf insertion and records no-op reason when summary is not smaller than input (AC 14, 21, 24)', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_2', '/tmp/project');

    store.ingestMessage({
      id: 'm0',
      seq: 0,
      role: 'user',
      content: 'X'.repeat(1200),
      tokenCount: 400,
      createdAt: 1,
    });

    store.replaceContextItems([{ kind: 'message', messageId: 'm0' }]);

    const summarizer: Summarizer = {
      async summarize(content: string): Promise<string> {
        // guarantee non-convergence for guard check
        return content + content;
      },
    } as any;

    const result = await runCompaction(
      store,
      summarizer,
      {
        freshTailCount: 0,
        leafChunkTokens: 1000,
        leafTargetTokens: 500,
        condensedTargetTokens: 500,
        condensedMinFanout: 3,
      },
      new AbortController().signal,
    );

    assert.strictEqual(result.actionTaken, false);
    assert.strictEqual(result.summariesCreated, 0);
    assert.ok(
      result.noOpReasons.includes('leaf_not_smaller_than_input'),
      `Expected leaf_not_smaller_than_input in noOpReasons, got: ${result.noOpReasons.join(', ')}`,
    );

    // message stays in context, no summary replacement
    assert.deepStrictEqual(store.getContextItems(), [{ kind: 'message', messageId: 'm0' }]);

    store.close();
  });
});
