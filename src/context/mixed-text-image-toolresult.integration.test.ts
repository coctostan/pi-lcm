import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { TextContent } from '@mariozechner/pi-ai';

import { buildSession } from '../test-fixtures/sessions.ts';
import { ContextHandler } from './context-handler.ts';
import { StripStrategy } from './strip-strategy.ts';
import { MemoryContentStore } from './content-store.ts';
import { createExpandExecute } from '../tools/expand.ts';

describe('Edge — mixed text+image toolResults expand with image placeholder (AC 16) + fixture option (AC 2)', () => {
  it('buildSession can include image entries; strip/store/expand outputs image placeholder line', async () => {
    const session = buildSession(2, {
      contentSize: 'small',
      toolTypes: ['read'],
      includeImages: true,
    });

    const tool0: any = session[2];
    assert.strictEqual(tool0.role, 'toolResult');
    assert.ok(tool0.content.some((c: any) => c.type === 'image'), 'Expected fixture toolResult to include an image entry');

    const expectedExpandedText =
      (tool0.content[0] as TextContent).text + '\n' + '[Image content — not expandable in text mode]';

    const store = new MemoryContentStore();
    const handler = new ContextHandler(new StripStrategy(), store, { freshTailCount: 1 });
    const execute = createExpandExecute(store, { maxExpandTokens: 200_000 });

    handler.process(session);

    const expanded = await execute('call_expand', { id: tool0.toolCallId });
    const expandedText = (expanded.content[0] as TextContent).text;

    assert.strictEqual(expandedText, expectedExpandedText);
  });
});
