export const SCHEMA_VERSION = 'v0.2-foundation-1';

export const SCHEMA_SQL = `
-- schema version marker
CREATE TABLE IF NOT EXISTS schema_version (
  version   TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
DELETE FROM schema_version;
INSERT INTO schema_version(version, createdAt) VALUES ('${SCHEMA_VERSION}', CAST(strftime('%s','now') AS INTEGER));

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  projectRoot TEXT NOT NULL,
  createdAt   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL REFERENCES conversations(id),
  seq            INTEGER NOT NULL,
  role           TEXT NOT NULL,
  toolName       TEXT,
  content        TEXT NOT NULL,
  tokenCount     INTEGER NOT NULL,
  createdAt      INTEGER NOT NULL,
  UNIQUE(conversationId, seq)
);

CREATE TABLE IF NOT EXISTS summaries (
  summaryId       TEXT PRIMARY KEY,
  conversationId  TEXT NOT NULL REFERENCES conversations(id),
  depth           INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  content         TEXT NOT NULL,
  tokenCount      INTEGER NOT NULL,
  earliestAt      INTEGER NOT NULL,
  latestAt        INTEGER NOT NULL,
  descendantCount INTEGER NOT NULL,
  createdAt       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS summary_messages (
  summaryId TEXT NOT NULL REFERENCES summaries(summaryId),
  messageId TEXT NOT NULL REFERENCES messages(id),
  PRIMARY KEY (summaryId, messageId)
);

CREATE TABLE IF NOT EXISTS summary_parents (
  childSummaryId  TEXT NOT NULL REFERENCES summaries(summaryId),
  parentSummaryId TEXT NOT NULL REFERENCES summaries(summaryId),
  PRIMARY KEY (childSummaryId, parentSummaryId)
);

CREATE TABLE IF NOT EXISTS context_items (
  conversationId TEXT NOT NULL REFERENCES conversations(id),
  ordinal        INTEGER NOT NULL,
  messageId      TEXT REFERENCES messages(id),
  summaryId      TEXT REFERENCES summaries(summaryId),
  PRIMARY KEY (conversationId, ordinal),
  CHECK ((messageId IS NULL) != (summaryId IS NULL))
);

CREATE TABLE IF NOT EXISTS large_files (
  fileId             TEXT PRIMARY KEY,
  conversationId     TEXT NOT NULL REFERENCES conversations(id),
  path               TEXT NOT NULL,
  explorationSummary TEXT NOT NULL,
  tokenCount         INTEGER NOT NULL,
  storagePath        TEXT NOT NULL,
  capturedAt         INTEGER NOT NULL,
  fileMtime          INTEGER NOT NULL
);

-- Full-text search (FTS5)
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='rowid');
CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(content, content='summaries', content_rowid='rowid');

-- Keep FTS in sync with external content tables
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO summaries_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;
