import type { Store } from '../store/types.ts';
import type { SessionEntry, SessionMessageEntry } from '@mariozechner/pi-coding-agent';
import { serializeMessageContent, INGESTABLE_ROLES } from '../ingestion/ingest.ts';
import { estimateTokens } from '../summarizer/token-estimator.ts';

export interface ReconcileOptions {
  rebuild?: boolean;
}

export function reconcile(
  store: Store,
  branchEntries: SessionEntry[],
  options: ReconcileOptions = {},
): number {
  const allBranchMessageIds: string[] = [];
  const newMessageIds: string[] = [];

  for (let i = 0; i < branchEntries.length; i++) {
    const entry = branchEntries[i]!;
    if (entry.type !== 'message') continue;

    const msgEntry = entry as SessionMessageEntry;
    const role = msgEntry.message.role;
    if (!INGESTABLE_ROLES.has(role)) continue;

    allBranchMessageIds.push(entry.id);

    const existing = store.getMessage(entry.id);
    if (existing) continue;

    const content = serializeMessageContent(msgEntry.message);
    store.ingestMessage({
      id: entry.id,
      seq: i,
      role: role as 'user' | 'assistant' | 'toolResult',
      toolName: (msgEntry.message as any).toolName,
      content,
      tokenCount: estimateTokens(content),
      createdAt: new Date(entry.timestamp).getTime(),
    });

    newMessageIds.push(entry.id);
  }

  if (options.rebuild) {
    store.replaceContextItems(
      allBranchMessageIds.map(messageId => ({ kind: 'message' as const, messageId })),
    );
    return newMessageIds.length;
  }

  if (newMessageIds.length === 0) return 0;

  const existingItems = store.getContextItems();
  const appended = newMessageIds.map(messageId => ({ kind: 'message' as const, messageId }));
  store.replaceContextItems([...existingItems, ...appended]);

  return newMessageIds.length;
}
