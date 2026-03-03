import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildSession } from './sessions.ts';

describe('buildSession — toolTypes', () => {
  it('cycles toolName across turns using toolTypes option (AC 2)', () => {
    const session = buildSession(3, { toolTypes: ['read', 'bash', 'grep'] });

    const tool0 = session[2] as any;
    const tool1 = session[5] as any;
    const tool2 = session[8] as any;

    assert.strictEqual(tool0.toolName, 'read');
    assert.strictEqual(tool1.toolName, 'bash');
    assert.strictEqual(tool2.toolName, 'grep');
  });
});
