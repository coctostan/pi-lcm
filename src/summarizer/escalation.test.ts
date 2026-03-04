import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWithEscalation } from './summarizer.ts';
import type { Summarizer, SummarizeOptions } from './summarizer.ts';

describe('summarizeWithEscalation', () => {
  it('Level 1: returns result if estimateTokens(output) < estimateTokens(input) (AC 19)', async () => {
    const calls: string[] = [];
    const mockSummarizer: Summarizer = {
      async summarize(content: string, _opts: SummarizeOptions): Promise<string> {
        calls.push(content.slice(0, 20));
        // Return a shorter summary than the input
        return 'short summary';
      },
    };

    // Input is significantly longer than "short summary"
    const longInput =
      'This is a very long input string that should be summarized into something much shorter by the LLM.';
    const result = await summarizeWithEscalation(mockSummarizer, longInput, {
      depth: 1,
      kind: 'leaf',
      maxOutputTokens: 500,
    });

    assert.strictEqual(result, 'short summary');
    assert.strictEqual(calls.length, 1, 'Should only call summarizer once (Level 1)');
  });

  it('Level 2: re-prompts with aggressive "compress harder" instruction when Level 1 fails token check (AC 20)', async () => {
    const calls: Array<{ content: string; callIndex: number }> = [];
    let callIndex = 0;
    const mockSummarizer: Summarizer = {
      async summarize(content: string, _opts: SummarizeOptions): Promise<string> {
        calls.push({ content: content.slice(0, 100), callIndex: callIndex++ });
        if (callIndex === 1) {
          // Level 1: return something LONGER than input (fails token check)
          return 'This is an even longer output that exceeds the original input length by a significant margin to trigger escalation to level 2';
        }
        // Level 2: return a short result
        return 'compressed';
      },
    };

    const input = 'Medium length input text for testing.';
    const result = await summarizeWithEscalation(mockSummarizer, input, {
      depth: 1,
      kind: 'leaf',
      maxOutputTokens: 500,
    });

    assert.strictEqual(result, 'compressed');
    assert.strictEqual(calls.length, 2, 'Should call summarizer twice (Level 1 + Level 2)');
    // Level 2 content should contain "compress" instruction
    assert.ok(
      calls[1]!.content.toLowerCase().includes('compress') || calls[1]!.content.toLowerCase().includes('shorter'),
      `Level 2 should include aggressive compression instruction, got: ${calls[1]!.content}`,
    );
  });

  it('Level 3: performs deterministic binary-search truncation when Level 2 also fails (AC 21)', async () => {
    let callCount = 0;
    const mockSummarizer: Summarizer = {
      async summarize(content: string, _opts: SummarizeOptions): Promise<string> {
        callCount++;
        // Both Level 1 and Level 2 return something LONGER than input
        return content + ' extra words that make this even longer than before';
      },
    };

    const input = 'A'.repeat(100); // 100 chars
    const result = await summarizeWithEscalation(mockSummarizer, input, {
      depth: 1,
      kind: 'leaf',
      maxOutputTokens: 10, // Very small target
    });

    // Level 3 should have kicked in (no additional LLM call)
    assert.strictEqual(callCount, 2, 'Should only call summarizer twice (Level 1 + Level 2), Level 3 is deterministic');
    // Result should be a truncated string
    assert.ok(result.length > 0, 'Result should not be empty');
  });

  it('Level 3 always converges — returns string with estimateTokens(output) <= maxOutputTokens (AC 22)', async () => {
    const mockSummarizer: Summarizer = {
      async summarize(content: string, _opts: SummarizeOptions): Promise<string> {
        // Always return something longer
        return content + content;
      },
    };

    const input = 'B'.repeat(500); // 500 chars
    const maxOutputTokens = 5;
    const result = await summarizeWithEscalation(mockSummarizer, input, {
      depth: 1,
      kind: 'leaf',
      maxOutputTokens,
    });

    const { estimateTokens } = await import('./token-estimator.ts');
    const outputTokens = estimateTokens(result);
    assert.ok(
      outputTokens <= maxOutputTokens,
      `Level 3 must converge: estimateTokens(output)=${outputTokens} should be <= maxOutputTokens=${maxOutputTokens}`,
    );
  });

  it('Level 3 convergence works with various maxOutputTokens values', async () => {
    const mockSummarizer: Summarizer = {
      async summarize(content: string, _opts: SummarizeOptions): Promise<string> {
        return content + ' padded output that is longer';
      },
    };

    const { estimateTokens } = await import('./token-estimator.ts');

    for (const maxTokens of [1, 3, 10, 50]) {
      const input = 'C'.repeat(200);
      const result = await summarizeWithEscalation(mockSummarizer, input, {
        depth: 1,
        kind: 'leaf',
        maxOutputTokens: maxTokens,
      });
      const outputTokens = estimateTokens(result);
      assert.ok(
        outputTokens <= maxTokens,
        `For maxOutputTokens=${maxTokens}: got ${outputTokens} tokens`,
      );
    }
  });
});
