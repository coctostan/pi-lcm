import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PiSummarizer, SummarizationUnavailableError } from './summarizer.ts';

describe('PiSummarizer no-text responses', () => {
  it('rejects assistant messages that contain no usable text blocks', async () => {
    const summarizer = new PiSummarizer({
      modelRegistry: {
        find: () => ({ id: 'claude-haiku-4-5', provider: 'anthropic' }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'oauth-token', headers: { Authorization: 'Bearer oauth-token' } }),
      } as any,
      summaryModel: 'anthropic/claude-haiku-4-5',
      completeFn: async () => ({
        role: 'assistant' as const,
        content: [{ type: 'toolCall' as const, id: 'tool_1', name: 'read', arguments: { path: 'src/index.ts' } }],
        api: 'anthropic' as const,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        usage: {
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop' as const,
        timestamp: Date.now(),
      }),
    });

    await assert.rejects(
      () =>
        summarizer.summarize('Existing summaries...', {
          depth: 1,
          kind: 'condensed',
          maxOutputTokens: 256,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SummarizationUnavailableError);
        assert.strictEqual((error as SummarizationUnavailableError).reason, 'missing_text');
        assert.strictEqual((error as SummarizationUnavailableError).message, 'Summarization returned no text content.');
        return true;
      },
      'Expected summarize() to reject responses with no text blocks',
    );
  });
});
