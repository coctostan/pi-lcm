import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens } from './token-estimator.ts';

describe('estimateTokens', () => {
  it('returns 0 for empty string (AC 1)', () => {
    assert.strictEqual(estimateTokens(''), 0);
  });

  it('returns Math.ceil(5 / 3.5 * 1.2) = 2 for "hello" (AC 2)', () => {
    assert.strictEqual(estimateTokens('hello'), Math.ceil(5 / 3.5 * 1.2));
    assert.strictEqual(estimateTokens('hello'), 2);
  });

  it('uses string.length (JS char count) for multi-byte Unicode, not byte length (AC 3)', () => {
    const emoji = '👋🌍'; // Each emoji is a surrogate pair, so .length = 4
    assert.strictEqual(emoji.length, 4);
    const expected = Math.ceil(4 / 3.5 * 1.2);
    assert.strictEqual(estimateTokens(emoji), expected);
    assert.strictEqual(estimateTokens(emoji), 2); // ceil(4 / 3.5 * 1.2) = ceil(1.37) = 2
  });

  it('always returns a positive integer for non-empty input (AC 4)', () => {
    const cases = ['a', 'x', '!', ' ', '\n', '👋', 'hello world this is a longer string'];
    for (const input of cases) {
      const result = estimateTokens(input);
      assert.ok(result > 0, `Expected positive integer for "${input}", got ${result}`);
      assert.ok(Number.isInteger(result), `Expected integer for "${input}", got ${result}`);
    }
  });
});
