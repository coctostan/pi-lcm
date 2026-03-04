import type { StoredMessage } from '../store/types.ts';

/**
 * Format stored messages into a string suitable for summarization prompts.
 * Each message is serialized as [role]\n<content>, separated by double newlines.
 * Tool output is included in full (no truncation) for FTS coverage.
 */
export function formatMessagesForSummary(messages: StoredMessage[]): string {
  if (messages.length === 0) return '';

  return messages
    .map((msg) => {
      switch (msg.role) {
        case 'user':
          return `[user]\n${msg.content}`;
        case 'assistant':
          return `[assistant]\n${msg.content}`;
        case 'toolResult':
          return `[tool: ${msg.toolName ?? 'unknown'}]\n${msg.content}`;
      }
    })
    .join('\n\n');
}
