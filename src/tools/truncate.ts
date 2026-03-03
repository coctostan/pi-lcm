/**
 * Truncates text to fit within a token budget.
 * Uses char-based estimation: 1 token ≈ 3.5 characters.
 * Truncates at the last newline boundary before the character limit.
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (text.length === 0) return text;
  const charLimit = Math.floor(maxTokens * 3.5);
  if (text.length <= charLimit) {
    return text;
  }

  const totalTokens = Math.floor(text.length / 3.5);

  // Try to cut at last newline before the limit
  const lastNewline = text.lastIndexOf('\n', charLimit);
  let truncated: string;
  if (lastNewline > 0) {
    truncated = text.slice(0, lastNewline);
  } else {
    // Hard cut at char limit (no suitable newline)
    truncated = text.slice(0, charLimit);
  }

  const truncatedTokens = Math.floor(truncated.length / 3.5);
  return truncated + `\n\n[Truncated — content exceeds token budget. Showing first ~${truncatedTokens} of ~${totalTokens} estimated tokens.]`;
}
