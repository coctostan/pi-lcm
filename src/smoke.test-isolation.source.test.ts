import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('smoke.test.ts uses injected DEFAULT_CONFIG for test isolation', () => {
  it('calls extensionSetup(pi, { ...DEFAULT_CONFIG }) in every scenario', () => {
    const source = readFileSync(new URL('./smoke.test.ts', import.meta.url), 'utf-8');

    // There are currently 6 extensionSetup calls in src/smoke.test.ts.
    const injectedCalls = source.match(/extensionSetup\(pi,\s*\{\s*\.\.\.DEFAULT_CONFIG\s*\}\s*\);/g) ?? [];
    assert.strictEqual(
      injectedCalls.length,
      6,
      `Expected 6 injected calls, got ${injectedCalls.length}. Ensure every extensionSetup(pi) call passes { ...DEFAULT_CONFIG }.`
    );

    // Ensure we didn't leave any bare calls behind.
    assert.ok(!source.includes('extensionSetup(pi);'), 'Found a bare extensionSetup(pi); call.');
  });
});
