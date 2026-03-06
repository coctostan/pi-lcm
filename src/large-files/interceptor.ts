import type { TextContent, ImageContent } from '@mariozechner/pi-ai';
import { mkdirSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from '../store/types.ts';
import { explore } from './explorer.ts';

export interface InterceptConfig {
  largeFileTokenThreshold: number;
  maxExpandTokens: number;
}

export interface ToolResultLike {
  type: 'tool_result';
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: (TextContent | ImageContent)[];
  isError: boolean;
}

/** Subset of pi-coding-agent's ToolResultEventResult, defined locally to avoid import issues. */
interface ToolResultReplacement {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
}

type ExplorerFn = (filePath: string, content: string) => string;

export async function interceptLargeFileWithExplorer(
  event: ToolResultLike,
  store: Store,
  config: InterceptConfig,
  cacheDir: string,
  explorerFn: ExplorerFn,
): Promise<ToolResultReplacement | undefined> {
  if (event.toolName !== 'read') {
    return undefined;
  }

  // Estimate tokens from text content only (skip images) — AC 3, AC 4
  const textParts: string[] = [];
  for (const block of event.content) {
    if (block.type === 'text') {
      textParts.push((block as TextContent).text);
    }
  }
  const fullText = textParts.join('\n');
  const estimatedTokens = Math.floor(fullText.length / 3.5);

  if (estimatedTokens < config.largeFileTokenThreshold) {
    return undefined;
  }

  const filePath = event.input.path as string;

  // Get file mtime for cache invalidation
  let fileMtime = 0;
  try {
    fileMtime = statSync(filePath).mtimeMs;
  } catch {
    fileMtime = Date.now();
  }

  // Check for existing entry with same path and mtime (AC 9: dedup)
  let existing: ReturnType<typeof store.getLargeFileByPath>;
  try {
    existing = store.getLargeFileByPath(filePath);
  } catch {
    return undefined; // store error -> pass-through
  }
  if (existing && existing.fileMtime === fileMtime) {
    let summary: string;
    try {
      summary = explorerFn(filePath, fullText);
    } catch {
      const lineCount = fullText.split('\n').length;
      summary = `${filePath}\n${lineCount} lines, ~${estimatedTokens} tokens.`;
    }
    const replacementText = `${summary}\n\n~${estimatedTokens} tokens total. Use lcm_expand("${existing.fileId}") to retrieve content.`;
    return {
      content: [{ type: 'text', text: replacementText }],
    };
  }

  // Mtime changed — delete old entry and its cache file (AC 10)
  if (existing && existing.fileMtime !== fileMtime) {
    try { unlinkSync(existing.storagePath); } catch { /* cache file may already be gone */ }
    try { store.deleteLargeFile(existing.fileId); } catch { /* ignore */ }
  }

  // Auto-create cache dir and write cache file (AC 19, AC 8)
  const cacheFileName = `${randomUUID()}.txt`;
  const storagePath = join(cacheDir, cacheFileName);

  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(storagePath, fullText, 'utf-8');
  } catch {
    return undefined; // AC 8: persistence failure -> pass-through
  }

  // Insert into store
  try {
    // Generate exploration summary
    let summary: string;
    try {
      summary = explorerFn(filePath, fullText);
    } catch {
      // AC 7: fallback to generic summary
      const lineCount = fullText.split('\n').length;
      summary = `${filePath}\n${lineCount} lines, ~${estimatedTokens} tokens.`;
    }

    const fileId = store.insertLargeFile({
      path: filePath,
      explorationSummary: summary,
      tokenCount: estimatedTokens,
      storagePath,
      capturedAt: Date.now(),
      fileMtime,
    });

    const replacementText = `${summary}\n\n~${estimatedTokens} tokens total. Use lcm_expand("${fileId}") to retrieve content.`;

    return {
      content: [{ type: 'text', text: replacementText }],
    };
  } catch {
    return undefined; // AC 8: store failure -> pass-through
  }
}

export async function interceptLargeFile(
  event: ToolResultLike,
  store: Store,
  config: InterceptConfig,
  cacheDir: string,
): Promise<ToolResultReplacement | undefined> {
  return interceptLargeFileWithExplorer(event, store, config, cacheDir, explore);
}
