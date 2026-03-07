import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import extensionSetup from './index.ts';
import { MemoryStore } from './store/memory-store.ts';
import type { SessionEntry } from '@mariozechner/pi-coding-agent';

function makeMessageEntry(
  id: string,
  role: 'user' | 'assistant' | 'toolResult',
  content: string,
  parentId: string | null = null,
): SessionEntry {
  const msg: any = { role, timestamp: Date.now() };
  if (role === 'user') {
    msg.content = content;
  } else if (role === 'assistant') {
    msg.content = [{ type: 'text', text: content }];
    msg.api = 'anthropic-messages';
    msg.provider = 'anthropic';
    msg.model = 'claude-sonnet';
    msg.usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    msg.stopReason = 'stop';
  } else {
    msg.content = [{ type: 'text', text: content }];
    msg.toolCallId = `tool_${id}`;
    msg.toolName = 'bash';
    msg.isError = false;
  }
  return {
    type: 'message',
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: msg,
  } as SessionEntry;
}

describe('session_start handler', () => {
  it('reconciles branch and enables DAG-backed context path after start (AC 7)', async () => {
    const ref: { startHandler: any; contextHandler: any } = {
      startHandler: null,
      contextHandler: null,
    };

    const store = new MemoryStore();
    // Intentionally do not openConversation() — session_start must do this.
    const branch: SessionEntry[] = [
      makeMessageEntry('e0', 'user', 'hello'),
      makeMessageEntry('e1', 'assistant', 'hi there', 'e0'),
      makeMessageEntry('e2', 'user', 'do something', 'e1'),
    ];

    const mockPi = {
      on(event: string, h: any) {
        if (event === 'session_start') ref.startHandler = h;
        if (event === 'context') ref.contextHandler = h;
      },
      registerTool(_tool: any) {},
    } as any;

    extensionSetup(mockPi, undefined, { dagStore: store });

    const mockCtx = {
      sessionManager: {
        getBranch: () => branch,
        getSessionId: () => 'test-sess',
      },
      cwd: '/tmp/test',
      ui: { setStatus: () => {} },
      getContextUsage: () => undefined,
    } as any;

    await ref.startHandler!({ type: 'session_start' }, mockCtx);

    const messages = store.getMessagesAfter(-1);
    assert.strictEqual(messages.length, 3, 'All branch messages should be ingested during session_start');

    const items = store.getContextItems();
    assert.strictEqual(items.length, 3, 'session_start should populate context_items');

    // Make DAG-path behavior observable in context handler.
    const summaryId = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'post-start summary',
      tokenCount: 10,
      earliestAt: 1,
      latestAt: 2,
      descendantCount: 1,
      createdAt: Date.now(),
    });
    store.replaceContextItems([{ kind: 'summary', summaryId }]);

    const contextEvent = { messages: [] as any[] };
    const contextResult = await ref.contextHandler!(contextEvent, mockCtx);

    assert.ok(contextResult, 'Context handler must return a ContextEventResult');
    assert.ok(Array.isArray(contextResult.messages), 'Context handler return must include messages array');
    assert.strictEqual(contextResult.messages.length, 1, 'ContextBuilder should use dagStore-backed context_items');

    const summaryMessage = contextResult.messages[0] as any;
    assert.strictEqual(summaryMessage.role, 'user');
    assert.ok(typeof summaryMessage.content === 'string');
    assert.ok(summaryMessage.content.includes('[LCM Context Summary \u2014 this summarizes earlier parts of the conversation]'));
    assert.ok(summaryMessage.content.includes('Summary 1: post-start summary'));

    store.close();
  });

  it('creates a fresh store and re-ingests branch messages when primary store is corrupted (AC 4)', async () => {
    const ref: { startHandler: any } = {
      startHandler: null,
    };

    const corruptedStore = {
      openConversation() {
        throw new Error('SQLITE_CORRUPT: database disk image is malformed');
      },
      close() {},
    } as any;

    let factoryCalls = 0;
    let recoveredStore: MemoryStore | null = null;

    const branch: SessionEntry[] = [
      makeMessageEntry('e0', 'user', 'hello'),
      makeMessageEntry('e1', 'assistant', 'hi there', 'e0'),
      makeMessageEntry('e2', 'toolResult', 'tool output', 'e1'),
    ];

    const mockPi = {
      on(event: string, h: any) {
        if (event === 'session_start') ref.startHandler = h;
      },
      registerTool(_tool: any) {},
    } as any;

    extensionSetup(mockPi, undefined, {
      dagStore: corruptedStore,
      createDagStore: () => {
        factoryCalls++;
        recoveredStore = new MemoryStore();
        return recoveredStore;
      },
    } as any);

    const mockCtx = {
      sessionManager: {
        getBranch: () => branch,
        getSessionId: () => 'test-sess',
      },
      cwd: '/tmp/test',
      ui: { setStatus: () => {} },
      getContextUsage: () => undefined,
    } as any;

    await ref.startHandler!({ type: 'session_start' }, mockCtx);

    assert.strictEqual(factoryCalls, 1, 'createDagStore should be called once');
    assert.ok(recoveredStore, 'Recovered store should be created');
    const ms = recoveredStore as MemoryStore;

    const messages = ms.getMessagesAfter(-1);
    assert.strictEqual(messages.length, 3, 'Recovered store should ingest all branch messages');

    const items = ms.getContextItems();
    assert.strictEqual(items.length, 3, 'Recovered store should rebuild context_items from branch');
    assert.deepStrictEqual(items[0], { kind: 'message', messageId: 'e0' });
    assert.deepStrictEqual(items[1], { kind: 'message', messageId: 'e1' });
    assert.deepStrictEqual(items[2], { kind: 'message', messageId: 'e2' });

    ms.close();
  });
});
