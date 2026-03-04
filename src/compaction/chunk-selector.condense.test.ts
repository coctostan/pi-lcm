import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectCondensationChunk } from './chunk-selector.ts';
import type { ContextItem, StoredSummary } from '../store/types.ts';

function sum(summaryId: string): ContextItem {
  return { kind: 'summary', summaryId };
}

describe('selectCondensationChunk', () => {
  it('selects oldest contiguous same-depth summaries outside fresh tail with minimum fanout (AC 9)', () => {
    const contextItems: ContextItem[] = [
      sum('s0'),
      sum('s1'),
      sum('s2'),
      sum('s3'),
      sum('s4'), // fresh tail
    ];

    const summaries = new Map<string, StoredSummary>([
      ['s0', { summaryId: 's0', conversationId: 'c', depth: 0, kind: 'leaf', content: 'a', tokenCount: 2, earliestAt: 1, latestAt: 1, descendantCount: 1, createdAt: 1 }],
      ['s1', { summaryId: 's1', conversationId: 'c', depth: 0, kind: 'leaf', content: 'b', tokenCount: 2, earliestAt: 2, latestAt: 2, descendantCount: 1, createdAt: 2 }],
      ['s2', { summaryId: 's2', conversationId: 'c', depth: 0, kind: 'leaf', content: 'c', tokenCount: 2, earliestAt: 3, latestAt: 3, descendantCount: 1, createdAt: 3 }],
      ['s3', { summaryId: 's3', conversationId: 'c', depth: 1, kind: 'condensed', content: 'd', tokenCount: 2, earliestAt: 4, latestAt: 4, descendantCount: 2, createdAt: 4 }],
      ['s4', { summaryId: 's4', conversationId: 'c', depth: 0, kind: 'leaf', content: 'e', tokenCount: 2, earliestAt: 5, latestAt: 5, descendantCount: 1, createdAt: 5 }],
    ]);

    const chunk = selectCondensationChunk(
      contextItems,
      1,
      0,
      3,
      100,
      {
        getSummary(id: string) {
          return summaries.get(id);
        },
      } as any,
    );

    assert.deepStrictEqual(chunk.map(item => item.summaryId), ['s0', 's1', 's2']);
  });

  it('returns empty when contiguous run is below condensedMinFanout (AC 10)', () => {
    const contextItems: ContextItem[] = [sum('s0'), sum('x0'), sum('s1')];

    const summaries = new Map<string, StoredSummary>([
      ['s0', { summaryId: 's0', conversationId: 'c', depth: 0, kind: 'leaf', content: 'a', tokenCount: 1, earliestAt: 1, latestAt: 1, descendantCount: 1, createdAt: 1 }],
      ['x0', { summaryId: 'x0', conversationId: 'c', depth: 1, kind: 'condensed', content: 'x', tokenCount: 1, earliestAt: 2, latestAt: 2, descendantCount: 2, createdAt: 2 }],
      ['s1', { summaryId: 's1', conversationId: 'c', depth: 0, kind: 'leaf', content: 'b', tokenCount: 1, earliestAt: 3, latestAt: 3, descendantCount: 1, createdAt: 3 }],
    ]);

    const chunk = selectCondensationChunk(
      contextItems,
      0,
      0,
      2,
      100,
      {
        getSummary(id: string) {
          return summaries.get(id);
        },
      } as any,
    );

    assert.deepStrictEqual(chunk, []);
  });
});
