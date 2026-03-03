import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('index.status-bar.test.ts uses injected DEFAULT_CONFIG for test isolation', () => {
  it('calls extensionSetup(mockPi, { ...DEFAULT_CONFIG }) in every test', () => {
    const source = readFileSync(new URL('./index.status-bar.test.ts', import.meta.url), 'utf-8');

    const injectedCalls = source.match(/extensionSetup\(mockPi,\s*\{\s*\.\.\.DEFAULT_CONFIG\s*\}\s*\);/g) ?? [];
    assert.strictEqual(injectedCalls.length, 2, `Expected 2 injected calls, got ${injectedCalls.length}`);

    assert.ok(!source.includes('extensionSetup(mockPi);'), 'Found a bare extensionSetup(mockPi); call.');
  });
});
