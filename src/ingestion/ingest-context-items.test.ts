import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEntry } from '@mariozechner/pi-coding-agent';
import { MemoryStore } from '../store/memory-store.ts';
import { ingestNewMessages } from './ingest.ts';

function makeMessageEntry(id: string, role: 'user' | 'assistant', text: string): SessionEntry {
  if (role === 'user') {
    return {
      type: 'message',
      id,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: text, timestamp: Date.now() },
    } as SessionEntry;
  }

  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    },
  } as SessionEntry;
}

describe('ingestNewMessages context_items append', () => {
  it('appends {kind:"message", messageId} for each new message at end of existing context_items (AC 4)', () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/project');

    const existingSummaryId = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'already summarized',
      tokenCount: 10,
      earliestAt: 1,
      latestAt: 1,
      descendantCount: 1,
      createdAt: 1,
    });

    store.replaceContextItems([{ kind: 'summary', summaryId: existingSummaryId }]);

    const entries: SessionEntry[] = [
      makeMessageEntry('m0', 'user', 'hello'),
      makeMessageEntry('m1', 'assistant', 'world'),
    ];

    const count = ingestNewMessages(store, {
      sessionManager: { getBranch: () => entries },
    } as any);

    assert.strictEqual(count, 2);
    assert.deepStrictEqual(store.getContextItems(), [
      { kind: 'summary', summaryId: existingSummaryId },
      { kind: 'message', messageId: 'm0' },
      { kind: 'message', messageId: 'm1' },
    ]);

    // idempotency still holds: second run should not append duplicates
    const count2 = ingestNewMessages(store, {
      sessionManager: { getBranch: () => entries },
    } as any);
    assert.strictEqual(count2, 0);
    assert.deepStrictEqual(store.getContextItems(), [
      { kind: 'summary', summaryId: existingSummaryId },
      { kind: 'message', messageId: 'm0' },
      { kind: 'message', messageId: 'm1' },
    ]);

    store.close();
  });
});
