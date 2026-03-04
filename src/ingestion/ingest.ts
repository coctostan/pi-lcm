import type { Store } from '../store/types.ts';
import type { ExtensionContext, SessionMessageEntry } from '@mariozechner/pi-coding-agent';
import { estimateTokens } from '../summarizer/token-estimator.ts';

type IngestContext = Pick<ExtensionContext, 'sessionManager'>;

const INGESTABLE_ROLES = new Set(['user', 'assistant', 'toolResult']);

/**
 * Serialize AgentMessage content into a plain string for storage.
 */
function serializeMessageContent(message: any): string {
  const { role, content } = message;

  if (role === 'user') {
    if (typeof content === 'string') return content;
    // Array of TextContent | ImageContent
    return (content as any[])
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
  }

  if (role === 'assistant') {
    // Array of TextContent | ThinkingContent | ToolCall
    return (content as any[])
      .map((c: any) => {
        if (c.type === 'text') return c.text;
        if (c.type === 'toolCall') return `[toolCall: ${c.name}] ${JSON.stringify(c.arguments)}`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (role === 'toolResult') {
    // Array of TextContent | ImageContent
    return (content as any[])
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
  }

  return '';
}

/**
 * Ingest new session messages into the Store.
 * Reads the current branch from sessionManager, filters to message entries,
 * diffs against lastIngestedSeq, and inserts new messages.
 *
 * Returns the count of newly ingested messages.
 */
export function ingestNewMessages(store: Store, ctx: IngestContext): number {
  const branch = ctx.sessionManager.getBranch();
  const lastSeq = store.getLastIngestedSeq();
  let count = 0;

  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i]!;

    // Only process message entries (AC 23)
    if (entry.type !== 'message') continue;

    const msgEntry = entry as SessionMessageEntry;
    const role = msgEntry.message.role;

    // Only ingest user, assistant, toolResult (AC 23)
    if (!INGESTABLE_ROLES.has(role)) continue;

    // Only process entries with index > lastIngestedSeq (AC 24)
    if (i <= lastSeq) continue;

    const content = serializeMessageContent(msgEntry.message);
    const tokenCount = estimateTokens(content);

    store.ingestMessage({
      id: entry.id,
      seq: i,
      role: role as 'user' | 'assistant' | 'toolResult',
      toolName: (msgEntry.message as any).toolName,
      content,
      tokenCount,
      createdAt: new Date(entry.timestamp).getTime(),
    });

    count++;
  }

  return count;
}
