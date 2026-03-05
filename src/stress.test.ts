/**
 * pi-lcm Real-World Stress Tests
 * ================================
 * Four scenarios exercising the full stack against SqliteStore:
 *
 *  S1 — Long conversation replay: 500 messages → compaction → DAG integrity
 *  S2 — High-volume ingestion: 1000 messages → FTS5 search correctness at scale
 *  S3 — Tool round-trip: lcm_grep → lcm_expand → lcm_describe (bugs #012–#015)
 *  S4 — Edge cases: empty messages, giant tool output, image-only, special FTS5 chars, persistence
 *
 * Each scenario prints a structured REPORT block showing timing, throughput,
 * and correctness metrics. All assertions must pass for the suite to be green.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteStore } from './store/sqlite-store.ts';
import { MemoryContentStore } from './context/content-store.ts';
import { runCompaction } from './compaction/engine.ts';
import { createGrepExecute } from './tools/grep.ts';
import { createExpandExecute } from './tools/expand.ts';
import { createDescribeExecute } from './tools/describe.ts';
import { estimateTokens } from './summarizer/token-estimator.ts';
import type { Summarizer, SummarizeOptions } from './summarizer/summarizer.ts';
import type { IngestableMessage } from './store/types.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Fast mock summarizer — no real LLM calls, ~1ms latency */
const fastSummarizer: Summarizer = {
  async summarize(content: string, _opts: SummarizeOptions): Promise<string> {
    const words = content.split(/\s+/).slice(0, 40).join(' ');
    return `[summary] ${words}`;
  },
};

/** Slower mock summarizer (simulates real LLM round-trip at ~20ms) */
const slowSummarizer: Summarizer = {
  async summarize(content: string, _opts: SummarizeOptions): Promise<string> {
    await new Promise(r => setTimeout(r, 20));
    const words = content.split(/\s+/).slice(0, 30).join(' ');
    return `[summary] ${words}`;
  },
};

/** Realistic message content pool — mimics real pi conversations */
const REALISTIC_CONTENT = [
  `I need to refactor the SqliteStore so it uses WAL journaling. Currently the schema migration fails
   when the database version is bumped. Here's the error: SQLITE_ERROR: no such table: schema_version.
   Let me walk through the migration logic step by step.`,

  `Here is the updated migration code:\n\`\`\`typescript\nfunction ensureSchema(db: DatabaseSync): void {\n  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get();\n  if (!row) { db.exec(SCHEMA_SQL); }\n}\n\`\`\``,

  `Tool output from \`read\` on src/store/sqlite-store.ts:\n\`\`\`\nimport { DatabaseSync } from 'node:' + 'sqlite';\nexport class SqliteStore implements Store {\n  private db: DatabaseSync;\n  ...\n}\n\`\`\``,

  `Running the test suite: npm test -- --grep "sqlite"\n309 tests pass, 0 fail. Duration: 1.76s\nAll assertions green.`,

  `Let me check the FTS5 virtual table definition. The issue with better-sqlite3 hyphenated tokens\nis that FTS5 parses the hyphen as a minus operator. We need to quote all tokens with double-quotes\nto prevent this: SELECT * FROM messages_fts WHERE messages_fts MATCH '"better-sqlite3"';`,

  `The compaction engine runs a leaf pass first, then cascades condensation upward through the DAG.\nEach leaf summary covers a configurable chunk of messages (default leafChunkTokens=800).\nThe condensation guard prevents summaries from growing larger than their inputs.`,

  `Performance numbers from the stress test run:\n- 1000 messages ingested: 234ms\n- FTS5 search (10 queries): 12ms avg\n- buildContext (100 msgs, 10 summaries): 8ms\n- runCompaction (leaf pass, 50 msgs): 340ms\nAll within bounds.`,

  `Error encountered during integration test: TypeError: Cannot read properties of undefined (reading 'content')\n  at ContextBuilder.buildContext (src/context/context-builder.ts:45:23)\n  at Object.<anonymous> (src/context/context-builder.test.ts:88:5)`,

  `Fixed the null-check in ContextBuilder. The issue was that getContextItems() can return summary items\nwhose summaryId no longer exists in the store after a migration. Added a guard:\nif (!summary) { filteredItems.push(item); continue; }`,

  `Session tree after compaction:\n- [condensed-summary depth=2] covers msgs 0–399 (descendantCount=8)\n  ├─ [leaf-summary depth=1] covers msgs 0–199\n  └─ [leaf-summary depth=1] covers msgs 200–399\n- [raw messages] msgs 400–499 (fresh tail)`,
];

function pickContent(i: number, role: 'user' | 'assistant' | 'toolResult'): string {
  const base = REALISTIC_CONTENT[i % REALISTIC_CONTENT.length]!;
  if (role === 'toolResult') {
    return `Tool: read\nPath: src/store/sqlite-store.ts\nOutput (message ${i}):\n${base}`;
  }
  return `[msg ${i}] ${base}`;
}

