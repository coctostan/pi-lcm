import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectLeafChunk } from './chunk-selector.ts';
import type { ContextItem, StoredMessage } from '../store/types.ts';

function msg(messageId: string): ContextItem {
  return { kind: 'message', messageId };
}

function sum(summaryId: string): ContextItem {
  return { kind: 'summary', summaryId };
}

describe('selectLeafChunk', () => {
  it('selects oldest contiguous message run outside fresh tail, capped by token budget (AC 5)', () => {
    const contextItems: ContextItem[] = [
      msg('m0'),
      msg('m1'),
      msg('m2'),
      sum('s0'),
      msg('m3'),
      msg('m4'),
      msg('m5'), // in fresh tail
    ];

    const messages = new Map<string, StoredMessage>([
      ['m0', { id: 'm0', seq: 0, role: 'user', content: 'a', tokenCount: 2, createdAt: 1, conversationId: 'c' }],
      ['m1', { id: 'm1', seq: 1, role: 'user', content: 'b', tokenCount: 2, createdAt: 2, conversationId: 'c' }],
      ['m2', { id: 'm2', seq: 2, role: 'user', content: 'c', tokenCount: 2, createdAt: 3, conversationId: 'c' }],
      ['m3', { id: 'm3', seq: 3, role: 'user', content: 'd', tokenCount: 2, createdAt: 4, conversationId: 'c' }],
      ['m4', { id: 'm4', seq: 4, role: 'user', content: 'e', tokenCount: 2, createdAt: 5, conversationId: 'c' }],
      ['m5', { id: 'm5', seq: 5, role: 'user', content: 'f', tokenCount: 2, createdAt: 6, conversationId: 'c' }],
    ]);

    const chunk = selectLeafChunk(contextItems, 1, 4, {
      getMessage(id: string) {
        return messages.get(id);
      },
    } as any);

    assert.deepStrictEqual(chunk.map(item => item.messageId), ['m0', 'm1']);
  });

  it('always includes first eligible message even if it exceeds leafChunkTokens (AC 6)', () => {
    const contextItems: ContextItem[] = [msg('big'), msg('m1')];

    const messages = new Map<string, StoredMessage>([
      ['big', { id: 'big', seq: 0, role: 'user', content: 'x', tokenCount: 999, createdAt: 1, conversationId: 'c' }],
      ['m1', { id: 'm1', seq: 1, role: 'user', content: 'y', tokenCount: 1, createdAt: 2, conversationId: 'c' }],
    ]);

    const chunk = selectLeafChunk(contextItems, 0, 10, {
      getMessage(id: string) {
        return messages.get(id);
      },
    } as any);

    assert.deepStrictEqual(chunk.map(item => item.messageId), ['big']);
  });

  it('stops chunk at first non-message item (summary breaks contiguity) (AC 7)', () => {
    const contextItems: ContextItem[] = [msg('m0'), sum('s0'), msg('m1'), msg('m2')];

    const messages = new Map<string, StoredMessage>([
      ['m0', { id: 'm0', seq: 0, role: 'user', content: 'a', tokenCount: 1, createdAt: 1, conversationId: 'c' }],
      ['m1', { id: 'm1', seq: 1, role: 'user', content: 'b', tokenCount: 1, createdAt: 2, conversationId: 'c' }],
      ['m2', { id: 'm2', seq: 2, role: 'user', content: 'c', tokenCount: 1, createdAt: 3, conversationId: 'c' }],
    ]);

    const chunk = selectLeafChunk(contextItems, 0, 100, {
      getMessage(id: string) {
        return messages.get(id);
      },
    } as any);

    assert.deepStrictEqual(chunk.map(item => item.messageId), ['m0']);
  });

  it('returns empty array when no eligible messages exist outside fresh tail (AC 8)', () => {
    const contextItems: ContextItem[] = [msg('m0'), msg('m1')];

    const chunk = selectLeafChunk(contextItems, 2, 100, {
      getMessage(_id: string) {
        return undefined;
      },
    } as any);

    assert.deepStrictEqual(chunk, []);
  });
});
