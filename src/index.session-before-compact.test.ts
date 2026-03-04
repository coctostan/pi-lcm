import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import extensionSetup from './index.ts';
import { MemoryStore } from './store/memory-store.ts';

describe('session_before_compact handler', () => {
  it('returns { cancel: true } when dagStore is available (AC 12)', async () => {
    const ref: { handler: any } = { handler: null };

    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/test');

    const mockPi = {
      on(event: string, h: any) {
        if (event === 'session_before_compact') ref.handler = h;
      },
      registerTool(_tool: any) {},
    } as any;

    extensionSetup(mockPi, undefined, { dagStore: store });

    const event = {
      type: 'session_before_compact',
      preparation: {},
      branchEntries: [],
      signal: new AbortController().signal,
    } as any;

    const result = await ref.handler!(event, {} as any);
    assert.deepStrictEqual(result, { cancel: true }, 'Should return { cancel: true }');
    assert.strictEqual((result as any).compaction, undefined, 'Should not include a compaction field');

    store.close();
  });

  it('runs emergency compaction before returning cancel (AC 13)', async () => {
    const ref: { handler: any } = { handler: null };

    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/test');

    const compactionCalls: Array<{ signalType: string }> = [];
    const runCompactionFn = async (_store: any, _summarizer: any, _config: any, signal: AbortSignal) => {
      compactionCalls.push({ signalType: signal.constructor.name });
      return {
        actionTaken: false,
        summariesCreated: 0,
        messagesSummarized: 0,
        noOpReasons: ['test'],
      };
    };

    const fakeSummarizer = {
      async summarize(): Promise<string> {
        return 'summary';
      },
    } as any;

    const mockPi = {
      on(event: string, h: any) {
        if (event === 'session_before_compact') ref.handler = h;
      },
      registerTool(_tool: any) {},
      appendEntry(_type: string, _data: any) {},
    } as any;

    extensionSetup(mockPi, undefined, {
      dagStore: store,
      summarizer: fakeSummarizer,
      runCompactionFn: runCompactionFn as any,
    });

    const event = {
      type: 'session_before_compact',
      preparation: {},
      branchEntries: [],
      signal: new AbortController().signal,
    } as any;

    const result = await ref.handler!(event, {} as any);

    assert.deepStrictEqual(result, { cancel: true });
    assert.strictEqual(compactionCalls.length, 1, 'runCompaction should be called once');
    assert.strictEqual(compactionCalls[0]!.signalType, 'AbortSignal');

    store.close();
  });

  it('returns undefined when dagStore is null (AC 14)', async () => {
    const ref: { handler: any } = { handler: null };
    const mockPi = {
      on(event: string, h: any) {
        if (event === 'session_before_compact') ref.handler = h;
      },
      registerTool(_tool: any) {},
    } as any;

    extensionSetup(mockPi);

    const event = {
      type: 'session_before_compact',
      preparation: {},
      branchEntries: [],
      signal: new AbortController().signal,
    } as any;

    const result = await ref.handler!(event, {} as any);
    assert.strictEqual(result, undefined, 'Should return undefined to fall through');
  });

  it('catches compaction errors and returns undefined to fall through (AC 15)', async () => {
    const ref: { handler: any } = { handler: null };

    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/test');

    const fakeSummarizer = {
      async summarize(): Promise<string> {
        return 'summary';
      },
    } as any;

    const mockPi = {
      on(event: string, h: any) {
        if (event === 'session_before_compact') ref.handler = h;
      },
      registerTool(_tool: any) {},
      appendEntry(_type: string, _data: any) {},
    } as any;

    extensionSetup(mockPi, undefined, {
      dagStore: store,
      summarizer: fakeSummarizer,
      runCompactionFn: async () => {
        throw new Error('compaction engine exploded');
      },
    } as any);

    const originalError = console.error;
    const logged: any[] = [];
    console.error = (...args: any[]) => {
      logged.push(args);
    };

    try {
      const event = {
        type: 'session_before_compact',
        preparation: {},
        branchEntries: [],
        signal: new AbortController().signal,
      } as any;

      const result = await ref.handler!(event, {} as any);

      assert.strictEqual(result, undefined, 'Should return undefined on error');
      assert.ok(logged.length > 0, 'Error should be logged');
      assert.ok(
        logged.some(args => String(args).includes('compaction engine exploded')),
        'Logged error should contain original message',
      );
    } finally {
      console.error = originalError;
      store.close();
    }
  });
});
