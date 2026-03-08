import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetSessionLargeFileCache, sessionLargeFileCacheDir } from './cache-dir.ts';

describe('sessionLargeFileCacheDir', () => {
  it('removes only the requested session cache directory and preserves sibling sessions', () => {
    const root = mkdtempSync(join(tmpdir(), 'lcm-cache-root-'));
    const sessionA = sessionLargeFileCacheDir(root, 'sess-a');
    const sessionB = sessionLargeFileCacheDir(root, 'sess-b');

    mkdirSync(sessionA, { recursive: true });
    mkdirSync(sessionB, { recursive: true });
    writeFileSync(join(sessionA, 'orphan.txt'), 'old session data', 'utf-8');
    writeFileSync(join(sessionB, 'keep.txt'), 'active session data', 'utf-8');

    resetSessionLargeFileCache(root, 'sess-a');

    assert.ok(!existsSync(sessionA), 'target session cache should be removed');
    assert.ok(existsSync(sessionB), 'other session cache should be preserved');
    assert.ok(existsSync(join(sessionB, 'keep.txt')), 'other session files should remain');

    rmSync(root, { recursive: true, force: true });
  });
});
