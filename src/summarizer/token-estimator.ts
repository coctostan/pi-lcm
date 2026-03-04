/**
 * Conservative character-based token estimation.
 * Uses chars / 3.5 * 1.2 (safety margin) — more conservative than chars/4.
 * Returns 0 for empty input, positive integer for non-empty input.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil((text.length / 3.5) * 1.2);
}
