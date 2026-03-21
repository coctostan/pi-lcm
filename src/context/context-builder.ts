import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ContextHandler, ContextHandlerResult, ContextHandlerStats } from './context-handler.ts';
import type { Store, StoredMessage, StoredSummary } from '../store/types.ts';
import { isFreshUserTurn, extractUserQuery, buildCueBlock } from './cue-builder.ts';

function serializeMessageForMatch(message: AgentMessage): string {
  const candidate = message as any;
  const { role, content } = candidate;

  if (role === 'user') {
    if (typeof content === 'string') return content;
    return (content as any[])
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join('\n');
  }

  if (role === 'assistant') {
    return (content as any[])
      .map((part: any) => {
        if (part.type === 'text') return part.text;
        if (part.type === 'toolCall') return `[toolCall: ${part.name}] ${JSON.stringify(part.arguments)}`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (role === 'toolResult') {
    return (content as any[])
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join('\n');
  }

  return '';
}

function matchesStoredMessage(message: AgentMessage, stored: StoredMessage): boolean {
  const candidate = message as any;
  if (!candidate || candidate.role !== stored.role) return false;
  if (candidate.timestamp !== stored.createdAt) return false;
  if (stored.role === 'toolResult' && candidate.toolName !== stored.toolName) return false;
  return serializeMessageForMatch(message) === stored.content;
}

function hasDirectMessageId(message: AgentMessage, messageId: string): boolean {
  const candidate = message as any;
  return candidate.toolCallId === messageId || ('id' in candidate && candidate.id === messageId);
}

function formatSummaryText(summary: StoredSummary, childIds: string[]): string {
  const lines = [
    summary.content,
    `summaryId: ${summary.summaryId}`,
    `depth: ${summary.depth}`,
    `kind: ${summary.kind}`,
    `earliestAt: ${summary.earliestAt}`,
    `latestAt: ${summary.latestAt}`,
    `descendantCount: ${summary.descendantCount}`,
  ];

  if (childIds.length > 0) {
    lines.push(`childIds: ${childIds.join(', ')}`);
  }

  return lines.join('\n');
}

function createAssistantSummaryMessage(summaryText: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: summaryText }],
    timestamp: 0,
  } as AgentMessage;
}

export class ContextBuilder {
  private handler: ContextHandler;
  private dagStore: Store | null;

  constructor(handler: ContextHandler, dagStore: Store | null) {
    this.handler = handler;
    this.dagStore = dagStore;
  }

  buildContext(messages: AgentMessage[] | undefined): ContextHandlerResult {
    if (!this.dagStore) {
      return this.handler.process(messages);
    }

    const contextItems = this.dagStore.getContextItems();
    if (contextItems.length === 0) {
      return this.handler.process(messages);
    }

    const inputMessages = messages ?? [];
    const assembled: AgentMessage[] = [];
    const usedInputIndexes = new Set<number>();

    let strippedCount = 0;
    let summaryCount = 0;
    let maxDepth = 0;

    for (const item of contextItems) {
      if (item.kind === 'summary') {
        const summary = this.dagStore.getSummary(item.summaryId);
        if (!summary) {
          continue;
        }
        summaryCount++;
        if (summary.depth > maxDepth) {
          maxDepth = summary.depth;
        }
        const childIds = this.dagStore.getSummaryChildIds(summary.summaryId);
        const text = formatSummaryText(summary, childIds);
        assembled.push(createAssistantSummaryMessage(text));
        continue;
      }

      let resolvedIndex = inputMessages.findIndex(
        (message, index) => !usedInputIndexes.has(index) && hasDirectMessageId(message, item.messageId),
      );

      if (resolvedIndex < 0) {
        const stored = this.dagStore.getMessage(item.messageId);
        if (!stored) {
          continue;
        }

        resolvedIndex = inputMessages.findIndex(
          (message, index) => !usedInputIndexes.has(index) && matchesStoredMessage(message, stored),
        );
      }

      if (resolvedIndex >= 0) {
        assembled.push(inputMessages[resolvedIndex]!);
        usedInputIndexes.add(resolvedIndex);
      }
    }

    // Append trailing unmatched input messages (e.g. the latest user prompt
    // which hasn't been ingested yet — ingestion runs in agent_end, after
    // the model responds, while the context event fires before the model call).
    // Only append messages AFTER the last matched index to avoid re-introducing
    // old messages that were replaced by summaries.
    if (usedInputIndexes.size > 0) {
      const lastMatchedIndex = Math.max(...usedInputIndexes);
      for (let i = lastMatchedIndex + 1; i < inputMessages.length; i++) {
        if (!usedInputIndexes.has(i)) {
          assembled.push(inputMessages[i]!);
        }
      }
    } else {
      // No matched messages at all (only summaries) — append ALL input messages
      // since none were consumed by context items.
      for (let i = 0; i < inputMessages.length; i++) {
        assembled.push(inputMessages[i]!);
      }
    }

    // Cue injection: insert <memory-cues> before the final user turn
    if (this.dagStore && assembled.length > 0) {
      const freshTurn = isFreshUserTurn(assembled);
      if (freshTurn) {
        const userQuery = extractUserQuery(assembled);
        if (userQuery) {
          const activeSummaryIds = new Set<string>();
          for (const item of contextItems) {
            if (item.kind === 'summary') activeSummaryIds.add(item.summaryId);
          }
          const cueMsg = buildCueBlock(this.dagStore, userQuery, activeSummaryIds);
          if (cueMsg) {
            // Insert cue block immediately before the last message (the user turn)
            assembled.splice(assembled.length - 1, 0, cueMsg);
          }
        }
      }
    }
    const stats: ContextHandlerStats = {
      strippedCount,
      estimatedTokensSaved: 0,
      summaryCount,
      maxDepth: summaryCount > 0 ? maxDepth : undefined,
    };
    if (assembled.length === 0) {
      return this.handler.process(messages);
    }
    return { messages: assembled, stats };
  }
}
