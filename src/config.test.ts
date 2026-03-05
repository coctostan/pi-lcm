import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG, validateConfig, loadConfig } from './config.ts';
import type { LCMConfig } from './config.ts';

// Type-level check: keyof LCMConfig === ExpectedKeys (fails tsc if mismatch)
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
  ? true
  : false;

type Assert<T extends true> = T;

type ExpectedKeys =
  | 'freshTailCount'
  | 'maxExpandTokens'
  | 'contextThreshold'
  | 'leafChunkTokens'
  | 'leafTargetTokens'
  | 'condensedTargetTokens'
  | 'largeFileTokenThreshold'
  | 'summaryModel'
  | 'incrementalMaxDepth'
  | 'condensedMinFanout'
  | 'megapowersAware'
  | 'crossSession';

// Fails `tsc` if LCMConfig has missing/extra keys.
const _assertKeys: Assert<Equal<keyof LCMConfig, ExpectedKeys>> = true;
void _assertKeys;

describe('LCMConfig type and DEFAULT_CONFIG', () => {
  it('DEFAULT_CONFIG has exactly the 12 expected fields', () => {
    const config: LCMConfig = DEFAULT_CONFIG;
    const keys = Object.keys(config).sort();
    assert.deepStrictEqual(keys, [
      'condensedMinFanout',
      'condensedTargetTokens',
      'contextThreshold',
      'crossSession',
      'freshTailCount',
      'incrementalMaxDepth',
      'largeFileTokenThreshold',
      'leafChunkTokens',
      'leafTargetTokens',
      'maxExpandTokens',
      'megapowersAware',
      'summaryModel',
    ]);
  });

  it('DEFAULT_CONFIG has exact expected values', () => {
    assert.deepStrictEqual(DEFAULT_CONFIG, {
      freshTailCount: 32,
      maxExpandTokens: 4000,
      contextThreshold: 0.75,
      leafChunkTokens: 20000,
      leafTargetTokens: 1200,
      condensedTargetTokens: 2000,
      largeFileTokenThreshold: 25000,
      summaryModel: "anthropic/claude-haiku-4-5",
      incrementalMaxDepth: -1,
      condensedMinFanout: 4,
      megapowersAware: false,
      crossSession: false,
    });
  });
});


describe('validateConfig — happy path', () => {
  it('returns valid LCMConfig when passed a complete valid object', () => {
    const input = {
      freshTailCount: 16,
      maxExpandTokens: 8000,
      contextThreshold: 0.5,
      leafChunkTokens: 10000,
      leafTargetTokens: 600,
      condensedTargetTokens: 1000,
      largeFileTokenThreshold: 50000,
      summaryModel: "anthropic/claude-sonnet",
      incrementalMaxDepth: 3,
      condensedMinFanout: 2,
      megapowersAware: true,
      crossSession: true,
    };
    const result = validateConfig(input);
    assert.deepStrictEqual(result, input);
  });

  it('fills missing fields from DEFAULT_CONFIG when passed a partial object', () => {
    const input = { freshTailCount: 16 };
    const result = validateConfig(input);
    assert.strictEqual(result.freshTailCount, 16);
    assert.deepStrictEqual(result, { ...DEFAULT_CONFIG, freshTailCount: 16 });
  });

  it('returns DEFAULT_CONFIG when passed an empty object', () => {
    const result = validateConfig({});
    assert.deepStrictEqual(result, DEFAULT_CONFIG);
  });
});


