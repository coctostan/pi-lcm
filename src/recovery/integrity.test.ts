import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIntegrity } from './integrity.ts';
import { MemoryStore } from '../store/memory-store.ts';
import { estimateTokens } from '../summarizer/token-estimator.ts';

function ingestTestMessage(store: MemoryStore, id: string, seq: number, content: string) {
  store.ingestMessage({
    id,
    seq,
    role: 'user',
    content,
    tokenCount: estimateTokens(content),
    createdAt: Date.now(),
  });
}

describe('checkIntegrity', () => {
  it('removes orphaned context_items referencing nonexistent messages (AC 5)', () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/test');

    // Ingest 2 real messages
    ingestTestMessage(store, 'm0', 0, 'hello');
    ingestTestMessage(store, 'm1', 1, 'world');

    // Set context_items with one valid and one orphaned reference
    store.replaceContextItems([
      { kind: 'message', messageId: 'm0' },
      { kind: 'message', messageId: 'nonexistent_msg' },
      { kind: 'message', messageId: 'm1' },
    ]);

    const warnings = checkIntegrity(store);

    // Should have a warning about the orphan
    assert.ok(warnings.length >= 1, 'Should have at least one warning');
    assert.ok(
      warnings.some(w => w.includes('nonexistent_msg')),
      'Warning should mention the orphaned messageId',
    );

    // Orphan should be removed from context_items
    const items = store.getContextItems();
    assert.strictEqual(items.length, 2, 'Orphaned item should be removed');
    assert.deepStrictEqual(items[0], { kind: 'message', messageId: 'm0' });
    assert.deepStrictEqual(items[1], { kind: 'message', messageId: 'm1' });

    store.close();
  });

  it('removes orphaned context_items referencing nonexistent summaries (AC 5)', () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/test');

    ingestTestMessage(store, 'm0', 0, 'hello');

    // Set context_items with a valid message and an orphaned summary reference
    store.replaceContextItems([
      { kind: 'message', messageId: 'm0' },
      { kind: 'summary', summaryId: 'nonexistent_summary' },
    ]);

    const warnings = checkIntegrity(store);

    assert.ok(warnings.length >= 1);
    assert.ok(warnings.some(w => w.includes('nonexistent_summary')));

    const items = store.getContextItems();
    assert.strictEqual(items.length, 1);
    assert.deepStrictEqual(items[0], { kind: 'message', messageId: 'm0' });

    store.close();
  });

  it('warns about position gaps in context_items message seqs (AC 6)', () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/test');

    // Ingest messages at seqs 0, 1, 2, 3
    ingestTestMessage(store, 'm0', 0, 'msg 0');
    ingestTestMessage(store, 'm1', 1, 'msg 1');
    ingestTestMessage(store, 'm2', 2, 'msg 2');
    ingestTestMessage(store, 'm3', 3, 'msg 3');

    // Set context_items with a gap: m0, m1, m3 (missing m2)
    store.replaceContextItems([
      { kind: 'message', messageId: 'm0' },
      { kind: 'message', messageId: 'm1' },
      { kind: 'message', messageId: 'm3' },
    ]);

    const warnings = checkIntegrity(store);

    // Should warn about the gap
    assert.ok(
      warnings.some(w => w.includes('gap')),
      `Expected a gap warning, got: ${JSON.stringify(warnings)}`,
    );

    // context_items should NOT be modified (log only, no auto-repair)
    const items = store.getContextItems();
    assert.strictEqual(items.length, 3, 'Should not modify context_items for gaps');

    store.close();
  });

  it('does not warn about gaps when summaries break message continuity', () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/test');

    ingestTestMessage(store, 'm0', 0, 'msg 0');
    ingestTestMessage(store, 'm3', 3, 'msg 3');

    // Insert a summary between the messages
    const summaryId = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'summary of m1 and m2',
      tokenCount: 20,
      earliestAt: 100,
      latestAt: 200,
      descendantCount: 2,
      createdAt: Date.now(),
    });

    // context_items: message, summary, message — no gap warning expected
    store.replaceContextItems([
      { kind: 'message', messageId: 'm0' },
      { kind: 'summary', summaryId },
      { kind: 'message', messageId: 'm3' },
    ]);

    const warnings = checkIntegrity(store);

    assert.ok(
      !warnings.some(w => w.includes('gap')),
      `Should not warn about gaps when summaries intervene, got: ${JSON.stringify(warnings)}`,
    );

    store.close();
  });
});
