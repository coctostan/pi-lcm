import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.ts';
import { SqliteStore } from './sqlite-store.ts';

describe('grepMessages regex safety', () => {
  it('rejects nested-quantifier patterns in MemoryStore', () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/project');

    store.ingestMessage({
      id: 'm0',
      seq: 0,
      role: 'user',
      content: 'a'.repeat(50_000),
      tokenCount: 50_000,
      createdAt: 1,
    });

    assert.throws(
      () => store.grepMessages('(a+)+$', 'regex'),
      (err: any) => {
        assert.ok(err instanceof Error);
        assert.strictEqual(err.message, 'Unsafe search regex: nested quantifiers are not allowed');
        return true;
      },
    );

    store.close();
  });

  it('rejects nested-quantifier patterns in SqliteStore', () => {
    const store = new SqliteStore(':memory:');
    store.openConversation('sess_1', '/tmp/project');

    store.ingestMessage({
      id: 'm0',
      seq: 0,
      role: 'user',
      content: 'a'.repeat(50_000),
      tokenCount: 50_000,
      createdAt: 1,
    });

    assert.throws(
      () => store.grepMessages('(a+)+$', 'regex'),
      (err: any) => {
        assert.ok(err instanceof Error);
        assert.strictEqual(err.message, 'Unsafe search regex: nested quantifiers are not allowed');
        return true;
      },
    );

    store.close();
  });
});
