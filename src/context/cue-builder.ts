import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Store, GrepResult } from '../store/types.ts';

/**
 * Extract the text content from the last user message in assembled messages.
 * Returns null if the last message is not a user role.
 */
export function extractUserQuery(messages: AgentMessage[]): string | null {
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1] as any;
  if (last.role !== 'user') return null;

  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join('\n');
  }
  return null;
}

/**
 * Check if the assembled messages end with a fresh user turn
 * (i.e., the last message is a user message with no trailing assistant/toolResult).
 */
export function isFreshUserTurn(messages: AgentMessage[]): boolean {
  if (messages.length === 0) return false;
  return (messages[messages.length - 1] as any).role === 'user';
}

/**
 * Format a single cue line from a grep result and its summary metadata.
 */
export function formatCueLine(summaryId: string, depth: number, kind: string, snippet: string): string {
  const truncatedSnippet = snippet.length > 120 ? snippet.slice(0, 120) + '...' : snippet;
  return `[cue] summaryId=${summaryId} depth=${depth} kind=${kind} cue="${truncatedSnippet}"`;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and',
  'or', 'if', 'while', 'that', 'this', 'these', 'those', 'it', 'its',
  'my', 'your', 'his', 'her', 'our', 'their', 'what', 'which', 'who',
  'whom', 'me', 'him', 'them', 'we', 'you', 'she', 'he', 'they', 'i',
  'show', 'tell', 'give', 'get', 'make', 'use', 'see', 'look', 'find',
  'know', 'want', 'think', 'say', 'let', 'put', 'take', 'come', 'go',
]);

/**
 * Extract significant keywords from user text for cue retrieval.
 * Filters out stop words and short words.
 */
export function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
  // Deduplicate while preserving order
  return [...new Set(words)];
}

/**
 * Build a <memory-cues> assistant message from non-active summaries that match the user query.
 * Returns null if no relevant cues are found.
 */
export function buildCueBlock(
  store: Store,
  userQuery: string,
  activeSummaryIds: Set<string>,
): AgentMessage | null {
  if (!userQuery || userQuery.trim().length === 0) return null;
  // Extract significant keywords (4+ chars, skip common stop words)
  const keywords = extractKeywords(userQuery);
  if (keywords.length === 0) return null;

  // Search with each keyword, deduplicate hits
  const hitMap = new Map<string, GrepResult>();
  for (const keyword of keywords) {
    let results: GrepResult[];
    try {
      results = store.grepMessages(keyword, 'fulltext');
    } catch {
      continue;
    }
    for (const r of results) {
      if (r.kind === 'summary' && !activeSummaryIds.has(r.id) && !hitMap.has(r.id)) {
        hitMap.set(r.id, r);
      }
    }
  }

  const cueHits = Array.from(hitMap.values());
  if (cueHits.length === 0) return null;
  const cueLines: string[] = [];
  for (const hit of cueHits) {
    const summary = store.getSummary(hit.id);
    if (!summary) continue;
    cueLines.push(formatCueLine(summary.summaryId, summary.depth, summary.kind, hit.snippet));
  }

  if (cueLines.length === 0) return null;
  const cueText = `<memory-cues>\n${cueLines.join('\n')}\n</memory-cues>`;
  return {
    role: 'assistant',
    content: [{ type: 'text', text: cueText }],
    timestamp: 0,
  } as AgentMessage;
}
