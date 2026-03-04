import { randomUUID } from 'node:crypto';
import type {
  ContextItem,
  GrepResult,
  IngestableMessage,
  StoredMessage,
  Store,
  StoredSummary,
  SummaryInsert,
  SummaryMeta,
} from './types.ts';
import { StoreClosedError } from './types.ts';

export class MemoryStore implements Store {
  private closed = false;

  private conversationId: string | null = null;

  private conversations = new Map<string, { projectRoot: string; createdAt: number }>();
  private messagesByConversation = new Map<string, StoredMessage[]>();
  private summaries = new Map<string, StoredSummary>();
  private summaryMessages = new Map<string, Set<string>>();
  private summaryParents = new Map<string, Set<string>>();
  private contextItemsByConversation = new Map<string, ContextItem[]>();

  private assertOpen(): void {
    if (this.closed) throw new StoreClosedError();
  }

  private requireConversationId(): string {
    if (this.conversationId === null) throw new Error('No active conversation. Call openConversation() first.');
    return this.conversationId;
  }

  openConversation(sessionId: string, projectRoot: string): void {
    this.assertOpen();
    this.conversationId = sessionId;
    if (!this.conversations.has(sessionId)) {
      this.conversations.set(sessionId, { projectRoot, createdAt: Date.now() });
    }
    if (!this.messagesByConversation.has(sessionId)) this.messagesByConversation.set(sessionId, []);
    if (!this.contextItemsByConversation.has(sessionId)) this.contextItemsByConversation.set(sessionId, []);
  }

  ingestMessage(msg: IngestableMessage): void {
    this.assertOpen();
    const conversationId = this.requireConversationId();

    const list = this.messagesByConversation.get(conversationId) ?? [];

    // Replace-by-id if present, else append.
    const existingIndex = list.findIndex(m => m.id === msg.id);
    const stored: StoredMessage = { ...msg, conversationId };
    if (existingIndex >= 0) list[existingIndex] = stored;
    else list.push(stored);

    // Keep seq order for getMessagesAfter.
    list.sort((a, b) => a.seq - b.seq);
    this.messagesByConversation.set(conversationId, list);
  }

  getMessagesAfter(seq: number): StoredMessage[] {
    this.assertOpen();
    const conversationId = this.requireConversationId();
    const list = this.messagesByConversation.get(conversationId) ?? [];
    return list.filter(m => m.seq > seq);
  }

  getMessage(id: string): StoredMessage | undefined {
    this.assertOpen();
    const conversationId = this.requireConversationId();
    const list = this.messagesByConversation.get(conversationId) ?? [];
    return list.find(message => message.id === id);
  }

  getLastIngestedSeq(): number {
    this.assertOpen();
    const conversationId = this.requireConversationId();
    const list = this.messagesByConversation.get(conversationId) ?? [];
    if (list.length === 0) return -1;
    return list[list.length - 1]!.seq;
  }

  insertSummary(summary: SummaryInsert): string {
    this.assertOpen();
    const conversationId = this.requireConversationId();

    const summaryId = randomUUID();
    const stored: StoredSummary = { ...summary, summaryId, conversationId };
    this.summaries.set(summaryId, stored);
    return summaryId;
  }

  getSummary(summaryId: string): StoredSummary | undefined {
    this.assertOpen();
    return this.summaries.get(summaryId);
  }

  linkSummaryMessages(summaryId: string, messageIds: string[]): void {
    this.assertOpen();
    // Ensure summary exists (helps catch typos early).
    if (!this.summaries.has(summaryId)) throw new Error(`Summary not found: ${summaryId}`);

    const set = this.summaryMessages.get(summaryId) ?? new Set<string>();
    for (const messageId of messageIds) {
      set.add(messageId);
    }
    this.summaryMessages.set(summaryId, set);
  }

  linkSummaryParents(parentId: string, childIds: string[]): void {
    this.assertOpen();
    if (!this.summaries.has(parentId)) throw new Error(`Summary not found: ${parentId}`);

    const set = this.summaryParents.get(parentId) ?? new Set<string>();
    for (const childId of childIds) {
      set.add(childId);
    }
    this.summaryParents.set(parentId, set);
  }

  getSummaryChildIds(parentId: string): string[] {
    this.assertOpen();
    const children = this.summaryParents.get(parentId);
    if (!children) return [];
    return Array.from(children);
  }

  getContextItems(): ContextItem[] {
    this.assertOpen();
    const conversationId = this.requireConversationId();
    const items = this.contextItemsByConversation.get(conversationId) ?? [];
    return items.map(item => ({ ...item }));
  }

  replaceContextItems(items: ContextItem[]): void {
    this.assertOpen();
    const conversationId = this.requireConversationId();
    this.contextItemsByConversation.set(conversationId, items.map(item => ({ ...item })));
  }

  expandSummary(summaryId: string): string {
    this.assertOpen();
    const s = this.summaries.get(summaryId);
    if (!s) throw new Error(`Summary not found: ${summaryId}`);
    return s.content;
  }

  grepMessages(pattern: string, mode: 'fulltext' | 'regex'): GrepResult[] {
    this.assertOpen();
    const conversationId = this.requireConversationId();

    const messageHaystack = this.messagesByConversation.get(conversationId) ?? [];
    const summaryHaystack = Array.from(this.summaries.values()).filter(
      summary => summary.conversationId === conversationId,
    );

    const match = (text: string): boolean => {
      if (mode === 'fulltext') {
        return text.toLowerCase().includes(pattern.toLowerCase());
      }

      const re = new RegExp(pattern, 'i');
      return re.test(text);
    };

    const results: GrepResult[] = [];

    for (const message of messageHaystack) {
      if (match(message.content)) {
        results.push({ kind: 'message', id: message.id, snippet: message.content.slice(0, 200) });
      }
    }

    for (const summary of summaryHaystack) {
      if (match(summary.content)) {
        results.push({ kind: 'summary', id: summary.summaryId, snippet: summary.content.slice(0, 200) });
      }
    }

    return results;
  }

  describeSummary(summaryId: string): SummaryMeta {
    this.assertOpen();
    const s = this.summaries.get(summaryId);
    if (!s) throw new Error(`Summary not found: ${summaryId}`);

    const { content: _content, ...rest } = s;
    return rest;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
  }
}