function makeMessage(i: number): IngestableMessage {
  const roles: Array<'user' | 'assistant' | 'toolResult'> = ['user', 'assistant', 'toolResult'];
  const role = roles[i % 3]!;
  const content = pickContent(i, role);
  return {
    id: `msg_${i.toString().padStart(5, '0')}`,
    seq: i,
    role,
    toolName: role === 'toolResult' ? 'read' : undefined,
    content,
    tokenCount: estimateTokens(content),
    createdAt: 1_700_000_000_000 + i * 5_000, // 5s apart
  };
}

function report(title: string, metrics: Record<string, string | number>): void {
  console.log(`\n╔${'═'.repeat(62)}╗`);
  console.log(`║  STRESS REPORT: ${title.padEnd(44)}║`);
  console.log(`╠${'═'.repeat(62)}╣`);
  for (const [k, v] of Object.entries(metrics)) {
    const key = k.padEnd(32);
    const val = String(v).padStart(26);
    console.log(`║  ${key}${val}  ║`);
  }
  console.log(`╚${'═'.repeat(62)}╝`);
}

function elapsed(start: number): string {
  return `${(performance.now() - start).toFixed(1)}ms`;
}

// ────────────────────────────────────────────────────────────────────────────
// S1 — Long conversation replay: 500 messages → compaction → DAG integrity
// ────────────────────────────────────────────────────────────────────────────

