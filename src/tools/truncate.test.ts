import { describe, it } from 'node:test';
import assert from 'node:assert';
import { truncateToTokenBudget } from './truncate.ts';
import { estimateTokens, maxCharsForTokenBudget } from '../summarizer/token-estimator.ts';

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
    const maxTokens = 10;
    const charLimit = maxCharsForTokenBudget(maxTokens);
    const text = 'line one here\nline two here\nline three is longer than the rest';
    const result = truncateToTokenBudget(text, maxTokens);

    const lastNewline = text.lastIndexOf('\n', charLimit);
    const truncated = text.slice(0, lastNewline);
    const truncatedTokens = estimateTokens(truncated);
    const totalTokens = estimateTokens(text);
    const expected = truncated + `\n\n[Truncated — content exceeds token budget. Showing first ~${truncatedTokens} of ~${totalTokens} estimated tokens.]`;

    assert.strictEqual(result, expected);
  });

  it('performs hard character cut when no newlines before limit (AC 4)', () => {
    const maxTokens = 10;
    const charLimit = maxCharsForTokenBudget(maxTokens);
    const text = 'a'.repeat(100);
    const result = truncateToTokenBudget(text, maxTokens);
    const truncated = text.slice(0, charLimit);
    const truncatedTokens = estimateTokens(truncated);
    const totalTokens = estimateTokens(text);
    const expected = truncated + `\n\n[Truncated — content exceeds token budget. Showing first ~${truncatedTokens} of ~${totalTokens} estimated tokens.]`;

    assert.strictEqual(result, expected);
  });

  it('keeps the returned content within the requested token budget under estimateTokens()', () => {
    const text = 'a'.repeat(315);
    const result = truncateToTokenBudget(text, 100);
    const truncated = result.split('\n\n[Truncated')[0]!;

    assert.ok(
      estimateTokens(truncated) <= 100,
      `Expected truncated content to stay within 100 estimated tokens, got ${estimateTokens(truncated)}`,
    );
  });
});