describe('validateConfig — field validation', () => {
  // AC 5, 6, 8, 9, 10, 11, 13, 14: positive integer fields
  const positiveIntFields = [
    'freshTailCount', 'maxExpandTokens', 'leafChunkTokens',
    'leafTargetTokens', 'condensedTargetTokens', 'largeFileTokenThreshold',
    'condensedMinFanout',
  ];

  for (const field of positiveIntFields) {
    it(`throws when ${field} is 0`, () => {
      assert.throws(() => validateConfig({ [field]: 0 }), /positive integer/);
    });
    it(`throws when ${field} is -1`, () => {
      assert.throws(() => validateConfig({ [field]: -1 }), /positive integer/);
    });
    it(`throws when ${field} is 1.5`, () => {
      assert.throws(() => validateConfig({ [field]: 1.5 }), /positive integer/);
    });
    it(`throws when ${field} is a string`, () => {
      assert.throws(() => validateConfig({ [field]: "32" }), /positive integer/);
    });
  }

  // AC 7: contextThreshold
  it('throws when contextThreshold is 0', () => {
    assert.throws(() => validateConfig({ contextThreshold: 0 }), /between 0 and 1/);
  });
  it('throws when contextThreshold is 1', () => {
    assert.throws(() => validateConfig({ contextThreshold: 1 }), /between 0 and 1/);
  });
  it('throws when contextThreshold is negative', () => {
    assert.throws(() => validateConfig({ contextThreshold: -0.5 }), /between 0 and 1/);
  });
  it('throws when contextThreshold is > 1', () => {
    assert.throws(() => validateConfig({ contextThreshold: 1.5 }), /between 0 and 1/);
  });
  it('throws when contextThreshold is a string', () => {
    assert.throws(() => validateConfig({ contextThreshold: "0.5" }), /between 0 and 1/);
  });

  // AC 12: summaryModel
  it('throws when summaryModel is empty string', () => {
    assert.throws(() => validateConfig({ summaryModel: "" }), /non-empty string/);
  });
  it('throws when summaryModel is a number', () => {
    assert.throws(() => validateConfig({ summaryModel: 42 }), /non-empty string/);
  });
  it('throws when summaryModel is null', () => {
    assert.throws(() => validateConfig({ summaryModel: null }), /non-empty string/);
  });

  // AC 15: incrementalMaxDepth
  it('throws when incrementalMaxDepth is 1.5', () => {
    assert.throws(() => validateConfig({ incrementalMaxDepth: 1.5 }), /integer/);
  });
  it('throws when incrementalMaxDepth is a string', () => {
    assert.throws(() => validateConfig({ incrementalMaxDepth: "3" }), /integer/);
  });
  it('accepts incrementalMaxDepth of -1', () => {
    const result = validateConfig({ incrementalMaxDepth: -1 });
    assert.strictEqual(result.incrementalMaxDepth, -1);
  });
  it('accepts incrementalMaxDepth of 0', () => {
    const result = validateConfig({ incrementalMaxDepth: 0 });
    assert.strictEqual(result.incrementalMaxDepth, 0);
  });

  // AC 16: non-object input
  it('throws when config is null', () => {
    assert.throws(() => validateConfig(null), /plain object/);
  });
  it('throws when config is a number', () => {
    assert.throws(() => validateConfig(42), /plain object/);
  });
  it('throws when config is a string', () => {
    assert.throws(() => validateConfig("string"), /plain object/);
  });
  it('throws when config is an array', () => {
    assert.throws(() => validateConfig([1, 2, 3]), /plain object/);
  });
});


