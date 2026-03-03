import { describe, it } from 'node:test';
import assert from 'node:assert';
import { truncateToTokenBudget } from './truncate.ts';

describe('truncateToTokenBudget', () => {
  it('returns text unchanged when within token budget (AC 1)', () => {
    const text = 'Hello, world!'; // 13 chars ≈ 3.7 tokens
    const result = truncateToTokenBudget(text, 100);
    assert.strictEqual(result, text);
  });

  it('returns empty string unchanged (AC 5)', () => {
    const result = truncateToTokenBudget('', 100);
    assert.strictEqual(result, '');
  });

  it('truncates at last newline before char limit and appends notice (AC 2, 3)', () => {
    // maxTokens = 10 → charLimit = 35
    // Build text that exceeds 35 chars with newlines
    const text = 'line one here\nline two here\nline three is longer than the rest';
    // text.length = 61, exceeds 35
    const result = truncateToTokenBudget(text, 10);
    // Last newline before char 35 is at index 27 ('line one here\nline two here')
    const truncated = 'line one here\nline two here';
    const truncatedTokens = Math.floor(truncated.length / 3.5);
    const totalTokens = Math.floor(text.length / 3.5);
    const expected = truncated + `\n\n[Truncated — content exceeds token budget. Showing first ~${truncatedTokens} of ~${totalTokens} estimated tokens.]`;
    assert.strictEqual(result, expected);
  });

  it('performs hard character cut when no newlines before limit (AC 4)', () => {
    // maxTokens = 10 → charLimit = 35
    // Single long line with no newlines — lastNewline will be -1
    const text = 'a'.repeat(100);
    const result = truncateToTokenBudget(text, 10);
    const truncated = 'a'.repeat(35);
    const truncatedTokens = Math.floor(35 / 3.5);
    const totalTokens = Math.floor(100 / 3.5);
    const expected = truncated + `\n\n[Truncated — content exceeds token budget. Showing first ~${truncatedTokens} of ~${totalTokens} estimated tokens.]`;
    assert.strictEqual(result, expected);
  });
});
