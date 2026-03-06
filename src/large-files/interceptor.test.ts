import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interceptLargeFile } from './interceptor.ts';
import { MemoryStore } from '../store/memory-store.ts';

describe('interceptLargeFile', () => {
  it('returns undefined for non-read tool events', async () => {
    const store = new MemoryStore();
    store.openConversation('test-session', '/tmp');
    const event = {
      type: 'tool_result' as const,
      toolName: 'bash',
      toolCallId: 'call_1',
      input: { command: 'ls' },
      content: [{ type: 'text' as const, text: 'a'.repeat(100000) }],
      isError: false,
      details: undefined,
    };
    const result = await interceptLargeFile(event, store, {
      largeFileTokenThreshold: 100,
      maxExpandTokens: 4000,
    }, '/tmp/lcm-cache');
    assert.strictEqual(result, undefined);
  });

  it('returns undefined when text content tokens are below threshold', async () => {
    const store = new MemoryStore();
    store.openConversation('test-session', '/tmp');
    const event = {
      type: 'tool_result' as const,
      toolName: 'read',
      toolCallId: 'call_2',
      input: { path: '/tmp/small.ts' },
      content: [{ type: 'text' as const, text: 'a'.repeat(1000) }],
      isError: false,
      details: undefined,
    };
    const result = await interceptLargeFile(event, store, {
      largeFileTokenThreshold: 500,
      maxExpandTokens: 4000,
    }, '/tmp/lcm-cache');
    assert.strictEqual(result, undefined);
  });

  it('skips ImageContent blocks when estimating tokens', async () => {
    const store = new MemoryStore();
    store.openConversation('test-session', '/tmp');
    const event = {
      type: 'tool_result' as const,
      toolName: 'read',
      toolCallId: 'call_3',
      input: { path: '/tmp/image-file.png' },
      content: [
        { type: 'text' as const, text: 'a'.repeat(100) },
        { type: 'image' as const, data: 'x'.repeat(500000), mimeType: 'image/png' },
      ],
      isError: false,
      details: undefined,
    };
    const result = await interceptLargeFile(event, store, {
      largeFileTokenThreshold: 50,
      maxExpandTokens: 4000,
    }, '/tmp/lcm-cache');
    assert.strictEqual(result, undefined);
  });

  it('caches content and returns exploration summary when over threshold', async () => {
    const store = new MemoryStore();
    store.openConversation('test-session', '/tmp');
    const cacheDir = join(mkdtempSync(join(tmpdir(), 'lcm-test-')), 'cache');

    const bigContent = 'export function hello() { return 1; }\n'.repeat(3000);
    const event = {
      type: 'tool_result' as const,
      toolName: 'read',
      toolCallId: 'call_4',
      input: { path: '/project/src/big-file.ts' },
      content: [{ type: 'text' as const, text: bigContent }],
      isError: false,
      details: undefined,
    };

    const result = await interceptLargeFile(event, store, {
      largeFileTokenThreshold: 100,
      maxExpandTokens: 4000,
    }, cacheDir);

    assert.ok(result !== undefined, 'should intercept over-threshold file');
    assert.ok(result!.content, 'result should have content');
    assert.strictEqual(result!.content!.length, 1);
    const text = (result!.content![0] as { type: 'text'; text: string }).text;

    assert.ok(text.includes('big-file.ts'), 'should reference file name');
    assert.ok(text.includes('lcm_expand'), 'should include expand instruction');

    assert.ok(existsSync(cacheDir), 'cache dir should exist');

    const storedFile = store.getLargeFileByPath('/project/src/big-file.ts');
    assert.ok(storedFile !== undefined, 'should be in store');
    assert.ok(storedFile!.storagePath.startsWith(cacheDir), 'storagePath should be in cache dir');
    assert.ok(storedFile!.tokenCount > 100, 'tokenCount should be set');

    const cached = readFileSync(storedFile!.storagePath, 'utf-8');
    assert.strictEqual(cached, bigContent);

    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('returns generic summary when explore throws', async () => {
    const store = new MemoryStore();
    store.openConversation('test-session', '/tmp');
    const cacheDir = mkdtempSync(join(tmpdir(), 'lcm-test-'));

    const bigContent = 'line\n'.repeat(30000);
    const event = {
      type: 'tool_result' as const,
      toolName: 'read',
      toolCallId: 'call_explore_fail',
      input: { path: '/project/src/data.bin' },
      content: [{ type: 'text' as const, text: bigContent }],
      isError: false,
      details: undefined,
    };

    const { interceptLargeFileWithExplorer } = await import('./interceptor.ts');
    const throwingExplorer = () => { throw new Error('parse failed'); };

    const result = await interceptLargeFileWithExplorer(event, store, {
      largeFileTokenThreshold: 100,
      maxExpandTokens: 4000,
    }, cacheDir, throwingExplorer);

    assert.ok(result !== undefined, 'should still intercept');
    const text = (result!.content![0] as { type: 'text'; text: string }).text;
    assert.ok(text.includes('/project/src/data.bin'), 'should contain file path');
    assert.ok(text.includes('lines'), 'should contain line count');
    assert.ok(text.includes('tokens'), 'should contain token info');
    assert.ok(text.includes('lcm_expand'), 'should contain expand instruction');

    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('returns undefined when store.insertLargeFile throws', async () => {
    const store = new MemoryStore();
    store.openConversation('test-session', '/tmp');
    store.close();

    const cacheDir = mkdtempSync(join(tmpdir(), 'lcm-test-'));
    const bigContent = 'export const x = 1;\n'.repeat(5000);
    const event = {
      type: 'tool_result' as const,
      toolName: 'read',
      toolCallId: 'call_persist_fail',
      input: { path: '/project/src/huge.ts' },
      content: [{ type: 'text' as const, text: bigContent }],
      isError: false,
      details: undefined,
    };

    const result = await interceptLargeFile(event, store, {
      largeFileTokenThreshold: 100,
      maxExpandTokens: 4000,
    }, cacheDir);

    assert.strictEqual(result, undefined, 'should pass through on store failure');
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('returns undefined when cache file write fails', async () => {
    const store = new MemoryStore();
    store.openConversation('test-session', '/tmp');
    const invalidCacheDir = '/dev/null/impossible/path';

    const bigContent = 'export const x = 1;\n'.repeat(5000);
    const event = {
      type: 'tool_result' as const,
      toolName: 'read',
      toolCallId: 'call_write_fail',
      input: { path: '/project/src/huge.ts' },
      content: [{ type: 'text' as const, text: bigContent }],
      isError: false,
      details: undefined,
    };

    const result = await interceptLargeFile(event, store, {
      largeFileTokenThreshold: 100,
      maxExpandTokens: 4000,
    }, invalidCacheDir);

    assert.strictEqual(result, undefined, 'should pass through on write failure');
  });

  it('reuses existing entry when path and mtime match', async () => {
    const store = new MemoryStore();
    store.openConversation('test-session', '/tmp');
    const cacheDir = mkdtempSync(join(tmpdir(), 'lcm-test-'));

    // Create a real temp file so statSync works and gives consistent mtime
    const { writeFileSync } = await import('node:fs');
    const realFile = join(cacheDir, 'source.ts');
    const bigContent = 'export function foo() {}\n'.repeat(4000);
    writeFileSync(realFile, bigContent, 'utf-8');

    const makeEvent = () => ({
      type: 'tool_result' as const,
      toolName: 'read' as const,
      toolCallId: 'call_dedup',
      input: { path: realFile },
      content: [{ type: 'text' as const, text: bigContent }],
      isError: false,
      details: undefined,
    });

    const config = { largeFileTokenThreshold: 100, maxExpandTokens: 4000 };
    const cacheSub = join(cacheDir, 'sub');

    // First call - creates new entry
    const result1 = await interceptLargeFile(makeEvent(), store, config, cacheSub);
    assert.ok(result1 !== undefined);
    const text1 = (result1!.content![0] as { type: 'text'; text: string }).text;
    const idMatch1 = text1.match(/lcm_expand\("([^"]+)"\)/);
    assert.ok(idMatch1, 'should have fileId in first result');
    const fileId1 = idMatch1![1];

    // Second call - same path, same mtime -> reuse
    const result2 = await interceptLargeFile(makeEvent(), store, config, cacheSub);
    assert.ok(result2 !== undefined);
    const text2 = (result2!.content![0] as { type: 'text'; text: string }).text;
    const idMatch2 = text2.match(/lcm_expand\("([^"]+)"\)/);
    assert.ok(idMatch2, 'should have fileId in second result');
    const fileId2 = idMatch2![1];

    // Same fileId means same entry was reused
    assert.strictEqual(fileId2, fileId1, 'should reuse same fileId');

    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('replaces entry when path matches but mtime differs', async () => {
    const store = new MemoryStore();
    store.openConversation('test-session', '/tmp');
    const cacheDir = mkdtempSync(join(tmpdir(), 'lcm-test-'));

    const { writeFileSync, utimesSync } = await import('node:fs');
    const realFile = join(cacheDir, 'changing.ts');
    const bigContent1 = 'export function v1() {}\n'.repeat(4000);
    writeFileSync(realFile, bigContent1, 'utf-8');

    const config = { largeFileTokenThreshold: 100, maxExpandTokens: 4000 };
    const cacheSub = join(cacheDir, 'sub');

    // First call
    const event1 = {
      type: 'tool_result' as const,
      toolName: 'read' as const,
      toolCallId: 'call_v1',
      input: { path: realFile },
      content: [{ type: 'text' as const, text: bigContent1 }],
      isError: false,
      details: undefined,
    };
    const result1 = await interceptLargeFile(event1, store, config, cacheSub);
    assert.ok(result1 !== undefined);
    const text1 = (result1!.content![0] as { type: 'text'; text: string }).text;
    const id1 = text1.match(/lcm_expand\("([^"]+)"\)/)![1];

    // Change the file mtime
    const bigContent2 = 'export function v2() {}\n'.repeat(4000);
    writeFileSync(realFile, bigContent2, 'utf-8');
    const futureTime = Date.now() + 10000;
    utimesSync(realFile, futureTime / 1000, futureTime / 1000);

    // Second call with different mtime
    const event2 = {
      type: 'tool_result' as const,
      toolName: 'read' as const,
      toolCallId: 'call_v2',
      input: { path: realFile },
      content: [{ type: 'text' as const, text: bigContent2 }],
      isError: false,
      details: undefined,
    };
    const result2 = await interceptLargeFile(event2, store, config, cacheSub);
    assert.ok(result2 !== undefined);
    const text2 = (result2!.content![0] as { type: 'text'; text: string }).text;
    const id2 = text2.match(/lcm_expand\("([^"]+)"\)/)![1];

    // Should be a different fileId
    assert.notStrictEqual(id2, id1, 'should create new entry with different fileId');

    // Old entry should be deleted
    const oldEntry = store.getLargeFile(id1);
    assert.strictEqual(oldEntry, undefined, 'old entry should be deleted');

    // New entry should exist
    const newEntry = store.getLargeFile(id2);
    assert.ok(newEntry !== undefined, 'new entry should exist');

    rmSync(cacheDir, { recursive: true, force: true });
  });
});