describe('loadConfig', () => {
  const testDir = join(tmpdir(), `pi-lcm-test-${Date.now()}`);

  before(() => {
    mkdirSync(testDir, { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // AC 17: missing file returns defaults
  it('returns DEFAULT_CONFIG when config file does not exist', () => {
    const result = loadConfig(join(testDir, 'nonexistent.json'));
    assert.deepStrictEqual(result, DEFAULT_CONFIG);
  });

  // AC 22: filePath parameter override
  it('accepts a filePath parameter to override the default path', () => {
    const configPath = join(testDir, 'custom.json');
    writeFileSync(configPath, JSON.stringify({ freshTailCount: 64 }));
    const result = loadConfig(configPath);
    assert.strictEqual(result.freshTailCount, 64);
  });

  it('silently ignores unknown fields like leafMinFanout', () => {
    const configPath = join(testDir, 'unknown-field.json');
    writeFileSync(configPath, JSON.stringify({ leafMinFanout: 8, freshTailCount: 16 }));
    const warnMock = mock.method(console, 'warn', () => {});
    const result = loadConfig(configPath);
    assert.strictEqual(result.freshTailCount, 16);
    assert.ok(!('leafMinFanout' in result), 'leafMinFanout should not appear in result');
    assert.strictEqual(warnMock.mock.callCount(), 0, 'No warnings for unknown fields');
    warnMock.mock.restore();
  });

  // AC 18: valid JSON merge
  it('merges valid user values over DEFAULT_CONFIG', () => {
    const configPath = join(testDir, 'merge.json');
    const userConfig = { freshTailCount: 16, contextThreshold: 0.5 };
    writeFileSync(configPath, JSON.stringify(userConfig));
    const result = loadConfig(configPath);
    assert.strictEqual(result.freshTailCount, 16);
    assert.strictEqual(result.contextThreshold, 0.5);
    assert.strictEqual(result.maxExpandTokens, DEFAULT_CONFIG.maxExpandTokens);
    assert.strictEqual(result.summaryModel, DEFAULT_CONFIG.summaryModel);
  });

  // AC 19: malformed JSON
  it('returns DEFAULT_CONFIG and warns when file has malformed JSON', () => {
    const configPath = join(testDir, 'malformed.json');
    writeFileSync(configPath, '{ not valid json!!!');
    const warnMock = mock.method(console, 'warn', () => {});
    const result = loadConfig(configPath);
    assert.deepStrictEqual(result, DEFAULT_CONFIG);
    assert.strictEqual(warnMock.mock.callCount(), 1);
    warnMock.mock.restore();
  });

  // AC 20: non-object JSON
  it('returns DEFAULT_CONFIG and warns when file has a JSON array', () => {
    const configPath = join(testDir, 'array.json');
    writeFileSync(configPath, '[1, 2, 3]');
    const warnMock = mock.method(console, 'warn', () => {});
    const result = loadConfig(configPath);
    assert.deepStrictEqual(result, DEFAULT_CONFIG);
    assert.strictEqual(warnMock.mock.callCount(), 1);
    warnMock.mock.restore();
  });

  it('returns DEFAULT_CONFIG and warns when file has JSON null', () => {
    const configPath = join(testDir, 'null.json');
    writeFileSync(configPath, 'null');
    const warnMock = mock.method(console, 'warn', () => {});
    const result = loadConfig(configPath);
    assert.deepStrictEqual(result, DEFAULT_CONFIG);
    assert.strictEqual(warnMock.mock.callCount(), 1);
    warnMock.mock.restore();
  });

  // AC 21: per-field fallback with warning naming the field
  it('falls back to default for an invalid field and warns naming it', () => {
    const configPath = join(testDir, 'bad-field.json');
    writeFileSync(configPath, JSON.stringify({
      freshTailCount: -1,
      contextThreshold: 0.5,
    }));
    const warnMock = mock.method(console, 'warn', () => {});
    const result = loadConfig(configPath);
    assert.strictEqual(result.freshTailCount, DEFAULT_CONFIG.freshTailCount);
    assert.strictEqual(result.contextThreshold, 0.5);
    assert.strictEqual(warnMock.mock.callCount(), 1);
    const warnMsg = warnMock.mock.calls[0].arguments[0] as string;
    assert.ok(warnMsg.includes('freshTailCount'), `Warning should name the field, got: ${warnMsg}`);
    warnMock.mock.restore();
  });

  it('falls back to default for multiple invalid fields with a warning per field', () => {
    const configPath = join(testDir, 'multi-bad.json');
    writeFileSync(configPath, JSON.stringify({
      freshTailCount: "not a number",
      summaryModel: "",
      contextThreshold: 2,
    }));
    const warnMock = mock.method(console, 'warn', () => {});
    const result = loadConfig(configPath);
    assert.strictEqual(result.freshTailCount, DEFAULT_CONFIG.freshTailCount);
    assert.strictEqual(result.summaryModel, DEFAULT_CONFIG.summaryModel);
    assert.strictEqual(result.contextThreshold, DEFAULT_CONFIG.contextThreshold);
    assert.strictEqual(warnMock.mock.callCount(), 3);
    warnMock.mock.restore();
  });
});

describe('integration wiring', () => {
  it('src/types.ts re-exports LCMConfig from src/config.ts', () => {
    const typesSource = readFileSync(new URL('./types.ts', import.meta.url), 'utf-8');
    assert.match(
      typesSource,
      /export\s+type\s*{\s*LCMConfig\s*}\s+from\s+['"]\.\/config\.ts['"]/,
    );
  });

  it('src/index.ts loads config once at extension factory top level', () => {
    const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf-8');

    assert.match(
      indexSource,
      /import\s*{\s*loadConfig\s*}\s*from\s*['"]\.\/config\.ts['"]/
    );

    const loadCallMatches = indexSource.match(/loadConfig\(\)/g) ?? [];
    assert.strictEqual(loadCallMatches.length, 1);

    const factoryStart = indexSource.indexOf('export default function');
    const loadDecl = indexSource.indexOf('const resolvedConfig = config ?? loadConfig();');
    const firstHandler = indexSource.indexOf('pi.on(');

    assert.ok(factoryStart >= 0, 'factory function missing');
    assert.ok(loadDecl > factoryStart, 'config should be loaded inside factory');
    assert.ok(firstHandler > loadDecl, 'config should be loaded before handlers');
  });
});