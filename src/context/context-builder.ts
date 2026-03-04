import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ContextHandler, ContextHandlerResult, ContextHandlerStats } from './context-handler.ts';
import type { Store } from '../store/types.ts';
import type { SummaryBlock } from '../schemas.ts';

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
    let strippedCount = 0;

    for (const item of contextItems) {
      if (item.kind === 'summary') {
        const summary = this.dagStore.getSummary(item.summaryId);
        if (!summary) {
          continue;
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
      } else {
        const original = inputMessages.find(
          (m: any) => m.toolCallId === item.messageId || ('id' in m && m.id === item.messageId),
        );
        if (original) {
          assembled.push(original);
        }
      }
    }

    const stats: ContextHandlerStats = {
      strippedCount,
      estimatedTokensSaved: 0,
    };

    return { messages: assembled, stats };
  }
}
