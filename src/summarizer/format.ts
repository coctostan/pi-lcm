import type { StoredMessage } from '../store/types.ts';

/**
 * Format stored messages into a string suitable for summarization prompts.
 * Each message is serialized as [role]\n<content>, separated by double newlines,
 * then wrapped in explicit transcript delimiters so the model treats the input
 * as data to summarize rather than a conversation to continue.
 * Tool output is included in full (no truncation) for FTS coverage.
 */
export function formatMessagesForSummary(messages: StoredMessage[]): string {
  if (messages.length === 0) return '';

  const body = messages
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

  return `<conversation_to_summarize>\n${body}\n</conversation_to_summarize>`;
}
