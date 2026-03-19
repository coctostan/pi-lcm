import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ContextHandler, ContextHandlerResult, ContextHandlerStats } from './context-handler.ts';
import type { Store, StoredMessage, StoredSummary } from '../store/types.ts';

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

type InjectedSummaryContext = Pick<
  StoredSummary,
  'summaryId' | 'depth' | 'kind' | 'content' | 'earliestAt' | 'latestAt' | 'descendantCount'
> & {
  childIds: string[];
};

function formatSummaryContext(summaries: InjectedSummaryContext[]): string {
  return `[LCM Context Summary — this summarizes earlier parts of the conversation]\n\n` +
    summaries
      .map((summary, i) => {
        const lines = [
          `Summary ${i + 1}: ${summary.content}`,
          `summaryId: ${summary.summaryId}`,
          `depth: ${summary.depth}`,
          `kind: ${summary.kind}`,
          `earliestAt: ${summary.earliestAt}`,
          `latestAt: ${summary.latestAt}`,
          `descendantCount: ${summary.descendantCount}`,
        ];

        if (summary.childIds.length > 0) { // AC 5: include child IDs when available
          lines.push(`childIds: ${summary.childIds.join(', ')}`);
        }

        return lines.join('\n');
      })
      .join('\n\n');
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
    const summaries: InjectedSummaryContext[] = [];

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
        summaries.push({
          summaryId: summary.summaryId,
          depth: summary.depth,
          kind: summary.kind,
          earliestAt: summary.earliestAt,
          latestAt: summary.latestAt,
          descendantCount: summary.descendantCount,
          childIds: this.dagStore.getSummaryChildIds(summary.summaryId),
          content: summary.content,
        });
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

    // Final user-leading contract: any user-leading assembled context should get
    // persisted summaries as assistant context so historical text never becomes
    // a stronger synthetic user instruction. Non-user-leading paths keep the
    // framed user-summary behavior.
    if (summaries.length > 0) {
      const summaryText = formatSummaryContext(summaries);
      const shouldEmitAssistantSummary =
        assembled[0]?.role === 'user' &&
        (assembled.length === 1 || assembled.some((message) => message.role === 'assistant'));

      if (shouldEmitAssistantSummary) {
        assembled.unshift(createAssistantSummaryMessage(summaryText));
      } else {
        assembled.unshift({ role: 'user', content: summaryText, timestamp: 0 } as AgentMessage);
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
