import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryContentStore } from '../context/content-store.ts';
import { MemoryStore } from '../store/memory-store.ts';
import { createExpandExecute } from './expand.ts';
import { ExpandResultSchema } from '../schemas.ts';

describe('lcm_expand — DAG expansion (sum_ prefix) (AC 19)', () => {
  it('routes sum_ IDs to DAG store and returns source: dag', async () => {
    const contentStore = new MemoryContentStore();
    const mockDagStore = {
      expandSummary(id: string) {
        if (id === 'sum_test123') return 'Expanded DAG content here.';
        throw new Error(`Summary not found: ${id}`);
      },
    } as any;

    const execute = createExpandExecute(contentStore, { maxExpandTokens: 4000 }, mockDagStore);
    const result = await execute('call1', { id: 'sum_test123' });
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

    const validated = ExpandResultSchema.parse(parsed);
    assert.strictEqual((validated as any).source, 'dag');
    assert.strictEqual((validated as any).id, 'sum_test123');
  });
});

describe('lcm_expand — session path JSON contract (AC 20)', () => {
  it('routes non-sum_ IDs to ContentStore and returns source: session JSON', async () => {
    const contentStore = new MemoryContentStore();
    contentStore.set('toolu_ABC', [{ type: 'text', text: 'original session content' }]);
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    const execute = createExpandExecute(contentStore, { maxExpandTokens: 4000 }, dagStore);
    const result = await execute('call1', { id: 'toolu_ABC' });
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

    const validated = ExpandResultSchema.parse(parsed);
    assert.strictEqual((validated as any).source, 'session');
    assert.strictEqual((validated as any).content, 'original session content');
  });
});

describe('lcm_expand — token cap on both paths (AC 21)', () => {
  it('truncates DAG expanded content when exceeding maxExpandTokens', async () => {
    const contentStore = new MemoryContentStore();
    const longContent = 'A'.repeat(50000);
    const mockDagStore = {
      expandSummary(id: string) {
        if (id === 'sum_long') return longContent;
        throw new Error(`Summary not found: ${id}`);
      },
    } as any;

    const execute = createExpandExecute(contentStore, { maxExpandTokens: 100 }, mockDagStore);
    const result = await execute('call1', { id: 'sum_long' });
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

    const validated = ExpandResultSchema.parse(parsed);
    assert.ok((validated as any).content.includes('[Truncated'));
  });

  it('truncates session path content when exceeding maxExpandTokens', async () => {
    const contentStore = new MemoryContentStore();
    contentStore.set('toolu_long', [{ type: 'text', text: 'B'.repeat(50000) }]);

    const execute = createExpandExecute(contentStore, { maxExpandTokens: 100 }, new MemoryStore());
    const result = await execute('call1', { id: 'toolu_long' });
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

    const validated = ExpandResultSchema.parse(parsed);
    assert.strictEqual((validated as any).source, 'session');
    assert.ok((validated as any).content.includes('[Truncated'));
  });
});

describe('lcm_expand — nonexistent sum_ ID (AC 22)', () => {
  it('returns structured error for sum_ ID not in DAG store', async () => {
    const contentStore = new MemoryContentStore();
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    const execute = createExpandExecute(contentStore, { maxExpandTokens: 4000 }, dagStore);
    const result = await execute('call1', { id: 'sum_doesnotexist' });
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

    const validated = ExpandResultSchema.parse(parsed);
    assert.ok('error' in validated);
    assert.strictEqual((validated as any).error, 'Summary not found');
    assert.strictEqual((validated as any).id, 'sum_doesnotexist');
  });
});

describe('lcm_expand — sum_ fallback without DAG Store (AC 23)', () => {
  it('falls back to session JSON path for sum_ IDs when no DAG Store is available', async () => {
    const contentStore = new MemoryContentStore();
    contentStore.set('sum_oldformat', [{ type: 'text', text: 'Phase 1 stored content' }]);

    const execute = createExpandExecute(contentStore, { maxExpandTokens: 4000 }, null);
    const result = await execute('call1', { id: 'sum_oldformat' });
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

    const validated = ExpandResultSchema.parse(parsed);
    assert.strictEqual((validated as any).source, 'session');
    assert.strictEqual((validated as any).content, 'Phase 1 stored content');
  });
});
