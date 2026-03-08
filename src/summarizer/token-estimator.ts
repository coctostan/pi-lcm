/**
 * Conservative character-based token estimation.
 * Uses chars / 3.5 * 1.2 (safety margin) — more conservative than chars/4.
 * Returns 0 for empty input, positive integer for non-empty input.
 */
export const ESTIMATED_CHARS_PER_TOKEN = 3.5;
export const TOKEN_SAFETY_MARGIN = 1.2;

export function estimateTokensFromCharCount(charCount: number): number {
  if (charCount <= 0) return 0;
  return Math.ceil((charCount / ESTIMATED_CHARS_PER_TOKEN) * TOKEN_SAFETY_MARGIN);
}

export function maxCharsForTokenBudget(maxTokens: number): number {
  if (maxTokens <= 0) return 0;
  return Math.floor((maxTokens / TOKEN_SAFETY_MARGIN) * ESTIMATED_CHARS_PER_TOKEN);
}

export function estimateTokens(text: string): number {
  return estimateTokensFromCharCount(text.length);
}
