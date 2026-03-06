import type { TextContent } from '@mariozechner/pi-ai';
import type { AgentToolResult, ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { readFileSync, statSync } from 'node:fs';
import { Type } from '@sinclair/typebox';
import type { ContentStore } from '../context/content-store.ts';
import type { Store, StoredLargeFile } from '../store/types.ts';
import { ExpandResultSchema, LargeFileExpandResultSchema } from '../schemas.ts';
import { truncateToTokenBudget } from './truncate.ts';
import { debugLog } from '../debug.ts';

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text }], details: undefined };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRUNCATION_NOTICE_RE = /\n\n\[Truncated — content exceeds token budget\. Showing first ~\d+ of ~\d+ estimated tokens\.\]$/;
function chunkForPagination(text: string, maxTokens: number): string {
  const charLimit = Math.floor(maxTokens * 3.5);
  if (text.length <= charLimit) return text;
  const truncated = truncateToTokenBudget(text, maxTokens);
  const noticeMatch = truncated.match(TRUNCATION_NOTICE_RE);
  if (!noticeMatch) return truncated;

  const chunk = truncated.slice(0, -noticeMatch[0].length);
  if (chunk.length > 0) return chunk;
  return text.slice(0, Math.max(1, charLimit));
}

function expandLargeFile(
  id: string,
  largeFile: StoredLargeFile,
  rawOffset: number,
  maxExpandTokens: number,
): AgentToolResult<undefined> {
  debugLog('expand large file request', {
    id,
    path: largeFile.path,
    rawOffset,
    maxExpandTokens,
    totalTokens: largeFile.tokenCount,
  });
  // AC 16: clamp negative offset
  const offset = Math.max(0, rawOffset);
  const charOffset = Math.floor(offset * 3.5 + 1e-6);

  let fileContent: string;
  try {
    fileContent = readFileSync(largeFile.storagePath, 'utf-8');
  } catch {
    // AC 17: cache file missing
    const errorOutput = { error: `Cached file not found at ${largeFile.storagePath}. The file may have been cleaned up.`, id };
    LargeFileExpandResultSchema.parse(errorOutput);
    return textResult(JSON.stringify(errorOutput));
  }

  // AC 15: offset past end
  if (charOffset >= fileContent.length) {
    const output = {
      id,
      source: 'large_file' as const,
      content: 'No more content — offset is past end of file.',
      hasMore: false,
      totalTokens: largeFile.tokenCount,
    };
    LargeFileExpandResultSchema.parse(output);
    return textResult(JSON.stringify(output));
  }

  const remaining = fileContent.slice(charOffset);
  const chunk = chunkForPagination(remaining, maxExpandTokens);
  const chunkEndCharOffset = charOffset + chunk.length;
  const hasMore = chunkEndCharOffset < fileContent.length;
  const nextOffsetTokens = chunkEndCharOffset / 3.5;

  // AC 18: stale detection
  let stale = false;
  let staleNote: string | undefined;
  try {
    const currentMtime = statSync(largeFile.path).mtimeMs;
    if (currentMtime !== largeFile.fileMtime) {
      stale = true;
      staleNote = 'File has changed since capture — content may be outdated. Re-read the file for fresh content.';
    }
  } catch {
    // File may not exist anymore — not a stale detection concern
  }

  const output: Record<string, unknown> = {
    id,
    source: 'large_file',
    content: chunk,
    hasMore,
    totalTokens: largeFile.tokenCount,
  };
  if (hasMore) output.nextOffset = nextOffsetTokens;
  if (stale) {
    output.stale = true;
    output.staleNote = staleNote;
  }

  LargeFileExpandResultSchema.parse(output);
  debugLog('expand large file response', {
    id,
    contentChars: chunk.length,
    hasMore,
    nextOffset: hasMore ? nextOffsetTokens : null,
    stale,
  });
  return textResult(JSON.stringify(output));
}
export function createExpandExecute(
  store: ContentStore,
  config: { maxExpandTokens: number },
  dagStore?: Store | null,
): (toolCallId: string, params: { id: string; offset?: number }) => Promise<AgentToolResult<undefined>> {
  const structuredMode = dagStore !== undefined;
  return async (_toolCallId: string, params: { id: string; offset?: number }): Promise<AgentToolResult<undefined>> => {
    try {
      const { id } = params;
      debugLog('expand request', {
        id,
        offset: params.offset ?? 0,
        structuredMode,
      });

      if (structuredMode) {
        if (id.startsWith('sum_') && dagStore) {
          try {
            const content = dagStore.expandSummary(id);
            const truncated = truncateToTokenBudget(content, config.maxExpandTokens);
            const output = { id, source: 'dag' as const, content: truncated };
            debugLog('expand dag summary response', {
              id,
              contentChars: truncated.length,
            });
            ExpandResultSchema.parse(output);
            return textResult(JSON.stringify(output));
          } catch {
            const errorOutput = { error: 'Summary not found', id };
            ExpandResultSchema.parse(errorOutput);
            return textResult(JSON.stringify(errorOutput));
          }
        }

        // AC 22: Large-file IDs take priority over session/dag paths
        if (dagStore) {
          const largeFile = dagStore.getLargeFile(id);
          if (largeFile) {
            return expandLargeFile(id, largeFile, params.offset ?? 0, config.maxExpandTokens);
          }
        }

        // Structured session path:
        // - non-sum_ IDs
        // - sum_ IDs when no DAG store is available
        const content = store.get(id);
        if (content === undefined) {
          if (dagStore) {
            if (UUID_RE.test(id)) {
              try {
                const summaryContent = dagStore.expandSummary(id);
                const truncated = truncateToTokenBudget(summaryContent, config.maxExpandTokens);
                const output = { id, source: 'dag' as const, content: truncated };
                debugLog('expand dag uuid fallback response', {
                  id,
                  contentChars: truncated.length,
                });
                ExpandResultSchema.parse(output);
                return textResult(JSON.stringify(output));
              } catch {
                // Summary not found: continue to message fallback.
              }
            }
            const msg = dagStore.getMessage(id);
            if (msg !== undefined) {
              const truncated = truncateToTokenBudget(msg.content, config.maxExpandTokens);
              const output = { id, source: 'session' as const, content: truncated };
              debugLog('expand message fallback response', {
                id,
                contentChars: truncated.length,
              });
              ExpandResultSchema.parse(output);
              return textResult(JSON.stringify(output));
            }
          }
          const errorOutput = { error: `No content found for ID "${id}"`, id };
          ExpandResultSchema.parse(errorOutput);
          return textResult(JSON.stringify(errorOutput));
        }

        const textParts: string[] = [];
        for (const entry of content) {
          if (entry.type === 'text') textParts.push((entry as TextContent).text);
          else textParts.push('[Image content — not expandable in text mode]');
        }

        const text = truncateToTokenBudget(textParts.join('\n'), config.maxExpandTokens);
        const output = { id, source: 'session' as const, content: text };
        ExpandResultSchema.parse(output);
        return textResult(JSON.stringify(output));
      }

      // Legacy Phase 1 behavior (2-arg call): keep plain-text outputs unchanged.
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
        return textResult(
          `Content for ID "${id}" contains only image data, which cannot be displayed in text mode.`,
        );
      }

      let text = textParts.join('\n');
      text = truncateToTokenBudget(text, config.maxExpandTokens);
      return textResult(text);
    } catch (err) {
      if (structuredMode) {
        const errorOutput = {
          error: `Error expanding content: ${err instanceof Error ? err.message : String(err)}`,
          id: params.id,
        };
        ExpandResultSchema.parse(errorOutput);
        return textResult(JSON.stringify(errorOutput));
      }

      return textResult(`Error expanding content: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export function registerExpandTool(
  pi: ExtensionAPI,
  store: ContentStore,
  config: { maxExpandTokens: number },
  dagStore?: Store | null,
): void {
  const execute = createExpandExecute(store, config, dagStore);

  pi.registerTool({
    name: 'lcm_expand',
    label: 'LCM Expand',
    description:
      'Retrieve original content that was stripped from old messages by LCM context management. Use the ID from the LCM placeholder text to recover the full content.',
    parameters: Type.Object({
      id: Type.String({ description: 'The ID from the LCM placeholder (e.g., the tool call ID).' }),
      offset: Type.Optional(Type.Number({ description: 'Token-based offset for paginated large file retrieval (default: 0).' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      return execute(toolCallId, params as { id: string; offset?: number });
    },
  });
}
