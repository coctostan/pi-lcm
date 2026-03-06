#!/usr/bin/env node
/**
 * pi-lcm DB Inspector
 * Usage: node --experimental-strip-types scripts/inspect-live-db.ts <path-to.db>
 *
 * Verifies:
 *   - SQLite integrity check
 *   - Schema version
 *   - Conversations + context composition (raw msgs vs summaries)
 *   - Summary depth distribution
 *   - FTS5 functional check
 *   - large_files table entries
 */

import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: node --experimental-strip-types scripts/inspect-live-db.ts <path-to.db>');
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { open: true });
db.exec('PRAGMA foreign_keys = ON;');

function hr(label?: string) {
  const line = '─'.repeat(60);
  if (label) {
    console.log(`\n${line}`);
    console.log(`  ${label}`);
    console.log(line);
  } else {
    console.log(line);
  }
}

function row<T = Record<string, unknown>>(sql: string, ...params: (string | number | bigint | null)[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

function rows<T = Record<string, unknown>>(sql: string, ...params: (string | number | bigint | null)[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

console.log(`\npi-lcm DB Inspector`);
console.log(`DB: ${dbPath}`);

// ── Integrity ──────────────────────────────────────────────────────────────
hr('1. SQLite Integrity Check');
const integrity = row<{ integrity_check: string }>('PRAGMA integrity_check;');
const integrityResult = integrity?.integrity_check ?? 'ERROR';
const integrityOk = integrityResult === 'ok';
console.log(`  integrity_check: ${integrityOk ? '✅ ok' : `❌ ${integrityResult}`}`);

// ── Schema Version ─────────────────────────────────────────────────────────
hr('2. Schema Version');
try {
  const sv = row<{ version: string; createdAt: number }>('SELECT version, createdAt FROM schema_version LIMIT 1');
  if (sv) {
    console.log(`  version:   ${sv.version}`);
    console.log(`  createdAt: ${new Date(sv.createdAt * 1000).toISOString()} (schema_version uses epoch-seconds)`);
  } else {
    console.log('  ❌ No schema_version row found');
  }
} catch (e) {
  console.log(`  ❌ schema_version table missing: ${e}`);
}

// ── Conversations ──────────────────────────────────────────────────────────
hr('3. Conversations');
const convs = rows<{ id: string; projectRoot: string; createdAt: number }>('SELECT id, projectRoot, createdAt FROM conversations ORDER BY createdAt DESC LIMIT 5');
console.log(`  Count: ${convs.length}`);
for (const c of convs) {
  console.log(`  • ${c.id.slice(0, 8)}…  root=${c.projectRoot}  started=${new Date(c.createdAt).toISOString()}`);
}

// ── Messages ───────────────────────────────────────────────────────────────
hr('4. Messages');
const msgCount = row<{ n: number }>('SELECT COUNT(*) AS n FROM messages')?.n ?? 0;
const msgTokens = row<{ t: number }>('SELECT SUM(tokenCount) AS t FROM messages')?.t ?? 0;
const roleBreakdown = rows<{ role: string; n: number }>('SELECT role, COUNT(*) AS n FROM messages GROUP BY role ORDER BY n DESC');
console.log(`  Total rows:   ${msgCount}`);
console.log(`  Total tokens: ${msgTokens}`);
console.log(`  By role:`);
for (const r of roleBreakdown) {
  console.log(`    ${r.role}: ${r.n}`);
}

// ── Summaries ──────────────────────────────────────────────────────────────
hr('5. Summaries');
const summaryCount = row<{ n: number }>('SELECT COUNT(*) AS n FROM summaries')?.n ?? 0;
const summaryTokens = row<{ t: number }>('SELECT SUM(tokenCount) AS t FROM summaries')?.t ?? 0;
console.log(`  Total rows:   ${summaryCount}`);
console.log(`  Total tokens: ${summaryTokens}`);

const byDepth = rows<{ depth: number; kind: string; n: number; avgTokens: number }>(
  'SELECT depth, kind, COUNT(*) AS n, AVG(tokenCount) AS avgTokens FROM summaries GROUP BY depth, kind ORDER BY depth, kind'
);
if (byDepth.length > 0) {
  console.log(`  Depth × Kind breakdown:`);
  for (const d of byDepth) {
    console.log(`    depth=${d.depth}  kind=${d.kind}  count=${d.n}  avgTokens=${Math.round(d.avgTokens)}`);
  }
} else {
  console.log('  (no summaries yet)');
}

// ── Context Composition ────────────────────────────────────────────────────
hr('6. Context Composition (context_items)');
const ctxCount = row<{ n: number }>('SELECT COUNT(*) AS n FROM context_items')?.n ?? 0;
const ctxMessages = row<{ n: number }>('SELECT COUNT(*) AS n FROM context_items WHERE messageId IS NOT NULL')?.n ?? 0;
const ctxSummaries = row<{ n: number }>('SELECT COUNT(*) AS n FROM context_items WHERE summaryId IS NOT NULL')?.n ?? 0;
console.log(`  Total context items: ${ctxCount}`);
console.log(`    Raw messages:  ${ctxMessages}`);
console.log(`    Summaries:     ${ctxSummaries}`);
const compressionPct = ctxCount > 0 ? ((ctxSummaries / ctxCount) * 100).toFixed(1) : '0.0';
console.log(`  Compression ratio:   ${compressionPct}% summary-backed`);

// ── FTS5 Check ─────────────────────────────────────────────────────────────
hr('7. FTS5 Functional Check');
try {
  // messages_fts
  row(`SELECT * FROM messages_fts('test') LIMIT 1`);
  console.log(`  messages_fts:   ✅ functional`);
} catch (e: any) {
  if (e.message?.includes('no rows')) {
    console.log(`  messages_fts:   ✅ functional (no hits for "test")`);
  } else {
    console.log(`  messages_fts:   ❌ ${e.message}`);
  }
}
try {
  row(`SELECT * FROM summaries_fts('test') LIMIT 1`);
  console.log(`  summaries_fts:  ✅ functional`);
} catch (e: any) {
  if (e.message?.includes('no rows')) {
    console.log(`  summaries_fts:  ✅ functional (no hits for "test")`);
  } else {
    console.log(`  summaries_fts:  ❌ ${e.message}`);
  }
}

// FTS5 integrity-check command (read-only validation)
try {
  db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run();
  console.log(`  messages_fts integrity-check: ✅ passed`);
} catch (e: any) {
  console.log(`  messages_fts integrity-check: ❌ ${e.message}`);
}

// ── Large Files ────────────────────────────────────────────────────────────
hr('8. Large Files');
const lfCount = row<{ n: number }>('SELECT COUNT(*) AS n FROM large_files')?.n ?? 0;
console.log(`  Total entries: ${lfCount}`);
if (lfCount > 0) {
  const lfs = rows<{ fileId: string; path: string; tokenCount: number; capturedAt: number; storagePath: string }>(
    'SELECT fileId, path, tokenCount, capturedAt, storagePath FROM large_files ORDER BY capturedAt DESC'
  );
  for (const lf of lfs) {
    console.log(`  • ${lf.fileId.slice(0, 8)}…  tokens=${lf.tokenCount}  path=${lf.path}`);
    console.log(`    stored: ${lf.storagePath}`);
    console.log(`    at:     ${new Date(lf.capturedAt).toISOString()}`);
  }
} else {
  console.log('  (no large file interceptions recorded)');
}

// ── Summary ────────────────────────────────────────────────────────────────
hr('Summary');
const allOk = integrityOk;
console.log(`  integrity:   ${integrityOk ? '✅' : '❌'}`);
console.log(`  messages:    ${msgCount} rows, ${msgTokens} tokens`);
console.log(`  summaries:   ${summaryCount} rows, ${summaryTokens} tokens`);
console.log(`  context:     ${ctxCount} items (${ctxMessages} raw, ${ctxSummaries} summarized)`);
console.log(`  large_files: ${lfCount} entries`);
console.log(`\n  ${allOk ? '✅ DB looks healthy' : '❌ Issues detected — review above'}`);
hr();

db.close();
