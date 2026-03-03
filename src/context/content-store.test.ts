import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { TextContent, ImageContent } from '@mariozechner/pi-ai';
import { MemoryContentStore } from './content-store.ts';
import type { ContentStore } from './content-store.ts';

describe('ContentStore interface', () => {
  it('MemoryContentStore implements ContentStore', () => {
    const store: ContentStore = new MemoryContentStore();
    assert.ok(store);
    assert.strictEqual(typeof store.set, 'function');
    assert.strictEqual(typeof store.get, 'function');
    assert.strictEqual(typeof store.has, 'function');
  });
});

describe('MemoryContentStore', () => {
  it('set returns true and get returns stored content (AC 13, 14)', () => {
    const store = new MemoryContentStore();
    const content: (TextContent | ImageContent)[] = [
      { type: 'text', text: 'hello world' },
    ];
    const result = store.set('key1', content);
    assert.strictEqual(result, true);
    assert.deepStrictEqual(store.get('key1'), content);
  });

  it('get returns undefined for missing key (AC 14)', () => {
    const store = new MemoryContentStore();
    assert.strictEqual(store.get('nonexistent'), undefined);
  });

  it('has returns true for stored keys and false otherwise (AC 15)', () => {
    const store = new MemoryContentStore();
    const content: (TextContent | ImageContent)[] = [
      { type: 'text', text: 'data' },
    ];
    assert.strictEqual(store.has('key1'), false);
    store.set('key1', content);
    assert.strictEqual(store.has('key1'), true);
    assert.strictEqual(store.has('key2'), false);
  });

  it('multiple entries do not interfere (AC 16)', () => {
    const store = new MemoryContentStore();
    const content1: (TextContent | ImageContent)[] = [
      { type: 'text', text: 'first' },
    ];
    const content2: (TextContent | ImageContent)[] = [
      { type: 'image', data: 'base64data', mimeType: 'image/png' },
    ];
    const content3: (TextContent | ImageContent)[] = [
      { type: 'text', text: 'third' },
      { type: 'image', data: 'img2', mimeType: 'image/jpeg' },
    ];
    store.set('a', content1);
    store.set('b', content2);
    store.set('c', content3);
    assert.deepStrictEqual(store.get('a'), content1);
    assert.deepStrictEqual(store.get('b'), content2);
    assert.deepStrictEqual(store.get('c'), content3);
    assert.strictEqual(store.has('a'), true);
    assert.strictEqual(store.has('b'), true);
    assert.strictEqual(store.has('c'), true);
    assert.strictEqual(store.has('d'), false);
  });

  it('keys() returns all stored keys (AC 14)', () => {
    const store = new MemoryContentStore();
    assert.deepStrictEqual(store.keys(), []);
    store.set('a', [{ type: 'text', text: 'first' }]);
    store.set('b', [{ type: 'text', text: 'second' }]);
    store.set('c', [{ type: 'text', text: 'third' }]);
    const keys = store.keys();
    assert.strictEqual(keys.length, 3);
    assert.ok(keys.includes('a'));
    assert.ok(keys.includes('b'));
    assert.ok(keys.includes('c'));
  });
});
