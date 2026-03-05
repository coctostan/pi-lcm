import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PiSummarizer } from './summarizer.ts';

describe('PiSummarizer', () => {
  it('resolves model via modelRegistry.find(provider, modelId) and throws if not found (AC 15)', () => {
    const mockRegistry = {
      find: (provider: string, modelId: string) => undefined,
    };

    assert.throws(
      () =>
        new PiSummarizer({
          modelRegistry: mockRegistry as any,
          summaryModel: 'google/gemini-2.5-flash',
        }),
      (err: any) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('google/gemini-2.5-flash'),
          `Error should include model string, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('resolves model successfully when modelRegistry.find returns a model (AC 15)', () => {
    const mockModel = { id: 'gemini-2.5-flash', provider: 'google' };
    const findCalls: Array<{ provider: string; modelId: string }> = [];
    const mockRegistry = {
      find: (provider: string, modelId: string) => {
        findCalls.push({ provider, modelId });
        return mockModel;
      },
    };

    const summarizer = new PiSummarizer({
      modelRegistry: mockRegistry as any,
      summaryModel: 'google/gemini-2.5-flash',
    });

    assert.ok(summarizer);
    assert.strictEqual(findCalls.length, 1);
    assert.strictEqual(findCalls[0]!.provider, 'google');
    assert.strictEqual(findCalls[0]!.modelId, 'gemini-2.5-flash');
  });

  it('calls complete() with leaf prompt for kind "leaf" and returns text content (AC 16, 17)', async () => {
    const mockModel = { id: 'gemini-2.5-flash', provider: 'google' };
    const completeCalls: Array<{ model: any; context: any; options: any }> = [];
    const mockComplete = async (model: any, context: any, options?: any) => {
      completeCalls.push({ model, context, options });
      return {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'This is a summary of the conversation.' }],
        api: 'google-generative-ai' as const,
        provider: 'google',
        model: 'gemini-2.5-flash',
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
      };
    };

    const summarizer = new PiSummarizer({
      modelRegistry: { find: () => mockModel } as any,
      summaryModel: 'google/gemini-2.5-flash',
      completeFn: mockComplete as any,
    });

    const result = await summarizer.summarize('Some conversation content', {
      depth: 1,
      kind: 'leaf',
      maxOutputTokens: 500,
    });

    assert.strictEqual(result, 'This is a summary of the conversation.');
    assert.strictEqual(completeCalls.length, 1);

    const call = completeCalls[0]!;
    assert.ok(
      call.context.systemPrompt.toLowerCase().includes('summar'),
      'System prompt should contain summarize instruction',
    );
    assert.strictEqual(call.context.messages.length, 1);
    assert.strictEqual(call.context.messages[0].role, 'user');
    assert.strictEqual(call.context.messages[0].content, 'Some conversation content');
    assert.strictEqual(call.options.maxTokens, 500);
  });

  it('calls complete() with condense prompt for kind "condensed" (AC 16)', async () => {
    const mockModel = { id: 'gemini-2.5-flash', provider: 'google' };
    const completeCalls: Array<{ context: any }> = [];
    const mockComplete = async (_model: any, context: any, _options?: any) => {
      completeCalls.push({ context });
      return {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'Condensed summary' }],
        api: 'google-generative-ai' as const,
        provider: 'google',
        model: 'gemini-2.5-flash',
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
      };
    };

    const summarizer = new PiSummarizer({
      modelRegistry: { find: () => mockModel } as any,
      summaryModel: 'google/gemini-2.5-flash',
      completeFn: mockComplete as any,
    });

    const result = await summarizer.summarize('Existing summaries...', {
      depth: 2,
      kind: 'condensed',
      maxOutputTokens: 500,
    });

    assert.strictEqual(result, 'Condensed summary');
    const call = completeCalls[0]!;
    assert.ok(
      call.context.systemPrompt.toLowerCase().includes('condens'),
      'System prompt should contain condense instruction',
    );
    assert.ok(call.context.systemPrompt.includes('2'), 'System prompt should include depth value');
  });

  it('propagates the signal option to complete() for abort support (AC 18)', async () => {
    const mockModel = { id: 'gemini-2.5-flash', provider: 'google' };
    let capturedOptions: any = null;
    const mockComplete = async (_model: any, _context: any, options?: any) => {
      capturedOptions = options;
      return {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'result' }],
        api: 'google-generative-ai' as const,
        provider: 'google',
        model: 'gemini-2.5-flash',
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
      modelRegistry: { find: () => mockModel } as any,
      summaryModel: 'google/gemini-2.5-flash',
      completeFn: mockComplete as any,
    });

    const ac = new AbortController();
    await summarizer.summarize('test content', {
      depth: 1,
      kind: 'leaf',
      maxOutputTokens: 500,
      signal: ac.signal,
    });

    assert.ok(capturedOptions, 'Options should have been passed to complete()');
    assert.strictEqual(capturedOptions.signal, ac.signal, 'Signal should be propagated to complete()');
  });

  it('resolves apiKey via modelRegistry.getApiKey and passes it in options (auth bridge)', async () => {
    const mockModel = { id: 'claude-haiku-4-5', provider: 'anthropic' };
    let capturedOptions: any = null;
    const mockComplete = async (_model: any, _context: any, options?: any) => {
      capturedOptions = options;
      return {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'summary' }],
        api: 'anthropic-messages' as const,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop' as const,
        timestamp: Date.now(),
      };
    };

    const mockRegistry = {
      find: () => mockModel,
      getApiKey: async (_m: any) => 'test-api-key-abc123',
    };

    const summarizer = new PiSummarizer({
      modelRegistry: mockRegistry as any,
      summaryModel: 'anthropic/claude-haiku-4-5',
      completeFn: mockComplete as any,
    });

    await summarizer.summarize('Some content', { depth: 0, kind: 'leaf', maxOutputTokens: 200 });

    assert.strictEqual(capturedOptions.apiKey, 'test-api-key-abc123',
      'apiKey from modelRegistry.getApiKey should be forwarded to completeFn options');
  });

  it('does not add apiKey to options when getApiKey is absent from registry', async () => {
    const mockModel = { id: 'claude-haiku-4-5', provider: 'anthropic' };
    let capturedOptions: any = null;
    const mockComplete = async (_model: any, _context: any, options?: any) => {
      capturedOptions = options;
      return {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'summary' }],
        api: 'anthropic-messages' as const,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop' as const,
        timestamp: Date.now(),
      };
    };

    const summarizer = new PiSummarizer({
      modelRegistry: { find: () => mockModel } as any,
      summaryModel: 'anthropic/claude-haiku-4-5',
      completeFn: mockComplete as any,
    });

    await summarizer.summarize('Some content', { depth: 0, kind: 'leaf', maxOutputTokens: 200 });

    assert.strictEqual(capturedOptions.apiKey, undefined,
      'apiKey should not be set when modelRegistry has no getApiKey method');
  });

  it('throws when response contains errorMessage (surfaces API auth / network errors)', async () => {
    const mockModel = { id: 'claude-haiku-4-5', provider: 'anthropic' };
    const mockComplete = async () => ({
      role: 'assistant' as const,
      content: [] as any[],
      api: 'anthropic-messages' as const,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'error' as const,
      timestamp: Date.now(),
      errorMessage: 'Could not resolve authentication method.',
    });

    const summarizer = new PiSummarizer({
      modelRegistry: { find: () => mockModel } as any,
      summaryModel: 'anthropic/claude-haiku-4-5',
      completeFn: mockComplete as any,
    });

    await assert.rejects(
      () => summarizer.summarize('content', { depth: 0, kind: 'leaf', maxOutputTokens: 200 }),
      (err: any) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('Could not resolve authentication'),
          `Expected auth error message, got: ${err.message}`);
        return true;
      },
    );
  });
});
