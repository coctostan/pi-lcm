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

function makeBuilder(dagStore: MemoryStore) {
  const handler = new ContextHandler(new StripStrategy(), new MemoryContentStore(), { freshTailCount: 32 });
  return new ContextBuilder(handler, dagStore);
}

describe('Cue injection (AC 9–13, AC 17)', () => {
  it('inserts a <memory-cues> assistant block before the final user message when a non-active summary matches (AC 9)', () => {
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_cue1', '/tmp/project');

    // Active summary
    const activeSid = dagStore.insertSummary({
      depth: 0, kind: 'leaf', content: 'Early setup discussion.',
      tokenCount: 20, earliestAt: 100, latestAt: 200, descendantCount: 2, createdAt: 300,
    });

    // Non-active summary whose content matches the user query
    dagStore.insertSummary({
      depth: 0, kind: 'leaf', content: 'Config options and environment variables discussed.',
      tokenCount: 30, earliestAt: 300, latestAt: 400, descendantCount: 3, createdAt: 500,
    });

    dagStore.ingestMessage({
      id: 'user_now', seq: 0, role: 'user',
      content: 'Show me the config options.', tokenCount: 6, createdAt: 1000,
    });

    // Only the first summary is active in context
    dagStore.replaceContextItems([
      { kind: 'summary', summaryId: activeSid },
      { kind: 'message', messageId: 'user_now' },
    ]);

    const builder = makeBuilder(dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'Show me the config options.', timestamp: 1000 } as AgentMessage,
    ]);

    // Should have: [summary, cue block, user]
    const roles = result.messages.map(m => m.role);
    assert.ok(roles.length >= 3, `Expected at least 3 messages (summary + cue + user), got ${roles.length}`);
    assert.strictEqual(roles[roles.length - 1], 'user', 'Last message must be user');
    assert.strictEqual(roles[roles.length - 2], 'assistant', 'Penultimate message should be assistant cue block');

    const cueText = textOf(result.messages[roles.length - 2]!);
    assert.ok(cueText.includes('<memory-cues>'), 'Cue block should contain <memory-cues> wrapper');
    assert.ok(cueText.includes('</memory-cues>'), 'Cue block should contain closing tag');
  });

  it('cue block format includes summaryId, depth, kind, and cue text (AC 10)', () => {
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_cue2', '/tmp/project');

    const nonActiveSid = dagStore.insertSummary({
      depth: 1, kind: 'condensed', content: 'Deployment config and environment variables.',
      tokenCount: 25, earliestAt: 100, latestAt: 500, descendantCount: 5, createdAt: 600,
    });

    dagStore.ingestMessage({
      id: 'user_now2', seq: 0, role: 'user',
      content: 'What deployment config was discussed?', tokenCount: 7, createdAt: 1000,
    });

    // No active summaries — user message only
    dagStore.replaceContextItems([
      { kind: 'message', messageId: 'user_now2' },
    ]);

    const builder = makeBuilder(dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'What deployment config was discussed?', timestamp: 1000 } as AgentMessage,
    ]);

    // Find cue message
    const cueIdx = result.messages.findIndex(m => {
      const t = textOf(m);
      return t.includes('<memory-cues>');
    });
    assert.ok(cueIdx >= 0, 'Should have a cue block');

    const cueText = textOf(result.messages[cueIdx]!);
    assert.ok(cueText.includes(`summaryId=${nonActiveSid}`), 'Cue should include summaryId');
    assert.ok(cueText.includes('depth=1'), 'Cue should include depth');
    assert.ok(cueText.includes('kind=condensed'), 'Cue should include kind');
  });

  it('skips summaries already active in context (AC 11)', () => {
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_cue3', '/tmp/project');

    const sid = dagStore.insertSummary({
      depth: 0, kind: 'leaf', content: 'Config options discussed.',
      tokenCount: 20, earliestAt: 100, latestAt: 200, descendantCount: 2, createdAt: 300,
    });

    dagStore.ingestMessage({
      id: 'user_now3', seq: 0, role: 'user',
      content: 'Show config options.', tokenCount: 4, createdAt: 1000,
    });

    // The matching summary IS active
    dagStore.replaceContextItems([
      { kind: 'summary', summaryId: sid },
      { kind: 'message', messageId: 'user_now3' },
    ]);

    const builder = makeBuilder(dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'Show config options.', timestamp: 1000 } as AgentMessage,
    ]);

    // No cue block — the only matching summary is already active
    const hasCue = result.messages.some(m => textOf(m).includes('<memory-cues>'));
    assert.ok(!hasCue, 'Should not insert cue block when all matching summaries are already active');
  });

  it('does not insert cues on tool-follow-up calls (AC 12)', () => {
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_cue4', '/tmp/project');

    dagStore.insertSummary({
      depth: 0, kind: 'leaf', content: 'Config options discussed.',
      tokenCount: 20, earliestAt: 100, latestAt: 200, descendantCount: 2, createdAt: 300,
    });

    dagStore.ingestMessage({
      id: 'user_cue4', seq: 0, role: 'user',
      content: 'Show config options.', tokenCount: 4, createdAt: 1000,
    });
    dagStore.ingestMessage({
      id: 'asst_cue4', seq: 1, role: 'assistant',
      content: 'Looking up config...', tokenCount: 4, createdAt: 1001,
    });
    dagStore.ingestMessage({
      id: 'tool_cue4', seq: 2, role: 'toolResult',
      content: 'config.json content here', tokenCount: 5, createdAt: 1002,
    });

    dagStore.replaceContextItems([
      { kind: 'message', messageId: 'user_cue4' },
      { kind: 'message', messageId: 'asst_cue4' },
      { kind: 'message', messageId: 'tool_cue4' },
    ]);

    const builder = makeBuilder(dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'Show config options.', timestamp: 1000 } as AgentMessage,
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'Looking up config...' }],
        api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'tool_use', timestamp: 1001,
      } as AgentMessage,
      {
        role: 'toolResult' as const, toolCallId: 'tool_cue4', toolName: 'read',
        content: [{ type: 'text' as const, text: 'config.json content here' }],
        isError: false, timestamp: 1002,
      } as AgentMessage,
    ]);

    const hasCue = result.messages.some(m => textOf(m).includes('<memory-cues>'));
    assert.ok(!hasCue, 'Should not insert cue block on tool-follow-up calls');
  });

  it('user message is always the final message (AC 13)', () => {
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_cue5', '/tmp/project');

    dagStore.insertSummary({
      depth: 0, kind: 'leaf', content: 'Config options and setup guide discussed.',
      tokenCount: 25, earliestAt: 100, latestAt: 400, descendantCount: 3, createdAt: 500,
    });

    dagStore.ingestMessage({
      id: 'user_cue5', seq: 0, role: 'user',
      content: 'Show me config options.', tokenCount: 5, createdAt: 1000,
    });

    dagStore.replaceContextItems([
      { kind: 'message', messageId: 'user_cue5' },
    ]);

    const builder = makeBuilder(dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'Show me config options.', timestamp: 1000 } as AgentMessage,
    ]);

    const lastMsg = result.messages[result.messages.length - 1]!;
    assert.strictEqual(lastMsg.role, 'user', 'Last message must always be user');
    assert.strictEqual(textOf(lastMsg), 'Show me config options.');
  });

  it('no cue block when no non-active summaries match (no false positives)', () => {
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_cue6', '/tmp/project');

    dagStore.insertSummary({
      depth: 0, kind: 'leaf', content: 'Discussed deployment pipelines.',
      tokenCount: 15, earliestAt: 100, latestAt: 200, descendantCount: 2, createdAt: 300,
    });

    dagStore.ingestMessage({
      id: 'user_cue6', seq: 0, role: 'user',
      content: 'What is the weather today?', tokenCount: 6, createdAt: 1000,
    });

    dagStore.replaceContextItems([
      { kind: 'message', messageId: 'user_cue6' },
    ]);

    const builder = makeBuilder(dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'What is the weather today?', timestamp: 1000 } as AgentMessage,
    ]);

    const hasCue = result.messages.some(m => textOf(m).includes('<memory-cues>'));
    assert.ok(!hasCue, 'Should not insert cue block when no summaries match');
  });
});
