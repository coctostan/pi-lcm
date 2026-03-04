import type { Store, ContextItem, StoredMessage } from '../store/types.ts';
import type { Summarizer } from '../summarizer/summarizer.ts';
import { summarizeWithEscalation } from '../summarizer/summarizer.ts';
import { formatMessagesForSummary } from '../summarizer/format.ts';
import { estimateTokens } from '../summarizer/token-estimator.ts';
import { selectCondensationChunk, selectLeafChunk } from './chunk-selector.ts';
import type { CompactionConfig, CompactionResult } from './types.ts';

let compactionRunning = false;

function replaceChunkWithSummary(
  contextItems: ContextItem[],
  messageIds: string[],
  summaryId: string,
): ContextItem[] {
  const start = contextItems.findIndex(
    item => item.kind === 'message' && item.messageId === messageIds[0],
  );
  if (start === -1) return contextItems;

  const end = start + messageIds.length - 1;

  return [
    ...contextItems.slice(0, start),
    { kind: 'summary', summaryId } as const,
    ...contextItems.slice(end + 1),
  ];
}

function getPriorSummaryContext(contextItems: ContextItem[], chunkStartIndex: number, store: Store): string {
  const priorSummaries: string[] = [];

  for (let i = chunkStartIndex - 1; i >= 0 && priorSummaries.length < 2; i--) {
    const item = contextItems[i]!;
    if (item.kind !== 'summary') break;
    const summary = store.getSummary(item.summaryId);
    if (summary) priorSummaries.unshift(summary.content);
  }

  if (priorSummaries.length === 0) return '';

  return [
    '[prior-summary-context]',
    ...priorSummaries,
    '',
    '[chunk-to-summarize]',
    '',
  ].join('\n');
}

function getSummaryDepthsOutsideFreshTail(
  contextItems: ContextItem[],
  freshTailCount: number,
  store: Store,
): number[] {
  const eligibleEnd = Math.max(0, contextItems.length - freshTailCount);
  const depths = new Set<number>();

  for (let i = 0; i < eligibleEnd; i++) {
    const item = contextItems[i]!;
    if (item.kind !== 'summary') continue;
    const summary = store.getSummary(item.summaryId);
    if (!summary) continue;
    depths.add(summary.depth);
  }

  return Array.from(depths).sort((a, b) => a - b);
}

function replaceSummaryChunkWithParent(
  contextItems: ContextItem[],
  childIds: string[],
  parentId: string,
): ContextItem[] {
  const start = contextItems.findIndex(
    item => item.kind === 'summary' && item.summaryId === childIds[0],
  );
  if (start === -1) return contextItems;

  const end = start + childIds.length - 1;

  return [
    ...contextItems.slice(0, start),
    { kind: 'summary', summaryId: parentId } as const,
    ...contextItems.slice(end + 1),
  ];
}

function getContextTotalTokens(contextItems: ContextItem[], store: Store): number {
  let total = 0;
  for (const item of contextItems) {
    if (item.kind === 'message') {
      total += store.getMessage(item.messageId)?.tokenCount ?? 0;
    } else {
      total += store.getSummary(item.summaryId)?.tokenCount ?? 0;
    }
  }
  return total;
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      (error as { name?: string }).name === 'AbortError',
  );
}

