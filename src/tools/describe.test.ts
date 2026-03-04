import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDescribeExecute, registerDescribeTool } from './describe.ts';
import { DescribeResultSchema } from '../schemas.ts';

describe('lcm_describe execute', () => {
  it('returns metadata for a valid summary ID including childIds (AC 17)', async () => {
    const store = {
      describeSummary(id: string) {
        if (id !== 'sum_parent') throw new Error(`Summary not found: ${id}`);
        return {
          summaryId: 'sum_parent',
          conversationId: 'sess_1',
          depth: 1,
          kind: 'condensed' as const,
          tokenCount: 150,
          earliestAt: 100,
          latestAt: 500,
          descendantCount: 8,
          createdAt: 600,
        };
      },
      getSummaryChildIds(id: string) {
        if (id !== 'sum_parent') return [];
        return ['sum_child_a', 'sum_child_b'];
      },
    } as any;

    const execute = createDescribeExecute(store);
    const result = await execute('call1', { id: 'sum_parent' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    const parsed = JSON.parse(text);

    const validated = DescribeResultSchema.parse(parsed);
    assert.ok('summaryId' in validated);
    assert.strictEqual((validated as any).summaryId, 'sum_parent');
    assert.deepStrictEqual((validated as any).childIds, ['sum_child_a', 'sum_child_b']);
  });

  it('returns structured error for nonexistent summary ID (AC 18)', async () => {
    const store = {
      describeSummary() {
        throw new Error('Summary not found');
      },
      getSummaryChildIds() {
        return [];
      },
    } as any;

    const execute = createDescribeExecute(store);
    const result = await execute('call1', { id: 'sum_nonexistent' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    const parsed = JSON.parse(text);

    const validated = DescribeResultSchema.parse(parsed);
    assert.ok('error' in validated);
    assert.strictEqual((validated as any).error, 'Summary not found');
    assert.strictEqual((validated as any).id, 'sum_nonexistent');
  });
});

describe('registerDescribeTool (AC 16)', () => {
  it('registers lcm_describe tool with correct name and { id: string } parameters', () => {
    let registeredTool: any = null;
    const mockPi = {
      registerTool(tool: any) {
        registeredTool = tool;
      },
    } as any;

    const store = {
      describeSummary() {
        throw new Error('not used');
      },
      getSummaryChildIds() {
        return [];
      },
    } as any;

    registerDescribeTool(mockPi, store);

    assert.ok(registeredTool !== null, 'registerTool should have been called');
    assert.strictEqual(registeredTool.name, 'lcm_describe');
    assert.ok(registeredTool.parameters.properties.id, 'Should have id parameter');
    assert.strictEqual(registeredTool.parameters.properties.id.type, 'string');
  });
});
