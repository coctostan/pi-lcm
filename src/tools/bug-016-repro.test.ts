/**
 * Reproduction tests for batch issue 016.
 * Each test FAILS on unpatched code and should PASS once fixed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../store/sqlite-store.ts';
import { MemoryContentStore } from '../context/content-store.ts';
import { createGrepExecute } from './grep.ts';
import { createExpandExecute } from './expand.ts';
import { createDescribeExecute } from './describe.ts';
import { estimateTokens } from '../summarizer/token-estimator.ts';

// ---------------------------------------------------------------------------
// Issue #012 — lcm_grep: hyphenated query terms crash FTS5 ("no such column")
// ---------------------------------------------------------------------------
describe('Bug #012 — lcm_grep FTS5 hyphenated query crash', () => {
  // Regression: hyphenated token should be treated as a literal search term.
  it('query "better-sqlite3" returns results without throwing (SqliteStore)', async () => {
    const store = new SqliteStore(':memory:');
    store.openConversation('sess_test', '/tmp');

    store.ingestMessage({
      id: 'm1',
      seq: 0,
      role: 'user',
      content: 'installing better-sqlite3 package for node',
      tokenCount: 10,
      createdAt: 100,
    });

    const exec = createGrepExecute(store);

    // Should NOT throw; should return a valid JSON result (possibly empty results,
    // but no error field containing "no such column").
    const result = await exec('call1', { query: 'better-sqlite3' });
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

    // Bug: currently returns { results: [], error: 'Invalid search query: no such column: sqlite3' }
    assert.strictEqual(
      parsed.error,
      undefined,
      `Expected no error but got: ${parsed.error}`,
    );
    // The message containing "better-sqlite3" should be found.
    assert.ok(
      parsed.results.length >= 1,
      `Expected at least 1 result, got ${parsed.results.length}`,
    );

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Issue #013 — lcm_expand: message IDs returned by lcm_grep are not expandable
// ---------------------------------------------------------------------------
describe('Bug #013 — lcm_expand cannot expand message IDs from lcm_grep', () => {
  // Regression: expand should fall back to SQLite messages when ContentStore misses.
  it('expanding a message ID returned by lcm_grep returns message content (structured mode)', async () => {
    const dagStore = new SqliteStore(':memory:');
    dagStore.openConversation('sess_test', '/tmp');

    dagStore.ingestMessage({
      id: 'msg_abc123',
      seq: 0,
      role: 'user',
      content: 'This is an important message about compaction strategy.',
      tokenCount: 15,
      createdAt: 100,
    });

    // Step 1: grep finds the message, returns its ID
    const grepExec = createGrepExecute(dagStore);
    const grepResult = await grepExec('call1', { query: 'compaction' });
    const grepParsed = JSON.parse((grepResult.content[0] as { type: 'text'; text: string }).text);

    assert.ok(grepParsed.results.length >= 1, 'Expected grep to find the message');
    const messageId = grepParsed.results.find((r: any) => r.kind === 'message')?.id;
    assert.ok(messageId, 'Expected a message result with an id');

    // Step 2: expand the ID returned by grep (structured mode: dagStore passed)
    const contentStore = new MemoryContentStore(); // empty — ID only lives in SQLite
    const expandExec = createExpandExecute(contentStore, { maxExpandTokens: 4000 }, dagStore);
    const expandResult = await expandExec('call2', { id: messageId });
    const expandParsed = JSON.parse((expandResult.content[0] as { type: 'text'; text: string }).text);

    // Bug: currently returns { error: 'No content found for ID "msg_abc123"', id: 'msg_abc123' }
    assert.strictEqual(
      expandParsed.error,
      undefined,
      `Expected no error but got: ${expandParsed.error}`,
    );
    assert.ok(
      (expandParsed.content as string).includes('compaction'),
      `Expected message content to include 'compaction', got: ${expandParsed.content}`,
    );

    dagStore.close();
  });
});

// ---------------------------------------------------------------------------
// Issue #014 — lcm_expand: summary UUIDs from lcm_describe/lcm_grep not expandable
// ---------------------------------------------------------------------------
describe('Bug #014 — lcm_expand cannot expand summary UUIDs from lcm_describe/lcm_grep', () => {
  // Regression: UUID summary IDs should route to DAG summary expansion.
  it('expanding a summary UUID from lcm_describe returns summary content (structured mode)', async () => {
    const dagStore = new SqliteStore(':memory:');
    dagStore.openConversation('sess_test', '/tmp');

    const summaryId = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Condensed: session covered installation steps for the project toolchain.',
      tokenCount: 30,
      earliestAt: 100,
      latestAt: 200,
      descendantCount: 3,
      createdAt: 300,
    });

    // Step 1: lcm_describe returns the UUID
    const describeExec = createDescribeExecute(dagStore);
    const describeResult = await describeExec('call1', { id: summaryId });
    const describeParsed = JSON.parse((describeResult.content[0] as { type: 'text'; text: string }).text);
    assert.strictEqual(describeParsed.summaryId, summaryId, 'describe should return the summaryId');
    assert.ok(describeParsed.tokenCount > 0, 'describe should report non-zero tokenCount');

    // Step 2: expand that UUID (structured mode, dagStore passed)
    const contentStore = new MemoryContentStore(); // empty — ID only in SQLite
    const expandExec = createExpandExecute(contentStore, { maxExpandTokens: 4000 }, dagStore);
    const expandResult = await expandExec('call2', { id: summaryId });
    const expandParsed = JSON.parse((expandResult.content[0] as { type: 'text'; text: string }).text);

    // Bug: currently returns { error: 'No content found for ID "<uuid>"', id: '<uuid>' }
    assert.strictEqual(
      expandParsed.error,
      undefined,
      `Expected no error but got: ${expandParsed.error}`,
    );
    assert.ok(
      (expandParsed.content as string).includes('toolchain'),
      `Expected summary content, got: ${expandParsed.content}`,
    );

    dagStore.close();
  });

  it('expanding a summary UUID returned by lcm_grep returns summary content (structured mode)', async () => {
    const dagStore = new SqliteStore(':memory:');
    dagStore.openConversation('sess_test', '/tmp');

    dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Summary about context-window management and eviction policy.',
      tokenCount: 20,
      earliestAt: 100,
      latestAt: 200,
      descendantCount: 2,
      createdAt: 300,
    });

    // Step 1: grep returns the summary UUID
    const grepExec = createGrepExecute(dagStore);
    const grepResult = await grepExec('call1', { query: 'eviction' });
    const grepParsed = JSON.parse((grepResult.content[0] as { type: 'text'; text: string }).text);
    assert.ok(grepParsed.results.length >= 1, 'Expected grep to find the summary');
    const summaryId = grepParsed.results.find((r: any) => r.kind === 'summary')?.id;
    assert.ok(summaryId, 'Expected a summary result with an id');

    // Step 2: expand that UUID (structured mode)
    const contentStore = new MemoryContentStore();
    const expandExec = createExpandExecute(contentStore, { maxExpandTokens: 4000 }, dagStore);
    const expandResult = await expandExec('call2', { id: summaryId });
    const expandParsed = JSON.parse((expandResult.content[0] as { type: 'text'; text: string }).text);

    // Bug: currently returns { error: 'No content found for ID "<uuid>"', id: '<uuid>' }
    assert.strictEqual(
      expandParsed.error,
      undefined,
      `Expected no error but got: ${expandParsed.error}`,
    );

    dagStore.close();
  });
});

// ---------------------------------------------------------------------------
// Issue #015 — tokenCount is 0 for all summaries in SQLite store
//
// Root cause: the SqliteStore relies entirely on callers to pass the correct
// tokenCount in SummaryInsert. Nothing prevents a caller from passing 0 (or
// forgetting to compute it). The fix is to compute tokenCount from content
// inside insertSummary rather than trusting the caller.
// ---------------------------------------------------------------------------
describe('Bug #015 — tokenCount is 0 for summaries stored via SqliteStore', () => {
  // Regression: insertSummary should derive tokenCount from summary content.
  it('insertSummary computes a non-zero tokenCount even when caller passes 0 for non-empty content', () => {
    const store = new SqliteStore(':memory:');
    store.openConversation('sess_test', '/tmp');

    // Simulates what the engine does when summarizer returns empty string (estimateTokens('') === 0)
    // but the actual summary content is non-empty (e.g. a fallback / prior-cycle result):
    const content = 'This is substantial summary content produced by the LLM for the session.';
    assert.ok(estimateTokens(content) > 0, 'precondition: content is non-empty');

    const sid = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content,
      tokenCount: 0,  // caller erroneously (or via a code path bug) passes 0
      earliestAt: 1,
      latestAt: 2,
      descendantCount: 1,
      createdAt: 3,
    });

    const meta = store.describeSummary(sid);

    // Bug: currently stores 0 because insertSummary uses summary.tokenCount verbatim.
    // Fix: insertSummary should always compute from content: estimateTokens(summary.content).
    assert.ok(
      meta.tokenCount > 0,
      `Expected tokenCount > 0 for non-empty content, but got ${meta.tokenCount}`,
    );

    store.close();
  });

  it('getSummary returns non-zero tokenCount for a non-empty summary', () => {
    const store = new SqliteStore(':memory:');
    store.openConversation('sess_test', '/tmp');

    const content = 'Another summary with real content that should have tokens.';
    const sid = store.insertSummary({
      depth: 1,
      kind: 'condensed',
      content,
      tokenCount: 0,
      earliestAt: 10,
      latestAt: 20,
      descendantCount: 5,
      createdAt: 30,
    });

    const stored = store.getSummary(sid);
    assert.ok(stored !== undefined, 'summary should exist');

    // Bug: currently 0.
    assert.ok(
      stored.tokenCount > 0,
      `Expected stored.tokenCount > 0 for non-empty content, but got ${stored.tokenCount}`,
    );

    store.close();
  });
});
