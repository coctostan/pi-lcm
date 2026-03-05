import type { Store, ContextItem, StoredMessage, StoredSummary } from '../store/types.ts';
import type { Summarizer } from '../summarizer/summarizer.ts';
import { summarizeWithEscalation } from '../summarizer/summarizer.ts';
import { formatMessagesForSummary } from '../summarizer/format.ts';
import { estimateTokens } from '../summarizer/token-estimator.ts';
import { selectCondensationChunk, selectLeafChunk } from './chunk-selector.ts';
import type { CompactionConfig, CompactionResult } from './types.ts';

let compactionRunning = false;
const compactionDebugEnabled = process.env.PI_LCM_DEBUG === '1';

function debugCompaction(event: string, data?: Record<string, unknown>): void {
  if (!compactionDebugEnabled) return;
  if (data) {
    console.warn('pi-lcm: debug: compaction:', event, data);
    return;
  }
  console.warn('pi-lcm: debug: compaction:', event);
}

function getEligibleSummaryCountsOutsideFreshTail(
  contextItems: ContextItem[],
  freshTailCount: number,
  store: Store,
): Record<string, number> {
  const eligibleEnd = Math.max(0, contextItems.length - freshTailCount);
  const counts = new Map<number, number>();

  for (let i = 0; i < eligibleEnd; i++) {
    const item = contextItems[i]!;
    if (item.kind !== 'summary') continue;
    const summary = store.getSummary(item.summaryId);
    if (!summary) continue;
    counts.set(summary.depth, (counts.get(summary.depth) ?? 0) + 1);
  }

  return Object.fromEntries(Array.from(counts.entries()).sort((a, b) => a[0] - b[0]));
}

