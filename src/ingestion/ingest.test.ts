import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ingestNewMessages } from './ingest.ts';
import { MemoryStore } from '../store/memory-store.ts';
import type { SessionEntry } from '@mariozechner/pi-coding-agent';

function makeMessageEntry(id: string, role: 'user' | 'assistant' | 'toolResult', content: string | any[], parentId: string | null = null): SessionEntry {
  const msg: any = { role, timestamp: Date.now() };
  if (role === 'user') {
    msg.content = typeof content === 'string' ? content : content;
  } else if (role === 'assistant') {
    msg.content = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    msg.api = 'anthropic-messages';
    msg.provider = 'anthropic';
    msg.model = 'claude-sonnet';
    msg.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    msg.stopReason = 'stop';
  } else {
    msg.content = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
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

function makeNonMessageEntry(id: string, parentId: string | null = null): SessionEntry {
  return {
    type: 'model_change',
    id,
    parentId,
    timestamp: new Date().toISOString(),
    provider: 'anthropic',
    modelId: 'claude-sonnet',
  } as SessionEntry;
}

describe('ingestNewMessages', () => {
  it('returns 0 for empty session with no message entries (AC 30)', () => {
    const store = new MemoryStore();
    store.openConversation('test-sess', '/tmp/test');

    const mockCtx = {
      sessionManager: {
        getBranch: () => [],
      },
    } as any;

    const count = ingestNewMessages(store, mockCtx);
    assert.strictEqual(count, 0);
    assert.strictEqual(store.getLastIngestedSeq(), -1);
    store.close();
  });

  it('filters to only type: "message" entries with roles user, assistant, toolResult (AC 23)', () => {
    const store = new MemoryStore();
    store.openConversation('test-sess', '/tmp/test');

    const entries: SessionEntry[] = [
      makeMessageEntry('e0', 'user', 'hello'),
      makeNonMessageEntry('e1', 'e0'), // model_change — should be skipped
      makeMessageEntry('e2', 'assistant', 'hi there', 'e1'),
      makeMessageEntry('e3', 'toolResult', 'bash output', 'e2'),
    ];

    const mockCtx = {
      sessionManager: { getBranch: () => entries },
    } as any;

    const count = ingestNewMessages(store, mockCtx);
    assert.strictEqual(count, 3); // 3 message entries (e0, e2, e3), skipping model_change
    store.close();
  });

  it('only processes entries with index > lastIngestedSeq (AC 24)', () => {
    const store = new MemoryStore();
    store.openConversation('test-sess', '/tmp/test');

    const entries: SessionEntry[] = [
      makeMessageEntry('e0', 'user', 'first'),
      makeMessageEntry('e1', 'assistant', 'response', 'e0'),
      makeMessageEntry('e2', 'user', 'second', 'e1'),
    ];

    const mockCtx = {
      sessionManager: { getBranch: () => entries },
    } as any;

    // Ingest first batch
    const count1 = ingestNewMessages(store, mockCtx);
    assert.strictEqual(count1, 3);

    // Ingest again — same entries — should process 0 new ones
    const count2 = ingestNewMessages(store, mockCtx);
    assert.strictEqual(count2, 0);

    // Add a new entry
    entries.push(makeMessageEntry('e3', 'toolResult', 'result', 'e2'));
    const count3 = ingestNewMessages(store, mockCtx);
    assert.strictEqual(count3, 1);

    store.close();
  });

  it('calls store.ingestMessage with entry id as message identifier (AC 25)', () => {
    const store = new MemoryStore();
    store.openConversation('test-sess', '/tmp/test');

    const entries: SessionEntry[] = [
      makeMessageEntry('pi-entry-abc', 'user', 'hello'),
    ];

    const mockCtx = {
      sessionManager: { getBranch: () => entries },
    } as any;

    ingestNewMessages(store, mockCtx);

    const messages = store.getMessagesAfter(-1);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0]!.id, 'pi-entry-abc');
  });

  it('serializes user string content directly (AC 26)', () => {
    const store = new MemoryStore();
    store.openConversation('test-sess', '/tmp/test');

    const entries: SessionEntry[] = [
      makeMessageEntry('e0', 'user', 'plain text content'),
    ];

    const mockCtx = {
      sessionManager: { getBranch: () => entries },
    } as any;

    ingestNewMessages(store, mockCtx);

    const messages = store.getMessagesAfter(-1);
    assert.strictEqual(messages[0]!.content, 'plain text content');
  });

  it('serializes assistant content extracting text from TextContent parts and tool call arguments (AC 26)', () => {
    const store = new MemoryStore();
    store.openConversation('test-sess', '/tmp/test');

    const assistantContent = [
      { type: 'text', text: 'Let me read that file.' },
      { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/src/index.ts' } },
    ];

    const entries: SessionEntry[] = [
      makeMessageEntry('e0', 'assistant', assistantContent),
    ];

    const mockCtx = {
      sessionManager: { getBranch: () => entries },
    } as any;

    ingestNewMessages(store, mockCtx);

    const messages = store.getMessagesAfter(-1);
    const content = messages[0]!.content;
    assert.ok(content.includes('Let me read that file.'), `Should include text content, got: ${content}`);
    assert.ok(content.includes('read'), `Should include tool call name, got: ${content}`);
    assert.ok(content.includes('/src/index.ts'), `Should include tool call arguments, got: ${content}`);
  });

  it('serializes toolResult content extracting text from TextContent parts (AC 26)', () => {
    const store = new MemoryStore();
    store.openConversation('test-sess', '/tmp/test');

    const toolResultContent = [
      { type: 'text', text: 'file contents line 1\nfile contents line 2' },
    ];

    const entries: SessionEntry[] = [
      makeMessageEntry('e0', 'toolResult', toolResultContent),
    ];

    const mockCtx = {
      sessionManager: { getBranch: () => entries },
    } as any;

    ingestNewMessages(store, mockCtx);

    const messages = store.getMessagesAfter(-1);
    assert.strictEqual(messages[0]!.content, 'file contents line 1\nfile contents line 2');
  });

  it('computes tokenCount via estimateTokens for each message (AC 27)', async () => {
    const { estimateTokens } = await import('../summarizer/token-estimator.ts');

    const store = new MemoryStore();
    store.openConversation('test-sess', '/tmp/test');

    const entries: SessionEntry[] = [
      makeMessageEntry('e0', 'user', 'hello world'),
    ];

    const mockCtx = {
      sessionManager: { getBranch: () => entries },
    } as any;

    ingestNewMessages(store, mockCtx);

    const messages = store.getMessagesAfter(-1);
    assert.strictEqual(messages[0]!.tokenCount, estimateTokens('hello world'));
  });

  it('returns the count of newly ingested messages (AC 28)', () => {
    const store = new MemoryStore();
    store.openConversation('test-sess', '/tmp/test');

    const entries: SessionEntry[] = [
      makeMessageEntry('e0', 'user', 'msg 1'),
      makeNonMessageEntry('e1', 'e0'),
      makeMessageEntry('e2', 'assistant', 'msg 2', 'e1'),
    ];

    const mockCtx = {
      sessionManager: { getBranch: () => entries },
    } as any;

    const count = ingestNewMessages(store, mockCtx);
    assert.strictEqual(count, 2, 'Should return 2 (two message entries, one model_change skipped)');
  });

  it('is idempotent — calling twice with same session state ingests zero on second call (AC 29)', () => {
    const store = new MemoryStore();
    store.openConversation('test-sess', '/tmp/test');

    const entries: SessionEntry[] = [
      makeMessageEntry('e0', 'user', 'first message'),
      makeMessageEntry('e1', 'assistant', 'response', 'e0'),
      makeMessageEntry('e2', 'toolResult', 'tool output', 'e1'),
    ];

    const mockCtx = {
      sessionManager: { getBranch: () => entries },
    } as any;

    const count1 = ingestNewMessages(store, mockCtx);
    assert.strictEqual(count1, 3);

    // Second call with identical session state
    const count2 = ingestNewMessages(store, mockCtx);
    assert.strictEqual(count2, 0, 'Second call should ingest zero messages');

    // Verify total stored messages didn't change
    const allMessages = store.getMessagesAfter(-1);
    assert.strictEqual(allMessages.length, 3, 'Should still have exactly 3 messages in store');
  });
});
