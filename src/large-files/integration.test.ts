import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../store/memory-store.ts';
import { MemoryContentStore } from '../context/content-store.ts';
import { interceptLargeFile } from './interceptor.ts';
import { createExpandExecute } from '../tools/expand.ts';

describe('large file interception → expansion integration', () => {
  it('intercepts large file and retrieves all content via paginated lcm_expand', async () => {
    const store = new MemoryStore();
    store.openConversation('test-session', '/tmp');
    const cacheDir = mkdtempSync(join(tmpdir(), 'lcm-integration-'));
    const cacheSub = join(cacheDir, 'cache');

    // Create a large file content (~1000 tokens = ~3500 chars)
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(`export const var${i} = ${i};`);
    }
    const bigContent = lines.join('\n');

    // Step 1: Intercept the tool result
    const event = {
      type: 'tool_result' as const,
      toolName: 'read' as const,
      toolCallId: 'call_integration',
      input: { path: '/project/src/constants.ts' },
      content: [{ type: 'text' as const, text: bigContent }],
      isError: false,
      details: undefined,
    };

    const interceptResult = await interceptLargeFile(event, store, {
      largeFileTokenThreshold: 100,
      maxExpandTokens: 200, // Small page size to force pagination
    }, cacheSub);

    assert.ok(interceptResult !== undefined, 'should intercept');
    const interceptText = (interceptResult!.content![0] as { type: 'text'; text: string }).text;

    // Should contain exploration summary (TS file → exports listed)
    assert.ok(interceptText.includes('constants.ts'), 'should reference file');
    assert.ok(interceptText.includes('export'), 'should have export info from explorer');

    // Extract fileId
    const idMatch = interceptText.match(/lcm_expand\("([^"]+)"\)/);
    assert.ok(idMatch, 'should have fileId in replacement');
    const fileId = idMatch![1];

    // Step 2: Expand via lcm_expand with pagination
    const contentStore = new MemoryContentStore();
    const execute = createExpandExecute(contentStore, { maxExpandTokens: 200 }, store);

    // Collect all pages
    const allContent: string[] = [];
    let offset = 0;
    let pages = 0;
    const MAX_PAGES = 50;

    while (pages < MAX_PAGES) {
      const expandResult = await execute('expand_call', { id: fileId, offset });
      const parsed = JSON.parse((expandResult.content[0] as { type: 'text'; text: string }).text);

      assert.strictEqual(parsed.source, 'large_file');
      allContent.push(parsed.content);
      pages++;

      if (!parsed.hasMore) break;
      offset = parsed.nextOffset;
    }

    assert.ok(pages > 1, 'should require multiple pages');
    assert.ok(pages < MAX_PAGES, 'should terminate');

    // Verify pagination returns exact raw content without gaps or duplication
    const combined = allContent.join('');
    assert.strictEqual(combined, bigContent, 'paginated expansion should reconstruct exact original content');

    rmSync(cacheDir, { recursive: true, force: true });
  });
});
