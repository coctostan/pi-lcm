import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ContextHandler, ContextHandlerResult, ContextHandlerStats } from './context-handler.ts';
import type { Store, StoredMessage } from '../store/types.ts';

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

function formatSummaryContext(summaryContents: string[]): string {
  return `[LCM Context Summary — this summarizes earlier parts of the conversation]\n\n` +
    summaryContents.map((c, i) => `Summary ${i + 1}: ${c}`).join('\n\n');
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
    const summaryContents: string[] = [];

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

        summaryContents.push(summary.content);
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

    // Present summaries as a separate user context message. Never merge into the
    // current user message — current-turn user intent must stay authoritative.
    if (summaryContents.length > 0) {
      const summaryText = formatSummaryContext(summaryContents);
      if (assembled[0]?.role === 'user') {
        // Maintain user/assistant alternation without rewriting current user text.
        assembled.unshift(
          { role: 'user', content: summaryText, timestamp: 0 } as AgentMessage,
          {
            role: 'assistant',
            content: [{ type: 'text', text: '[context received]' }],
            timestamp: 0,
          } as AgentMessage,
        );
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
