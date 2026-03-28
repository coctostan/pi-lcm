import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as summarizerModule from './summarizer.ts';

const { PiSummarizer } = summarizerModule;

describe('PiSummarizer error responses', () => {
  it('rejects error-shaped assistant messages instead of returning empty text', async () => {
    const summarizer = new PiSummarizer({
      modelRegistry: {
        find: () => ({ id: 'claude-haiku-4-5', provider: 'anthropic' }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'oauth-token', headers: { Authorization: 'Bearer oauth-token' } }),
      } as any,
      summaryModel: 'anthropic/claude-haiku-4-5',
      completeFn: async () => ({
        role: 'assistant' as const,
        content: [],
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
        stopReason: 'error' as const,
        errorMessage: 'Could not resolve authentication method. Expected either apiKey or oauthToken to be set.',
        timestamp: Date.now(),
      }),
    });

    await assert.rejects(
      () =>
        summarizer.summarize('Some conversation content', {
          depth: 0,
          kind: 'leaf',
          maxOutputTokens: 256,
        }),
      (error: unknown) => {
        assert.ok('SummarizationUnavailableError' in summarizerModule);
        const SummarizationUnavailableError = summarizerModule
          .SummarizationUnavailableError as unknown as typeof Error;
        assert.ok(error instanceof SummarizationUnavailableError);
        assert.strictEqual((error as any).reason, 'error_response');
        assert.strictEqual((error as any).stopReason, 'error');
        assert.match((error as Error).message, /Could not resolve authentication method/);
        return true;
      },
      'Expected summarize() to reject error-shaped provider responses',
    );
  });
});
