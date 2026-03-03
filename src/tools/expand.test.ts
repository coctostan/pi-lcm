import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryContentStore } from '../context/content-store.ts';
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
    assert.ok(text.startsWith('line one content\nline two content'), 'Should contain content up to truncation');
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
