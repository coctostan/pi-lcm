import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import extensionSetup from './index.ts';
import { MemoryStore } from './store/memory-store.ts';

describe('session_shutdown handler', () => {
  it('returns without error when dagStore is null (AC 17)', async () => {
    const ref: { handler: ((event: any, ctx: any) => Promise<void>) | null } = {
      handler: null,
    };

    const mockPi = {
      on(event: string, h: any) {
        if (event === 'session_shutdown') ref.handler = h;
      },
      registerTool(_tool: any) {},
    } as any;

    // No dagStore passed — dagStore will be null
    extensionSetup(mockPi);

    assert.ok(ref.handler !== null, 'session_shutdown handler should be registered');

    // Should not throw
    await ref.handler!({ type: 'session_shutdown' }, {} as any);
  });

  it('calls dagStore.close() when dagStore is available (AC 16)', async () => {
    const ref: { handler: ((event: any, ctx: any) => Promise<void>) | null } = {
      handler: null,
    };

    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/test');

    const mockPi = {
      on(event: string, h: any) {
        if (event === 'session_shutdown') ref.handler = h;
      },
      registerTool(_tool: any) {},
    } as any;

    extensionSetup(mockPi, undefined, { dagStore: store });

    await ref.handler!({ type: 'session_shutdown' }, {} as any);

    // Verify close was called by checking that store operations now throw
    assert.throws(
      () => store.getLastIngestedSeq(),
      (err: Error) => err.message.includes('closed'),
      'Store should be closed after session_shutdown',
    );
  });

  it('catches and logs close() errors without re-throwing (AC 18)', async () => {
    const ref: { handler: ((event: any, ctx: any) => Promise<void>) | null } = {
      handler: null,
    };

    // Create a store wrapper that throws on close
    const realStore = new MemoryStore();
    realStore.openConversation('sess_1', '/tmp/test');
    const throwingStore = {
      ...realStore,
      close() {
        throw new Error('disk I/O error on close');
      },
    };

    const mockPi = {
      on(event: string, h: any) {
        if (event === 'session_shutdown') ref.handler = h;
      },
      registerTool(_tool: any) {},
    } as any;

    extensionSetup(mockPi, undefined, { dagStore: throwingStore as any });

    const originalError = console.error;
    const logged: any[] = [];
    console.error = (...args: any[]) => {
      logged.push(args);
    };

    try {
      // Should NOT throw
      await ref.handler!({ type: 'session_shutdown' }, {} as any);

      assert.ok(logged.length > 0, 'Error should be logged');
      assert.ok(
        logged.some(args => String(args).includes('disk I/O error on close')),
        'Logged error should contain the original error message',
      );
    } finally {
      console.error = originalError;
      realStore.close();
    }
  });
});
