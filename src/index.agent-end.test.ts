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
});
