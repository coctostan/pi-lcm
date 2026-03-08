import type { ContextItem, Store } from '../store/types.ts';

export function selectLeafChunk(
  contextItems: ContextItem[],
  freshTailCount: number,
  leafChunkTokens: number,
  store: Pick<Store, 'getMessage'>,
  skippedStartMessageIds: ReadonlySet<string> = new Set(),
): Array<{ kind: 'message'; messageId: string }> {
  const eligibleEnd = Math.max(0, contextItems.length - freshTailCount);
  if (eligibleEnd <= 0) return [];

  let start = -1;
  for (let i = 0; i < eligibleEnd; i++) {
    const item = contextItems[i]!;
    if (item.kind !== 'message') continue;
    if (skippedStartMessageIds.has(item.messageId)) {
      while (i + 1 < eligibleEnd && contextItems[i + 1]!.kind === 'message') i += 1;
      continue;
    }
    start = i;
    break;
  }

  if (start === -1) return [];

  const chunk: Array<{ kind: 'message'; messageId: string }> = [];
  let totalTokens = 0;

  for (let i = start; i < eligibleEnd; i++) {
    const item = contextItems[i]!;
    if (item.kind !== 'message') break;

    const tokenCount = store.getMessage(item.messageId)?.tokenCount ?? 0;

    if (chunk.length === 0) {
      chunk.push(item);
      totalTokens += tokenCount;
      continue;
    }

    if (totalTokens + tokenCount > leafChunkTokens) break;

    chunk.push(item);
    totalTokens += tokenCount;
  }

  return chunk;
}

export function selectCondensationChunk(
  contextItems: ContextItem[],
  freshTailCount: number,
  depth: number,
  condensedMinFanout: number,
  leafChunkTokens: number,
  store: Pick<Store, 'getSummary'>,
  skippedStartSummaryIds: ReadonlySet<string> = new Set(),
): Array<{ kind: 'summary'; summaryId: string }> {
  const eligibleEnd = Math.max(0, contextItems.length - freshTailCount);
  if (eligibleEnd <= 0) return [];

  let start = -1;
  for (let i = 0; i < eligibleEnd; i++) {
    const item = contextItems[i]!;
    if (item.kind !== 'summary') continue;
    const summary = store.getSummary(item.summaryId);
    if (!summary || summary.depth !== depth) continue;

    if (skippedStartSummaryIds.has(item.summaryId)) {
      while (i + 1 < eligibleEnd) {
        const nextItem = contextItems[i + 1]!;
        if (nextItem.kind !== 'summary') break;
        const nextSummary = store.getSummary(nextItem.summaryId);
        if (!nextSummary || nextSummary.depth !== depth) break;
        i += 1;
      }
      continue;
    }

    start = i;
    break;
  }

  if (start === -1) return [];

  const chunk: Array<{ kind: 'summary'; summaryId: string }> = [];
  let totalTokens = 0;

  for (let i = start; i < eligibleEnd; i++) {
    const item = contextItems[i]!;
    if (item.kind !== 'summary') break;

    const summary = store.getSummary(item.summaryId);
    if (!summary || summary.depth !== depth) break;

    const tokenCount = summary.tokenCount;

    if (chunk.length === 0) {
      chunk.push(item);
      totalTokens += tokenCount;
      continue;
    }

    if (totalTokens + tokenCount > leafChunkTokens) break;

    chunk.push(item);
    totalTokens += tokenCount;
  }

  if (chunk.length < condensedMinFanout) return [];
  return chunk;
}
