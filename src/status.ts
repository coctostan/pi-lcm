import type { ContextUsage } from '@mariozechner/pi-coding-agent';
import type { ContextHandlerStats } from './context/context-handler.ts';

export const STATUS_GREEN_MAX_PERCENT = 60;
export const STATUS_YELLOW_MAX_PERCENT = 85;

function iconForPercent(percent: number): '🟢' | '🟡' | '🔴' {
  const pct = Math.round(percent);
  if (pct < STATUS_GREEN_MAX_PERCENT) return '🟢';
  if (pct < STATUS_YELLOW_MAX_PERCENT) return '🟡';
  return '🔴';
}

/**
 * Pure formatter for the pi footer status line.
 * Returns `undefined` to clear/hide the status bar.
 */
export function formatStatusBar(
  stats: ContextHandlerStats,
  contextUsage: ContextUsage | undefined,
  freshTailCount: number
): string | undefined {
  if (stats.summaryCount != null && stats.summaryCount > 0) {
    const percent = contextUsage?.percent;
    const depth = stats.maxDepth ?? 0;

    if (typeof percent === 'number') {
      const pct = Math.round(percent);
      const icon = iconForPercent(percent);
      return `${icon} ${pct}% | ${stats.summaryCount} summaries (d${depth}) | tail: ${freshTailCount}`;
    }

    return `🟢 ${stats.summaryCount} summaries (d${depth}) | tail: ${freshTailCount}`;
  }

  if (stats.strippedCount === 0) return undefined;
  const percent = contextUsage?.percent;
  if (typeof percent !== 'number') {
    return `🟢 ${stats.strippedCount} stripped | tail: ${freshTailCount}`;
  }

  const pct = Math.round(percent);
  const icon = iconForPercent(percent);
  return `${icon} ${pct}% | ${stats.strippedCount} stripped | tail: ${freshTailCount}`;
}
