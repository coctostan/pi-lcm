import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLeafPrompt, getCondensePrompt } from './prompts.ts';

describe('prompts', () => {
  it('getLeafPrompt() returns a non-empty string containing instruction to summarize raw messages (AC 10)', () => {
    const prompt = getLeafPrompt();
    assert.ok(typeof prompt === 'string');
    assert.ok(prompt.length > 0, 'Prompt should be non-empty');
    assert.ok(
      prompt.toLowerCase().includes('summar'),
      `Leaf prompt should contain summarize/summary instruction, got: ${prompt.slice(0, 100)}`,
    );
  });

  it('getCondensePrompt(depth) returns a non-empty string with condense instruction and depth value (AC 11)', () => {
    const prompt = getCondensePrompt(2);
    assert.ok(typeof prompt === 'string');
    assert.ok(prompt.length > 0, 'Prompt should be non-empty');
    assert.ok(
      prompt.toLowerCase().includes('condens') || prompt.toLowerCase().includes('summar'),
      `Condense prompt should contain condense/summary instruction, got: ${prompt.slice(0, 100)}`,
    );
    assert.ok(prompt.includes('2'), `Condense prompt should include the depth value (2), got: ${prompt.slice(0, 200)}`);
  });

  it('getCondensePrompt includes depth for different depth values', () => {
    const prompt3 = getCondensePrompt(3);
    assert.ok(prompt3.includes('3'), 'Condense prompt should include depth 3');
    const prompt5 = getCondensePrompt(5);
    assert.ok(prompt5.includes('5'), 'Condense prompt should include depth 5');
  });

  it('getLeafPrompt() content does not change unexpectedly — snapshot-stable (AC 12)', () => {
    const prompt = getLeafPrompt();
    const snapshot = `You are a precise conversation summarizer. Your task is to summarize the raw conversation messages provided by the user.

Rules:
- Preserve all technical details: file paths, function names, error messages, code snippets, command outputs
- Preserve the chronological flow of actions taken
- Preserve any decisions made and their rationale
- Omit pleasantries, filler, and redundant acknowledgments
- Use concise, information-dense prose
- Output ONLY the summary text, no preamble or meta-commentary`;
    assert.strictEqual(prompt, snapshot);
  });

  it('getCondensePrompt(2) content does not change unexpectedly — snapshot-stable (AC 12)', () => {
    const prompt = getCondensePrompt(2);
    const snapshot = `You are a precise summary condenser. Your task is to condense existing summaries into a higher-level overview at depth 2.

Rules:
- These are already summaries, not raw messages — condense further without losing critical details
- Preserve all technical details: file paths, function names, error messages, code patterns
- Merge overlapping information across summaries
- Maintain chronological ordering of events
- Be more aggressive about removing redundancy than a leaf summarizer
- Depth 2 summaries should be progressively more abstract while retaining key facts
- Output ONLY the condensed summary text, no preamble or meta-commentary`;
    assert.strictEqual(prompt, snapshot);
  });
});
