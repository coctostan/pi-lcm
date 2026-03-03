import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { TextContent } from '@mariozechner/pi-ai';
import { buildSession } from './sessions.ts';

describe('buildSession — contentSize', () => {
  it('generates toolResult text >= 5KB when contentSize="large" (AC 4)', () => {
    const session = buildSession(1, { contentSize: 'large' });

    const toolResult = session[2] as any;
    assert.strictEqual(toolResult.role, 'toolResult');

    const text = (toolResult.content[0] as TextContent).text;
    assert.ok(
      text.length >= 5 * 1024,
      `Expected >= 5120 chars, got ${text.length}`,
    );
  });
});
