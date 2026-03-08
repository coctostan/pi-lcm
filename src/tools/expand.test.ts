import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryContentStore } from '../context/content-store.ts';
import { MemoryStore } from '../store/memory-store.ts';
import { createExpandExecute, registerExpandTool } from './expand.ts';

describe('lcm_expand execute', () => {
  it('returns concatenated text from TextContent entries (AC 7)', async () => {
    const store = new MemoryContentStore();
    store.set('toolu_01ABC', [
      { type: 'text', text: 'first line' },
      { type: 'text', text: 'second line' },
    ]);

    const execute = createExpandExecute(store, { maxExpandTokens: 4000 });
    const result = await execute('call1', { id: 'toolu_01ABC' });

    assert.strictEqual(result.content.length, 1);
    assert.strictEqual(result.content[0].type, 'text');
    assert.strictEqual((result.content[0] as { type: 'text'; text: string }).text, 'first line\nsecond line');
  });

  it('replaces ImageContent with placeholder text in output (AC 8)', async () => {
    const store = new MemoryContentStore();
    store.set('toolu_02DEF', [
      { type: 'text', text: 'some text' },
      { type: 'image', data: 'base64data', mimeType: 'image/png' },
      { type: 'text', text: 'more text' },
    ]);
    const execute = createExpandExecute(store, { maxExpandTokens: 4000 });
    const result = await execute('call2', { id: 'toolu_02DEF' });
    assert.strictEqual(result.content.length, 1);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    assert.strictEqual(text, 'some text\n[Image content — not expandable in text mode]\nmore text');
  });

  it('returns error with available IDs when ID not found (AC 10)', async () => {
    const store = new MemoryContentStore();
    store.set('toolu_A', [{ type: 'text', text: 'a' }]);
    store.set('toolu_B', [{ type: 'text', text: 'b' }]);
    const execute = createExpandExecute(store, { maxExpandTokens: 4000 });
    const result = await execute('call4', { id: 'toolu_MISSING' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    assert.ok(text.includes('No content found for ID "toolu_MISSING"'));
    assert.ok(text.includes('Available IDs:'));
    assert.ok(text.includes('toolu_A'));
    assert.ok(text.includes('toolu_B'));
  });

  it('returns empty store message when ID not found and store is empty (AC 10)', async () => {
    const store = new MemoryContentStore();
    const execute = createExpandExecute(store, { maxExpandTokens: 4000 });
    const result = await execute('call5', { id: 'toolu_MISSING' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    assert.strictEqual(text, 'No content found for ID "toolu_MISSING". The store is empty.');
  });

  it('returns empty content message for empty content array (AC 11)', async () => {
    const store = new MemoryContentStore();
    store.set('toolu_EMPTY', []);
    const execute = createExpandExecute(store, { maxExpandTokens: 4000 });
    const result = await execute('call6', { id: 'toolu_EMPTY' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    assert.strictEqual(text, 'Content for ID "toolu_EMPTY" exists but is empty.');
  });

  it('returns image-only message when content has no TextContent (AC 12)', async () => {
    const store = new MemoryContentStore();
    store.set('toolu_IMGS', [
      { type: 'image', data: 'base64a', mimeType: 'image/png' },
      { type: 'image', data: 'base64b', mimeType: 'image/jpeg' },
    ]);
    const execute = createExpandExecute(store, { maxExpandTokens: 4000 });
    const result = await execute('call7', { id: 'toolu_IMGS' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    assert.strictEqual(text, 'Content for ID "toolu_IMGS" contains only image data, which cannot be displayed in text mode.');
  });

  it('truncates output when exceeding maxExpandTokens (AC 9)', async () => {
    const store = new MemoryContentStore();
    const longText = 'line one content\nline two content\nline three content is very long';
    store.set('toolu_03GHI', [{ type: 'text', text: longText }]);
    const execute = createExpandExecute(store, { maxExpandTokens: 10 });
    const result = await execute('call3', { id: 'toolu_03GHI' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    assert.ok(text.includes('[Truncated'), 'Should contain truncation notice');
    assert.ok(!text.includes('line three'), 'Should not contain content beyond truncation point');
    assert.ok(text.startsWith('line one content'), 'Should contain content up to truncation');
  });

  it('never throws — returns error text on unexpected failure (AC 13)', async () => {
    const brokenStore = {
      set: () => true,
      get: () => {
        throw new Error('Store exploded');
      },
      has: () => false,
      keys: () => [],
    };
    const execute = createExpandExecute(brokenStore, { maxExpandTokens: 4000 });
    const result = await execute('call8', { id: 'toolu_BROKEN' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    assert.ok(text.includes('Error expanding content'));
    assert.ok(text.includes('Store exploded'));
  });
});


describe('registerExpandTool', () => {
  it('registers lcm_expand tool with correct name and schema (AC 6, 16)', () => {
    const store = new MemoryContentStore();
    let registeredTool: any = null;
    const mockPi = {
      registerTool(tool: any) {
        registeredTool = tool;
      },
    } as any;

    registerExpandTool(mockPi, store, { maxExpandTokens: 4000 });

    assert.ok(registeredTool, 'registerTool should have been called');
    assert.strictEqual(registeredTool.name, 'lcm_expand');
    assert.strictEqual(registeredTool.label, 'LCM Expand');
    assert.ok(registeredTool.description.length > 0, 'Should have a description');
    assert.ok(registeredTool.parameters, 'Should have a parameter schema');
    assert.ok(registeredTool.execute, 'Should have an execute function');
    assert.strictEqual(registeredTool.parameters.properties.id.type, 'string');
    assert.deepStrictEqual(registeredTool.parameters.required, ['id']);
  });
});

describe('lcm_expand large file pagination', () => {
  it('returns first chunk with pagination metadata when offset is 0', async () => {
    const contentStore = new MemoryContentStore();
    const dagStore = new MemoryStore();
    dagStore.openConversation('test-session', '/tmp');

    // Create a cache file with content
    const cacheDir = mkdtempSync(join(tmpdir(), 'lcm-expand-test-'));
    const storagePath = join(cacheDir, 'cached.txt');
    // Create content that's ~200 tokens (700 chars)
    const fileContent = 'x'.repeat(700);
    writeFileSync(storagePath, fileContent, 'utf-8');

    const fileId = dagStore.insertLargeFile({
      path: '/project/big.ts',
      explorationSummary: '# big.ts\n100 lines',
      tokenCount: 200,
      storagePath,
      capturedAt: Date.now(),
      fileMtime: Date.now(),
    });

    // maxExpandTokens = 50 → ~175 chars, so content will be paginated
    const execute = createExpandExecute(contentStore, { maxExpandTokens: 50 }, dagStore);
    const result = await execute('call1', { id: fileId, offset: 0 });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    const parsed = JSON.parse(text);
    assert.strictEqual(parsed.id, fileId);
    assert.strictEqual(parsed.source, 'large_file');
    assert.ok(parsed.content.length > 0, 'should have content');
    assert.ok(parsed.content.length < 700, 'should be truncated');
    assert.strictEqual(parsed.hasMore, true);
    assert.ok(typeof parsed.nextOffset === 'number', 'should have nextOffset');
    assert.strictEqual(parsed.totalTokens, 200);

    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('returns correct slice when offset is provided', async () => {
    const contentStore = new MemoryContentStore();
    const dagStore = new MemoryStore();
    dagStore.openConversation('test-session', '/tmp');

    const cacheDir = mkdtempSync(join(tmpdir(), 'lcm-expand-test-'));
    const storagePath = join(cacheDir, 'cached2.txt');
    // 700 chars ≈ 200 tokens
    const fileContent = 'A'.repeat(350) + 'B'.repeat(350);
    writeFileSync(storagePath, fileContent, 'utf-8');

    const fileId = dagStore.insertLargeFile({
      path: '/project/big2.ts',
      explorationSummary: '# big2.ts',
      tokenCount: 200,
      storagePath,
      capturedAt: Date.now(),
      fileMtime: Date.now(),
    });

    // maxExpandTokens = 50 → ~175 chars per page
    const execute = createExpandExecute(contentStore, { maxExpandTokens: 50 }, dagStore);

    // First page
    const r1 = await execute('call1', { id: fileId, offset: 0 });
    const p1 = JSON.parse((r1.content[0] as { type: 'text'; text: string }).text);
    assert.strictEqual(p1.hasMore, true);
    assert.ok(p1.content.startsWith('A'), 'first page should start with As');
    assert.ok(typeof p1.nextOffset === 'number');

    // Second page using nextOffset
    const r2 = await execute('call2', { id: fileId, offset: p1.nextOffset });
    const p2 = JSON.parse((r2.content[0] as { type: 'text'; text: string }).text);
    assert.ok(p2.content.length > 0, 'second page should have content');

    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('returns "no more content" when offset exceeds file length', async () => {
    const contentStore = new MemoryContentStore();
    const dagStore = new MemoryStore();
    dagStore.openConversation('test-session', '/tmp');

    const cacheDir = mkdtempSync(join(tmpdir(), 'lcm-expand-test-'));
    const storagePath = join(cacheDir, 'cached3.txt');
    writeFileSync(storagePath, 'short content', 'utf-8');

    const fileId = dagStore.insertLargeFile({
      path: '/project/small.ts',
      explorationSummary: '# small.ts',
      tokenCount: 4,
      storagePath,
      capturedAt: Date.now(),
      fileMtime: Date.now(),
    });

    const execute = createExpandExecute(contentStore, { maxExpandTokens: 4000 }, dagStore);
    const result = await execute('call1', { id: fileId, offset: 99999 });
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

    assert.strictEqual(parsed.hasMore, false);
    assert.ok(parsed.content.includes('No more content'), 'should indicate no more content');

    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('clamps negative offset to 0', async () => {
    const contentStore = new MemoryContentStore();
    const dagStore = new MemoryStore();
    dagStore.openConversation('test-session', '/tmp');

    const cacheDir = mkdtempSync(join(tmpdir(), 'lcm-expand-test-'));
    const storagePath = join(cacheDir, 'cached4.txt');
    writeFileSync(storagePath, 'hello world', 'utf-8');

    const fileId = dagStore.insertLargeFile({
      path: '/project/neg.ts',
      explorationSummary: '# neg.ts',
      tokenCount: 3,
      storagePath,
      capturedAt: Date.now(),
      fileMtime: Date.now(),
    });

    const execute = createExpandExecute(contentStore, { maxExpandTokens: 4000 }, dagStore);

    // Negative offset should be clamped to 0 and return content from start
    const result = await execute('call1', { id: fileId, offset: -10 });
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    assert.ok(parsed.content.includes('hello world'), 'should return content from start');

    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('returns error when cache file is missing on disk', async () => {
    const contentStore = new MemoryContentStore();
    const dagStore = new MemoryStore();
    dagStore.openConversation('test-session', '/tmp');

    const missingPath = '/tmp/lcm-nonexistent-cache-file-12345.txt';
    const fileId = dagStore.insertLargeFile({
      path: '/project/gone.ts',
      explorationSummary: '# gone.ts',
      tokenCount: 100,
      storagePath: missingPath,
      capturedAt: Date.now(),
      fileMtime: Date.now(),
    });

    const execute = createExpandExecute(contentStore, { maxExpandTokens: 4000 }, dagStore);
    const result = await execute('call1', { id: fileId, offset: 0 });
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

    assert.ok(parsed.error, 'should have error field');
    assert.ok(parsed.error.includes('Cached file not found'), 'should mention cached file');
    assert.ok(parsed.error.includes(missingPath), 'should include the storage path');
  });

  it('includes stale flag when file mtime has changed', async () => {
    const contentStore = new MemoryContentStore();
    const dagStore = new MemoryStore();
    dagStore.openConversation('test-session', '/tmp');

    const cacheDir = mkdtempSync(join(tmpdir(), 'lcm-expand-test-'));
    const storagePath = join(cacheDir, 'cached-stale.txt');
    writeFileSync(storagePath, 'cached content here', 'utf-8');

    // Create the original file with a known mtime
    const originalFile = join(cacheDir, 'original.ts');
    writeFileSync(originalFile, 'original content', 'utf-8');
    const originalMtime = 1000000; // old mtime in ms
    utimesSync(originalFile, originalMtime / 1000, originalMtime / 1000);

    const fileId = dagStore.insertLargeFile({
      path: originalFile,
      explorationSummary: '# original.ts',
      tokenCount: 5,
      storagePath,
      capturedAt: Date.now(),
      fileMtime: originalMtime,
    });

    // Now change the file's mtime
    const newMtime = Date.now();
    writeFileSync(originalFile, 'modified content', 'utf-8');
    utimesSync(originalFile, newMtime / 1000, newMtime / 1000);

    const execute = createExpandExecute(contentStore, { maxExpandTokens: 4000 }, dagStore);
    const result = await execute('call1', { id: fileId, offset: 0 });
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

    assert.strictEqual(parsed.stale, true, 'should have stale flag');
    assert.ok(parsed.staleNote, 'should have stale note');
    assert.ok(parsed.staleNote.includes('changed since capture'), 'note should mention change');
    // Should still return the cached content
    assert.ok(parsed.content.includes('cached content'), 'should still return cached content');

    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('returns pages whose content stays within maxExpandTokens under estimateTokens()', async () => {
    const { estimateTokens } = await import('../summarizer/token-estimator.ts');

    const contentStore = new MemoryContentStore();
    const dagStore = new MemoryStore();
    dagStore.openConversation('test-session', '/tmp');

    const cacheDir = mkdtempSync(join(tmpdir(), 'lcm-expand-budget-test-'));
    const storagePath = join(cacheDir, 'budget.txt');
    const fileContent = 'a'.repeat(315);
    writeFileSync(storagePath, fileContent, 'utf-8');

    const fileId = dagStore.insertLargeFile({
      path: '/project/budget.ts',
      explorationSummary: '# budget.ts',
      tokenCount: estimateTokens(fileContent),
      storagePath,
      capturedAt: Date.now(),
      fileMtime: Date.now(),
    });

    const execute = createExpandExecute(contentStore, { maxExpandTokens: 100 }, dagStore);
    const result = await execute('call1', { id: fileId, offset: 0 });
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

    assert.ok(
      estimateTokens(parsed.content) <= 100,
      `Expected page content to stay within 100 estimated tokens, got ${estimateTokens(parsed.content)}`,
    );

    rmSync(cacheDir, { recursive: true, force: true });
  });
});
