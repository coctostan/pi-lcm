import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { ContextBuilder } from './context-builder.ts';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import { MemoryStore } from '../store/memory-store.ts';

function makeBuilder(dagStore: MemoryStore): ContextBuilder {
  const contentStore = new MemoryContentStore();
  const strategy = new StripStrategy();
  const handler = new ContextHandler(strategy, contentStore, { freshTailCount: 32 });
  return new ContextBuilder(handler, dagStore);
}

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

describe('ContextBuilder summary-only DAG contexts', () => {
  it('emits assistant summary messages instead of a legacy framed preamble', () => {
    const store = new MemoryStore();
    store.openConversation('sess_summary_only_inline', '/tmp/project');

    const sid1 = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'First historical summary.',
      tokenCount: 10,
      earliestAt: 100,
      latestAt: 150,
      descendantCount: 2,
      createdAt: 200,
    });

    const sid2 = store.insertSummary({
      depth: 1,
      kind: 'condensed',
      content: 'Second historical summary.',
      tokenCount: 10,
      earliestAt: 100,
      latestAt: 180,
      descendantCount: 4,
      createdAt: 250,
    });

    store.replaceContextItems([
      { kind: 'summary', summaryId: sid1 },
      { kind: 'summary', summaryId: sid2 },
    ]);

    const result = makeBuilder(store).buildContext([]);

    assert.deepStrictEqual(result.messages.map((m) => m.role), ['assistant', 'assistant']);

    const renderedTexts = result.messages.map((m) => textOf(m));
    assert.ok(renderedTexts[0]!.includes('First historical summary.'));
    assert.ok(renderedTexts[0]!.includes('summaryId:'));
    assert.ok(renderedTexts[1]!.includes('Second historical summary.'));
    assert.ok(renderedTexts[1]!.includes('summaryId:'));
    for (const text of renderedTexts) {
      assert.ok(!text.includes('[LCM Context Summary'));
      assert.ok(!text.includes('Summary 1:'));
    }

    assert.strictEqual(result.stats.summaryCount, 2);
    assert.strictEqual(result.stats.maxDepth, 1);
  });
});
