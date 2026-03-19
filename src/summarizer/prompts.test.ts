import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLeafPrompt, getCondensePrompt } from './prompts.ts';

describe('prompts', () => {
  it('getLeafPrompt() returns a non-empty string containing instruction to summarize (AC 1)', () => {
    const prompt = getLeafPrompt();
    assert.ok(typeof prompt === 'string');
    assert.ok(prompt.length > 0, 'Prompt should be non-empty');
    assert.ok(
      prompt.toLowerCase().includes('summar'),
      `Leaf prompt should contain summarize/summary instruction`,
    );
  });

  it('getCondensePrompt(depth) returns a non-empty string with condense instruction and depth value (AC 2)', () => {
    const prompt = getCondensePrompt(2);
    assert.ok(typeof prompt === 'string');
    assert.ok(prompt.length > 0, 'Prompt should be non-empty');
    assert.ok(
      prompt.toLowerCase().includes('condens') || prompt.toLowerCase().includes('summar'),
      `Condense prompt should contain condense/summary instruction`,
    );
    assert.ok(prompt.includes('2'), `Condense prompt should include the depth value (2)`);
  });

  it('getCondensePrompt includes depth for different depth values', () => {
    const prompt3 = getCondensePrompt(3);
    assert.ok(prompt3.includes('3'), 'Condense prompt should include depth 3');
    const prompt5 = getCondensePrompt(5);
    assert.ok(prompt5.includes('5'), 'Condense prompt should include depth 5');
  });

  it('getLeafPrompt() contains four structured sections (AC 1)', () => {
    const prompt = getLeafPrompt();
    assert.ok(prompt.includes('Facts:'), 'Leaf prompt must include Facts section');
    assert.ok(prompt.includes('Decisions:'), 'Leaf prompt must include Decisions section');
    assert.ok(
      prompt.includes('Open threads at end of covered span:'),
      'Leaf prompt must include Open threads section',
    );
    assert.ok(
      prompt.includes('Key artifacts / identifiers:'),
      'Leaf prompt must include Key artifacts section',
    );
  });

  it('getCondensePrompt() contains four structured sections (AC 2)', () => {
    const prompt = getCondensePrompt(2);
    assert.ok(prompt.includes('Facts:'), 'Condense prompt must include Facts section');
    assert.ok(prompt.includes('Decisions:'), 'Condense prompt must include Decisions section');
    assert.ok(
      prompt.includes('Open threads at end of covered span:'),
      'Condense prompt must include Open threads section',
    );
    assert.ok(
      prompt.includes('Key artifacts / identifiers:'),
      'Condense prompt must include Key artifacts section',
    );
  });

  it('getLeafPrompt() contains anti-instruction rules (AC 3)', () => {
    const prompt = getLeafPrompt();
    assert.ok(
      prompt.includes('Do not use second-person phrasing'),
      'Must prohibit second-person phrasing',
    );
    assert.ok(
      prompt.includes('Do not use imperative phrasing'),
      'Must prohibit imperative phrasing',
    );
    assert.ok(
      prompt.includes('historical state'),
      'Must require historical state for unfinished work',
    );
  });

  it('getCondensePrompt() contains anti-instruction rules (AC 3)', () => {
    const prompt = getCondensePrompt(2);
    assert.ok(
      prompt.includes('Do not use second-person phrasing'),
      'Must prohibit second-person phrasing',
    );
    assert.ok(
      prompt.includes('Do not use imperative phrasing'),
      'Must prohibit imperative phrasing',
    );
    assert.ok(
      prompt.includes('historical state'),
      'Must require historical state for unfinished work',
    );
  });

  it('getLeafPrompt() requires preservation of technical identifiers (AC 4)', () => {
    const prompt = getLeafPrompt();
    assert.ok(prompt.includes('file paths'), 'Must mention file paths');
    assert.ok(prompt.includes('function names'), 'Must mention function names');
    assert.ok(prompt.includes('error messages'), 'Must mention error messages');
    assert.ok(prompt.includes('marker strings'), 'Must mention marker strings');
    assert.ok(prompt.includes('commands'), 'Must mention commands');
    assert.ok(prompt.includes('code snippets'), 'Must mention code snippets');
  });

  it('getCondensePrompt() requires preservation of technical identifiers (AC 4)', () => {
    const prompt = getCondensePrompt(2);
    assert.ok(prompt.includes('file paths'), 'Must mention file paths');
    assert.ok(prompt.includes('function names'), 'Must mention function names');
    assert.ok(prompt.includes('error messages'), 'Must mention error messages');
    assert.ok(prompt.includes('marker strings'), 'Must mention marker strings');
    assert.ok(prompt.includes('commands'), 'Must mention commands');
    assert.ok(prompt.includes('code patterns'), 'Must mention code patterns');
  });

  it('getLeafPrompt() snapshot-stable (AC 5)', () => {
    const prompt = getLeafPrompt();
    assert.strictEqual(prompt, getLeafPrompt(), 'Leaf prompt must be deterministic');
    // Snapshot: verify key structural elements are present and ordered
    const lines = prompt.split('\n');
    const factsIdx = lines.findIndex(l => l === 'Facts:');
    const decisionsIdx = lines.findIndex(l => l === 'Decisions:');
    const openIdx = lines.findIndex(l => l === 'Open threads at end of covered span:');
    const artifactsIdx = lines.findIndex(l => l === 'Key artifacts / identifiers:');
    const rulesIdx = lines.findIndex(l => l === 'Rules:');
    assert.ok(factsIdx > 0, 'Facts section must exist');
    assert.ok(decisionsIdx > factsIdx, 'Decisions must follow Facts');
    assert.ok(openIdx > decisionsIdx, 'Open threads must follow Decisions');
    assert.ok(artifactsIdx > openIdx, 'Key artifacts must follow Open threads');
    assert.ok(rulesIdx > artifactsIdx, 'Rules must follow sections');
  });

  it('getCondensePrompt(2) snapshot-stable (AC 5)', () => {
    const prompt = getCondensePrompt(2);
    assert.strictEqual(prompt, getCondensePrompt(2), 'Condense prompt must be deterministic');
    const lines = prompt.split('\n');
    const factsIdx = lines.findIndex(l => l === 'Facts:');
    const decisionsIdx = lines.findIndex(l => l === 'Decisions:');
    const openIdx = lines.findIndex(l => l === 'Open threads at end of covered span:');
    const artifactsIdx = lines.findIndex(l => l === 'Key artifacts / identifiers:');
    const rulesIdx = lines.findIndex(l => l === 'Rules:');
    assert.ok(factsIdx > 0, 'Facts section must exist');
    assert.ok(decisionsIdx > factsIdx, 'Decisions must follow Facts');
    assert.ok(openIdx > decisionsIdx, 'Open threads must follow Decisions');
    assert.ok(artifactsIdx > openIdx, 'Key artifacts must follow Open threads');
    assert.ok(rulesIdx > artifactsIdx, 'Rules must follow sections');
  });

  it('getLeafPrompt() contains anti-role-play instructions and third-person guidance (bug 028)', () => {
    const prompt = getLeafPrompt().toLowerCase();
    assert.ok(
      prompt.includes('you are not the assistant') || prompt.includes('do not respond'),
      'Leaf prompt must contain anti-role-play instructions.',
    );
    assert.ok(
      prompt.includes('third-person') || prompt.includes('third person'),
      'Leaf prompt must require factual third-person summarization.',
    );
  });

  it('getCondensePrompt() contains anti-role-play instructions and third-person guidance (bug 028)', () => {
    const prompt = getCondensePrompt(2).toLowerCase();
    assert.ok(
      prompt.includes('you are not the assistant') || prompt.includes('do not respond'),
      'Condense prompt must contain anti-role-play instructions.',
    );
    assert.ok(
      prompt.includes('third-person') || prompt.includes('third person'),
      'Condense prompt must require factual third-person condensation.',
    );
  });
});
