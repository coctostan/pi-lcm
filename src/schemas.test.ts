import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SummaryBlockSchema, GrepResultSetSchema, DescribeResultSchema, ExpandResultSchema } from './schemas.ts';
import { ZodError } from 'zod';

describe('SummaryBlockSchema', () => {
  it('parses a valid SummaryBlock object', () => {
    const valid = {
      id: 'sum_abc',
      depth: 0,
      kind: 'leaf' as const,
      msgRange: { earliest: 1, latest: 10 },
      childCount: 5,
      content: 'Summary of messages 1-10.',
    };
    const result = SummaryBlockSchema.parse(valid);
    assert.deepStrictEqual(result, valid);
  });

  it('accepts kind "condensed"', () => {
    const valid = {
      id: 'sum_def',
      depth: 2,
      kind: 'condensed' as const,
      msgRange: { earliest: 100, latest: 200 },
      childCount: 3,
      content: 'Condensed summary.',
    };
    const result = SummaryBlockSchema.parse(valid);
    assert.strictEqual(result.kind, 'condensed');
  });

  it('rejects objects missing required fields', () => {
    assert.throws(
      () => SummaryBlockSchema.parse({ id: 'sum_abc' }),
      (err: unknown) => err instanceof ZodError,
    );
  });

  it('rejects invalid kind value', () => {
    assert.throws(
      () => SummaryBlockSchema.parse({
        id: 'sum_abc',
        depth: 0,
        kind: 'invalid',
        msgRange: { earliest: 1, latest: 10 },
        childCount: 5,
        content: 'text',
      }),
      (err: unknown) => err instanceof ZodError,
    );
  });
});

describe('GrepResultSetSchema', () => {
  it('parses a valid result set with results', () => {
    const valid = {
      results: [
        { kind: 'message' as const, id: 'm1', snippet: 'hello world' },
        { kind: 'summary' as const, id: 'sum_1', snippet: 'summary text' },
      ],
    };
    const result = GrepResultSetSchema.parse(valid);
    assert.strictEqual(result.results.length, 2);
  });

  it('is valid with empty results array', () => {
    const result = GrepResultSetSchema.parse({ results: [] });
    assert.deepStrictEqual(result, { results: [] });
  });

  it('is valid with error and empty results', () => {
    const valid = { results: [], error: 'Invalid search query: bad syntax' };
    const result = GrepResultSetSchema.parse(valid);
    assert.strictEqual(result.error, 'Invalid search query: bad syntax');
    assert.deepStrictEqual(result.results, []);
  });

  it('rejects objects missing results field', () => {
    assert.throws(
      () => GrepResultSetSchema.parse({}),
      (err: unknown) => err instanceof ZodError,
    );
  });

  it('rejects invalid kind in results', () => {
    assert.throws(
      () =>
        GrepResultSetSchema.parse({
          results: [{ kind: 'invalid', id: 'x', snippet: 'y' }],
        }),
      (err: unknown) => err instanceof ZodError,
    );
  });
});

describe('DescribeResultSchema', () => {
  it('parses a valid success result', () => {
    const valid = {
      summaryId: 'sum_abc',
      depth: 0,
      kind: 'leaf' as const,
      tokenCount: 123,
      earliestAt: 1000,
      latestAt: 2000,
      descendantCount: 5,
      childIds: [],
    };
    const result = DescribeResultSchema.parse(valid);
    assert.strictEqual((result as any).summaryId, 'sum_abc');
  });

  it('parses a valid success result with childIds', () => {
    const valid = {
      summaryId: 'sum_def',
      depth: 1,
      kind: 'condensed' as const,
      tokenCount: 456,
      earliestAt: 1000,
      latestAt: 3000,
      descendantCount: 10,
      childIds: ['sum_a', 'sum_b'],
    };
    const result = DescribeResultSchema.parse(valid);
    assert.ok('childIds' in result && result.childIds.length === 2);
  });

  it('parses a valid error result', () => {
    const valid = { error: 'Summary not found', id: 'sum_missing' };
    const result = DescribeResultSchema.parse(valid);
    assert.ok('error' in result);
    assert.strictEqual((result as any).error, 'Summary not found');
  });

  it('rejects objects missing required fields', () => {
    assert.throws(
      () => DescribeResultSchema.parse({ summaryId: 'sum_abc' }),
      (err: unknown) => err instanceof ZodError,
    );
  });
});


describe('ExpandResultSchema', () => {
  it('parses a valid DAG expansion result', () => {
    const valid = { id: 'sum_abc', source: 'dag' as const, content: 'Expanded summary content.' };
    const result = ExpandResultSchema.parse(valid);
    assert.ok('source' in result && result.source === 'dag');
  });

  it('parses a valid session expansion result', () => {
    const valid = { id: 'toolu_01', source: 'session' as const, content: 'Original tool content.' };
    const result = ExpandResultSchema.parse(valid);
    assert.ok('source' in result && result.source === 'session');
  });

  it('parses a valid error result', () => {
    const valid = { error: 'Summary not found', id: 'sum_missing' };
    const result = ExpandResultSchema.parse(valid);
    assert.ok('error' in result);
    assert.strictEqual((result as any).error, 'Summary not found');
  });

  it('rejects objects missing required fields', () => {
    assert.throws(
      () => ExpandResultSchema.parse({ id: 'sum_abc' }),
      (err: unknown) => err instanceof ZodError,
    );
  });

  it('rejects invalid source value', () => {
    assert.throws(
      () => ExpandResultSchema.parse({ id: 'x', source: 'invalid', content: 'c' }),
      (err: unknown) => err instanceof ZodError,
    );
  });
});
