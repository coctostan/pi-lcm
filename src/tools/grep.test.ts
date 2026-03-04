import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { createGrepExecute, registerGrepTool } from './grep.ts';
import { GrepResultSetSchema } from '../schemas.ts';

describe('lcm_grep execute', () => {
  it('returns matching results as Zod-validated JSON (AC 13)', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/project');
    store.ingestMessage({
      id: 'm1',
      seq: 0,
      role: 'user',
      content: 'alpha beta gamma',
      tokenCount: 10,
      createdAt: 100,
    });
    store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'summary about alpha topic',
      tokenCount: 20,
      earliestAt: 50,
      latestAt: 90,
      descendantCount: 2,
      createdAt: 200,
    });

    const execute = createGrepExecute(store);
    const result = await execute('call1', { query: 'alpha' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    const parsed = JSON.parse(text);

    const validated = GrepResultSetSchema.parse(parsed);
    assert.ok(
      validated.results.length >= 2,
      `Expected at least 2 results, got ${validated.results.length}`,
    );
    assert.ok(validated.results.some((r) => r.kind === 'message'));
    assert.ok(validated.results.some((r) => r.kind === 'summary'));
  });

  it('returns { results: [] } when query matches nothing (AC 14)', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/project');
    store.ingestMessage({
      id: 'm1',
      seq: 0,
      role: 'user',
      content: 'hello world',
      tokenCount: 5,
      createdAt: 100,
    });

    const execute = createGrepExecute(store);
    const result = await execute('call1', { query: 'zzzznotfound' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    const parsed = JSON.parse(text);

    const validated = GrepResultSetSchema.parse(parsed);
    assert.deepStrictEqual(validated.results, []);
    assert.strictEqual(validated.error, undefined);
  });

  it('catches Store error and returns structured error (AC 15)', async () => {
    const throwingStore = {
      grepMessages(_pattern: string, _mode: 'fulltext' | 'regex') {
        throw new Error('fts5: syntax error near "***"');
      },
      openConversation() {},
      ingestMessage() {},
      getMessagesAfter() {
        return [];
      },
      getMessage() {
        return undefined;
      },
      getLastIngestedSeq() {
        return -1;
      },
      insertSummary() {
        return 'fake';
      },
      getSummary() {
        return undefined;
      },
      linkSummaryMessages() {},
      linkSummaryParents() {},
      getContextItems() {
        return [];
      },
      replaceContextItems() {},
      expandSummary() {
        return '';
      },
      describeSummary() {
        return {} as any;
      },
      close() {},
    } as any;

    const execute = createGrepExecute(throwingStore);
    const result = await execute('call1', { query: '***bad***' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    const parsed = JSON.parse(text);

    const validated = GrepResultSetSchema.parse(parsed);
    assert.deepStrictEqual(validated.results, []);
    assert.ok(validated.error, 'Should have error field');
    assert.ok(validated.error!.includes('Invalid search query:'));
    assert.ok(validated.error!.includes('fts5: syntax error'));
  });
});

describe('registerGrepTool (AC 12)', () => {
  it('registers lcm_grep tool with correct name and { query: string } parameters', () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/project');
    let registeredTool: any = null;
    const mockPi = {
      registerTool(tool: any) {
        registeredTool = tool;
      },
    } as any;

    registerGrepTool(mockPi, store);

    assert.ok(registeredTool !== null, 'registerTool should have been called');
    assert.strictEqual(registeredTool.name, 'lcm_grep');
    assert.ok(registeredTool.parameters.properties.query, 'Should have query parameter');
    assert.strictEqual(registeredTool.parameters.properties.query.type, 'string');
  });
});
