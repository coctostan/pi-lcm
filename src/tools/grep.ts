import type { AgentToolResult, ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { Store } from '../store/types.ts';
import { Type } from '@sinclair/typebox';
import { GrepResultSetSchema } from '../schemas.ts';

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text }], details: undefined };
}

export function createGrepExecute(
  store: Store,
): (toolCallId: string, params: { query: string }) => Promise<AgentToolResult<undefined>> {
  return async (_toolCallId: string, params: { query: string }): Promise<AgentToolResult<undefined>> => {
    try {
      const { query } = params;
      const rawResults = store.grepMessages(query, 'fulltext');

      const output = {
        results: rawResults.map((r) => ({
          kind: r.kind,
          id: r.id,
          snippet: r.snippet,
        })),
      };

      GrepResultSetSchema.parse(output);
      return textResult(JSON.stringify(output));
    } catch (err) {
      const errorOutput = {
        results: [] as Array<{ kind: 'message' | 'summary'; id: string; snippet: string }>,
        error: `Invalid search query: ${err instanceof Error ? err.message : String(err)}`,
      };
      GrepResultSetSchema.parse(errorOutput);
      return textResult(JSON.stringify(errorOutput));
    }
  };
}

export function registerGrepTool(pi: ExtensionAPI, store: Store): void {
  const execute = createGrepExecute(store);

  pi.registerTool({
    name: 'lcm_grep',
    label: 'LCM Grep',
    description:
      'Search across archived messages and summaries using full-text search. Returns matching snippets with IDs for further inspection via lcm_describe or lcm_expand.',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query string.' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      return execute(toolCallId, params);
    },
  });
}
