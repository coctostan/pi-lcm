import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer } from '../summarizer/summarizer.ts';

describe('runCompaction recovery appendEntry', () => {
  it('writes appendEntry("lcm-summary", {summaryId, depth, messageIds}) for leaf insertions (AC 25)', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_leaf_recovery', '/tmp/project');

    store.ingestMessage({ id: 'm0', seq: 0, role: 'user', content: 'hello', tokenCount: 5, createdAt: 1 });
    store.ingestMessage({ id: 'm1', seq: 1, role: 'assistant', content: 'world', tokenCount: 5, createdAt: 2 });
    store.replaceContextItems([
      { kind: 'message', messageId: 'm0' },
      { kind: 'message', messageId: 'm1' },
    ]);

    const entries: Array<{ type: string; data: any }> = [];
    const summarizer: Summarizer = {
      async summarize(): Promise<string> {
        return 'leaf summary';
      },
    } as any;

    await runCompaction(
      store,
      summarizer,
      {
        freshTailCount: 0,
        leafChunkTokens: 100,
        leafTargetTokens: 100,
        condensedTargetTokens: 100,
        condensedMinFanout: 2,
        appendEntry(customType, data) {
          entries.push({ type: customType, data });
        },
      },
      new AbortController().signal,
    );

    assert.ok(entries.length >= 1);
    const first = entries[0]!;
    assert.strictEqual(first.type, 'lcm-summary');
    assert.strictEqual(first.data.depth, 0);
    assert.deepStrictEqual(first.data.messageIds, ['m0', 'm1']);
    assert.ok(typeof first.data.summaryId === 'string');

    store.close();
  });

  it('writes appendEntry("lcm-summary", {summaryId, depth, childIds}) for condensation insertions (AC 25)', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_condense_recovery', '/tmp/project');

    const s0 = store.insertSummary({ depth: 0, kind: 'leaf', content: 'leaf summary alpha content for condensation testing', tokenCount: 20, earliestAt: 1, latestAt: 1, descendantCount: 1, createdAt: 1 });
    const s1 = store.insertSummary({ depth: 0, kind: 'leaf', content: 'leaf summary beta content for condensation testing', tokenCount: 20, earliestAt: 2, latestAt: 2, descendantCount: 1, createdAt: 2 });

    store.replaceContextItems([
      { kind: 'summary', summaryId: s0 },
      { kind: 'summary', summaryId: s1 },
    ]);

    const entries: Array<{ type: string; data: any }> = [];
    const summarizer: Summarizer = {
      async summarize(): Promise<string> {
        return 'condensed';
      },
    } as any;

    await runCompaction(
      store,
      summarizer,
      {
        freshTailCount: 0,
        leafChunkTokens: 100,
        leafTargetTokens: 100,
        condensedTargetTokens: 100,
        condensedMinFanout: 2,
        appendEntry(customType, data) {
          entries.push({ type: customType, data });
        },
      },
      new AbortController().signal,
    );

    const condensedEntry = entries.find(e => Array.isArray(e.data.childIds));
    assert.ok(condensedEntry, 'expected at least one condensation recovery entry');
    assert.strictEqual(condensedEntry!.type, 'lcm-summary');
    assert.strictEqual(condensedEntry!.data.depth, 1);
    assert.deepStrictEqual(condensedEntry!.data.childIds, [s0, s1]);

    store.close();
  });
});
