import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildSession } from '../test-fixtures/sessions.ts';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';

describe('Integration — short sessions are zero-cost no-ops (AC 8)', () => {
  it('returns original message array reference unchanged and zero stats for 5 turns', () => {
    const store = new MemoryContentStore();
    const handler = new ContextHandler(new StripStrategy(), store, { freshTailCount: 32 });

    const messages = buildSession(5, { contentSize: 'small', toolTypes: ['read'] });
    assert.ok(messages.length < 32, 'Test assumes 5 turns < freshTailCount=32 messages');

    const result = handler.process(messages);

    assert.strictEqual(result.messages, messages);
    assert.deepStrictEqual(result.stats, { strippedCount: 0, estimatedTokensSaved: 0 });
    assert.deepStrictEqual(store.keys(), []);
  });
});
