import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

describe('handler wiring verify gate', () => {
  it('verify gate requires session_tree and session_shutdown handlers (AC 21)', () => {
    const output = execFileSync('node', ['verify/extension-events-check.mjs'], {
      encoding: 'utf8',
    });

    assert.ok(
      output.includes('All 7 event handlers registered.'),
      `Expected verify gate to enforce 7 handlers, got: ${output.trim()}`,
    );
  });
});