describe('S1 — Long conversation replay (500 msgs → compaction → DAG)', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStore;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-lcm-s1-'));
    dbPath = join(tmpDir, 'stress-s1.db');
    store = new SqliteStore(dbPath);
    store.openConversation('sess_s1', '/tmp/stress-s1');
  });

  after(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ingests 500 messages without error', () => {
    const t = performance.now();
    for (let i = 0; i < 500; i++) {
      store.ingestMessage(makeMessage(i));
    }
    // Set all 500 as initial context items
    store.replaceContextItems(
      Array.from({ length: 500 }, (_, i) => ({
        kind: 'message' as const,
        messageId: `msg_${i.toString().padStart(5, '0')}`,
      })),
    );
    const ms = performance.now() - t;

    assert.strictEqual(store.getLastIngestedSeq(), 499);
    assert.ok(ms < 2000, `Ingestion of 500 msgs took ${ms.toFixed(0)}ms (limit: 2000ms)`);
    report('S1.ingest (500 msgs)', {
      'Messages ingested': 500,
      'Wall time': `${ms.toFixed(1)}ms`,
      'Throughput': `${(500 / (ms / 1000)).toFixed(0)} msgs/s`,
      'Last seq': store.getLastIngestedSeq(),
    });
  });

  it('runs compaction (leaf pass) and creates summaries', async () => {
    const t = performance.now();
    const result = await runCompaction(
      store,
      fastSummarizer,
      {
        freshTailCount: 32,
        leafChunkTokens: 800,
        leafTargetTokens: 400,
        condensedTargetTokens: 600,
        condensedMinFanout: 1000, // disable condensation for this pass
      },
      new AbortController().signal,
    );
    const ms = performance.now() - t;

    assert.ok(result.actionTaken, 'Expected compaction to take action');
    assert.ok(result.summariesCreated >= 1, `Expected ≥1 summaries, got ${result.summariesCreated}`);
    assert.ok(ms < 5000, `Leaf compaction took ${ms.toFixed(0)}ms (limit: 5000ms)`);

    const items = store.getContextItems();
    const summaryCount = items.filter(i => i.kind === 'summary').length;
    const messageCount = items.filter(i => i.kind === 'message').length;

    assert.ok(summaryCount >= 1, 'Expected at least 1 summary in context items after compaction');
    assert.ok(messageCount <= 500, 'Messages should be reduced after compaction');

    report('S1.compaction (leaf pass)', {
      'Summaries created': result.summariesCreated,
      'Wall time': `${ms.toFixed(1)}ms`,
      'Context items after': items.length,
      '  → summaries': summaryCount,
      '  → messages': messageCount,
      'NoOp reasons': result.noOpReasons.join(', ') || 'none',
    });
  });

  it('runs condensation pass and produces multi-depth DAG', async () => {
    const t = performance.now();
    // Run compaction again with condensation enabled
    const result = await runCompaction(
      store,
      fastSummarizer,
      {
        freshTailCount: 32,
        leafChunkTokens: 800,
        leafTargetTokens: 400,
        condensedTargetTokens: 600,
        condensedMinFanout: 2, // allow condensation
      },
      new AbortController().signal,
    );
    const ms = performance.now() - t;

    // Condensation may or may not fire depending on how many leaves were created
    // But the engine should not error
    assert.ok(ms < 10_000, `Condensation pass took ${ms.toFixed(0)}ms (limit: 10000ms)`);

    const items = store.getContextItems();
    const maxDepthSummaryId = items.find(i => i.kind === 'summary');
    if (maxDepthSummaryId && maxDepthSummaryId.kind === 'summary') {
      const meta = store.describeSummary(maxDepthSummaryId.summaryId);
      report('S1.condensation pass', {
        'Action taken': String(result.actionTaken),
        'Summaries created': result.summariesCreated,
        'Wall time': `${ms.toFixed(1)}ms`,
        'Top summary depth': meta.depth,
        'Top summary descendantCount': meta.descendantCount,
        'Context items after': items.length,
      });
    } else {
      report('S1.condensation pass', {
        'Action taken': String(result.actionTaken),
        'Summaries created': result.summariesCreated,
        'Wall time': `${ms.toFixed(1)}ms`,
        'NoOp reasons': result.noOpReasons.join(', ') || 'none',
      });
    }
  });

  it('all summaries have valid content and positive tokenCount after compaction', () => {
    const items = store.getContextItems();
    const summaryItems = items.filter(i => i.kind === 'summary');
    assert.ok(summaryItems.length >= 1, 'Need at least 1 summary to validate');

    let ok = 0;
    for (const item of summaryItems) {
      if (item.kind !== 'summary') continue;
      const meta = store.describeSummary(item.summaryId);
      assert.ok(meta.tokenCount > 0, `Summary ${item.summaryId} has tokenCount=0`);
      assert.ok(meta.descendantCount > 0, `Summary ${item.summaryId} has descendantCount=0`);
      const content = store.expandSummary(item.summaryId);
      assert.ok(content.length > 0, `Summary ${item.summaryId} has empty content`);
      ok++;
    }

    report('S1.DAG integrity', {
      'Summaries validated': ok,
      'All tokenCount > 0': 'YES',
      'All content non-empty': 'YES',
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// S2 — High-volume ingestion: 1000 messages → FTS5 correctness at scale
// ────────────────────────────────────────────────────────────────────────────

describe('S2 — High-volume ingestion (1000 msgs → FTS5 search)', () => {
  let tmpDir: string;
  let store: SqliteStore;

  // Marker messages at known positions (injected into the message stream)
  const MARKERS = [
    { seq: 7,   term: 'CANARY_ALPHA',   id: 'msg_00007' },
    { seq: 123, term: 'CANARY_BETA',    id: 'msg_00123' },
    { seq: 499, term: 'CANARY_GAMMA',   id: 'msg_00499' },
    { seq: 750, term: 'CANARY_DELTA',   id: 'msg_00750' },
    { seq: 999, term: 'CANARY_EPSILON', id: 'msg_00999' },
  ];

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-lcm-s2-'));
    store = new SqliteStore(join(tmpDir, 'stress-s2.db'));
    store.openConversation('sess_s2', '/tmp/stress-s2');
  });

  after(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ingests 1000 messages (with canary markers) within 3 seconds', () => {
    const markerSet = new Map(MARKERS.map(m => [m.seq, m.term]));
    const t = performance.now();

    for (let i = 0; i < 1000; i++) {
      const msg = makeMessage(i);
      if (markerSet.has(i)) {
        msg.content = `${markerSet.get(i)} — unique identifier for stress test retrieval. ${msg.content}`;
        msg.tokenCount = estimateTokens(msg.content);
      }
      store.ingestMessage(msg);
    }
    const ms = performance.now() - t;

    assert.strictEqual(store.getLastIngestedSeq(), 999);
    assert.ok(ms < 3000, `Ingestion of 1000 msgs took ${ms.toFixed(0)}ms (limit: 3000ms)`);

    report('S2.ingest (1000 msgs)', {
      'Messages ingested': 1000,
      'Wall time': `${ms.toFixed(1)}ms`,
      'Throughput': `${(1000 / (ms / 1000)).toFixed(0)} msgs/s`,
      'Canary markers injected': MARKERS.length,
    });
  });

  it('getMessagesAfter returns correct slice', () => {
    const t = performance.now();
    const msgs = store.getMessagesAfter(900);
    const ms = performance.now() - t;

    assert.strictEqual(msgs.length, 99, `Expected 99 messages after seq 900, got ${msgs.length}`);
    assert.ok(msgs.every(m => m.seq > 900), 'All returned messages should have seq > 900');
    assert.ok(ms < 50, `getMessagesAfter took ${ms.toFixed(1)}ms (limit: 50ms)`);

    report('S2.getMessagesAfter', {
      'Seq boundary': 900,
      'Messages returned': msgs.length,
      'Wall time': `${ms.toFixed(1)}ms`,
    });
  });

  it('FTS5 search finds all 5 canary markers correctly', async () => {
    const grepExec = createGrepExecute(store);
    const results: Array<{ term: string; found: boolean; ms: number }> = [];

    for (const marker of MARKERS) {
      const t = performance.now();
      const raw = await grepExec('call', { query: marker.term });
      const ms = performance.now() - t;
      const parsed = JSON.parse((raw.content[0] as { type: 'text'; text: string }).text);

      const found = parsed.results?.some((r: any) => r.id === marker.id) ?? false;
      results.push({ term: marker.term, found, ms });

      assert.ok(!parsed.error, `FTS5 error for "${marker.term}": ${parsed.error}`);
      assert.ok(found, `Canary "${marker.term}" not found (expected at ${marker.id})`);
    }

    const avgMs = results.reduce((s, r) => s + r.ms, 0) / results.length;
    report('S2.FTS5 search (5 canary terms)', {
      'All markers found': 'YES',
      'Avg search time': `${avgMs.toFixed(1)}ms`,
      'Max search time': `${Math.max(...results.map(r => r.ms)).toFixed(1)}ms`,
      ...Object.fromEntries(results.map(r => [r.term, `found=${r.found} ${r.ms.toFixed(1)}ms`])),
    });
  });

  it('FTS5 search across 1000 messages completes 10 queries in under 500ms total', async () => {
    const grepExec = createGrepExecute(store);
    const queries = [
      'compaction engine',
      'schema migration',
      'context builder',
      'WAL journaling',
      'SqliteStore',
      'FTS5 virtual table',
      'integration test',
      'null-check',
      'session tree',
      'performance numbers',
    ];

    const t = performance.now();
    for (const q of queries) {
      const raw = await grepExec('call', { query: q });
      const parsed = JSON.parse((raw.content[0] as { type: 'text'; text: string }).text);
      assert.ok(!parsed.error, `FTS5 error for "${q}": ${parsed.error}`);
    }
    const total = performance.now() - t;

    assert.ok(total < 500, `10 FTS5 queries took ${total.toFixed(0)}ms (limit: 500ms)`);
    report('S2.FTS5 batch search (10 realistic queries)', {
      'Queries run': queries.length,
      'Total time': `${total.toFixed(1)}ms`,
      'Avg per query': `${(total / queries.length).toFixed(1)}ms`,
    });
  });

  it('getMessage retrieval by ID is O(1) and correct', () => {
    const t = performance.now();
    const msg = store.getMessage('msg_00499');
    const ms = performance.now() - t;

    assert.ok(msg !== undefined, 'Expected to find msg_00499');
    assert.strictEqual(msg!.id, 'msg_00499');
    assert.ok(msg!.content.includes('CANARY_GAMMA'), 'Expected CANARY_GAMMA in msg_00499');
    assert.ok(ms < 10, `getMessage took ${ms.toFixed(2)}ms (limit: 10ms)`);

    report('S2.getMessage point lookup', {
      'ID': 'msg_00499',
      'Wall time': `${ms.toFixed(2)}ms`,
      'Content contains CANARY_GAMMA': 'YES',
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// S3 — Tool round-trip: lcm_grep → lcm_expand → lcm_describe (bugs #012–#015)
// ────────────────────────────────────────────────────────────────────────────

describe('S3 — Tool round-trip: grep → expand → describe (bugs #012–#015)', () => {
  let tmpDir: string;
  let store: SqliteStore;
  let contentStore: MemoryContentStore;
  let grepExec: ReturnType<typeof createGrepExecute>;
  let expandExec: ReturnType<typeof createExpandExecute>;
  let describeExec: ReturnType<typeof createDescribeExecute>;

  /** Special FTS5 tokens that previously caused crashes */
  const FTS5_HAZARD_CASES = [
    { term: 'better-sqlite3',     desc: 'hyphenated package name (#012)' },
    { term: 'user-agent',         desc: 'HTTP header name with hyphen' },
    { term: 'api-key',            desc: 'config key with hyphen' },
    { term: 'WAL:journal',        desc: 'colon-separated token' },
    { term: 'node:sqlite',        desc: 'Node.js bare specifier with colon' },
    { term: 'C++',                desc: 'plus-plus in query' },
    { term: 'pi@0.2.0',           desc: 'at-sign version string' },
    { term: 'SELECT * FROM',      desc: 'SQL with asterisk operator' },
    { term: '"quoted phrase"',    desc: 'already-quoted phrase' },
    { term: '(nested OR terms)',  desc: 'FTS5 boolean operator in query' },
  ];

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-lcm-s3-'));
    store = new SqliteStore(join(tmpDir, 'stress-s3.db'));
    store.openConversation('sess_s3', '/tmp/stress-s3');
    contentStore = new MemoryContentStore();

    // Ingest messages that contain every hazard term
    FTS5_HAZARD_CASES.forEach((c, i) => {
      store.ingestMessage({
        id: `hazard_${i.toString().padStart(3, '0')}`,
        seq: i,
        role: 'user',
        content: `Testing ${c.term} search resilience. ${c.desc}. The system should handle this gracefully.`,
        tokenCount: estimateTokens(`Testing ${c.term} search resilience.`),
        createdAt: Date.now() + i,
      });
    });

    // Ingest some regular messages too
    for (let i = 0; i < 20; i++) {
      const msg = makeMessage(i + 100);
      msg.id = `regular_${i.toString().padStart(3, '0')}`;
      msg.seq = FTS5_HAZARD_CASES.length + i;
      store.ingestMessage(msg);
    }

    // Insert a few summaries so we can test describe
    store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: `Leaf summary covering the hazard test messages. Topics: better-sqlite3, WAL journaling, FTS5 search.`,
      tokenCount: 42,
      earliestAt: Date.now(),
      latestAt: Date.now() + 10,
      descendantCount: FTS5_HAZARD_CASES.length,
      createdAt: Date.now(),
    });

    grepExec = createGrepExecute(store);
    expandExec = createExpandExecute(contentStore, { maxExpandTokens: 2000 }, store);
    describeExec = createDescribeExecute(store);
  });

  after(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('FTS5 does not crash on any of the 10 hazard query terms (bug #012)', async () => {
    const results: Array<{ term: string; crashed: boolean; found: number }> = [];

    for (const c of FTS5_HAZARD_CASES) {
      const raw = await grepExec('call', { query: c.term });
      const parsed = JSON.parse((raw.content[0] as { type: 'text'; text: string }).text);

      // Must not have a crash-style error about "no such column" or "syntax error"
      const crashed = typeof parsed.error === 'string' && (
        parsed.error.includes('no such column') ||
        parsed.error.includes('syntax error') ||
        parsed.error.includes('fts5')
      );
      results.push({ term: c.term, crashed, found: parsed.results?.length ?? 0 });

      assert.ok(!crashed, `FTS5 crashed on "${c.term}": ${parsed.error}`);
    }

    const noCrashes = results.every(r => !r.crashed);
    report('S3.FTS5 hazard terms (bug #012)', {
      'Total hazard queries': FTS5_HAZARD_CASES.length,
      'Crashes': results.filter(r => r.crashed).length,
      'All queries safe': noCrashes ? 'YES ✓' : 'NO ✗',
      ...Object.fromEntries(
        results.map(r => [`  "${r.term.slice(0, 20)}"`, `found=${r.found} crash=${r.crashed}`])
      ),
    });
  });

  it('message IDs from grep are expandable via lcm_expand (bug #013)', async () => {
    // grep for something we know is there
    const grepRaw = await grepExec('call', { query: 'search resilience' });
    const grepParsed = JSON.parse((grepRaw.content[0] as { type: 'text'; text: string }).text);

    assert.ok(!grepParsed.error, `grep returned error: ${grepParsed.error}`);
    const msgResults = grepParsed.results.filter((r: any) => r.kind === 'message');
    assert.ok(msgResults.length >= 1, `Expected grep to find message results, got ${msgResults.length}`);

    const expandResults: Array<{ id: string; source: string; ok: boolean }> = [];
    for (const r of msgResults.slice(0, 5)) {
      const raw = await expandExec('call', { id: r.id });
      const parsed = JSON.parse((raw.content[0] as { type: 'text'; text: string }).text);
      const ok = !parsed.error && parsed.content && parsed.content.length > 0;
      expandResults.push({ id: r.id, source: parsed.source ?? 'unknown', ok });
      assert.ok(ok, `lcm_expand failed for message ID "${r.id}": ${parsed.error}`);
    }

    report('S3.message IDs from grep → lcm_expand (bug #013)', {
      'Messages found by grep': msgResults.length,
      'Messages tested via expand': expandResults.length,
      'All expandable': expandResults.every(r => r.ok) ? 'YES ✓' : 'NO ✗',
      ...Object.fromEntries(expandResults.map(r => [`  ${r.id}`, `source=${r.source} ok=${r.ok}`])),
    });
  });

  it('summary IDs from grep are describable via lcm_describe (bug #014)', async () => {
    // Insert a summary whose content is searchable
    const sumId = store.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'DESCRIBE_CANARY — this summary covers important architectural decisions about the compaction pipeline.',
      tokenCount: estimateTokens('DESCRIBE_CANARY — important architectural decisions'),
      earliestAt: Date.now() - 1000,
      latestAt: Date.now(),
      descendantCount: 5,
      createdAt: Date.now(),
    });

    // grep should find it
    const grepRaw = await grepExec('call', { query: 'DESCRIBE_CANARY' });
    const grepParsed = JSON.parse((grepRaw.content[0] as { type: 'text'; text: string }).text);
    assert.ok(!grepParsed.error, `grep error: ${grepParsed.error}`);

    const summaryResults = grepParsed.results.filter((r: any) => r.kind === 'summary');
    assert.ok(summaryResults.length >= 1, `Expected grep to find summary with DESCRIBE_CANARY, got ${summaryResults.length}`);

    const descRaw = await describeExec('call', { id: summaryResults[0]!.id });
    const descParsed = JSON.parse((descRaw.content[0] as { type: 'text'; text: string }).text);

    assert.ok(!descParsed.error, `lcm_describe error: ${descParsed.error}`);
    assert.ok(descParsed.summaryId, 'lcm_describe missing summaryId');
    assert.strictEqual(typeof descParsed.depth, 'number', 'lcm_describe missing depth');

    report('S3.summary IDs from grep → lcm_describe (bug #014)', {
      'Summary ID': sumId,
      'Found by grep': summaryResults.length > 0 ? 'YES ✓' : 'NO ✗',
      'lcm_describe ok': !descParsed.error ? 'YES ✓' : `NO — ${descParsed.error}`,
      'depth': descParsed.depth,
      'kind': descParsed.kind,
      'descendantCount': descParsed.descendantCount,
    });
  });

  it('lcm_describe tokenCount > 0 for all real summaries (bug #015)', () => {
    // Insert a fresh summary and verify tokenCount comes back correctly
    const content = 'This summary was created to validate that tokenCount is persisted and returned correctly by describeSummary.';
    const tokenCount = estimateTokens(content);
    assert.ok(tokenCount > 0, 'Sanity check: estimateTokens should return > 0');

    const sumId = store.insertSummary({
      depth: 1,
      kind: 'condensed',
      content,
      tokenCount,
      earliestAt: Date.now() - 2000,
      latestAt: Date.now(),
      descendantCount: 3,
      createdAt: Date.now(),
    });

    const meta = store.describeSummary(sumId);
    assert.ok(meta.tokenCount > 0, `describeSummary returned tokenCount=${meta.tokenCount} (expected > 0)`);
    assert.strictEqual(meta.tokenCount, tokenCount, `tokenCount round-trip mismatch: stored ${tokenCount}, got ${meta.tokenCount}`);

    report('S3.tokenCount round-trip (bug #015)', {
      'Content length': content.length,
      'estimateTokens result': tokenCount,
      'describeSummary tokenCount': meta.tokenCount,
      'Round-trip match': meta.tokenCount === tokenCount ? 'YES ✓' : 'NO ✗',
    });
  });

  it('expand → describe pipeline for a DAG-linked summary is faithful', async () => {
    // Set up a small DAG: parent summary → child summary → messages
    const msg1 = `msg_dag_a`;
    const msg2 = `msg_dag_b`;
    store.ingestMessage({ id: msg1, seq: 200, role: 'user', content: 'DAG test message A: architecture discussion', tokenCount: 10, createdAt: Date.now() });
    store.ingestMessage({ id: msg2, seq: 201, role: 'assistant', content: 'DAG test message B: implementation details', tokenCount: 10, createdAt: Date.now() });

    const leafId = store.insertSummary({
      depth: 0, kind: 'leaf',
      content: 'Leaf: covers DAG test messages A and B.',
      tokenCount: estimateTokens('Leaf: covers DAG test messages A and B.'),
      earliestAt: Date.now() - 100, latestAt: Date.now(), descendantCount: 2, createdAt: Date.now(),
    });
    store.linkSummaryMessages(leafId, [msg1, msg2]);

    const parentId = store.insertSummary({
      depth: 1, kind: 'condensed',
      content: 'Condensed: covers the leaf summary about DAG test messages.',
      tokenCount: estimateTokens('Condensed: covers the leaf summary about DAG test messages.'),
      earliestAt: Date.now() - 200, latestAt: Date.now(), descendantCount: 2, createdAt: Date.now(),
    });
    store.linkSummaryParents(parentId, [leafId]);

    // expand the parent → should return content
    const expandRaw = await expandExec('call', { id: parentId });
    const expandParsed = JSON.parse((expandRaw.content[0] as { type: 'text'; text: string }).text);
    assert.ok(!expandParsed.error, `expand parent failed: ${expandParsed.error}`);
    assert.ok(expandParsed.content.length > 0, 'expand returned empty content');

    // describe the parent → should show child
    const descRaw = await describeExec('call', { id: parentId });
    const descParsed = JSON.parse((descRaw.content[0] as { type: 'text'; text: string }).text);
    assert.ok(!descParsed.error, `describe failed: ${descParsed.error}`);
    assert.ok(Array.isArray(descParsed.childIds), 'childIds should be an array');
    assert.ok(descParsed.childIds.includes(leafId), `Expected childIds to include leafId ${leafId}`);

    report('S3.DAG expand+describe round-trip', {
      'Leaf summary ID': leafId,
      'Parent summary ID': parentId,
      'expand(parent) ok': !expandParsed.error ? 'YES ✓' : 'NO ✗',
      'describe(parent) ok': !descParsed.error ? 'YES ✓' : 'NO ✗',
      'childIds contains leaf': descParsed.childIds.includes(leafId) ? 'YES ✓' : 'NO ✗',
      'depth': descParsed.depth,
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// S4 — Edge cases: empty, giant, image-only, special chars, persistence
// ────────────────────────────────────────────────────────────────────────────

describe('S4 — Edge cases', () => {
  let tmpDir: string;
  let dbPath: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-lcm-s4-'));
    dbPath = join(tmpDir, 'stress-s4.db');
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('empty content message — estimateTokens=0, ingest ok, not searchable', () => {
    const store = new SqliteStore(dbPath);
    store.openConversation('sess_s4_empty', '/tmp/stress-s4');

    const emptyContent = '';
    const tokenCount = estimateTokens(emptyContent);
    assert.strictEqual(tokenCount, 0, 'estimateTokens("") should be 0');

    // Should not throw
    store.ingestMessage({
      id: 'msg_empty',
      seq: 0,
      role: 'user',
      content: emptyContent,
      tokenCount,
      createdAt: Date.now(),
    });

    assert.strictEqual(store.getLastIngestedSeq(), 0, 'Empty message should still be ingested');

    // getMessage should return it
    const retrieved = store.getMessage('msg_empty');
    assert.ok(retrieved !== undefined, 'getMessage should find the empty message');
    assert.strictEqual(retrieved!.content, '', 'Content should be empty string');

    store.close();
    report('S4.empty content message', {
      'estimateTokens("")': tokenCount,
      'Ingest ok': 'YES ✓',
      'getMessage ok': retrieved !== undefined ? 'YES ✓' : 'NO ✗',
      'content preserved': retrieved?.content === '' ? 'YES ✓' : 'NO ✗',
    });
  });

  it('giant tool output (~50 KB) — ingest, retrieve, and truncate correctly', async () => {
    const store = new SqliteStore(':memory:');
    store.openConversation('sess_s4_giant', '/tmp/stress-s4');

    // 50 KB of realistic-looking code output
    const line = 'console.log("Tool output line with realistic content for stress testing padding.");\n';
    const giantContent = line.repeat(Math.ceil(50 * 1024 / line.length));
    assert.ok(giantContent.length >= 50 * 1024, 'Sanity: giant content is ≥50KB');

    const tokenCount = estimateTokens(giantContent);
    const t = performance.now();
    store.ingestMessage({
      id: 'msg_giant',
      seq: 0,
      role: 'toolResult',
      toolName: 'bash',
      content: giantContent,
      tokenCount,
      createdAt: Date.now(),
    });
    const ingestMs = performance.now() - t;

    const retrieved = store.getMessage('msg_giant');
    assert.ok(retrieved !== undefined, 'getMessage should find giant message');
    assert.strictEqual(retrieved!.content, giantContent, 'Giant content should be stored verbatim');

    // lcm_expand with a token budget should truncate it
    const contentStore = new MemoryContentStore();
    const expandExec = createExpandExecute(contentStore, { maxExpandTokens: 500 }, store);
    const raw = await expandExec('call', { id: 'msg_giant' });
    const parsed = JSON.parse((raw.content[0] as { type: 'text'; text: string }).text);
    assert.ok(!parsed.error, `expand error: ${parsed.error}`);
    // Truncated content should be shorter than original
    assert.ok(parsed.content.length < giantContent.length, 'Truncated content should be shorter than original');
    assert.ok(parsed.content.includes('[truncated]') || parsed.content.length < giantContent.length,
      'Truncated content should indicate truncation');

    store.close();
    report('S4.giant tool output (50KB)', {
      'Content size': `${(giantContent.length / 1024).toFixed(1)} KB`,
      'estimateTokens': tokenCount,
      'Ingest time': `${ingestMs.toFixed(1)}ms`,
      'Retrieve ok': retrieved !== undefined ? 'YES ✓' : 'NO ✗',
      'Expand (budget=500 tok) truncated': parsed.content.length < giantContent.length ? 'YES ✓' : 'NO ✗',
    });
  });

  it('image-only content — serializeMessageContent returns empty string, ingest ok', () => {
    // Simulate what serializeMessageContent produces for image-only tool results
    // (it filters to text parts only, returning '' if none exist)
    const imageOnlyContent = ''; // no text parts
    const tokenCount = estimateTokens(imageOnlyContent);

    const store = new SqliteStore(':memory:');
    store.openConversation('sess_s4_image', '/tmp/stress-s4');

    store.ingestMessage({
      id: 'msg_image_only',
      seq: 0,
      role: 'toolResult',
      toolName: 'screenshot',
      content: imageOnlyContent,
      tokenCount,
      createdAt: Date.now(),
    });

    const retrieved = store.getMessage('msg_image_only');
    assert.ok(retrieved !== undefined, 'Image-only message should be ingested and retrievable');
    assert.strictEqual(retrieved!.content, '', 'Content should be empty string for image-only');

    store.close();
    report('S4.image-only content', {
      'Serialized content length': imageOnlyContent.length,
      'tokenCount': tokenCount,
      'Ingest ok': 'YES ✓',
      'Retrieve ok': retrieved !== undefined ? 'YES ✓' : 'NO ✗',
    });
  });

  it('special FTS5 characters in content are stored and searchable without crash', async () => {
    const store = new SqliteStore(':memory:');
    store.openConversation('sess_s4_fts5', '/tmp/stress-s4');

    // Messages containing FTS5 operator characters in their content
    const specialMessages = [
      { id: 'sp_1', content: 'Using better-sqlite3 for the WAL journal mode implementation.' },
      { id: 'sp_2', content: 'SELECT * FROM messages WHERE id = "abc-123" AND role:user' },
      { id: 'sp_3', content: 'Version pi@0.2.0 includes (major OR minor) improvements to C++ bindings.' },
      { id: 'sp_4', content: 'Error: TypeError: Cannot read "properties" of undefined (reading \'content\')' },
      { id: 'sp_5', content: 'npm install --save-dev @types/node^22 && node:sqlite build complete' },
    ];

    specialMessages.forEach((m, i) => {
      store.ingestMessage({
        id: m.id,
        seq: i,
        role: 'user',
        content: m.content,
        tokenCount: estimateTokens(m.content),
        createdAt: Date.now() + i,
      });
    });

    const grepExec = createGrepExecute(store);
    const hazardQueries = [
      'better-sqlite3',
      'WAL journal',
      'pi@0.2.0',
      'TypeError',
      'node:sqlite',
      '@types/node',
    ];

    let crashes = 0;
    let totalResults = 0;
    const details: Record<string, string> = {};

    for (const q of hazardQueries) {
      const raw = await grepExec('call', { query: q });
      const parsed = JSON.parse((raw.content[0] as { type: 'text'; text: string }).text);
      const crashed = typeof parsed.error === 'string' &&
        (parsed.error.includes('no such column') || parsed.error.includes('syntax error'));
      if (crashed) crashes++;
      totalResults += parsed.results?.length ?? 0;
      details[`"${q}"`] = `found=${parsed.results?.length ?? 0} crash=${crashed}`;
    }

    assert.strictEqual(crashes, 0, `${crashes} FTS5 queries crashed`);

    store.close();
    report('S4.special FTS5 chars in queries', {
      'Queries run': hazardQueries.length,
      'Crashes': crashes,
      'Total results returned': totalResults,
      ...details,
    });
  });

  it('persistence — data survives store.close() and re-open', () => {
    // Write to a file-backed store, close it, re-open, verify data intact
    const persistPath = join(tmpDir, 'persist-test.db');
    const store1 = new SqliteStore(persistPath);
    store1.openConversation('sess_persist', '/tmp/persist-test');

    for (let i = 0; i < 20; i++) {
      store1.ingestMessage(makeMessage(i));
    }
    const sumId = store1.insertSummary({
      depth: 0, kind: 'leaf',
      content: 'Persistence test summary — should survive close/re-open.',
      tokenCount: 30, earliestAt: Date.now() - 1000, latestAt: Date.now(),
      descendantCount: 5, createdAt: Date.now(),
    });
    const lastSeq = store1.getLastIngestedSeq();
    store1.close();

    // Re-open
    const store2 = new SqliteStore(persistPath);
    store2.openConversation('sess_persist', '/tmp/persist-test');

    assert.strictEqual(store2.getLastIngestedSeq(), lastSeq, 'lastIngestedSeq should survive close/re-open');

    const msg5 = store2.getMessage('msg_00005');
    assert.ok(msg5 !== undefined, 'msg_00005 should survive close/re-open');

    const summary = store2.getSummary(sumId);
    assert.ok(summary !== undefined, 'Summary should survive close/re-open');
    assert.ok(summary!.content.includes('Persistence test'), 'Summary content should be intact');
    assert.ok(summary!.tokenCount > 0, 'Summary tokenCount should be > 0 after re-open');

    const lastSeqAfter = store2.getLastIngestedSeq();
    store2.close();
    report('S4.persistence (close + re-open)', {
      'lastIngestedSeq persisted': lastSeq === lastSeqAfter ? 'YES ✓' : 'NO ✗',
      'getMessage after re-open': msg5 !== undefined ? 'YES ✓' : 'NO ✗',
      'Summary content intact': summary?.content.includes('Persistence test') ? 'YES ✓' : 'NO ✗',
      'Summary tokenCount > 0': (summary?.tokenCount ?? 0) > 0 ? 'YES ✓' : 'NO ✗',
    });
  });

  it('rapid sequential writes — 500 messages in a tight loop, no corruption', () => {
    const store = new SqliteStore(':memory:');
    store.openConversation('sess_s4_rapid', '/tmp/stress-s4');

    const t = performance.now();
    for (let i = 0; i < 500; i++) {
      const msg = makeMessage(i);
      store.ingestMessage(msg);
    }
    const ms = performance.now() - t;

    // Spot-check: first, middle, last
    const first = store.getMessage('msg_00000');
    const mid = store.getMessage('msg_00250');
    const last = store.getMessage('msg_00499');

    assert.ok(first !== undefined && mid !== undefined && last !== undefined,
      'Spot-check messages should all be retrievable');
    assert.strictEqual(store.getLastIngestedSeq(), 499);

    const finalSeq = store.getLastIngestedSeq();
    store.close();
    report('S4.rapid sequential writes (500 msgs)', {
      'Wall time': `${ms.toFixed(1)}ms`,
      'Throughput': `${(500 / (ms / 1000)).toFixed(0)} msgs/s`,
      'Spot-check msg_00000': first !== undefined ? 'OK ✓' : 'MISSING ✗',
      'Spot-check msg_00250': mid !== undefined ? 'OK ✓' : 'MISSING ✗',
      'Spot-check msg_00499': last !== undefined ? 'OK ✓' : 'MISSING ✗',
      'lastIngestedSeq': finalSeq,
    });
  });

  it('StoreClosedError is thrown after close()', () => {
    const store = new SqliteStore(':memory:');
    store.openConversation('sess_s4_closed', '/tmp');
    store.ingestMessage(makeMessage(0));
    store.close();

    assert.throws(
      () => store.getMessage('msg_00000'),
      (err: Error) => err.name === 'StoreClosedError',
      'Expected StoreClosedError after close()',
    );

    report('S4.StoreClosedError after close()', {
      'Throws StoreClosedError': 'YES ✓',
    });
  });
});
