import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { ContextBuilder } from './context-builder.ts';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import { MemoryStore } from '../store/memory-store.ts';

function textOf(message: AgentMessage): string {
  const content = (message as any).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join('\n');
  }
  return '';
}

describe('Bug #040 — injected summaries should be addressable memory objects', () => {
  it('includes summaryId while keeping the live user turn final', () => {
    const handler = new ContextHandler(new StripStrategy(), new MemoryContentStore(), { freshTailCount: 32 });
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_040', '/tmp/project');

    const summaryId = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'User discussed config setup and deployment options.',
      tokenCount: 50,
      earliestAt: 100,
      latestAt: 500,
      descendantCount: 5,
      createdAt: 600,
    });

    dagStore.ingestMessage({
      id: 'entry_user_040',
      seq: 0,
      role: 'user',
      content: 'latest message',
      tokenCount: 4,
      createdAt: 1000,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId },
      { kind: 'message', messageId: 'entry_user_040' },
    ]);

    const builder = new ContextBuilder(handler, dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'latest message', timestamp: 1000 } as AgentMessage,
    ]);

    assert.deepStrictEqual(result.messages.map((m) => m.role), ['assistant', 'user']);

    const summaryText = textOf(result.messages[0]!);
    assert.ok(
      summaryText.includes(`summaryId: ${summaryId}`),
      `Injected summary text should include summaryId "${summaryId}" but got:\n${summaryText}`,
    );

    const currentUserText = textOf(result.messages[1]!);
    assert.strictEqual(currentUserText, 'latest message');
  });

  it('includes depth and kind metadata', () => {
    const handler = new ContextHandler(new StripStrategy(), new MemoryContentStore(), { freshTailCount: 32 });
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_040b', '/tmp/project');

    const summaryId = dagStore.insertSummary({
      depth: 1,
      kind: 'condensed',
      content: 'Condensed overview of setup discussion.',
      tokenCount: 30,
      earliestAt: 50,
      latestAt: 400,
      descendantCount: 8,
      createdAt: 500,
    });

    dagStore.ingestMessage({
      id: 'entry_user_040b',
      seq: 0,
      role: 'user',
      content: 'next question',
      tokenCount: 4,
      createdAt: 1000,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId },
      { kind: 'message', messageId: 'entry_user_040b' },
    ]);

    const builder = new ContextBuilder(handler, dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'next question', timestamp: 1000 } as AgentMessage,
    ]);

    const summaryText = textOf(result.messages[0]!);
    assert.ok(
      summaryText.includes('depth: 1'),
      `Summary should include depth "1" but got:\n${summaryText}`,
    );
    assert.ok(
      summaryText.includes('kind: condensed'),
      `Summary should include kind "condensed" but got:\n${summaryText}`,
    );
  });

  it('includes earliestAt, latestAt, and descendantCount metadata', () => {
    const handler = new ContextHandler(new StripStrategy(), new MemoryContentStore(), { freshTailCount: 32 });
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_040c', '/tmp/project');

    const summaryId = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Leaf summary of recent work.',
      tokenCount: 25,
      earliestAt: 1000,
      latestAt: 2000,
      descendantCount: 4,
      createdAt: 3000,
    });

    dagStore.ingestMessage({
      id: 'entry_user_040c',
      seq: 0,
      role: 'user',
      content: 'continue',
      tokenCount: 2,
      createdAt: 5000,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId },
      { kind: 'message', messageId: 'entry_user_040c' },
    ]);

    const builder = new ContextBuilder(handler, dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'continue', timestamp: 5000 } as AgentMessage,
    ]);

    const summaryText = textOf(result.messages[0]!);
    assert.ok(
      summaryText.includes('earliestAt: 1000'),
      `Summary should include earliestAt "1000" but got:\n${summaryText}`,
    );
    assert.ok(
      summaryText.includes('latestAt: 2000'),
      `Summary should include latestAt "2000" but got:\n${summaryText}`,
    );
    assert.ok(
      summaryText.includes('descendantCount: 4'),
      `Summary should include descendantCount "4" but got:\n${summaryText}`,
    );
    // Verify all metadata fields appear together for each summary
    assert.ok(
      summaryText.includes('earliestAt:') && summaryText.includes('latestAt:') && summaryText.includes('descendantCount:'),
      `All coverage metadata fields should be present together`,
    );
  });

  it('multiple summaries each carry their own metadata', () => {
    const handler = new ContextHandler(new StripStrategy(), new MemoryContentStore(), { freshTailCount: 32 });
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_040d', '/tmp/project');

    const sid1 = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'First leaf summary.',
      tokenCount: 20,
      earliestAt: 100,
      latestAt: 200,
      descendantCount: 2,
      createdAt: 300,
    });
    const sid2 = dagStore.insertSummary({
      depth: 1,
      kind: 'condensed',
      content: 'Second condensed summary.',
      tokenCount: 30,
      earliestAt: 300,
      latestAt: 600,
      descendantCount: 5,
      createdAt: 700,
    });

    dagStore.ingestMessage({
      id: 'entry_user_040d',
      seq: 0,
      role: 'user',
      content: 'what next',
      tokenCount: 3,
      createdAt: 1000,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId: sid1 },
      { kind: 'summary', summaryId: sid2 },
      { kind: 'message', messageId: 'entry_user_040d' },
    ]);

    const builder = new ContextBuilder(handler, dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'what next', timestamp: 1000 } as AgentMessage,
    ]);

    // With inline architecture, each summary is a separate assistant message
    assert.strictEqual(result.messages.length, 3); // 2 summaries + 1 user
    const summary1Text = textOf(result.messages[0]!);
    const summary2Text = textOf(result.messages[1]!);
    assert.ok(summary1Text.includes(`summaryId: ${sid1}`));
    assert.ok(summary2Text.includes(`summaryId: ${sid2}`));
  });

  it('includes childIds when lineage is available', () => {
    const handler = new ContextHandler(new StripStrategy(), new MemoryContentStore(), { freshTailCount: 32 });
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_040e', '/tmp/project');

    const childA = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Child summary A.',
      tokenCount: 10,
      earliestAt: 100,
      latestAt: 200,
      descendantCount: 2,
      createdAt: 300,
    });
    const childB = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Child summary B.',
      tokenCount: 10,
      earliestAt: 201,
      latestAt: 300,
      descendantCount: 2,
      createdAt: 301,
    });
    const parentId = dagStore.insertSummary({
      depth: 1,
      kind: 'condensed',
      content: 'Parent summary that condenses the two child summaries.',
      tokenCount: 25,
      earliestAt: 100,
      latestAt: 300,
      descendantCount: 4,
      createdAt: 400,
    });
    dagStore.linkSummaryParents(parentId, [childA, childB]);

    dagStore.ingestMessage({
      id: 'entry_user_040e',
      seq: 0,
      role: 'user',
      content: 'what next',
      tokenCount: 3,
      createdAt: 1000,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId: parentId },
      { kind: 'message', messageId: 'entry_user_040e' },
    ]);

    const builder = new ContextBuilder(handler, dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'what next', timestamp: 1000 } as AgentMessage,
    ]);

    assert.deepStrictEqual(result.messages.map((m) => m.role), ['assistant', 'user']);

    const summaryText = textOf(result.messages[0]!);
    assert.ok(
      summaryText.includes(`childIds: ${childA}, ${childB}`),
      `Summary should include childIds but got:\n${summaryText}`,
    );

    const currentUserText = textOf(result.messages[1]!);
    assert.strictEqual(currentUserText, 'what next');
  });
});
