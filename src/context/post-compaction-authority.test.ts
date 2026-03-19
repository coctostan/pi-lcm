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

describe('Post-compaction current-turn authority (AC 14, AC 15, AC 20)', () => {

  it('stale-summary takeover: live user turn is authoritative over unfinished-task summary (AC 14)', () => {
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_auth1', '/tmp/project');

    // Summary with stale unfinished-task content
    const staleSid = dagStore.insertSummary({
      depth: 0, kind: 'leaf',
      content: 'Open thread: ROADMAP summary was requested but not yet delivered.',
      tokenCount: 20, earliestAt: 100, latestAt: 500, descendantCount: 4, createdAt: 600,
    });

    dagStore.ingestMessage({
      id: 'user_config', seq: 0, role: 'user',
      content: 'Show me the config options.', tokenCount: 6, createdAt: 1000,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId: staleSid },
      { kind: 'message', messageId: 'user_config' },
    ]);

    const builder = makeBuilder(dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'Show me the config options.', timestamp: 1000 } as AgentMessage,
    ]);

    const roles = result.messages.map(m => m.role);
    // Live user turn must be the final message
    assert.strictEqual(roles[roles.length - 1], 'user', 'Live user turn must be final');

    // Verify no summary content after the user message
    const lastIdx = roles.length - 1;
    for (let i = lastIdx + 1; i < roles.length; i++) {
      assert.fail(`No message should appear after user turn, found ${roles[i]} at index ${i}`);
    }

    // The summary should be earlier in the sequence
    const summaryIdx = roles.indexOf('assistant');
    assert.ok(summaryIdx >= 0, 'Summary should appear as assistant message');
    assert.ok(summaryIdx < lastIdx, 'Summary must appear before live user turn');

    // Live user text is preserved
    assert.strictEqual(textOf(result.messages[lastIdx]!), 'Show me the config options.');
  });

  it('full post-compaction flow with multiple summaries + cue + user turn (AC 15)', () => {
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_auth2', '/tmp/project');

    // depth-0 leaf summary
    const leafSid = dagStore.insertSummary({
      depth: 0, kind: 'leaf',
      content: 'User discussed deployment steps and environment setup.',
      tokenCount: 25, earliestAt: 100, latestAt: 300, descendantCount: 3, createdAt: 400,
    });

    // depth-1 condensed summary
    const condensedSid = dagStore.insertSummary({
      depth: 1, kind: 'condensed',
      content: 'Consolidated overview of project initialization and CI pipeline config.',
      tokenCount: 40, earliestAt: 50, latestAt: 300, descendantCount: 6, createdAt: 500,
    });

    // Non-active summary that could trigger cues
    dagStore.insertSummary({
      depth: 0, kind: 'leaf',
      content: 'Authentication token setup and OAuth flow discussed.',
      tokenCount: 20, earliestAt: 400, latestAt: 600, descendantCount: 2, createdAt: 700,
    });

    dagStore.ingestMessage({
      id: 'user_auth', seq: 0, role: 'user',
      content: 'Explain the authentication setup.', tokenCount: 5, createdAt: 2000,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId: condensedSid },
      { kind: 'summary', summaryId: leafSid },
      { kind: 'message', messageId: 'user_auth' },
    ]);

    const builder = makeBuilder(dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'Explain the authentication setup.', timestamp: 2000 } as AgentMessage,
    ]);

    const roles = result.messages.map(m => m.role);
    // All messages should be assistant (summaries + optional cue) then user
    assert.strictEqual(roles[roles.length - 1], 'user', 'User turn must be last');
    for (let i = 0; i < roles.length - 1; i++) {
      assert.strictEqual(roles[i], 'assistant', `Message ${i} should be assistant, got ${roles[i]}`);
    }

    // Summary count in stats
    assert.strictEqual(result.stats.summaryCount, 2);

    // No old preamble anywhere (AC 20)
    for (const msg of result.messages) {
      const text = textOf(msg);
      assert.ok(!text.includes('[LCM Context Summary'), `No old preamble framing allowed, found in: ${text.slice(0, 80)}`);
    }
  });

  it('no old preamble in any assembled output (AC 20 regression guard)', () => {
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_auth3', '/tmp/project');

    const sid = dagStore.insertSummary({
      depth: 0, kind: 'leaf',
      content: 'Basic project setup completed.',
      tokenCount: 10, earliestAt: 100, latestAt: 200, descendantCount: 1, createdAt: 300,
    });

    dagStore.ingestMessage({
      id: 'user_simple', seq: 0, role: 'user',
      content: 'hello', tokenCount: 1, createdAt: 500,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId: sid },
      { kind: 'message', messageId: 'user_simple' },
    ]);

    const builder = makeBuilder(dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'hello', timestamp: 500 } as AgentMessage,
    ]);

    for (const msg of result.messages) {
      const text = textOf(msg);
      assert.ok(!text.includes('[LCM Context Summary'), `Old preamble must not appear: ${text.slice(0, 80)}`);
      assert.ok(!text.includes('Summary 1:'), `Old numbering must not appear: ${text.slice(0, 80)}`);
    }
  });

  it('multiple stale summaries + different user intent — user turn always last (AC 14 extended)', () => {
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_auth4', '/tmp/project');

    const stale1 = dagStore.insertSummary({
      depth: 0, kind: 'leaf',
      content: 'Open thread: deployment script was incomplete at end of span.',
      tokenCount: 20, earliestAt: 100, latestAt: 200, descendantCount: 2, createdAt: 300,
    });
    const stale2 = dagStore.insertSummary({
      depth: 0, kind: 'leaf',
      content: 'Open thread: test coverage report generation was pending.',
      tokenCount: 20, earliestAt: 300, latestAt: 400, descendantCount: 2, createdAt: 500,
    });

    dagStore.ingestMessage({
      id: 'user_unrelated', seq: 0, role: 'user',
      content: 'What is the current date?', tokenCount: 6, createdAt: 1000,
    });

    dagStore.replaceContextItems([
      { kind: 'summary', summaryId: stale1 },
      { kind: 'summary', summaryId: stale2 },
      { kind: 'message', messageId: 'user_unrelated' },
    ]);

    const builder = makeBuilder(dagStore);
    const result = builder.buildContext([
      { role: 'user' as const, content: 'What is the current date?', timestamp: 1000 } as AgentMessage,
    ]);

    const roles = result.messages.map(m => m.role);
    assert.strictEqual(roles[roles.length - 1], 'user', 'User turn must be final despite stale summaries');
    assert.strictEqual(textOf(result.messages[roles.length - 1]!), 'What is the current date?');

    // Both stale summaries should be before the user turn
    const assistantCount = roles.filter(r => r === 'assistant').length;
    assert.ok(assistantCount >= 2, `Expected at least 2 assistant messages (summaries), got ${assistantCount}`);
  });
});
