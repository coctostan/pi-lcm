import type { ContextUsage } from '@mariozechner/pi-coding-agent';
import type { ContextHandlerStats } from './context/context-handler.ts';

/**
 * Pure formatter for the pi footer status line.
 * Returns `undefined` to clear/hide the status bar.
 */
export function formatStatusBar(
  stats: ContextHandlerStats,
  contextUsage: ContextUsage | undefined,
  freshTailCount: number
): string | undefined {
  // Phase 2: summary display
  if (stats.summaryCount != null && stats.summaryCount > 0) {
    const percent = contextUsage?.percent;
    const depth = stats.maxDepth ?? 0;

    if (typeof percent === 'number') {
      const pct = Math.round(percent);
      const icon = pct < 60 ? '🟢' : pct < 85 ? '🟡' : '🔴';
      return `${icon} ${pct}% | ${stats.summaryCount} summaries (d${depth}) | tail: ${freshTailCount}`;
    }

    return `🟢 ${stats.summaryCount} summaries (d${depth}) | tail: ${freshTailCount}`;
  }

  // Phase 1: stripped display
  if (stats.strippedCount === 0) return undefined;
  const percent = contextUsage?.percent;
  if (typeof percent !== 'number') {
    return `🟢 ${stats.strippedCount} stripped | tail: ${freshTailCount}`;
  }
  const pct = Math.round(percent);
  const icon = pct < 60 ? '🟢' : pct < 85 ? '🟡' : '🔴';
  return `${icon} ${pct}% | ${stats.strippedCount} stripped | tail: ${freshTailCount}`;
}
