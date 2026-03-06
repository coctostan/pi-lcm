import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { explore } from './explorer.ts';

describe('explore — TS/JS handler', () => {
  it('extracts diverse export declarations with correct line numbers (AC 1,3,4,5)', () => {
    const content = [
      'import { something } from "./other";',       // L1 — not exported
      '',                                            // L2
      'export function processEvent(e: Event) {',    // L3
      '  return e;',                                 // L4
      '}',                                           // L5
      '',                                            // L6
      'export async function fetchData() {',         // L7
      '  return null;',                              // L8
      '}',                                           // L9
      '',                                            // L10
      'export class EventEmitter {',                 // L11
      '  emit() {}',                                 // L12
      '}',                                           // L13
      '',                                            // L14
      'export abstract class BaseParser {',          // L15
      '  abstract parse(): void;',                   // L16
      '}',                                           // L17
      '',                                            // L18
      'export const MAX_RETRIES = 3;',               // L19
      'export let counter = 0;',                     // L20
      'export var legacy = true;',                   // L21
      '',                                            // L22
      'export type Config = { key: string };',       // L23
      'export interface Handler {',                  // L24
      '  handle(): void;',                           // L25
      '}',                                           // L26
      '',                                            // L27
      'export enum LogLevel {',                      // L28
      '  INFO,',                                     // L29
      '  WARN,',                                     // L30
      '}',                                           // L31
      '',                                            // L32
      'export default class App {}',                 // L33
      '',                                            // L34
      'export { foo, bar } from "./utils";',         // L35
      'export * from "./helpers";',                  // L36
      '',                                            // L37
      'function internalHelper() {}',                // L38 — not exported
    ].join('\n');

    const result = explore('src/app/main.ts', content);

    // Header checks
    assert.ok(result.includes('src/app/main.ts'), 'header contains file path');
    assert.ok(result.includes('38 lines'), 'header contains line count');
    assert.ok(result.includes('13 exports'), 'header contains export count');

    // Each exported declaration appears with its line number
    assert.ok(result.includes('L3: export function processEvent(e: Event) {'));
    assert.ok(result.includes('L7: export async function fetchData() {'));
    assert.ok(result.includes('L11: export class EventEmitter {'));
    assert.ok(result.includes('L15: export abstract class BaseParser {'));
    assert.ok(result.includes('L19: export const MAX_RETRIES = 3;'));
    assert.ok(result.includes('L20: export let counter = 0;'));
    assert.ok(result.includes('L21: export var legacy = true;'));
    assert.ok(result.includes('L23: export type Config = { key: string };'));
    assert.ok(result.includes('L24: export interface Handler {'));
    assert.ok(result.includes('L28: export enum LogLevel {'));
    assert.ok(result.includes('L33: export default class App {}'));
    assert.ok(result.includes('L35: export { foo, bar } from "./utils";'));
    assert.ok(result.includes('L36: export * from "./helpers";'));

    // Internal helper is NOT included
    assert.ok(!result.includes('internalHelper'));
  });

  it('routes .js files to TS/JS handler (AC 2)', () => {
    const content = 'export function hello() {}\n';
    const result = explore('lib/utils.js', content);
    assert.ok(result.includes('lib/utils.js'));
    assert.ok(result.includes('1 export'));
    assert.ok(result.includes('L1: export function hello() {'));
  });

  it('routes .tsx and .jsx files to TS/JS handler (AC 2)', () => {
    const tsx = 'export function App() { return null; }\n';
    const tsxResult = explore('src/App.tsx', tsx);
    assert.ok(tsxResult.includes('1 export'));

    const jsxResult = explore('src/App.jsx', tsx);
    assert.ok(jsxResult.includes('1 export'));
  });

  it('routes .mjs and .cjs files to TS/JS handler (AC 2)', () => {
    const content = 'export const config = {};\n';
    const mjsResult = explore('config.mjs', content);
    assert.ok(mjsResult.includes('1 export'));

    const cjsResult = explore('config.cjs', content);
    assert.ok(cjsResult.includes('1 export'));
  });
});

