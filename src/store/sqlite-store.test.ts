import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { runStoreContractTests } from './store-contract.test-helper.ts';
import { SqliteStore } from './sqlite-store.ts';
import { SCHEMA_VERSION } from './schema.ts';

const testDir = join(tmpdir(), `pi-lcm-sqlite-store-${Date.now()}`);
mkdirSync(testDir, { recursive: true });

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function dbPath(name: string) {
  return join(testDir, name);
}

describe('SqliteStore -- shared Store contract', () => {
  runStoreContractTests('SqliteStore', () => {
    // Create a unique DB file per contract run (tests within the contract share the instance).
    const path = dbPath(`contract-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
    const store = new SqliteStore(path);
    return store;
  });
});

describe('SqliteStore -- sqlite-specific behavior', () => {
  it('creates all schema tables and FTS5 virtual tables on construction', () => {
    const path = dbPath(`schema-${Date.now()}.sqlite`);
    const store = new SqliteStore(path);
    store.close();

    const db = new DatabaseSync(path);

    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);

    for (const required of [
      'schema_version',
      'conversations',
      'messages',
      'summaries',
      'summary_messages',
      'summary_parents',
      'context_items',
      'large_files',
      // virtual tables appear as type=table in sqlite_master
      'messages_fts',
      'summaries_fts',
    ]) {
      assert.ok(names.includes(required), `Expected table ${required} to exist. Have: ${names.join(', ')}`);
    }

    const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as any;
    assert.strictEqual(versionRow.version, SCHEMA_VERSION);

    db.close();
  });

  it('enables WAL journal mode for file-based databases', () => {
    const path = dbPath(`wal-${Date.now()}.sqlite`);
    const store = new SqliteStore(path);
    store.close();

    const db = new DatabaseSync(path);
    const row = db.prepare('PRAGMA journal_mode;').get() as any;
    assert.strictEqual(row.journal_mode, 'wal');
    db.close();
  });

  it('does not require WAL for :memory: databases (journal_mode is memory)', () => {
    const store = new SqliteStore(':memory:');

    // We can verify journal_mode directly via a second in-memory DB check.
    // (The important part is: constructor does not throw.)
    store.close();
  });

  it('recreates schema when opening a DB file with mismatched schema_version (data cleared)', () => {
    const path = dbPath(`mismatch-${Date.now()}.sqlite`);

    // Create an incompatible schema with a wrong version and leftover data.
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE schema_version(version TEXT NOT NULL);
      INSERT INTO schema_version(version) VALUES ('WRONG');

      CREATE TABLE conversations(id TEXT PRIMARY KEY, projectRoot TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE messages(
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        toolName TEXT,
        content TEXT NOT NULL,
        tokenCount INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );

      INSERT INTO conversations(id, projectRoot, createdAt) VALUES ('sess_1', '/tmp', 1);
      INSERT INTO messages(id, conversationId, seq, role, toolName, content, tokenCount, createdAt)
      VALUES ('m0', 'sess_1', 0, 'user', NULL, 'old data', 1, 1);
    `);
    db.close();

    const store = new SqliteStore(path);
    store.openConversation('sess_1', '/tmp');

    assert.strictEqual(store.getLastIngestedSeq(), -1, 'old messages should be gone after recreation');

    store.close();
  });

  it('FTS5 is queryable through grepMessages(fulltext)', () => {
    const path = dbPath(`fts-${Date.now()}.sqlite`);
    const store = new SqliteStore(path);
    store.openConversation('sess_1', '/tmp');

    store.ingestMessage({
      id: 'm0',
      seq: 0,
      role: 'user',
      content: 'the quick brown fox',
      tokenCount: 4,
      createdAt: 1,
    });

    const results = store.grepMessages('quick', 'fulltext');
    assert.ok(results.some(r => r.kind === 'message' && r.id === 'm0'));

    store.close();
  });

  it('getMessage returns a stored message by id and undefined when missing (AC 3)', () => {
    const path = dbPath(`get-message-${Date.now()}.sqlite`);
    const store = new SqliteStore(path);
    store.openConversation('sess_1', '/tmp');

    store.ingestMessage({
      id: 'm0',
      seq: 0,
      role: 'user',
      content: 'hello sqlite',
      tokenCount: 2,
      createdAt: 1,
    });

    const found = (store as any).getMessage('m0');
    assert.ok(found);
    assert.strictEqual(found.id, 'm0');
    assert.strictEqual(found.content, 'hello sqlite');

    const missing = (store as any).getMessage('missing');
    assert.strictEqual(missing, undefined);

    store.close();
  });

  it('re-opening a matching-version DB does NOT re-execute SCHEMA_SQL (schema_version.createdAt is stable)', () => {
    const path = dbPath(`reopen-${Date.now()}.sqlite`);

    // First open: establishes the schema.
    const store1 = new SqliteStore(path);
    store1.close();

    // Manually set createdAt to a sentinel value that cannot be confused with a real Unix timestamp.
    // strftime('%s','now') returns ~1.7 billion; 42 is unmistakably different.
    const dbSentinel = new DatabaseSync(path);
    dbSentinel.exec('UPDATE schema_version SET createdAt = 42');
    dbSentinel.close();

    // Second open with matching version: must NOT re-execute SCHEMA_SQL (no DELETE+INSERT on schema_version).
    const store2 = new SqliteStore(path);
    store2.close();

    const dbCheck = new DatabaseSync(path);
    const row = dbCheck.prepare('SELECT createdAt FROM schema_version LIMIT 1').get() as any;
    dbCheck.close();

    assert.strictEqual(
      row.createdAt,
      42,
      'schema_version.createdAt must remain unchanged across re-opens when version matches; ' +
      'if it changed, ensureSchema() is re-executing SCHEMA_SQL unnecessarily'
    );
  });
});
