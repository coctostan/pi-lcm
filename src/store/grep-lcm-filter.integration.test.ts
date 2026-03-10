import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from './sqlite-store.ts';

describe('SqliteStore grepMessages LCM tool noise filtering', () => {
  it('excludes lcm_ toolResult messages and lcm_ tool call assistant messages from fulltext results', () => {
    const store = new SqliteStore(':memory:');
    store.openConversation('sess_1', '/tmp/project');

    // Substantive user message
    store.ingestMessage({
      id: 'm1', seq: 0, role: 'user',
      content: 'I set up a marker called LCM-CANARY in the config file.',
      tokenCount: 15, createdAt: 100,
    });

    // Assistant tool call echo for lcm_grep
    store.ingestMessage({
      id: 'm2', seq: 1, role: 'assistant',
      content: '[toolCall: lcm_grep] {"query":"LCM-CANARY"}',
      tokenCount: 10, createdAt: 200,
    });

    // lcm_grep tool result
    store.ingestMessage({
      id: 'm3', seq: 2, role: 'toolResult',
      toolName: 'lcm_grep',
      content: '{"results":[{"kind":"message","id":"m1","snippet":"LCM-CANARY in the config file."}]}',
      tokenCount: 20, createdAt: 201,
    });

    // Non-LCM tool result should still be searchable
    store.ingestMessage({
      id: 'm4', seq: 3, role: 'toolResult',
      toolName: 'read',
      content: 'File contents mentioning LCM-CANARY marker',
      tokenCount: 10, createdAt: 202,
    });

    const results = store.grepMessages('LCM-CANARY', 'fulltext');
    const ids = results.map(r => r.id).sort();

    // m1 (substantive user) and m4 (non-LCM tool result) should be returned
    // m2 (lcm_ tool call) and m3 (lcm_ tool result) should be excluded
    assert.deepStrictEqual(ids, ['m1', 'm4']);

    store.close();
  });

  it('excludes lcm_ tool noise from regex results too', () => {
    const store = new SqliteStore(':memory:');
    store.openConversation('sess_1', '/tmp/project');

    store.ingestMessage({
      id: 'm1', seq: 0, role: 'user',
      content: 'marker CANARY-123 here',
      tokenCount: 5, createdAt: 100,
    });

    store.ingestMessage({
      id: 'm2', seq: 1, role: 'toolResult',
      toolName: 'lcm_grep',
      content: '{"results":[{"snippet":"CANARY-123"}]}',
      tokenCount: 10, createdAt: 200,
    });

    const results = store.grepMessages('CANARY-\\d+', 'regex');
    const ids = results.map(r => r.id);

    assert.deepStrictEqual(ids, ['m1']);

    store.close();
  });
});
