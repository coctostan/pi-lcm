import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer, SummarizeOptions } from '../summarizer/summarizer.ts';

describe('runCompaction mutex', () => {
  it('returns immediate no-op when compaction is already running (AC 26)', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_mutex', '/tmp/project');

    store.ingestMessage({ id: 'm0', seq: 0, role: 'user', content: 'hello', tokenCount: 5, createdAt: 1 });
    store.replaceContextItems([{ kind: 'message', messageId: 'm0' }]);

    let releaseFirstCall: (() => void) | undefined;
    const blockFirstCall = new Promise<void>(resolve => {
      releaseFirstCall = resolve;
    });

    let summarizeCallCount = 0;
    const summarizer: Summarizer = {
      async summarize(_content: string, _opts: SummarizeOptions): Promise<string> {
        summarizeCallCount += 1;
        if (summarizeCallCount === 1) {
          await blockFirstCall;
        }
        return 'short';
      },
    };

    const firstRun = runCompaction(
      store,
      summarizer,
      {
        freshTailCount: 0,
        leafChunkTokens: 100,
        leafTargetTokens: 100,
        condensedTargetTokens: 100,
        condensedMinFanout: 2,
      },
      new AbortController().signal,
    );

    // Second invocation while first is blocked
    const secondResult = await runCompaction(
      store,
      summarizer,
      {
        freshTailCount: 0,
        leafChunkTokens: 100,
        leafTargetTokens: 100,
        condensedTargetTokens: 100,
        condensedMinFanout: 2,
      },
      new AbortController().signal,
    );

    assert.strictEqual(secondResult.actionTaken, false);
    assert.deepStrictEqual(secondResult.noOpReasons, ['compaction_already_running']);

    releaseFirstCall!();
    await firstRun;

    store.close();
  });
});
