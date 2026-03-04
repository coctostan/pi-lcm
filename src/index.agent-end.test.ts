import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import extensionSetup from './index.ts';
import { MemoryStore } from './store/memory-store.ts';
import type { SessionEntry } from '@mariozechner/pi-coding-agent';

describe('agent_end handler (AC 31)', () => {
  it('calls ingestNewMessages when a Store is available', async () => {
    // Use a mutable ref-box so TypeScript does not narrow through the closure assignment
    const ref: { agentEndHandler: ((event: any, ctx: any) => Promise<void>) | null } = {
      agentEndHandler: null,
    };

    const mockPi = {
      on(event: string, handler: any) {
        if (event === 'agent_end') ref.agentEndHandler = handler;
      },
      registerTool(_tool: any) {},
    } as any;

    // Create a store and pass it via _testDagStore in config
    const store = new MemoryStore();
    store.openConversation('test-sess', '/tmp/test');

    extensionSetup(mockPi, undefined, { dagStore: store });

    assert.ok(ref.agentEndHandler !== null, 'agent_end handler should be registered');

    // Create mock session entries
    const entries: SessionEntry[] = [
      {
        type: 'message',
        id: 'entry-1',
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: 'Hello from agent_end test',
          timestamp: Date.now(),
        },
      } as SessionEntry,
    ];

    const mockCtx = {
      sessionManager: { getBranch: () => entries },
      ui: { setStatus(_key: string, _text: string | undefined) {} },
      getContextUsage() { return undefined; },
    } as any;

    // ref.agentEndHandler is narrowed to non-null after the assert above
    await ref.agentEndHandler!({ messages: [] }, mockCtx);

    // Verify the message was ingested
    const messages = store.getMessagesAfter(-1);
    assert.strictEqual(messages.length, 1, 'Should have ingested 1 message');
    assert.strictEqual(messages[0]!.id, 'entry-1');
    assert.strictEqual(messages[0]!.content, 'Hello from agent_end test');

    store.close();
  });

  it('does nothing when no Store is available', async () => {
    const ref: { agentEndHandler: ((event: any, ctx: any) => Promise<void>) | null } = {
      agentEndHandler: null,
    };

    const mockPi = {
      on(event: string, handler: any) {
        if (event === 'agent_end') ref.agentEndHandler = handler;
      },
      registerTool(_tool: any) {},
    } as any;

    // No store passed
    extensionSetup(mockPi);

    assert.ok(ref.agentEndHandler !== null, 'agent_end handler should be registered');

    const mockCtx = {
      sessionManager: { getBranch: () => [] },
      ui: { setStatus(_key: string, _text: string | undefined) {} },
      getContextUsage() { return undefined; },
    } as any;

    // Should not throw even with no store
    await ref.agentEndHandler!({ messages: [] }, mockCtx);
  });

  it('calls runCompaction after ingestNewMessages completes, passing store/summarizer/config/signal (AC 28)', async () => {
    const ref: { agentEndHandler: ((event: any, ctx: any) => Promise<void>) | null } = {
      agentEndHandler: null,
    };

    const mockPi = {
      on(event: string, handler: any) {
        if (event === 'agent_end') ref.agentEndHandler = handler;
      },
      registerTool(_tool: any) {},
      appendEntry(_customType: string, _data: any) {},
    } as any;

    const store = new MemoryStore();
    store.openConversation('test-sess', '/tmp/test');

    const calls: Array<{ messageCountAtCall: number; signalType: string }> = [];

    const fakeSummarizer = {
      async summarize(): Promise<string> {
        return 'summary';
      },
    } as any;

    const runCompactionFn = async (passedStore: any, _summarizer: any, _config: any, signal: AbortSignal) => {
      calls.push({
        messageCountAtCall: passedStore.getMessagesAfter(-1).length,
        signalType: signal.constructor.name,
      });
      return {
        actionTaken: false,
        summariesCreated: 0,
        messagesSummarized: 0,
        noOpReasons: ['eligible_leaves_below_min'],
      };
    };

    extensionSetup(mockPi, undefined, {
      dagStore: store,
      summarizer: fakeSummarizer,
      runCompactionFn,
    } as any);

    const entries: SessionEntry[] = [
      {
        type: 'message',
        id: 'entry-1',
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: 'Hello from compaction wiring test',
          timestamp: Date.now(),
        },
      } as SessionEntry,
    ];

    const mockCtx = {
      sessionManager: { getBranch: () => entries },
      ui: { setStatus(_key: string, _text: string | undefined) {} },
      getContextUsage() { return undefined; },
    } as any;

    await ref.agentEndHandler!({ messages: [] }, mockCtx);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.messageCountAtCall, 1, 'compaction should run after ingestion');
    assert.strictEqual(calls[0]!.signalType, 'AbortSignal');

    store.close();
  });

  it('catches and logs runCompaction errors without propagating from agent_end (AC 29)', async () => {
    const ref: { agentEndHandler: ((event: any, ctx: any) => Promise<void>) | null } = {
      agentEndHandler: null,
    };

    const mockPi = {
      on(event: string, handler: any) {
        if (event === 'agent_end') ref.agentEndHandler = handler;
      },
      registerTool(_tool: any) {},
      appendEntry(_customType: string, _data: any) {},
    } as any;

    const store = new MemoryStore();
    store.openConversation('test-sess', '/tmp/test');

    const fakeSummarizer = {
      async summarize(): Promise<string> {
        return 'summary';
      },
    } as any;

    const originalError = console.error;
    const logged: any[] = [];
    console.error = (...args: any[]) => {
      logged.push(args);
    };

    try {
      extensionSetup(mockPi, undefined, {
        dagStore: store,
        summarizer: fakeSummarizer,
        runCompactionFn: async () => {
          throw new Error('boom from runCompaction');
        },
      } as any);

      const mockCtx = {
        sessionManager: { getBranch: () => [] },
        ui: { setStatus(_key: string, _text: string | undefined) {} },
        getContextUsage() { return undefined; },
      } as any;

      await ref.agentEndHandler!({ messages: [] }, mockCtx);

      assert.ok(logged.length > 0, 'expected compaction error to be logged');
      assert.ok(String(logged[0]![0]).includes('pi-lcm: compaction error'));
    } finally {
      console.error = originalError;
      store.close();
    }
  });
});