function inspectCondensationDepth(
  contextItems: ContextItem[],
  freshTailCount: number,
  depth: number,
  leafChunkTokens: number,
  store: Store,
): {
  eligibleEnd: number;
  firstDepthIndex: number;
  contiguousRunLength: number;
  contiguousRunTokens: number;
  tokenBudgetFitLength: number;
  tokenBudgetFitTokens: number;
} {
  const eligibleEnd = Math.max(0, contextItems.length - freshTailCount);

  for (let i = 0; i < eligibleEnd; i++) {
    const item = contextItems[i]!;
    if (item.kind !== 'summary') continue;
    const summary = store.getSummary(item.summaryId);
    if (!summary || summary.depth !== depth) continue;

    const tokenCounts: number[] = [];
    for (let j = i; j < eligibleEnd; j++) {
      const candidate = contextItems[j]!;
      if (candidate.kind !== 'summary') break;
      const candidateSummary = store.getSummary(candidate.summaryId);
      if (!candidateSummary || candidateSummary.depth !== depth) break;
      tokenCounts.push(candidateSummary.tokenCount);
    }

    const contiguousRunTokens = tokenCounts.reduce((acc, tokenCount) => acc + tokenCount, 0);

    let tokenBudgetFitLength = 0;
    let tokenBudgetFitTokens = 0;
    for (const tokenCount of tokenCounts) {
      if (tokenBudgetFitLength === 0) {
        tokenBudgetFitLength = 1;
        tokenBudgetFitTokens = tokenCount;
        continue;
      }
      if (tokenBudgetFitTokens + tokenCount > leafChunkTokens) break;
      tokenBudgetFitLength += 1;
      tokenBudgetFitTokens += tokenCount;
    }

    return {
      eligibleEnd,
      firstDepthIndex: i,
      contiguousRunLength: tokenCounts.length,
      contiguousRunTokens,
      tokenBudgetFitLength,
      tokenBudgetFitTokens,
    };
  }

  return {
    eligibleEnd,
    firstDepthIndex: -1,
    contiguousRunLength: 0,
    contiguousRunTokens: 0,
    tokenBudgetFitLength: 0,
    tokenBudgetFitTokens: 0,
  };
}

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
      const eligibleEnd = Math.max(0, contextItems.length - config.freshTailCount);

      debugCompaction('leaf_sweep_iteration_start', {
        contextItems: contextItems.length,
        eligibleEnd,
        currentTotalTokens,
        freshTailCount: config.freshTailCount,
        leafChunkTokens: config.leafChunkTokens,
      });

      if (previousTotalTokens !== undefined && currentTotalTokens >= previousTotalTokens) {
        result.noOpReasons.push('context_tokens_not_decreasing');
        debugCompaction('leaf_sweep_stopped_context_not_decreasing', {
          previousTotalTokens,
          currentTotalTokens,
        });
        break;
      }

      previousTotalTokens = currentTotalTokens;

      const chunk = selectLeafChunk(
        contextItems,
        config.freshTailCount,
        config.leafChunkTokens,
        store,
      );

      if (chunk.length === 0) {
        debugCompaction('leaf_sweep_no_eligible_chunk', {
          contextItems: contextItems.length,
          eligibleEnd,
        });
        break;
      }

      const messageIds = chunk.map(item => item.messageId);
      const messages = messageIds
        .map(id => store.getMessage(id))
        .filter((message): message is StoredMessage => Boolean(message));

      if (messages.length === 0) {
        debugCompaction('leaf_sweep_chunk_resolved_no_messages', {
          chunkLength: chunk.length,
          messageIds,
        });
        break;
      }

      const chunkStartIndex = contextItems.findIndex(
        item => item.kind === 'message' && item.messageId === messageIds[0],
      );
      const chunkContent = formatMessagesForSummary(messages);
      const chunkTokens = estimateTokens(chunkContent);
      const priorContextPrefix =
        chunkStartIndex >= 0 ? getPriorSummaryContext(contextItems, chunkStartIndex, store) : '';

      const input = priorContextPrefix.length > 0
        ? `${priorContextPrefix}${chunkContent}`
        : chunkContent;
      const inputTokens = estimateTokens(input);

      debugCompaction('leaf_summarize_start', {
        chunkLength: chunk.length,
        messageCount: messages.length,
        chunkStartIndex,
        inputChars: input.length,
        inputTokens,
        targetTokens: config.leafTargetTokens,
      });

      let summaryContent: string;
      try {
        summaryContent = await summarizeWithEscalation(summarizer, input, {
          depth: 0,
          kind: 'leaf',
          maxOutputTokens: config.leafTargetTokens,
          signal,
        });
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          debugCompaction('leaf_summarize_aborted');
          break;
        }
        throw error;
      }

      const outputTokens = estimateTokens(summaryContent);

      if (outputTokens >= chunkTokens) {
        result.noOpReasons.push('leaf_not_smaller_than_input');
        debugCompaction('leaf_guard_not_smaller_than_input', {
          inputTokens,
          chunkTokens,
          outputTokens,
          inputChars: input.length,
          outputChars: summaryContent.length,
        });
        break;
      }

      const summaryId = store.insertSummary({
        depth: 0,
        kind: 'leaf',
        content: summaryContent,
        tokenCount: outputTokens,
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

      debugCompaction('leaf_summary_created', {
        summaryId,
        messageCount: messages.length,
        inputTokens,
        chunkTokens,
        outputTokens,
        contextItemsBefore: contextItems.length,
        contextItemsAfter: updated.length,
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
      const depths = getSummaryDepthsOutsideFreshTail(
        contextItems,
        config.freshTailCount,
        store,
      );
      const eligibleSummaryCounts = getEligibleSummaryCountsOutsideFreshTail(
        contextItems,
        config.freshTailCount,
        store,
      );

      debugCompaction('condensation_sweep_iteration_start', {
        contextItems: contextItems.length,
        currentTotalTokens,
        freshTailCount: config.freshTailCount,
        leafChunkTokens: config.leafChunkTokens,
        condensedMinFanout: config.condensedMinFanout,
        condensedTargetTokens: config.condensedTargetTokens,
        eligibleSummaryCounts,
        depths,
      });

      if (previousTotalTokens !== undefined && currentTotalTokens >= previousTotalTokens) {
        result.noOpReasons.push('context_tokens_not_decreasing');
        debugCompaction('condensation_sweep_stopped_context_not_decreasing', {
          previousTotalTokens,
          currentTotalTokens,
        });
        break;
      }

      previousTotalTokens = currentTotalTokens;

      if (depths.length === 0) {
        debugCompaction('condensation_no_eligible_depths', {
          contextItems: contextItems.length,
          eligibleSummaryCounts,
        });
      }

      for (const depth of depths) {
        if (signal.aborted) break;

        const currentItems = store.getContextItems();
        const inspection = inspectCondensationDepth(
          currentItems,
          config.freshTailCount,
          depth,
          config.leafChunkTokens,
          store,
        );

        debugCompaction('condensation_depth_check', {
          depth,
          condensedMinFanout: config.condensedMinFanout,
          leafChunkTokens: config.leafChunkTokens,
          ...inspection,
        });

        const chunk = selectCondensationChunk(
          currentItems,
          config.freshTailCount,
          depth,
          config.condensedMinFanout,
          config.leafChunkTokens,
          store,
        );

        if (chunk.length === 0) {
          const reason = inspection.firstDepthIndex === -1
            ? 'no_summary_at_depth_outside_fresh_tail'
            : inspection.contiguousRunLength < config.condensedMinFanout
            ? 'contiguous_run_below_min_fanout'
            : inspection.tokenBudgetFitLength < config.condensedMinFanout
            ? 'leaf_chunk_tokens_too_small_for_min_fanout'
            : 'select_condensation_chunk_returned_empty';

          debugCompaction('condensation_depth_skip', {
            depth,
            reason,
            condensedMinFanout: config.condensedMinFanout,
            leafChunkTokens: config.leafChunkTokens,
            ...inspection,
          });
          continue;
        }

        const childIds = chunk.map(item => item.summaryId);
        const children = childIds
          .map(id => store.getSummary(id))
          .filter((summary): summary is StoredSummary => Boolean(summary));

        if (children.length < config.condensedMinFanout) {
          debugCompaction('condensation_depth_skip_children_missing', {
            depth,
            chunkLength: chunk.length,
            childIds,
            resolvedChildren: children.length,
            condensedMinFanout: config.condensedMinFanout,
          });
          continue;
        }

        const input = children.map(s => s.content).join('\n\n');
        const condensationInputTokens = estimateTokens(input);

        debugCompaction('condensation_summarize_start', {
          depth,
          parentDepth: depth + 1,
          childCount: children.length,
          inputChars: input.length,
          inputTokens: condensationInputTokens,
          targetTokens: config.condensedTargetTokens,
        });

        let summaryContent: string;
        try {
          summaryContent = await summarizeWithEscalation(summarizer, input, {
            depth: depth + 1,
            kind: 'condensed',
            maxOutputTokens: config.condensedTargetTokens,
            signal,
          });
        } catch (error) {
          if (signal.aborted || isAbortError(error)) {
            debugCompaction('condensation_summarize_aborted', { depth });
            break;
          }
          throw error;
        }

        const condensationOutputTokens = estimateTokens(summaryContent);
        const childrenTotalTokens = children.reduce((acc, s) => acc + s.tokenCount, 0);
        if (condensationOutputTokens >= childrenTotalTokens) {
          result.noOpReasons.push('condensation_not_smaller_than_input');
          debugCompaction('condensation_guard_not_smaller_than_input', {
            depth,
            parentDepth: depth + 1,
            childCount: children.length,
            inputTokens: condensationInputTokens,
            childrenTotalTokens,
            outputTokens: condensationOutputTokens,
            inputChars: input.length,
            outputChars: summaryContent.length,
            targetTokens: config.condensedTargetTokens,
          });
          continue;
        }

        const parentId = store.insertSummary({
          depth: depth + 1,
          kind: 'condensed',
          content: summaryContent,
          tokenCount: condensationOutputTokens,
          earliestAt: Math.min(...children.map(s => s.earliestAt)),
          latestAt: Math.max(...children.map(s => s.latestAt)),
          descendantCount: children.reduce((acc, s) => acc + s.descendantCount, 0),
          createdAt: Date.now(),
        });

        store.linkSummaryParents(parentId, childIds);

        const updated = replaceSummaryChunkWithParent(currentItems, childIds, parentId);
        store.replaceContextItems(updated);

        config.appendEntry?.('lcm-summary', {
          summaryId: parentId,
          depth: depth + 1,
          childIds,
        });

        debugCompaction('condensation_summary_created', {
          depth,
          parentDepth: depth + 1,
          parentId,
          childCount: childIds.length,
          inputTokens: condensationInputTokens,
          outputTokens: condensationOutputTokens,
          contextItemsBefore: currentItems.length,
          contextItemsAfter: updated.length,
        });

        result.actionTaken = true;
        result.summariesCreated += 1;
        condensedInThisSweep = true;
        break;
      }

      if (!condensedInThisSweep) {
        debugCompaction('condensation_sweep_stopped_no_progress');
        break;
      }
    }

    if (!result.actionTaken && result.noOpReasons.length === 0) {
      result.noOpReasons.push('eligible_leaves_below_min');
    }

    debugCompaction('run_compaction_complete', {
      actionTaken: result.actionTaken,
      summariesCreated: result.summariesCreated,
      messagesSummarized: result.messagesSummarized,
      noOpReasons: result.noOpReasons,
    });

    return result;
  } finally {
    compactionRunning = false;
  }
}
