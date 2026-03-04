import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.ts';

describe('MemoryStore.getMessage', () => {
  it('returns a stored message by id and undefined for unknown ids (AC 2)', () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/project');

    store.ingestMessage({
      id: 'm0',
      seq: 0,
      role: 'user',
      content: 'hello',
      tokenCount: 1,
      createdAt: 100,
    });

    store.ingestMessage({
      id: 'm1',
      seq: 1,
      role: 'assistant',
      content: 'world',
      tokenCount: 1,
      createdAt: 200,
    });

    const found = (store as any).getMessage('m1');
    assert.ok(found, 'expected getMessage to return a message');
    assert.strictEqual(found.id, 'm1');
    assert.strictEqual(found.content, 'world');

    const missing = (store as any).getMessage('does-not-exist');
    assert.strictEqual(missing, undefined);

    store.close();
  });
});
