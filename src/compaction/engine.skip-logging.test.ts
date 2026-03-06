import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import {
  SummarizationUnavailableError,
  type Summarizer,
} from '../summarizer/summarizer.ts';

describe('runCompaction debug logging for skipped summaries', () => {
  it('emits a debug log with the skip reason and provider error details', async () => {
    const previousDebug = process.env.PI_LCM_DEBUG;
    process.env.PI_LCM_DEBUG = '1';

    const originalConsoleLog = console.log;
    const logs: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args);
    };

    try {
      const store = new MemoryStore();
      store.openConversation('sess_skip_log', '/tmp/project');
      store.ingestMessage({ id: 'm0', seq: 0, role: 'user', content: 'First message', tokenCount: 50, createdAt: 1 });
      store.replaceContextItems([{ kind: 'message', messageId: 'm0' }]);

      const summarizer: Summarizer = {
        async summarize() {
          throw new SummarizationUnavailableError(
            'error_response',
            'error',
            'Could not resolve authentication method. Expected either apiKey or oauthToken to be set.',
          );
        },
      };

      await runCompaction(
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

      const skipLog = logs.find(args => {
        return (
          args[0] === 'pi-lcm: debug: compaction summary skipped' &&
          typeof args[1] === 'object' &&
          args[1] !== null &&
          (args[1] as { phase?: string }).phase === 'leaf' &&
          (args[1] as { reason?: string }).reason === 'summary_error_response'
        );
      });

      assert.ok(
        skipLog,
        'Expected compaction summary skipped debug log for summary_error_response',
      );
      assert.strictEqual(
        (skipLog![1] as { stopReason?: string }).stopReason,
        'error',
      );
      assert.match(
        String((skipLog![1] as { errorMessage?: string }).errorMessage),
        /Could not resolve authentication method/,
      );

      store.close();
    } finally {
      console.log = originalConsoleLog;
      if (previousDebug === undefined) {
        delete process.env.PI_LCM_DEBUG;
      } else {
        process.env.PI_LCM_DEBUG = previousDebug;
      }
    }
  });
});
