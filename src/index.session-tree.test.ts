import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import extensionSetup from './index.ts';
import { MemoryStore } from './store/memory-store.ts';
import type { SessionEntry } from '@mariozechner/pi-coding-agent';
import { estimateTokens } from './summarizer/token-estimator.ts';

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

describe('session_tree handler', () => {
  it('returns without error when dagStore is null (AC 11)', async () => {
    const ref: { handler: any } = { handler: null };

    const mockPi = {
      on(event: string, h: any) {
        if (event === 'session_tree') ref.handler = h;
      },
      registerTool(_tool: any) {},
    } as any;

    // No dagStore — dagStore will be null
    extensionSetup(mockPi);

    assert.ok(ref.handler !== null, 'session_tree handler should be registered');

    // Should not throw
    await ref.handler!(
      { type: 'session_tree', newLeafId: 'leaf_1', oldLeafId: 'leaf_0' },
      {} as any,
    );
  });

  it('ingests messages that exist on new branch but not yet in Store (AC 9)', async () => {
    const ref: { handler: any } = { handler: null };

    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/test');
    // Existing old-branch state in store
    store.ingestMessage({
      id: 'shared_0',
      seq: 0,
      role: 'user',
      content: 'shared',
      tokenCount: estimateTokens('shared'),
      createdAt: Date.now(),
    });
    store.ingestMessage({
      id: 'old_1',
      seq: 1,
      role: 'assistant',
      content: 'old branch msg',
      tokenCount: estimateTokens('old branch msg'),
      createdAt: Date.now(),
    });
    store.replaceContextItems([
      { kind: 'message', messageId: 'shared_0' },
      { kind: 'message', messageId: 'old_1' },
    ]);

    const newBranch: SessionEntry[] = [
      makeMessageEntry('shared_0', 'user', 'shared'),
      makeMessageEntry('new_1', 'assistant', 'new branch msg 1', 'shared_0'),
      makeMessageEntry('new_2', 'user', 'new branch msg 2', 'new_1'),
    ];
    const mockPi = {
      on(event: string, h: any) {
        if (event === 'session_tree') ref.handler = h;
      },
      registerTool(_tool: any) {},
    } as any;

    extensionSetup(mockPi, undefined, { dagStore: store });
    await ref.handler!(
      { type: 'session_tree', newLeafId: 'new_2', oldLeafId: 'old_1' },
      {
        sessionManager: {
          getBranch: () => newBranch,
          getSessionId: () => 'sess_1',
        },
        cwd: '/tmp/test',
      } as any,
    );

    assert.ok(store.getMessage('new_1'), 'new_1 should be ingested on session_tree');
    assert.ok(store.getMessage('new_2'), 'new_2 should be ingested on session_tree');
    store.close();
  });

  it('rebuilds context_items from new branch while preserving old summaries (AC 8, AC 10)', async () => {
    const ref: { handler: any } = { handler: null };

    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/test');
    // Old branch data
    store.ingestMessage({
      id: 'old_0',
      seq: 0,
      role: 'user',
      content: 'old branch msg',
      tokenCount: estimateTokens('old branch msg'),
      createdAt: Date.now(),
    });
    const summaryId = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Summary of old branch work',
      tokenCount: 30,
      earliestAt: 100,
      latestAt: 200,
      descendantCount: 1,
      createdAt: Date.now(),
    });
    store.replaceContextItems([
      { kind: 'summary', summaryId },
      { kind: 'message', messageId: 'old_0' },
    ]);
    const newBranch: SessionEntry[] = [
      makeMessageEntry('new_0', 'user', 'new branch msg'),
    ];
    const mockPi = {
      on(event: string, h: any) {
        if (event === 'session_tree') ref.handler = h;
      },
      registerTool(_tool: any) {},
    } as any;
    extensionSetup(mockPi, undefined, { dagStore: store });
    await ref.handler!(
      { type: 'session_tree', newLeafId: 'new_0', oldLeafId: 'old_0' },
      {
        sessionManager: {
          getBranch: () => newBranch,
          getSessionId: () => 'sess_1',
        },
        cwd: '/tmp/test',
      } as any,
    );

    // Rebuilt for new branch only
    const items = store.getContextItems();
    assert.strictEqual(items.length, 1, 'context_items should be rebuilt from new branch only');
    assert.deepStrictEqual(items[0], { kind: 'message', messageId: 'new_0' });
    // Summary table entry must still exist
    const summary = store.getSummary(summaryId);
    assert.ok(summary, 'Old summary should remain in summaries table');
    assert.strictEqual(summary!.content, 'Summary of old branch work');

    store.close();
  });
});
