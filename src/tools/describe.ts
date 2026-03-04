import type { AgentToolResult, ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { Store } from '../store/types.ts';
import { DescribeResultSchema } from '../schemas.ts';

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text }], details: undefined };
}

export function createDescribeExecute(
  store: Store,
): (toolCallId: string, params: { id: string }) => Promise<AgentToolResult<undefined>> {
  return async (_toolCallId: string, params: { id: string }): Promise<AgentToolResult<undefined>> => {
    const { id } = params;

    try {
      const meta = store.describeSummary(id);
      const childIds = store.getSummaryChildIds(id);

      const output = {
        summaryId: meta.summaryId,
        depth: meta.depth,
        kind: meta.kind,
        tokenCount: meta.tokenCount,
        earliestAt: meta.earliestAt,
        latestAt: meta.latestAt,
        descendantCount: meta.descendantCount,
        childIds,
      };

      DescribeResultSchema.parse(output);
      return textResult(JSON.stringify(output));
    } catch {
      const errorOutput = { error: 'Summary not found', id };
      DescribeResultSchema.parse(errorOutput);
      return textResult(JSON.stringify(errorOutput));
    }
  };
}

export function registerDescribeTool(pi: ExtensionAPI, store: Store): void {
  const execute = createDescribeExecute(store);

  pi.registerTool({
    name: 'lcm_describe',
    label: 'LCM Describe',
    description:
      'Inspect summary metadata (depth, kind, token count, time range, descendant count) without expanding the full content. Use with summary IDs from lcm_grep results.',
    parameters: Type.Object({
      id: Type.String({ description: 'Summary ID to describe.' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      return execute(toolCallId, params);
    },
  });
}