describe('explore \u2014 TS/JS edge cases', () => {
  it('TS file with zero exports produces header with "0 exports" and no declaration lines (AC 6)', () => {
    const content = [
      'import { something } from "./other";',
      '',
      'function internalHelper() {}',
      'const SECRET = 42;',
    ].join('\n');

    const result = explore('src/internal.ts', content);

    assert.ok(result.includes('src/internal.ts'), 'header contains file path');
    assert.ok(result.includes('4 lines'), 'header contains line count');
    assert.ok(result.includes('0 exports'), 'header says 0 exports');
    // No L{N}: lines
    assert.ok(!result.includes('L1:'));
    assert.ok(!result.includes('L2:'));
    assert.ok(!result.includes('L3:'));
    assert.ok(!result.includes('L4:'));
  });

  it('empty .ts file produces valid minimal header (AC 11)', () => {
    const result = explore('src/empty.ts', '');

    assert.ok(result.includes('src/empty.ts'), 'header contains file path');
    assert.ok(result.includes('0 exports'), 'header says 0 exports');
    assert.ok(result.length > 0, 'output is not empty');
    assert.ok(result.includes('0 lines'), 'empty TS file header says 0 lines, not 1');
  });
});

describe('explore — generic handler', () => {
  it('routes non-TS/JS files to generic handler with file stats (AC 2, 7)', () => {
    const content = 'line one\nline two\nline three\n';
    const result = explore('docs/readme.md', content);

    assert.ok(result.includes('docs/readme.md'), 'header contains file path');
    assert.ok(result.includes('4 lines'), 'header contains line count');
    assert.ok(result.includes(`${content.length} bytes`), 'header contains byte count');
  });

  it('emits first 60 lines verbatim for files ≤60 lines, no trailer (AC 8, 10)', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `content line ${i + 1}`);
    const content = lines.join('\n');
    const result = explore('data/config.yaml', content);

    // All 20 lines present
    for (const line of lines) {
      assert.ok(result.includes(line), `missing line: ${line}`);
    }
    // No trailer
    assert.ok(!result.includes('[...'), 'no truncation trailer for ≤60 lines');
  });

  it('appends trailer when file exceeds 60 lines (AC 8, 9)', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n');
    const result = explore('data/large.csv', content);

    // First 60 lines present
    assert.ok(result.includes('line 1'), 'first line present');
    assert.ok(result.includes('line 60'), 'line 60 present');
    // Line 61 NOT present in preview
    assert.ok(!result.includes('line 61'), 'line 61 not in preview');
    // Trailer shows remaining count
    assert.ok(result.includes('[...40 more lines]'), 'trailer shows remaining line count');
  });

  it('empty generic file produces valid minimal header (AC 11)', () => {
    const result = explore('empty.txt', '');

    assert.ok(result.includes('empty.txt'), 'header contains file path');
    assert.ok(result.includes('0 bytes'), 'header contains byte count');
    assert.ok(result.length > 0, 'output is not empty');
  });

  it('routes extensionless files to generic handler (AC 2)', () => {
    const content = 'some content\n';
    const result = explore('Makefile', content);

    assert.ok(result.includes('Makefile'), 'header contains file path');
    assert.ok(result.includes(`${content.length} bytes`), 'byte count present');
  });
});

describe('explore — token budget cap', () => {
  const TOKEN_BUDGET = 500;
  const CHAR_LIMIT = Math.floor(TOKEN_BUDGET * 3.5); // 1750

  it('TS file with 10,000 exports stays within 500-token cap (AC 12, 13)', () => {
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      lines.push(`export const value${i} = ${i};`);
    }
    const content = lines.join('\n');
    const result = explore('src/huge.ts', content);

    assert.ok(result.length <= CHAR_LIMIT + 200, `output ${result.length} chars exceeds budget (max ~${CHAR_LIMIT + 200} with truncation notice)`);
    assert.ok(result.includes('[Truncated'), 'truncation notice present');
    assert.ok(result.includes('src/huge.ts'), 'header still present');
  });

  it('generic file with 10,000 lines stays within 500-token cap (AC 12, 14)', () => {
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      lines.push(`This is line number ${i + 1} with some content padding here.`);
    }
    const content = lines.join('\n');
    const result = explore('data/huge.csv', content);

    assert.ok(result.length <= CHAR_LIMIT + 200, `output ${result.length} chars exceeds budget (max ~${CHAR_LIMIT + 200} with truncation notice)`);
    assert.ok(result.includes('[Truncated'), 'truncation notice present');
    assert.ok(result.includes('data/huge.csv'), 'header still present');
  });
});
