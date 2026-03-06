import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type {
  ContextItem,
  GrepResult,
  IngestableMessage,
  LargeFileInsert,
  StoredLargeFile,
  StoredMessage,
  Store,
  StoredSummary,
  SummaryInsert,
  SummaryMeta,
} from './types.ts';
import { StoreClosedError } from './types.ts';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';
import { estimateTokens } from '../summarizer/token-estimator.ts';
import { debugLog } from '../debug.ts';

function isMemoryPath(path: string): boolean {
  return path === ':memory:';
}
/**
 * Wrap each whitespace-delimited token in double quotes so FTS5 treats
 * them as phrase literals — preventing operators like `-`, `:`, `*`, `^`
 * from being interpreted. Embedded double-quotes are escaped by doubling.
 */
function sanitizeFts5Query(pattern: string): string {
  const tokens = pattern.trim().split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) return '""';
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private closed = false;
  private conversationId: string | null = null;

  constructor(path: string) {
    this.db = new DatabaseSync(path);

    // Always-on pragmas.
    this.db.exec('PRAGMA foreign_keys = ON;');

    // Enable WAL for file-based DBs.
    if (!isMemoryPath(path)) {
      this.db.exec('PRAGMA journal_mode = WAL;');
      const row = this.db.prepare('PRAGMA journal_mode;').get() as any;
      if (row.journal_mode !== 'wal') {
        throw new Error(`Expected journal_mode=wal, got ${row.journal_mode}`);
      }
    }

    this.ensureSchema();
  }

  private assertOpen(): void {
    if (this.closed) throw new StoreClosedError();
  }

  private requireConversationId(): string {
    if (this.conversationId === null) throw new Error('No active conversation. Call openConversation() first.');
    return this.conversationId;
  }

  private ensureSchema(): void {
    const hasSchemaVersion =
      (this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'")
        .get() as any) !== undefined;

    if (hasSchemaVersion) {
      try {
        const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as any;
        if (row?.version !== SCHEMA_VERSION) {
          console.warn(`pi-lcm: sqlite schema version mismatch (${row?.version} != ${SCHEMA_VERSION}), recreating`);
          this.recreateSchema();
          return;
        }
        // Version matches -- schema is already correct, skip re-applying.
        return;
      } catch {
        // If schema_version is malformed, recreate.
        console.warn('pi-lcm: sqlite schema_version unreadable, recreating');
        this.recreateSchema();
        return;
      }
    }

    // Either missing or matches; apply schema (idempotent).
    this.db.exec(SCHEMA_SQL);
  }

  private recreateSchema(): void {
    // Drop known objects. (DB is a rebuildable cache.)
    this.db.exec('PRAGMA foreign_keys = OFF;');

    // Drop triggers first.
    this.db.exec(`
      DROP TRIGGER IF EXISTS messages_ai;
      DROP TRIGGER IF EXISTS messages_ad;
      DROP TRIGGER IF EXISTS messages_au;
      DROP TRIGGER IF EXISTS summaries_ai;
      DROP TRIGGER IF EXISTS summaries_ad;
      DROP TRIGGER IF EXISTS summaries_au;
    `);

    // Drop FTS virtual tables.
    this.db.exec(`
      DROP TABLE IF EXISTS messages_fts;
      DROP TABLE IF EXISTS summaries_fts;
    `);

    // Drop tables.
    this.db.exec(`
      DROP TABLE IF EXISTS large_files;
      DROP TABLE IF EXISTS context_items;
      DROP TABLE IF EXISTS summary_parents;
      DROP TABLE IF EXISTS summary_messages;
      DROP TABLE IF EXISTS summaries;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS conversations;
      DROP TABLE IF EXISTS schema_version;
    `);

    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA_SQL);
  }

  openConversation(sessionId: string, projectRoot: string): void {
    this.assertOpen();
    this.conversationId = sessionId;

    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO conversations(id, projectRoot, createdAt)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(sessionId, projectRoot, createdAt);
  }

  ingestMessage(msg: IngestableMessage): void {
    this.assertOpen();
    const conversationId = this.requireConversationId();

    this.db
      .prepare(
        `INSERT INTO messages(id, conversationId, seq, role, toolName, content, tokenCount, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           conversationId=excluded.conversationId,
           seq=excluded.seq,
           role=excluded.role,
           toolName=excluded.toolName,
           content=excluded.content,
           tokenCount=excluded.tokenCount,
           createdAt=excluded.createdAt`
      )
      .run(
        msg.id,
        conversationId,
        msg.seq,
        msg.role,
        msg.toolName ?? null,
        msg.content,
        msg.tokenCount,
        msg.createdAt
      );
  }

  getMessagesAfter(seq: number): StoredMessage[] {
    this.assertOpen();
    const conversationId = this.requireConversationId();

    const rows = this.db
      .prepare(
        `SELECT id, conversationId, seq, role, toolName, content, tokenCount, createdAt
         FROM messages
         WHERE conversationId = ? AND seq > ?
         ORDER BY seq ASC`
      )
      .all(conversationId, seq) as any[];

    return rows.map(r => ({
      id: r.id,
      conversationId: r.conversationId,
      seq: r.seq,
      role: r.role,
      toolName: r.toolName ?? undefined,
      content: r.content,
      tokenCount: r.tokenCount,
      createdAt: r.createdAt,
    }));
  }

  getMessage(id: string): StoredMessage | undefined {
    this.assertOpen();
    const conversationId = this.requireConversationId();

    const row = this.db
      .prepare(
        `SELECT id, conversationId, seq, role, toolName, content, tokenCount, createdAt
         FROM messages
         WHERE conversationId = ? AND id = ?`
      )
      .get(conversationId, id) as any;

    if (!row) return undefined;

    return {
      id: row.id,
      conversationId: row.conversationId,
      seq: row.seq,
      role: row.role,
      toolName: row.toolName ?? undefined,
      content: row.content,
      tokenCount: row.tokenCount,
      createdAt: row.createdAt,
    };
  }

  getLastIngestedSeq(): number {
    this.assertOpen();
    const conversationId = this.requireConversationId();

    const row = this.db
      .prepare('SELECT MAX(seq) AS maxSeq FROM messages WHERE conversationId = ?')
      .get(conversationId) as any;

    return row.maxSeq === null || row.maxSeq === undefined ? -1 : row.maxSeq;
  }

  insertSummary(summary: SummaryInsert): string {
    this.assertOpen();
    const conversationId = this.requireConversationId();

    const summaryId = randomUUID();
    // Always compute tokenCount from content — do not trust caller-provided values.
    const tokenCount = estimateTokens(summary.content);
    debugLog('store insertSummary preparing', {
      depth: summary.depth,
      kind: summary.kind,
      inputTokenCount: summary.tokenCount,
      computedTokenCount: tokenCount,
      contentChars: summary.content.length,
      contentPreview: summary.content.slice(0, 120),
    });
    this.db
      .prepare(
        `INSERT INTO summaries(summaryId, conversationId, depth, kind, content, tokenCount, earliestAt, latestAt, descendantCount, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        summaryId,
        conversationId,
        summary.depth,
        summary.kind,
        summary.content,
        tokenCount,
        summary.earliestAt,
        summary.latestAt,
        summary.descendantCount,
        summary.createdAt
      );
    const verifyRow = this.db
      .prepare('SELECT tokenCount, length(content) AS contentLen FROM summaries WHERE summaryId = ?')
      .get(summaryId) as any;
    debugLog('store insertSummary persisted', {
      summaryId,
      depth: summary.depth,
      kind: summary.kind,
      persistedTokenCount: verifyRow?.tokenCount ?? null,
      persistedContentLen: verifyRow?.contentLen ?? null,
    });

    return summaryId;
  }

  getSummary(summaryId: string): StoredSummary | undefined {
    this.assertOpen();

    const row = this.db
      .prepare(
        `SELECT summaryId, conversationId, depth, kind, content, tokenCount, earliestAt, latestAt, descendantCount, createdAt
         FROM summaries
         WHERE summaryId = ?`
      )
      .get(summaryId) as any;

    if (!row) return undefined;

    return {
      summaryId: row.summaryId,
      conversationId: row.conversationId,
      depth: row.depth,
      kind: row.kind,
      content: row.content,
      tokenCount: row.tokenCount,
      earliestAt: row.earliestAt,
      latestAt: row.latestAt,
      descendantCount: row.descendantCount,
      createdAt: row.createdAt,
    };
  }

  linkSummaryMessages(summaryId: string, messageIds: string[]): void {
    this.assertOpen();

    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO summary_messages(summaryId, messageId) VALUES (?, ?)'
    );
    for (const messageId of messageIds) {
      stmt.run(summaryId, messageId);
    }
  }

  linkSummaryParents(parentId: string, childIds: string[]): void {
    this.assertOpen();

    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO summary_parents(childSummaryId, parentSummaryId) VALUES (?, ?)'
    );
    for (const childId of childIds) {
      stmt.run(childId, parentId);
    }
  }

  getSummaryChildIds(parentId: string): string[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        `SELECT childSummaryId
         FROM summary_parents
         WHERE parentSummaryId = ?
         ORDER BY rowid ASC`
      )
      .all(parentId) as Array<{ childSummaryId: string }>;

    return rows.map(row => row.childSummaryId);
  }

  getContextItems(): ContextItem[] {
    this.assertOpen();
    const conversationId = this.requireConversationId();

    const rows = this.db
      .prepare(
        `SELECT ordinal, messageId, summaryId
         FROM context_items
         WHERE conversationId = ?
         ORDER BY ordinal ASC`
      )
      .all(conversationId) as any[];

    return rows.map(r => {
      if (r.messageId !== null && r.messageId !== undefined) return { kind: 'message', messageId: r.messageId };
      return { kind: 'summary', summaryId: r.summaryId };
    });
  }

  replaceContextItems(items: ContextItem[]): void {
    this.assertOpen();
    const conversationId = this.requireConversationId();

    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM context_items WHERE conversationId = ?').run(conversationId);

      const insert = this.db.prepare(
        `INSERT INTO context_items(conversationId, ordinal, messageId, summaryId)
         VALUES (?, ?, ?, ?)`
      );

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        insert.run(
          conversationId,
          i,
          item.kind === 'message' ? item.messageId : null,
          item.kind === 'summary' ? item.summaryId : null
        );
      }

      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  expandSummary(summaryId: string): string {
    this.assertOpen();
    const row = this.db.prepare('SELECT content FROM summaries WHERE summaryId = ?').get(summaryId) as any;
    if (!row) throw new Error(`Summary not found: ${summaryId}`);
    debugLog('store expandSummary hit', {
      summaryId,
      contentLen: typeof row.content === 'string' ? row.content.length : 0,
    });
    return row.content;
  }

  grepMessages(pattern: string, mode: 'fulltext' | 'regex'): GrepResult[] {
    this.assertOpen();
    const conversationId = this.requireConversationId();

    if (mode === 'fulltext') {
      const sanitized = sanitizeFts5Query(pattern);
      const messageRows = this.db
        .prepare(
          `SELECT m.id AS id, m.content AS content
           FROM messages_fts f
           JOIN messages m ON m.rowid = f.rowid
           WHERE m.conversationId = ? AND messages_fts MATCH ?`
        )
        .all(conversationId, sanitized) as any[];

      const summaryRows = this.db
        .prepare(
          `SELECT s.summaryId AS id, s.content AS content
           FROM summaries_fts f
           JOIN summaries s ON s.rowid = f.rowid
           WHERE s.conversationId = ? AND summaries_fts MATCH ?`
        )
        .all(conversationId, sanitized) as any[];

      return [
        ...messageRows.map(r => ({ kind: 'message' as const, id: r.id, snippet: String(r.content).slice(0, 200) })),
        ...summaryRows.map(r => ({ kind: 'summary' as const, id: r.id, snippet: String(r.content).slice(0, 200) })),
      ];
    }

    // regex: load and filter in JS
    const re = new RegExp(pattern, 'i');
    const messages = this.getMessagesAfter(-1).filter(m => re.test(m.content));

    const summaries = this.db
      .prepare(
        `SELECT summaryId AS id, content
         FROM summaries
         WHERE conversationId = ?`
      )
      .all(conversationId) as any[];

    const summaryMatches = summaries.filter(s => re.test(String(s.content)));

    return [
      ...messages.map(m => ({ kind: 'message' as const, id: m.id, snippet: m.content.slice(0, 200) })),
      ...summaryMatches.map(s => ({ kind: 'summary' as const, id: s.id, snippet: String(s.content).slice(0, 200) })),
    ];
  }

  describeSummary(summaryId: string): SummaryMeta {
    this.assertOpen();

    const row = this.db
      .prepare(
        `SELECT summaryId, conversationId, depth, kind, tokenCount, earliestAt, latestAt, descendantCount, createdAt
         FROM summaries
         WHERE summaryId = ?`
      )
      .get(summaryId) as any;

    if (!row) throw new Error(`Summary not found: ${summaryId}`);

    return {
      summaryId: row.summaryId,
      conversationId: row.conversationId,
      depth: row.depth,
      kind: row.kind,
      tokenCount: row.tokenCount,
      earliestAt: row.earliestAt,
      latestAt: row.latestAt,
      descendantCount: row.descendantCount,
      createdAt: row.createdAt,
    };
  }

  insertLargeFile(file: LargeFileInsert): string {
    this.assertOpen();
    const conversationId = this.requireConversationId();
    const fileId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO large_files(fileId, conversationId, path, explorationSummary, tokenCount, storagePath, capturedAt, fileMtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(fileId, conversationId, file.path, file.explorationSummary, file.tokenCount, file.storagePath, file.capturedAt, file.fileMtime);
    return fileId;
  }

  getLargeFile(fileId: string): StoredLargeFile | undefined {
    this.assertOpen();
    const row = this.db
      .prepare(
        `SELECT fileId, conversationId, path, explorationSummary, tokenCount, storagePath, capturedAt, fileMtime
         FROM large_files
         WHERE fileId = ?`
      )
      .get(fileId) as any;
    if (!row) return undefined;
    return {
      fileId: row.fileId,
      conversationId: row.conversationId,
      path: row.path,
      explorationSummary: row.explorationSummary,
      tokenCount: row.tokenCount,
      storagePath: row.storagePath,
      capturedAt: row.capturedAt,
      fileMtime: row.fileMtime,
    };
  }

  getLargeFileByPath(path: string): StoredLargeFile | undefined {
    this.assertOpen();
    const conversationId = this.requireConversationId();
    const row = this.db
      .prepare(
        `SELECT fileId, conversationId, path, explorationSummary, tokenCount, storagePath, capturedAt, fileMtime
         FROM large_files
         WHERE path = ? AND conversationId = ?`
      )
      .get(path, conversationId) as any;
    if (!row) return undefined;
    return {
      fileId: row.fileId,
      conversationId: row.conversationId,
      path: row.path,
      explorationSummary: row.explorationSummary,
      tokenCount: row.tokenCount,
      storagePath: row.storagePath,
      capturedAt: row.capturedAt,
      fileMtime: row.fileMtime,
    };
  }

  deleteLargeFile(fileId: string): void {
    this.assertOpen();
    this.db.prepare('DELETE FROM large_files WHERE fileId = ?').run(fileId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
