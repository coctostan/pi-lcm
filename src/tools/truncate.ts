import { estimateTokens, maxCharsForTokenBudget } from '../summarizer/token-estimator.ts';

/**
 * Truncates text to fit within a token budget.
 * Uses the same conservative estimator as estimateTokens().
 * Truncates at the last newline boundary before the character limit.
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (text.length === 0) return text;

  const charLimit = maxCharsForTokenBudget(maxTokens);
  if (text.length <= charLimit) {
    return text;
  }

  const totalTokens = estimateTokens(text);

  const lastNewline = text.lastIndexOf('\n', charLimit);
  let truncated: string;
  if (lastNewline > 0) {
    truncated = text.slice(0, lastNewline);
  } else {
    truncated = text.slice(0, charLimit);
  }

  const truncatedTokens = estimateTokens(truncated);
  return truncated + `\n\n[Truncated — content exceeds token budget. Showing first ~${truncatedTokens} of ~${totalTokens} estimated tokens.]`;
}
