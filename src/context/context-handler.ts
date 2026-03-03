import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ToolResultMessage } from '@mariozechner/pi-ai';
import type { ContextStrategy } from './strip-strategy.ts';
import type { ContentStore } from './content-store.ts';

export interface ContextHandlerConfig {
  freshTailCount: number;
}

export interface ContextHandlerStats {
  strippedCount: number;
  estimatedTokensSaved: number;
}

export interface ContextHandlerResult {
  messages: AgentMessage[];
  stats: ContextHandlerStats;
}

const EMPTY_STATS: ContextHandlerStats = { strippedCount: 0, estimatedTokensSaved: 0 };
function zeroStats(): ContextHandlerStats {
  return { ...EMPTY_STATS };
}

export class ContextHandler {
  private strategy: ContextStrategy;
  private store: ContentStore;
  private config: ContextHandlerConfig;

  constructor(strategy: ContextStrategy, store: ContentStore, config: ContextHandlerConfig) {
    this.strategy = strategy;
    this.store = store;
    this.config = config;
  }

  process(messages: AgentMessage[] | undefined): ContextHandlerResult {
    // Guard: empty/undefined
    if (!messages || messages.length === 0) {
      return { messages: messages ?? [], stats: zeroStats() };
    }

    // Guard: all messages within fresh tail
    if (messages.length <= this.config.freshTailCount) {
      return { messages, stats: zeroStats() };
    }

    const tailStart = messages.length - this.config.freshTailCount;
    const oldMessages = messages.slice(0, tailStart);
    const freshTail = messages.slice(tailStart);

    try {
      // Deep-clone entire old slice before strategy transformation (AC 6)
      const clonedOld = oldMessages.map((msg) => structuredClone(msg));

      const transformed = this.strategy.transformOldMessages(clonedOld, this.store);

      // Count stats by comparing transformed vs original old messages
      let originalCharCount = 0;
      let strippedCount = 0;

      for (let i = 0; i < oldMessages.length; i++) {
        const original = oldMessages[i];
        const result = transformed[i];

        if (
          'role' in original &&
          original.role === 'toolResult' &&
          'role' in result &&
          result.role === 'toolResult'
        ) {
          const origContent = (original as ToolResultMessage).content;
          const resContent = (result as ToolResultMessage).content;

          // Guard: skip messages that were already stripped in a prior call.
          // Without this, re-processing a session whose old zone contains LCM placeholders
          // (idempotency path) would double-count them in strippedCount and estimatedTokensSaved.
          const wasAlreadyStripped =
            origContent.length === 1 &&
            origContent[0].type === 'text' &&
            (origContent[0] as { type: string; text?: string }).text?.startsWith('[Content stripped by LCM.');

          if (
            !wasAlreadyStripped &&
            origContent.length > 0 &&
            resContent.length === 1 &&
            resContent[0].type === 'text' &&
            resContent[0].text?.startsWith('[Content stripped by LCM.')
          ) {
            strippedCount++;
            for (const part of origContent) {
              if (part.type === 'text' && part.text) {
                originalCharCount += part.text.length;
              }
            }
          }
        }
      }

      return {
        messages: [...transformed, ...freshTail],
        stats: {
          strippedCount,
          estimatedTokensSaved: Math.floor(originalCharCount / 4),
        },
      };
    } catch {
      // Fail-safe: return original messages on any error
      return { messages, stats: zeroStats() };
    }
  }
}
