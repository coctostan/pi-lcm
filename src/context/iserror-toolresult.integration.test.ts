import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { TextContent } from '@mariozechner/pi-ai';

import { buildSession } from '../test-fixtures/sessions.ts';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import { createExpandExecute } from '../tools/expand.ts';

describe('Edge — isError toolResults are stripped like normal toolResults (AC 15) + fixture option (AC 2)', () => {
  it('buildSession can include isError toolResults, and they strip/store/expand correctly', async () => {
    const session = buildSession(2, {
      contentSize: 'small',
      toolTypes: ['read'],
      includeErrors: true,
    });

    const tool0: any = session[2];
    assert.strictEqual(tool0.role, 'toolResult');
    assert.strictEqual(tool0.isError, true, 'Expected deterministic error toolResult in fixtures');

    const originalText = (tool0.content[0] as TextContent).text;

    const store = new MemoryContentStore();
    const handler = new ContextHandler(new StripStrategy(), store, { freshTailCount: 1 });
    const execute = createExpandExecute(store, { maxExpandTokens: 200_000 });

    const result = handler.process(session);

    const stripped0: any = result.messages[2];
    assert.strictEqual(stripped0.role, 'toolResult');
    assert.strictEqual(stripped0.isError, true, 'isError flag should be preserved after stripping');

    const placeholder = (stripped0.content[0] as TextContent).text;
    assert.ok(placeholder.startsWith('[Content stripped by LCM.'));

    assert.strictEqual(result.stats.strippedCount, 1);

    const expanded = await execute('call_expand', { id: tool0.toolCallId });
    const expandedText = (expanded.content[0] as TextContent).text;
    assert.strictEqual(expandedText, originalText);
  });
});
