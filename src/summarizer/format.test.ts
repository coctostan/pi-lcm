import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatMessagesForSummary } from './format.ts';
import { PiSummarizer } from './summarizer.ts';
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

  it('wraps a user transcript in conversation delimiters (bug 028)', () => {
    const msg = makeMsg({ role: 'user', content: 'Hello world' });
    const result = formatMessagesForSummary([msg]);
    assert.strictEqual(
      result,
      '<conversation_to_summarize>\n[user]\nHello world\n</conversation_to_summarize>',
    );
  });

  it('wraps an assistant transcript in conversation delimiters (bug 028)', () => {
    const msg = makeMsg({ role: 'assistant', content: 'I can help with that' });
    const result = formatMessagesForSummary([msg]);
    assert.strictEqual(
      result,
      '<conversation_to_summarize>\n[assistant]\nI can help with that\n</conversation_to_summarize>',
    );
  });

  it('wraps a tool transcript in conversation delimiters and preserves full output (bug 028)', () => {
    const msg = makeMsg({
      role: 'toolResult',
      toolName: 'read_file',
      content: 'File contents here: line1\nline2\nline3',
    });
    const result = formatMessagesForSummary([msg]);
    assert.strictEqual(
      result,
      '<conversation_to_summarize>\n[tool: read_file]\nFile contents here: line1\nline2\nline3\n</conversation_to_summarize>',
    );
  });

  it('wraps multiple messages while preserving double-newline separation (AC 9)', () => {
    const msgs = [
      makeMsg({ id: 'm1', seq: 0, role: 'user', content: 'What is 2+2?' }),
      makeMsg({ id: 'm2', seq: 1, role: 'assistant', content: 'The answer is 4.' }),
      makeMsg({ id: 'm3', seq: 2, role: 'toolResult', toolName: 'bash', content: 'echo 4' }),
    ];
    const result = formatMessagesForSummary(msgs);
    const expected = '<conversation_to_summarize>\n[user]\nWhat is 2+2?\n\n[assistant]\nThe answer is 4.\n\n[tool: bash]\necho 4\n</conversation_to_summarize>';
    assert.strictEqual(result, expected);
  });

  it('reproduces bug 028 path: summarizer receives delimited transcript and anti-role-play prompt', async () => {
    const msgs = [
      makeMsg({
        id: 'm1',
        seq: 0,
        role: 'user',
        content: 'Read the file src/context/context-handler.ts and explain how it works.',
      }),
      makeMsg({
        id: 'm2',
        seq: 1,
        role: 'toolResult',
        toolName: 'read',
        content: '1: export function handleContext() {}',
      }),
      makeMsg({
        id: 'm3',
        seq: 2,
        role: 'assistant',
        content: 'The context handler works by processing the stored messages in order.',
      }),
    ];

    const formatted = formatMessagesForSummary(msgs);
    assert.ok(formatted.includes('<conversation_to_summarize>'));
    assert.ok(formatted.includes('[tool: read]'));
    assert.ok(formatted.includes('[assistant]'));

    const calls: Array<{ context: any }> = [];
    const mockComplete = async (_model: any, context: any) => {
      calls.push({ context });
      return {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'summary' }],
        api: 'anthropic' as const,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop' as const,
        timestamp: Date.now(),
      };
    };

    const summarizer = new PiSummarizer({
      modelRegistry: {
        find: () => ({ id: 'claude-haiku-4-5', provider: 'anthropic' }),
        getApiKey: async () => 'oauth-token',
      } as any,
      summaryModel: 'anthropic/claude-haiku-4-5',
      completeFn: mockComplete as any,
    });

    await summarizer.summarize(formatted, {
      depth: 1,
      kind: 'leaf',
      maxOutputTokens: 500,
    });

    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0]!.context.systemPrompt.toLowerCase().includes('you are not the assistant'));
    assert.ok(calls[0]!.context.messages[0].content.includes('<conversation_to_summarize>'));
    assert.ok(calls[0]!.context.messages[0].content.includes('[tool: read]'));
    assert.ok(calls[0]!.context.messages[0].content.includes('[assistant]'));
  });
});
