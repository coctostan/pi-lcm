import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { runCompaction } from './engine.ts';
import type { Summarizer } from '../summarizer/summarizer.ts';

describe('runCompaction rejected summary logging', () => {
  it('emits a debug log with the validation rejection reason for leaf summaries', async () => {
    const previousDebug = process.env.PI_LCM_DEBUG;
    process.env.PI_LCM_DEBUG = '1';

    const originalConsoleLog = console.log;
    const logs: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args);
    };

    try {
      const store = new MemoryStore();
      store.openConversation('sess_rejected_leaf_log', '/tmp/project');
      store.ingestMessage({ id: 'm0', seq: 0, role: 'user', content: 'First message', tokenCount: 50, createdAt: 1 });
      store.replaceContextItems([{ kind: 'message', messageId: 'm0' }]);

      const summarizer: Summarizer = {
        async summarize() {
          return '[toolCall:read {"path":"src/index.ts"}]';
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

      const rejectionLog = logs.find(args => {
        return (
          args[0] === 'pi-lcm: debug: compaction summary rejected' &&
          typeof args[1] === 'object' &&
          args[1] !== null &&
          (args[1] as { phase?: string }).phase === 'leaf' &&
          (args[1] as { reason?: string }).reason === 'tool_roleplay_marker'
        );
      });

      assert.ok(
        rejectionLog,
        'Expected compaction summary rejected debug log for tool_roleplay_marker',
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
