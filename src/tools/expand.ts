import type { TextContent } from '@mariozechner/pi-ai';
import type { AgentToolResult, ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { ContentStore } from '../context/content-store.ts';
import { truncateToTokenBudget } from './truncate.ts';
import { Type } from '@sinclair/typebox';

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text }], details: undefined };
}

export function createExpandExecute(
  store: ContentStore,
  config: { maxExpandTokens: number },
): (toolCallId: string, params: { id: string }) => Promise<AgentToolResult<undefined>> {
  return async (_toolCallId: string, params: { id: string }): Promise<AgentToolResult<undefined>> => {
    try {
      const { id } = params;
      const content = store.get(id);

      if (content === undefined) {
        const keys = store.keys();
        if (keys.length === 0) {
          return textResult(`No content found for ID "${id}". The store is empty.`);
        }
        const listed = keys.slice(0, 10).join(', ');
        return textResult(`No content found for ID "${id}". Available IDs: ${listed}`);
      }

      if (content.length === 0) {
        return textResult(`Content for ID "${id}" exists but is empty.`);
      }

      const textParts: string[] = [];
      let hasText = false;
      for (const entry of content) {
        if (entry.type === 'text') {
          textParts.push((entry as TextContent).text);
          hasText = true;
        } else {
          textParts.push('[Image content — not expandable in text mode]');
        }
      }

      if (!hasText) {
        return textResult(`Content for ID "${id}" contains only image data, which cannot be displayed in text mode.`);
      }

      let text = textParts.join('\n');
      text = truncateToTokenBudget(text, config.maxExpandTokens);
      return textResult(text);
    } catch (err) {
      return textResult(`Error expanding content: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export function registerExpandTool(
  pi: ExtensionAPI,
  store: ContentStore,
  config: { maxExpandTokens: number },
): void {
  const execute = createExpandExecute(store, config);

  pi.registerTool({
    name: 'lcm_expand',
    label: 'LCM Expand',
    description:
      'Retrieve original content that was stripped from old messages by LCM context management. Use the ID from the placeholder text to recover the full content.',
    parameters: Type.Object({
      id: Type.String({ description: 'The ID from the LCM placeholder (e.g., the tool call ID).' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      return execute(toolCallId, params);
    },
  });
}
