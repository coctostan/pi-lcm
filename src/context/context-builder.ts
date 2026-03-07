import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ContextHandler, ContextHandlerResult, ContextHandlerStats } from './context-handler.ts';
import type { Store, StoredMessage } from '../store/types.ts';
import type { SummaryBlock } from '../schemas.ts';

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

        const block: SummaryBlock = {
          id: summary.summaryId,
          depth: summary.depth,
          kind: summary.kind,
          msgRange: { earliest: summary.earliestAt, latest: summary.latestAt },
          childCount: summary.descendantCount,
          content: summary.content,
        };

        assembled.push({
          role: 'assistant',
          content: [{ type: 'text', text: JSON.stringify(block) }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'lcm-context',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: summary.createdAt,
        } as AgentMessage);
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

    const stats: ContextHandlerStats = {
      strippedCount,
      estimatedTokensSaved: 0,
      summaryCount,
      maxDepth: summaryCount > 0 ? maxDepth : undefined,
    };

    // Safety guard: if assembled is empty, the API call would fail with
    // "messages: at least one message is required". This can happen when
    // context items reference user/assistant messages that have no toolCallId
    // or id field in the AgentMessage objects from the context event.
    // Fall back to the normal handler to ensure we always send valid messages.
    if (assembled.length === 0) {
      return this.handler.process(messages);
    }

    return { messages: assembled, stats };
  }
}
