import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from './types.ts';
import { StoreClosedError } from './types.ts';

export function runStoreContractTests(name: string, factory: () => Store) {
  describe(`${name} — Store contract`, () => {
    it('close() is idempotent and methods throw StoreClosedError after close()', () => {
      const store = factory();

      store.close();
      store.close();

      assert.throws(() => store.getLastIngestedSeq(), (err: any) => {
        assert.ok(err instanceof StoreClosedError);
        return true;
      });
    });

    it('openConversation() is idempotent; ingestMessage/getMessagesAfter/getLastIngestedSeq work', () => {
      const store = factory();
      store.openConversation('sess_1', '/tmp/project');
      store.openConversation('sess_1', '/tmp/project');

      assert.strictEqual(store.getLastIngestedSeq(), -1);

      store.ingestMessage({
        id: 'm0',
        seq: 0,
        role: 'user',
        content: 'hello',
        tokenCount: 1,
        createdAt: 100,
      });
      store.ingestMessage({
        id: 'm2',
        seq: 2,
        role: 'assistant',
        content: 'world',
        tokenCount: 1,
        createdAt: 200,
      });

      assert.strictEqual(store.getLastIngestedSeq(), 2);

      const after0 = store.getMessagesAfter(0);
      assert.deepStrictEqual(after0.map(m => m.seq), [2]);
      assert.strictEqual(after0[0]!.id, 'm2');

      const afterNeg1 = store.getMessagesAfter(-1);
      assert.deepStrictEqual(afterNeg1.map(m => m.seq), [0, 2]);

      store.close();
    });

    it('insertSummary/getSummary roundtrip; expandSummary returns content; describeSummary omits content', () => {
      const store = factory();
      store.openConversation('sess_1', '/tmp/project');

      const summaryId = store.insertSummary({
        depth: 0,
        kind: 'leaf',
        content: 'SUMMARY CONTENT',
        tokenCount: 123,
        earliestAt: 10,
        latestAt: 20,
        descendantCount: 2,
        createdAt: 30,
      });

      const stored = store.getSummary(summaryId);
      assert.ok(stored);
      assert.strictEqual(stored.summaryId, summaryId);
      assert.strictEqual(stored.depth, 0);
      assert.strictEqual(stored.kind, 'leaf');
      assert.strictEqual(stored.content, 'SUMMARY CONTENT');
      assert.strictEqual(stored.tokenCount, 123);
      assert.strictEqual(stored.earliestAt, 10);
      assert.strictEqual(stored.latestAt, 20);
      assert.strictEqual(stored.descendantCount, 2);
      assert.strictEqual(stored.createdAt, 30);

      assert.strictEqual(store.expandSummary(summaryId), 'SUMMARY CONTENT');

      const meta = store.describeSummary(summaryId);
      assert.strictEqual(meta.summaryId, summaryId);
      assert.strictEqual(meta.depth, 0);
      assert.strictEqual(meta.kind, 'leaf');

      // Important: SummaryMeta must not have a `content` field.
      assert.ok(!('content' in (meta as any)));

      store.close();
    });

    it('linkSummaryMessages/linkSummaryParents are idempotent (no throw on duplicates)', () => {
      const store = factory();
      store.openConversation('sess_1', '/tmp/project');

      store.ingestMessage({
        id: 'm0',
        seq: 0,
        role: 'user',
        content: 'hello',
        tokenCount: 1,
        createdAt: 100,
      });

      const leafId = store.insertSummary({
        depth: 0,
        kind: 'leaf',
        content: 'leaf',
        tokenCount: 1,
        earliestAt: 1,
        latestAt: 2,
        descendantCount: 1,
        createdAt: 3,
      });

      // Should not throw even if called twice with same pairs.
      store.linkSummaryMessages(leafId, ['m0']);
      store.linkSummaryMessages(leafId, ['m0']);

      const parentId = store.insertSummary({
        depth: 1,
        kind: 'condensed',
        content: 'parent',
        tokenCount: 1,
        earliestAt: 1,
        latestAt: 2,
        descendantCount: 1,
        createdAt: 3,
      });

      store.linkSummaryParents(parentId, [leafId]);
      store.linkSummaryParents(parentId, [leafId]);

      store.close();
    });

    it('replaceContextItems fully replaces prior items; getContextItems preserves order', () => {
      const store = factory();
      store.openConversation('sess_1', '/tmp/project');

      // Create referenced records (required for SqliteStore FK constraints)
      store.ingestMessage({
        id: 'm0',
        seq: 0,
        role: 'user',
        content: 'ctx msg',
        tokenCount: 1,
        createdAt: 1,
      });

      const s0 = store.insertSummary({
        depth: 0,
        kind: 'leaf',
        content: 'ctx summary 0',
        tokenCount: 1,
        earliestAt: 1,
        latestAt: 1,
        descendantCount: 0,
        createdAt: 1,
      });

      store.replaceContextItems([
        { kind: 'message', messageId: 'm0' },
        { kind: 'summary', summaryId: s0 },
      ]);

      assert.deepStrictEqual(store.getContextItems(), [
        { kind: 'message', messageId: 'm0' },
        { kind: 'summary', summaryId: s0 },
      ]);

      // Create another summary for the replacement call
      const s1 = store.insertSummary({
        depth: 0,
        kind: 'leaf',
        content: 'ctx summary 1',
        tokenCount: 1,
        earliestAt: 1,
        latestAt: 1,
        descendantCount: 0,
        createdAt: 2,
      });

      store.replaceContextItems([{ kind: 'summary', summaryId: s1 }]);
      assert.deepStrictEqual(store.getContextItems(), [{ kind: 'summary', summaryId: s1 }]);

      store.close();
    });

    it('grepMessages(pattern, "fulltext") finds matches across messages and summaries', () => {
      const store = factory();
      store.openConversation('sess_1', '/tmp/project');

      store.ingestMessage({
        id: 'm0',
        seq: 0,
        role: 'user',
        content: 'alpha beta',
        tokenCount: 2,
        createdAt: 1,
      });

      const sid = store.insertSummary({
        depth: 0,
        kind: 'leaf',
        content: 'gamma ALPHA delta',
        tokenCount: 3,
        earliestAt: 1,
        latestAt: 1,
        descendantCount: 1,
        createdAt: 2,
      });

      const results = store.grepMessages('alpha', 'fulltext');
      const ids = results.map(result => `${result.kind}:${result.id}`).sort();

      assert.deepStrictEqual(ids, [`message:m0`, `summary:${sid}`].sort());

      store.close();
    });
  });
}
