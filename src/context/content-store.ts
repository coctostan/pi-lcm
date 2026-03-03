import type { TextContent, ImageContent } from '@mariozechner/pi-ai';

/**
 * Interface for storing and retrieving original content stripped from messages.
 * Phase 1: MemoryContentStore (Map-backed).
 * Phase 2: SqliteContentStore.
 */
export interface ContentStore {
  /** Store content keyed by toolCallId. Returns true on success, false on failure. */
  set(key: string, content: (TextContent | ImageContent)[]): boolean;
  /** Retrieve stored content by key. Returns undefined if not found. */
  get(key: string): (TextContent | ImageContent)[] | undefined;
  /** Check if a key exists in the store. */
  has(key: string): boolean;
  /** Return all keys in the store. */
  keys(): string[];
}

/**
 * Map-backed implementation of ContentStore.
 * Shared between ContextHandler and lcm_expand tool.
 */
export class MemoryContentStore implements ContentStore {
  private store = new Map<string, (TextContent | ImageContent)[]>();

  set(key: string, content: (TextContent | ImageContent)[]): boolean {
    this.store.set(key, content);
    return true;
  }

  get(key: string): (TextContent | ImageContent)[] | undefined {
    return this.store.get(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  keys(): string[] {
    return Array.from(this.store.keys());
  }
}
