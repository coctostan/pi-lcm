/**
 * pi-lcm Live Database Inspector
 * ================================
 * Queries real LCM databases in ~/.pi/agent/lcm/ and prints a health report.
 * Usage:
 *   node --experimental-strip-types scripts/inspect-live-db.ts [dbPath...]
 *
 * If no path given, scans ~/.pi/agent/lcm/ and reports on all databases.
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LCM_DIR = join(homedir(), '.pi', 'agent', 'lcm');

// ─── Helpers ────────────────────────────────────────────────────────────────

function hr(char = '═', width = 72) { return char.repeat(width); }
function fmt(n: number) { return n.toLocaleString(); }
function fmtDate(ms: number | null) {
  if (!ms) return 'n/a';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}
function fmtSize(bytes: number) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}
function row(label: string, value: string) {
  return `║  ${label.padEnd(30)}${value.padStart(38)}  ║`;
}

// ─── Inspector ──────────────────────────────────────────────────────────────

function inspectDb(dbPath: string) {
  const sizeBytes = statSync(dbPath).size;
  const db = new DatabaseSync(dbPath, { open: true });

  console.log(`\n╔${hr()}╗`);
  const name = dbPath.split('/').pop()!.replace('.db', '');
  console.log(`║  DB: ${name.padEnd(66)}║`);
  console.log(`╠${hr()}╣`);
  console.log(row('File size', fmtSize(sizeBytes)));

  try {
    // Schema version
    const sv = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as any;
    console.log(row('Schema version', sv?.version ?? 'unknown'));

    // Conversation
    const conv = db.prepare('SELECT id, projectRoot FROM conversations LIMIT 1').get() as any;
    console.log(row('Conversation ID', conv?.id?.slice(0, 36) ?? 'n/a'));
    const root = conv?.projectRoot ?? 'n/a';
    console.log(row('Project root', root.length > 36 ? '...' + root.slice(-33) : root));

    console.log(`╠${hr('─')}╣`);

    // Messages
    const msgStats = db.prepare(`
      SELECT COUNT(*) as cnt,
             COALESCE(SUM(tokenCount), 0) as tokens,
             MIN(createdAt) as firstAt,
             MAX(createdAt) as lastAt
      FROM messages
    `).get() as any;
    console.log(row('Messages', fmt(msgStats?.cnt ?? 0)));
    console.log(row('  estimated tokens', fmt(msgStats?.tokens ?? 0)));
    console.log(row('  first at', fmtDate(msgStats?.firstAt ?? null)));
    console.log(row('  last at', fmtDate(msgStats?.lastAt ?? null)));

    // Roles breakdown
    const roles = db.prepare(`
      SELECT role, COUNT(*) as cnt FROM messages GROUP BY role
    `).all() as any[];
    for (const r of roles) {
      console.log(row(`  role:${r.role}`, fmt(r.cnt)));
    }

    console.log(`╠${hr('─')}╣`);

    // Summaries
    const sumStats = db.prepare(`
      SELECT COUNT(*) as cnt,
             COALESCE(SUM(tokenCount), 0) as tokens,
             COALESCE(MAX(depth), 0) as maxDepth
      FROM summaries
    `).get() as any;
    console.log(row('Summaries', fmt(sumStats?.cnt ?? 0)));
    console.log(row('  estimated tokens', fmt(sumStats?.tokens ?? 0)));
    console.log(row('  max depth', String(sumStats?.maxDepth ?? 0)));

    // By depth/kind
    const byDepth = db.prepare(`
      SELECT depth, kind, COUNT(*) as cnt, SUM(tokenCount) as tok
      FROM summaries GROUP BY depth, kind ORDER BY depth
    `).all() as any[];
    for (const r of byDepth) {
      console.log(row(`  d=${r.depth} ${r.kind}`, `${fmt(r.cnt)} summ  ${fmt(r.tok)} tok`));
    }

    console.log(`╠${hr('─')}╣`);

    // Context items
    const ctxTotal = db.prepare('SELECT COUNT(*) as cnt FROM context_items').get() as any;
    const ctxSumm = db.prepare("SELECT COUNT(*) as cnt FROM context_items WHERE summaryId IS NOT NULL").get() as any;
    const ctxMsg = db.prepare("SELECT COUNT(*) as cnt FROM context_items WHERE messageId IS NOT NULL").get() as any;
    console.log(row('Context items (total)', fmt(ctxTotal?.cnt ?? 0)));
    console.log(row('  → summaries', fmt(ctxSumm?.cnt ?? 0)));
    console.log(row('  → messages', fmt(ctxMsg?.cnt ?? 0)));

    console.log(`╠${hr('─')}╣`);

    // FTS5 + integrity
    let fts5Works = false;
    let ftsHits = 0;
    try {
      const r = db.prepare(`SELECT COUNT(*) as cnt FROM messages_fts WHERE messages_fts MATCH '"the"'`).get() as any;
      fts5Works = true;
      ftsHits = r?.cnt ?? 0;
    } catch {}
    console.log(row('FTS5 functional', fts5Works ? 'YES ✓' : 'NO ✗'));
    console.log(row('FTS5 hits for "the"', fmt(ftsHits)));

    const integ = db.prepare('PRAGMA integrity_check').get() as any;
    console.log(row('SQLite integrity', integ?.integrity_check === 'ok' ? 'OK ✓' : 'FAIL ✗'));

    console.log(`╚${hr()}╝`);

    // ── Detail section ──────────────────────────────────────────────────

    // 5 most recent messages
    const recentMsgs = db.prepare(`
      SELECT id, role, tokenCount, LENGTH(content) as clen,
             SUBSTR(REPLACE(content, char(10), '↵'), 1, 70) as preview
      FROM messages ORDER BY seq DESC LIMIT 5
    `).all() as any[];

    if (recentMsgs.length > 0) {
      console.log('\n  ── Recent messages (newest first) ─────────────────────────────────');
      for (const m of recentMsgs) {
        const badge = m.role.padEnd(12);
        console.log(`  [${badge}] tok=${String(m.tokenCount).padStart(5)}  len=${String(m.clen).padStart(6)}  "${m.preview}"`);
      }
    }

    // Most recent summary
    const latestSum = db.prepare(`
      SELECT summaryId, depth, kind, tokenCount, descendantCount,
             SUBSTR(REPLACE(content, char(10), '↵'), 1, 100) as preview
      FROM summaries ORDER BY createdAt DESC LIMIT 1
    `).get() as any;

    if (latestSum) {
      console.log('\n  ── Most recent summary ─────────────────────────────────────────────');
      console.log(`  id:   ${latestSum.summaryId}`);
      console.log(`  depth=${latestSum.depth}  kind=${latestSum.kind}  tokens=${latestSum.tokenCount}  descendants=${latestSum.descendantCount}`);
      console.log(`  "${latestSum.preview}..."`);
    }

    // FTS5 spot checks on real content terms
    const spotTerms = ['compaction', 'sqlite', 'function', 'error', 'test', 'stress'];
    console.log('\n  ── FTS5 spot checks ────────────────────────────────────────────────');
    let anyHits = false;
    for (const term of spotTerms) {
      try {
        const msgHits = db.prepare(`SELECT COUNT(*) as cnt FROM messages_fts WHERE messages_fts MATCH ?`)
          .get(`"${term}"`) as any;
        const sumHits = db.prepare(`SELECT COUNT(*) as cnt FROM summaries_fts WHERE summaries_fts MATCH ?`)
          .get(`"${term}"`) as any;
        if ((msgHits?.cnt ?? 0) > 0 || (sumHits?.cnt ?? 0) > 0) {
          anyHits = true;
          console.log(`  "${term}": ${msgHits?.cnt ?? 0} messages, ${sumHits?.cnt ?? 0} summaries`);
        }
      } catch (err: any) {
        console.log(`  "${term}": FTS5 error — ${err.message}`);
      }
    }
    if (!anyHits) console.log('  (no hits for spot-check terms)');

  } catch (err) {
    console.log(`╚${hr()}╝`);
    console.error(`  ✗ Error: ${err}`);
  }

  db.close();
}

// ─── Main ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let dbPaths: string[] = [];

if (args.length > 0) {
  dbPaths = args;
} else {
  const files = readdirSync(LCM_DIR);
  dbPaths = files
    .filter(f => f.endsWith('.db'))
    .map(f => join(LCM_DIR, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

console.log(`\npi-lcm Live DB Inspector  ·  ${new Date().toISOString()}`);
console.log(`Scanning: ${LCM_DIR}  (${dbPaths.length} database${dbPaths.length !== 1 ? 's' : ''})\n`);

for (const p of dbPaths) {
  inspectDb(p);
}
