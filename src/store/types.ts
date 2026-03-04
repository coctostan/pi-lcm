export type MessageRole = 'user' | 'assistant' | 'toolResult';

export interface IngestableMessage {
  id: string; // pi entry id
  seq: number;
  role: MessageRole;
  toolName?: string;
  content: string;
  tokenCount: number;
  createdAt: number;
}

export interface StoredMessage extends IngestableMessage {
  conversationId: string;
}

export type SummaryKind = 'leaf' | 'condensed';

export interface SummaryInsert {
  depth: number;
  kind: SummaryKind;
  content: string;
  tokenCount: number;
  earliestAt: number;
  latestAt: number;
  descendantCount: number;
  createdAt: number;
}

export interface StoredSummary extends SummaryInsert {
  summaryId: string;
  conversationId: string;
}

export type ContextItem =
  | { kind: 'message'; messageId: string }
  | { kind: 'summary'; summaryId: string };

export interface GrepResult {
  kind: 'message' | 'summary';
  id: string;
  snippet: string;
}

export interface SummaryMeta {
  summaryId: string;
  conversationId: string;
  depth: number;
  kind: SummaryKind;
  tokenCount: number;
  earliestAt: number;
  latestAt: number;
  descendantCount: number;
  createdAt: number;
}

export class StoreClosedError extends Error {
  constructor(message: string = 'Store is closed') {
    super(message);
    this.name = 'StoreClosedError';
  }
}

export interface Store {
  // Conversation lifecycle
  openConversation(sessionId: string, projectRoot: string): void;

  // Message operations
  ingestMessage(msg: IngestableMessage): void;
  getMessagesAfter(seq: number): StoredMessage[];
  getMessage(id: string): StoredMessage | undefined;
  getLastIngestedSeq(): number;

  // Summary operations
  insertSummary(summary: SummaryInsert): string; // returns summaryId
  getSummary(summaryId: string): StoredSummary | undefined;
  linkSummaryMessages(summaryId: string, messageIds: string[]): void;
  linkSummaryParents(parentId: string, childIds: string[]): void;

  // Context items
  getContextItems(): ContextItem[];
  replaceContextItems(items: ContextItem[]): void;

  // Expand / grep / describe
  expandSummary(summaryId: string): string;
  grepMessages(pattern: string, mode: 'fulltext' | 'regex'): GrepResult[];
  describeSummary(summaryId: string): SummaryMeta;
  getSummaryChildIds(parentId: string): string[];

  // Cleanup
  close(): void;
}
