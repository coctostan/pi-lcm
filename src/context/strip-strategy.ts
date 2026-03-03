import type { TextContent, ImageContent } from '@mariozechner/pi-ai';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ContentStore } from './content-store.ts';

/**
 * Interface for context transformation strategies.
 * Phase 1: StripStrategy (replace with placeholders).
 * Phase 2: SummaryStrategy (replace with XML summaries).
 */
export interface ContextStrategy {
  transformOldMessages(messages: AgentMessage[], store: ContentStore): AgentMessage[];
}

function isToolResult(msg: AgentMessage): msg is { role: 'toolResult'; toolCallId: string; toolName: string; content: (TextContent | ImageContent)[]; isError: boolean; timestamp: number; details?: unknown } {
  return 'role' in msg && msg.role === 'toolResult';
}

/**
 * Replaces toolResult content with lightweight placeholders.
 * Original content is stored in the ContentStore for retrieval via lcm_expand.
 */
export class StripStrategy implements ContextStrategy {
  transformOldMessages(messages: AgentMessage[], store: ContentStore): AgentMessage[] {
    return messages.map((msg) => {
      if (!isToolResult(msg)) {
        return msg;
      }
      // Skip empty content arrays as no-op (AC 12)
      if (msg.content.length === 0) {
        return msg;
      }
      // Store original content; skip stripping if store fails (AC 11)
      const stored = store.set(msg.toolCallId, msg.content);
      if (!stored) {
        return msg;
      }
      // Replace content with placeholder
      return {
        ...msg,
        content: [
          {
            type: 'text' as const,
            text: `[Content stripped by LCM. Use lcm_expand("${msg.toolCallId}") to retrieve.]`,
          },
        ],
      };
    });
  }
}
