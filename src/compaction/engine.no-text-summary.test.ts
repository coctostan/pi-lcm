import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import { PiSummarizer } from '../summarizer/summarizer.ts';

describe('runCompaction no-text regression', () => {
  it('keeps raw messages in context when the summarizer returns no text blocks', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_notext_leaf', '/tmp/project');

    store.ingestMessage({ id: 'm0', seq: 0, role: 'user', content: 'First message', tokenCount: 50, createdAt: 1 });
    store.ingestMessage({ id: 'm1', seq: 1, role: 'assistant', content: 'Second message', tokenCount: 50, createdAt: 2 });
    store.replaceContextItems([
      { kind: 'message', messageId: 'm0' },
      { kind: 'message', messageId: 'm1' },
    ]);

    const summarizer = new PiSummarizer({
      modelRegistry: {
        find: () => ({ id: 'claude-haiku-4-5', provider: 'anthropic' }),
        getApiKey: async () => 'fake-token',
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

    const result = await runCompaction(
      store,
      summarizer,
      {
        freshTailCount: 0,
        leafChunkTokens: 10,
        leafTargetTokens: 50,
        condensedTargetTokens: 50,
        condensedMinFanout: 2,
      },
      new AbortController().signal,
    );

    assert.strictEqual(
      result.actionTaken,
      false,
      'Expected actionTaken false when the summarizer returns no text blocks',
    );
    assert.strictEqual(result.summariesCreated, 0);
    assert.strictEqual(result.messagesSummarized, 0);
    assert.ok(
      result.noOpReasons.includes('summary_missing_text'),
      `Expected summary_missing_text, got: ${result.noOpReasons.join(', ')}`,
    );
    assert.deepStrictEqual(store.getContextItems(), [
      { kind: 'message', messageId: 'm0' },
      { kind: 'message', messageId: 'm1' },
    ]);

    store.close();
  });
});
