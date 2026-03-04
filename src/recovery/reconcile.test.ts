import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from './reconcile.ts';
import { MemoryStore } from '../store/memory-store.ts';
import type { SessionEntry } from '@mariozechner/pi-coding-agent';

function makeMessageEntry(
  id: string,
  role: 'user' | 'assistant' | 'toolResult',
  content: string,
  parentId: string | null = null,
): SessionEntry {
  const msg: any = { role, timestamp: Date.now() };
  if (role === 'user') {
    msg.content = content;
  } else if (role === 'assistant') {
    msg.content = [{ type: 'text', text: content }];
    msg.api = 'anthropic-messages';
    msg.provider = 'anthropic';
    msg.model = 'claude-sonnet';
    msg.usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    msg.stopReason = 'stop';
  } else {
    msg.content = [{ type: 'text', text: content }];
    msg.toolCallId = `tool_${id}`;
    msg.toolName = 'bash';
    msg.isError = false;
  }
  return {
    type: 'message',
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: msg,
  } as SessionEntry;
}

describe('reconcile', () => {
  it('ingests all messages and creates context_items on fresh start (AC 1)', () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/test');
    const branch: SessionEntry[] = [
      makeMessageEntry('e0', 'user', 'hello'),
      makeMessageEntry('e1', 'assistant', 'hi there', 'e0'),
      makeMessageEntry('e2', 'toolResult', 'output', 'e1'),
    ];

    const count = reconcile(store, branch);
    assert.strictEqual(count, 3, 'Should ingest 3 messages');
    assert.strictEqual(store.getLastIngestedSeq(), 2);

    const items = store.getContextItems();
    assert.strictEqual(items.length, 3, 'Should have 3 context_items');
    assert.deepStrictEqual(items[0], { kind: 'message', messageId: 'e0' });
    assert.deepStrictEqual(items[1], { kind: 'message', messageId: 'e1' });
    assert.deepStrictEqual(items[2], { kind: 'message', messageId: 'e2' });

    store.close();
  });

  it('does not insert duplicates when store already has all messages (AC 2)', () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/test');
    const branch: SessionEntry[] = [
      makeMessageEntry('e0', 'user', 'hello'),
      makeMessageEntry('e1', 'assistant', 'hi there', 'e0'),
    ];

    const firstCount = reconcile(store, branch);
    assert.strictEqual(firstCount, 2);

    const itemsBefore = store.getContextItems();
    assert.strictEqual(itemsBefore.length, 2);

    const secondCount = reconcile(store, branch);
    assert.strictEqual(secondCount, 0, 'No new messages should be ingested');

    const itemsAfter = store.getContextItems();
    assert.deepStrictEqual(itemsAfter, itemsBefore, 'context_items should be unchanged');

    const messages = store.getMessagesAfter(-1);
    assert.strictEqual(messages.length, 2, 'Store should still have exactly 2 messages');

    store.close();
  });

  it('ingests only missing messages and appends to existing context_items when Store is stale (AC 3)', () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/test');

    const allEntries: SessionEntry[] = [
      makeMessageEntry('e0', 'user', 'first'),
      makeMessageEntry('e1', 'assistant', 'second', 'e0'),
      makeMessageEntry('e2', 'user', 'third', 'e1'),
      makeMessageEntry('e3', 'assistant', 'fourth', 'e2'),
      makeMessageEntry('e4', 'toolResult', 'fifth', 'e3'),
    ];

    reconcile(store, allEntries.slice(0, 2));
    assert.strictEqual(store.getMessagesAfter(-1).length, 2);

    const summaryId = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'existing summary',
      tokenCount: 12,
      earliestAt: 1,
      latestAt: 2,
      descendantCount: 2,
      createdAt: Date.now(),
    });

    store.replaceContextItems([
      { kind: 'summary', summaryId },
      { kind: 'message', messageId: 'e0' },
      { kind: 'message', messageId: 'e1' },
    ]);

    const count = reconcile(store, allEntries);
    assert.strictEqual(count, 3, 'Should ingest only the 3 missing messages');

    const messages = store.getMessagesAfter(-1);
    assert.strictEqual(messages.length, 5, 'Store should now have 5 messages total');

    const items = store.getContextItems();
    assert.strictEqual(items.length, 6, 'Should preserve existing items and append 3 new message items');
    assert.deepStrictEqual(items[0], { kind: 'summary', summaryId });
    assert.deepStrictEqual(items[1], { kind: 'message', messageId: 'e0' });
    assert.deepStrictEqual(items[2], { kind: 'message', messageId: 'e1' });
    assert.deepStrictEqual(items[3], { kind: 'message', messageId: 'e2' });
    assert.deepStrictEqual(items[4], { kind: 'message', messageId: 'e3' });
    assert.deepStrictEqual(items[5], { kind: 'message', messageId: 'e4' });

    store.close();
  });
});
