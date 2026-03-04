import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatMessagesForSummary } from './format.ts';
import type { StoredMessage } from '../store/types.ts';

function makeMsg(
  overrides: Partial<StoredMessage> & {
    role: StoredMessage['role'];
    content: string;
  },
): StoredMessage {
  return {
    id: 'msg-1',
    seq: 0,
    tokenCount: 10,
    createdAt: 1000,
    conversationId: 'conv-1',
    ...overrides,
  };
}

describe('formatMessagesForSummary', () => {
  it('returns empty string for empty array (AC 8)', () => {
    assert.strictEqual(formatMessagesForSummary([]), '');
  });

  it('serializes a user message as [user]\\n<content> (AC 5)', () => {
    const msg = makeMsg({ role: 'user', content: 'Hello world' });
    const result = formatMessagesForSummary([msg]);
    assert.strictEqual(result, '[user]\nHello world');
  });

  it('serializes an assistant message as [assistant]\\n<content> (AC 6)', () => {
    const msg = makeMsg({ role: 'assistant', content: 'I can help with that' });
    const result = formatMessagesForSummary([msg]);
    assert.strictEqual(result, '[assistant]\nI can help with that');
  });

  it('serializes a toolResult message as [tool: <toolName>]\\n<content> with full output (AC 7)', () => {
    const msg = makeMsg({
      role: 'toolResult',
      toolName: 'read_file',
      content: 'File contents here: line1\nline2\nline3',
    });
    const result = formatMessagesForSummary([msg]);
    assert.strictEqual(result, '[tool: read_file]\nFile contents here: line1\nline2\nline3');
  });

  it('separates multiple messages with double newlines (AC 9)', () => {
    const msgs = [
      makeMsg({ id: 'm1', seq: 0, role: 'user', content: 'What is 2+2?' }),
      makeMsg({ id: 'm2', seq: 1, role: 'assistant', content: 'The answer is 4.' }),
      makeMsg({ id: 'm3', seq: 2, role: 'toolResult', toolName: 'bash', content: 'echo 4' }),
    ];
    const result = formatMessagesForSummary(msgs);
    const expected = '[user]\nWhat is 2+2?\n\n[assistant]\nThe answer is 4.\n\n[tool: bash]\necho 4';
    assert.strictEqual(result, expected);
  });
});
