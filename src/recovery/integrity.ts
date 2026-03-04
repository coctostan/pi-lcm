import type { Store, ContextItem } from '../store/types.ts';

/**
 * Run integrity checks on the Store after reconciliation.
 * Returns a list of warning strings for any issues found.
 *
 * Side effects:
 * - Removes orphaned context_items (referencing nonexistent messages/summaries)
 * - Does NOT auto-repair position gaps (log only)
 */
export function checkIntegrity(store: Store): string[] {
  const warnings: string[] = [];
  const contextItems = store.getContextItems();

  // Check 1: Orphaned context_items
  const validItems: ContextItem[] = [];
  for (let i = 0; i < contextItems.length; i++) {
    const item = contextItems[i]!;
    if (item.kind === 'message') {
      const msg = store.getMessage(item.messageId);
      if (!msg) {
        warnings.push(
          `orphaned context_item at position ${i}: references nonexistent message '${item.messageId}'`,
        );
        continue;
      }
    } else if (item.kind === 'summary') {
      const summary = store.getSummary(item.summaryId);
      if (!summary) {
        warnings.push(
          `orphaned context_item at position ${i}: references nonexistent summary '${item.summaryId}'`,
        );
        continue;
      }
    }
    validItems.push(item);
  }

  if (validItems.length < contextItems.length) {
    store.replaceContextItems(validItems);
  }

  // Check 2: Position gaps in consecutive message-type context_items
  // When two adjacent context_items are both messages, their seqs should be
  // contiguous (no skipped seqs). A summary item between them resets the check.
  let prevMessageSeq: number | undefined;
  for (const item of validItems) {
    if (item.kind !== 'message') {
      // Summary breaks message continuity — reset
      prevMessageSeq = undefined;
      continue;
    }
    const msg = store.getMessage(item.messageId);
    if (!msg) continue;

    if (prevMessageSeq !== undefined && msg.seq > prevMessageSeq + 1) {
      warnings.push(
        `context_items position gap: message seq jumped from ${prevMessageSeq} to ${msg.seq}`,
      );
    }
    prevMessageSeq = msg.seq;
  }

  return warnings;
}
