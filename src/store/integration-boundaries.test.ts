import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe('Store integration boundaries', () => {
  it('does not import node:sqlite outside src/store/', () => {
    const repoRoot = new URL('../..', import.meta.url).pathname;
    const srcRoot = join(repoRoot, 'src');

    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      if (!file.endsWith('.ts')) continue;
      const rel = file.slice(srcRoot.length + 1).replace(/\\/g, '/');
      const source = readFileSync(file, 'utf-8');
      if (source.includes("from 'node:sqlite'") || source.includes('from "node:sqlite"')) {
        if (!rel.startsWith('store/')) offenders.push(rel);
      }
    }

    assert.deepStrictEqual(offenders, []);
  });

  it('adds no new npm dependencies (store uses built-in node:sqlite)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };

    assert.ok(!('better-sqlite3' in deps), 'better-sqlite3 must not be added');
    assert.ok(!('@types/better-sqlite3' in deps), '@types/better-sqlite3 must not be added');
  });
});