export async function runCompaction(
  store: Store,
  summarizer: Summarizer,
  config: CompactionConfig,
  signal: AbortSignal,
  force: boolean = false,
): Promise<CompactionResult> {
  // reserved for future threshold/urgency behavior
  void force;
  if (compactionRunning) {
    return {
      actionTaken: false,
      summariesCreated: 0,
      messagesSummarized: 0,
      noOpReasons: ['compaction_already_running'],
    };
  }

  compactionRunning = true;

  try {

  const result: CompactionResult = {
    actionTaken: false,
    summariesCreated: 0,
    messagesSummarized: 0,
    noOpReasons: [],
  };

  let previousTotalTokens: number | undefined;

  while (!signal.aborted) {
    const contextItems = store.getContextItems();
    const currentTotalTokens = getContextTotalTokens(contextItems, store);
    if (previousTotalTokens !== undefined && currentTotalTokens >= previousTotalTokens) {
      result.noOpReasons.push('context_tokens_not_decreasing');
      break;
    }
    previousTotalTokens = currentTotalTokens;
    const chunk = selectLeafChunk(
      contextItems,
      config.freshTailCount,
      config.leafChunkTokens,
      store,
    );

    if (chunk.length === 0) break;

    const messageIds = chunk.map(item => item.messageId);
    const messages = messageIds
      .map(id => store.getMessage(id))
      .filter((message): message is StoredMessage => Boolean(message));

    if (messages.length === 0) break;

    const chunkStartIndex = contextItems.findIndex(
      item => item.kind === 'message' && item.messageId === messageIds[0],
    );
    const chunkContent = formatMessagesForSummary(messages);
    const priorContextPrefix =
      chunkStartIndex >= 0 ? getPriorSummaryContext(contextItems, chunkStartIndex, store) : '';

    const input = priorContextPrefix.length > 0
      ? `${priorContextPrefix}${chunkContent}`
      : chunkContent;
    let summaryContent: string;
    try {
      summaryContent = await summarizeWithEscalation(summarizer, input, {
        depth: 0,
        kind: 'leaf',
        maxOutputTokens: config.leafTargetTokens,
        signal,
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) break;
      throw error;
    }

    const inputTokens = estimateTokens(input);
    const outputTokens = estimateTokens(summaryContent);

    if (outputTokens >= inputTokens) {
      result.noOpReasons.push('leaf_not_smaller_than_input');
      break;
    }

    const summaryId = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: summaryContent,
      tokenCount: estimateTokens(summaryContent),
      earliestAt: Math.min(...messages.map(m => m.createdAt)),
      latestAt: Math.max(...messages.map(m => m.createdAt)),
      descendantCount: messages.length,
      createdAt: Date.now(),
    });

    store.linkSummaryMessages(summaryId, messageIds);

    const updated = replaceChunkWithSummary(contextItems, messageIds, summaryId);
    store.replaceContextItems(updated);

    config.appendEntry?.('lcm-summary', {
      summaryId,
      depth: 0,
      messageIds,
    });

    result.actionTaken = true;
    result.summariesCreated += 1;
    result.messagesSummarized += messages.length;
  }

  previousTotalTokens = undefined;

  while (!signal.aborted) {
    let condensedInThisSweep = false;
    const contextItems = store.getContextItems();
    const currentTotalTokens = getContextTotalTokens(contextItems, store);
    if (previousTotalTokens !== undefined && currentTotalTokens >= previousTotalTokens) {
      result.noOpReasons.push('context_tokens_not_decreasing');
      break;
    }
    previousTotalTokens = currentTotalTokens;
    const depths = getSummaryDepthsOutsideFreshTail(
      contextItems,
      config.freshTailCount,
      store,
    );
  for (const depth of depths) {
    if (signal.aborted) break;
      const currentItems = store.getContextItems();
      const chunk = selectCondensationChunk(
        currentItems,
        config.freshTailCount,
        depth,
        config.condensedMinFanout,
        config.leafChunkTokens,
        store,
      );

      if (chunk.length === 0) continue;
    const childIds = chunk.map(item => item.summaryId);
      const children = childIds
        .map(id => store.getSummary(id))
      .filter(Boolean);
      if (children.length < config.condensedMinFanout) continue;
    const input = children.map(s => s.content).join('\n\n');
      let summaryContent: string;
      try {
        summaryContent = await summarizeWithEscalation(summarizer, input, {
          depth: depth + 1,
          kind: 'condensed',
          maxOutputTokens: config.condensedTargetTokens,
          signal,
        });
      } catch (error) {
        if (signal.aborted || isAbortError(error)) break;
        throw error;
      }

      const condensationInputTokens = estimateTokens(input);
      const condensationOutputTokens = estimateTokens(summaryContent);
      if (condensationOutputTokens >= condensationInputTokens) {
        result.noOpReasons.push('condensation_not_smaller_than_input');
        continue;
      }
    const parentId = store.insertSummary({
        depth: depth + 1,
        kind: 'condensed',
        content: summaryContent,
        tokenCount: estimateTokens(summaryContent),
        earliestAt: Math.min(...children.map(s => s.earliestAt)),
        latestAt: Math.max(...children.map(s => s.latestAt)),
        descendantCount: children.reduce((acc, s) => acc + s.descendantCount, 0),
        createdAt: Date.now(),
      });
    store.linkSummaryParents(parentId, childIds);
      store.replaceContextItems(replaceSummaryChunkWithParent(currentItems, childIds, parentId));

      config.appendEntry?.('lcm-summary', {
        summaryId: parentId,
        depth: depth + 1,
        childIds,
      });
      result.actionTaken = true;
    result.summariesCreated += 1;
      condensedInThisSweep = true;
      break;
    }
    if (!condensedInThisSweep) break;
  }

  if (!result.actionTaken && result.noOpReasons.length === 0) {
    result.noOpReasons.push('eligible_leaves_below_min');
  }
  return result;
  } finally {
    compactionRunning = false;
  }
}
