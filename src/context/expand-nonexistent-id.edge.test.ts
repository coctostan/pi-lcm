import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { TextContent } from '@mariozechner/pi-ai';

import { MemoryContentStore } from './content-store.ts';
import { createExpandExecute } from '../tools/expand.ts';

describe('Edge — lcm_expand with non-existent ID (AC 18)', () => {
  it('returns error noting store is empty when no entries exist', async () => {
    const store = new MemoryContentStore();
    const execute = createExpandExecute(store, { maxExpandTokens: 200_000 });

    const result = await execute('call_expand', { id: 'nonexistent_id' });
    const text = (result.content[0] as TextContent).text;

    assert.ok(text.includes('"nonexistent_id"'), 'Error should mention the requested ID');
    assert.ok(text.includes('empty'), 'Error should note the store is empty');
  });

  it('returns error listing available IDs when store has entries', async () => {
    const store = new MemoryContentStore();
    store.set('call_abc', [{ type: 'text', text: 'content abc' }]);
    store.set('call_def', [{ type: 'text', text: 'content def' }]);

    const execute = createExpandExecute(store, { maxExpandTokens: 200_000 });

    const result = await execute('call_expand', { id: 'call_wrong' });
    const text = (result.content[0] as TextContent).text;

    assert.ok(text.includes('"call_wrong"'), 'Error should mention the requested ID');
    assert.ok(text.includes('call_abc'), 'Error should list available ID call_abc');
    assert.ok(text.includes('call_def'), 'Error should list available ID call_def');
  });
});
