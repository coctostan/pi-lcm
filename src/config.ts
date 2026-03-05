import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface LCMConfig {
  freshTailCount: number;
  maxExpandTokens: number;
  contextThreshold: number;
  leafChunkTokens: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  largeFileTokenThreshold: number;
  summaryModel: string;
  incrementalMaxDepth: number;
  condensedMinFanout: number;
  megapowersAware: boolean;
  crossSession: boolean;
}

export const DEFAULT_CONFIG: LCMConfig = {
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
};

const DEFAULT_CONFIG_PATH = join(
  homedir(), '.pi', 'agent', 'extensions', 'pi-lcm.config.json'
);

function isPositiveInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isValidThreshold(v: unknown): v is number {
  return typeof v === 'number' && v > 0 && v < 1;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

const POSITIVE_INT_FIELDS: (keyof LCMConfig)[] = [
  'freshTailCount', 'maxExpandTokens', 'leafChunkTokens',
  'leafTargetTokens', 'condensedTargetTokens', 'largeFileTokenThreshold',
  'condensedMinFanout',
];

const BOOLEAN_FIELDS: (keyof LCMConfig)[] = ['megapowersAware', 'crossSession'];

type FieldValidator = (v: unknown) => boolean;

const FIELD_VALIDATORS: Record<keyof LCMConfig, FieldValidator> = {
  freshTailCount: isPositiveInteger,
  maxExpandTokens: isPositiveInteger,
  leafChunkTokens: isPositiveInteger,
  leafTargetTokens: isPositiveInteger,
  condensedTargetTokens: isPositiveInteger,
  largeFileTokenThreshold: isPositiveInteger,
  condensedMinFanout: isPositiveInteger,
  contextThreshold: isValidThreshold,
  summaryModel: isNonEmptyString,
  incrementalMaxDepth: isInteger,
  megapowersAware: isBoolean,
  crossSession: isBoolean,
};
export function validateConfig(config: unknown): LCMConfig {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('Config must be a plain object');
  }
  const input = config as Record<string, unknown>;
  const result = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof LCMConfig)[]) {
    if (key in input) {
      (result as Record<string, unknown>)[key] = input[key];
    }
  }

  for (const field of POSITIVE_INT_FIELDS) {
    if (!isPositiveInteger(result[field])) {
      throw new Error(`"${field}" must be a positive integer, got ${JSON.stringify(result[field])}`);
    }
  }

  if (!isValidThreshold(result.contextThreshold)) {
    throw new Error(`"contextThreshold" must be a number between 0 and 1 (exclusive), got ${JSON.stringify(result.contextThreshold)}`);
  }

  if (!isNonEmptyString(result.summaryModel)) {
    throw new Error(`"summaryModel" must be a non-empty string, got ${JSON.stringify(result.summaryModel)}`);
  }

  if (!isInteger(result.incrementalMaxDepth)) {
    throw new Error(`"incrementalMaxDepth" must be an integer, got ${JSON.stringify(result.incrementalMaxDepth)}`);
  }

  for (const field of BOOLEAN_FIELDS) {
    if (!isBoolean(result[field])) {
      throw new Error(`"${field}" must be a boolean, got ${JSON.stringify(result[field])}`);
    }
  }
  return result;
}


export function loadConfig(filePath: string = DEFAULT_CONFIG_PATH): LCMConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return { ...DEFAULT_CONFIG };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('pi-lcm: config file contains invalid JSON, using defaults');
    return { ...DEFAULT_CONFIG };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn('pi-lcm: config file must contain a JSON object, using defaults');
    return { ...DEFAULT_CONFIG };
  }

  const input = parsed as Record<string, unknown>;
  const result = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof LCMConfig)[]) {
    if (key in input) {
      const validator = FIELD_VALIDATORS[key];
      if (validator(input[key])) {
        (result as Record<string, unknown>)[key] = input[key];
      } else {
        console.warn(`pi-lcm: invalid value for "${key}", using default`);
      }
    }
  }
  return result;
}
