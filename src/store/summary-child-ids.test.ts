import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { MemoryStore } from './memory-store.ts';
import { SqliteStore } from './sqlite-store.ts';

describe('Store.getSummaryChildIds', () => {
  it('MemoryStore returns linked child summary IDs in insertion order', () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/project');

    const childA = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'child A',
      tokenCount: 5,
      earliestAt: 1,
      latestAt: 1,
      descendantCount: 1,
      createdAt: 1,
    });
    const childB = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'child B',
      tokenCount: 5,
      earliestAt: 2,
      latestAt: 2,
      descendantCount: 1,
      createdAt: 2,
    });
    const parent = store.insertSummary({
      depth: 1,
      kind: 'condensed',
      content: 'parent',
      tokenCount: 10,
      earliestAt: 1,
      latestAt: 2,
      descendantCount: 2,
      createdAt: 3,
    });

    store.linkSummaryParents(parent, [childA, childB]);

    const childIds = store.getSummaryChildIds(parent);
    assert.deepStrictEqual(childIds, [childA, childB]);

    store.close();
  });

  it('SqliteStore returns linked child summary IDs in insertion order', () => {
    const dbPath = join(tmpdir(), `pi-lcm-childids-${Date.now()}-${Math.random()}.sqlite`);
    const store = new SqliteStore(dbPath);
    store.openConversation('sess_1', '/tmp/project');

    const childA = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'child A',
      tokenCount: 5,
      earliestAt: 1,
      latestAt: 1,
      descendantCount: 1,
      createdAt: 1,
    });
    const childB = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'child B',
      tokenCount: 5,
      earliestAt: 2,
      latestAt: 2,
      descendantCount: 1,
      createdAt: 2,
    });
    const parent = store.insertSummary({
      depth: 1,
      kind: 'condensed',
      content: 'parent',
      tokenCount: 10,
      earliestAt: 1,
      latestAt: 2,
      descendantCount: 2,
      createdAt: 3,
    });

    store.linkSummaryParents(parent, [childA, childB]);

    const childIds = store.getSummaryChildIds(parent);
    assert.deepStrictEqual(childIds, [childA, childB]);

    store.close();
    rmSync(dbPath, { force: true });
  });
});
