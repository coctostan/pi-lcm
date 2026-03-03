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
  if (stats.strippedCount === 0) return undefined;

  const percent = contextUsage?.percent;

  if (typeof percent !== 'number') {
    return `🟢 ${stats.strippedCount} stripped | tail: ${freshTailCount}`;
  }

  const pct = Math.round(percent);
  const icon = pct < 60 ? '🟢' : pct < 85 ? '🟡' : '🔴';
  return `${icon} ${pct}% | ${stats.strippedCount} stripped | tail: ${freshTailCount}`;
}
