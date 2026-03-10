import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory-store.ts';
import { createGrepExecute } from './grep.ts';

/**
 * Reproduction test for issue #032:
 * lcm_grep results get polluted by tool chatter and echoed outputs.
 *
 * After a user asks to grep for a term, subsequent messages (assistant tool call,
 * tool result JSON, assistant commentary) all contain the search term and get
 * returned as results on the next grep, drowning out the original substantive hit.
 */
describe('issue #032: lcm_grep self-pollution', () => {
  it('subsequent grep for same term should not be dominated by tool chatter', async () => {
    const store = new MemoryStore();
    store.openConversation('sess_1', '/tmp/project');

    // --- Turn 1: user mentions "LCM-CANARY" in a substantive message ---
    store.ingestMessage({
      id: 'm1',
      seq: 0,
      role: 'user',
      content: 'I set up a marker called LCM-CANARY in the config file for testing.',
      tokenCount: 15,
      createdAt: 100,
    });

    // First grep: should find exactly the one substantive message
    const execute = createGrepExecute(store);
    const result1 = await execute('call1', { query: 'LCM-CANARY' });
    const parsed1 = JSON.parse((result1.content[0] as any).text);
    assert.strictEqual(parsed1.results.length, 1, 'First grep should find exactly 1 result');
    assert.strictEqual(parsed1.results[0].id, 'm1');

    // --- Turn 2: user asks assistant to search for LCM-CANARY ---
    store.ingestMessage({
      id: 'm2',
      seq: 1,
      role: 'user',
      content: 'Can you search for LCM-CANARY in the archive?',
      tokenCount: 10,
      createdAt: 200,
    });

    // --- Turn 2: assistant issues tool call (serialized as ingested) ---
    store.ingestMessage({
      id: 'm3',
      seq: 2,
      role: 'assistant',
      content: '[toolCall: lcm_grep] {"query":"LCM-CANARY"}',
      tokenCount: 10,
      createdAt: 201,
    });

    // --- Turn 2: tool result comes back ---
    store.ingestMessage({
      id: 'm4',
      seq: 3,
      role: 'toolResult',
      toolName: 'lcm_grep',
      content: '{"results":[{"kind":"message","id":"m1","snippet":"I set up a marker called LCM-CANARY in the config file for testing."}]}',
      tokenCount: 25,
      createdAt: 202,
    });

    // --- Turn 2: assistant explains the result ---
    store.ingestMessage({
      id: 'm5',
      seq: 4,
      role: 'assistant',
      content: 'I found the LCM-CANARY marker. It appears in message m1 where you mentioned setting it up in the config file.',
      tokenCount: 20,
      createdAt: 203,
    });

    // --- Now grep again: the substantive hit (m1) should dominate, not be
    //     drowned out by tool chatter (m2, m3, m4, m5) ---
    const result2 = await execute('call2', { query: 'LCM-CANARY' });
    const parsed2 = JSON.parse((result2.content[0] as any).text);

    // BUG: Currently returns 5 results (m1-m5), all containing "LCM-CANARY".
    // The 4 extra results are tool chatter that pollute the search.
    //
    // Expected: only substantive user/assistant content should be returned,
    // NOT tool call echoes, tool results from lcm_grep, or meta-commentary.
    //
    // At minimum, tool results from lcm_grep itself (m4) and tool call
    // invocations (m3) should be excluded.
    const nonSubstantiveIds = parsed2.results
      .filter((r: any) => ['m3', 'm4'].includes(r.id))
      .map((r: any) => r.id);

    assert.strictEqual(
      nonSubstantiveIds.length,
      0,
      `grep results should not include tool call echoes or lcm_grep tool results, ` +
      `but found: ${nonSubstantiveIds.join(', ')}. ` +
      `Total results: ${parsed2.results.length} (ids: ${parsed2.results.map((r: any) => r.id).join(', ')})`,
    );
  });
});
