import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MemoryStore,
  SqliteStore,
  StoreClosedError,
  SCHEMA_SQL,
  SCHEMA_VERSION,
} from './index.ts';

describe('src/store/index.ts barrel exports', () => {
  it('re-exports implementations and public types', () => {
    assert.ok(typeof MemoryStore === 'function');
    assert.ok(typeof SqliteStore === 'function');
    assert.ok(StoreClosedError.prototype instanceof Error);
    assert.ok(typeof SCHEMA_SQL === 'string');
    assert.ok(typeof SCHEMA_VERSION === 'string');
  });
});
