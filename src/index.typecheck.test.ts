/**
 * Verifies that src/index.ts compiles without type errors.
 * Guards against regressions introduced by new imports or type mismatches.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

describe('TypeScript type check for src/index.ts', () => {
  it('tsc --noEmit reports no errors in src/index.ts', () => {
    const output = execSync('npx tsc --noEmit 2>&1 || true', {
      encoding: 'utf8',
      cwd: new URL('..', import.meta.url).pathname,
    });
    const indexErrors = output.split('\n').filter((l) => l.includes('src/index.ts'));
    assert.strictEqual(
      indexErrors.length,
      0,
      `Expected 0 type errors in src/index.ts but found:\n${indexErrors.join('\n')}`,
    );
  });
});
