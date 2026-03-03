import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildSession } from './sessions.ts';

describe('buildSession (basic)', () => {
  it('returns deterministic pi-shaped messages (user → assistant → toolResult per turn)', () => {
    const a = buildSession(2);
    const b = buildSession(2);

    // Determinism (AC 3)
    assert.deepStrictEqual(a, b);

    // Shape (AC 1)
    assert.strictEqual(a.length, 6);
    assert.strictEqual(a[0].role, 'user');
    assert.strictEqual(a[1].role, 'assistant');
    assert.strictEqual(a[2].role, 'toolResult');

    // Stable tool IDs
    assert.strictEqual((a[2] as any).toolCallId, 'toolu_000_0');
    assert.strictEqual((a[5] as any).toolCallId, 'toolu_001_0');

    // Deterministic timestamps (no Date.now())
    const ts = a.map((m: any) => m.timestamp);
    assert.deepStrictEqual(ts, [
      1700000000000,
      1700000000001,
      1700000000002,
      1700000001000,
      1700000001001,
      1700000001002,
    ]);
  });
});
