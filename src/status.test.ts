import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatStatusBar } from './status.ts';
import type { ContextHandlerStats } from './context/context-handler.ts';
import type { ContextUsage } from '@mariozechner/pi-coding-agent';

describe('formatStatusBar', () => {
  it('returns undefined when stats.strippedCount is 0 (AC 2)', () => {
    const stats: ContextHandlerStats = { strippedCount: 0, estimatedTokensSaved: 0 };

    const text = formatStatusBar(stats, undefined, 32);

    assert.strictEqual(text, undefined);
  });

  it('starts with 🟢 when contextUsage is undefined (AC 3)', () => {
    const stats: ContextHandlerStats = { strippedCount: 1, estimatedTokensSaved: 0 };

    const text = formatStatusBar(stats, undefined, 32);

    assert.ok(typeof text === 'string', 'expected a string status when strippedCount > 0');
    assert.ok(text.startsWith('🟢'), `expected status to start with 🟢, got: ${text}`);
  });

  it('includes percent and counts when contextUsage.percent is a number < 60 (AC 5, 8, 10)', () => {
    const stats: ContextHandlerStats = { strippedCount: 5, estimatedTokensSaved: 0 };
    const usage: ContextUsage = { tokens: 1000, contextWindow: 2000, percent: 50 };

    const text = formatStatusBar(stats, usage, 32);

    assert.ok(typeof text === 'string');
    assert.ok(text.startsWith('🟢'), `expected 🟢 prefix, got: ${text}`);
    assert.ok(text.includes('50%'), `expected percent segment, got: ${text}`);
    assert.ok(text.includes('5 stripped'), `expected stripped count segment, got: ${text}`);
    assert.ok(text.includes('tail: 32'), `expected tail segment, got: ${text}`);
  });

  it('omits the percentage segment when contextUsage is undefined (AC 9)', () => {
    const stats: ContextHandlerStats = { strippedCount: 5, estimatedTokensSaved: 0 };

    const text = formatStatusBar(stats, undefined, 32);

    assert.ok(typeof text === 'string');
    assert.ok(text.startsWith('🟢'), `expected 🟢 prefix, got: ${text}`);
    assert.ok(!text.includes('%'), `expected no % segment, got: ${text}`);
    assert.ok(text.includes('5 stripped'), `expected stripped count segment, got: ${text}`);
    assert.ok(text.includes('tail: 32'), `expected tail segment, got: ${text}`);
  });

  it('starts with 🟢 and omits the percentage segment when contextUsage.percent is null (AC 4, 9)', () => {
    const stats: ContextHandlerStats = { strippedCount: 5, estimatedTokensSaved: 0 };
    const usage: ContextUsage = { tokens: null, contextWindow: 2000, percent: null };

    const text = formatStatusBar(stats, usage, 32);

    assert.ok(typeof text === 'string');
    assert.ok(text.startsWith('🟢'), `expected 🟢 prefix, got: ${text}`);
    assert.ok(!text.includes('%'), `expected no % segment, got: ${text}`);
    assert.ok(text.includes('5 stripped'), `expected stripped count segment, got: ${text}`);
    assert.ok(text.includes('tail: 32'), `expected tail segment, got: ${text}`);
  });

  it('starts with 🟡 when percent is between 60 (inclusive) and 85 (exclusive) (AC 6)', () => {
    const stats: ContextHandlerStats = { strippedCount: 5, estimatedTokensSaved: 0 };
    const usage: ContextUsage = { tokens: 1000, contextWindow: 2000, percent: 60 };

    const text = formatStatusBar(stats, usage, 32);

    assert.ok(typeof text === 'string');
    assert.ok(text.startsWith('🟡'), `expected 🟡 prefix, got: ${text}`);
    assert.ok(text.includes('60%'), `expected percent segment, got: ${text}`);
  });

  it('starts with 🔴 when percent is 85 or greater (AC 7)', () => {
    const stats: ContextHandlerStats = { strippedCount: 5, estimatedTokensSaved: 0 };
    const usage: ContextUsage = { tokens: 1000, contextWindow: 2000, percent: 85 };

    const text = formatStatusBar(stats, usage, 32);

    assert.ok(typeof text === 'string');
    assert.ok(text.startsWith('🔴'), `expected 🔴 prefix, got: ${text}`);
    assert.ok(text.includes('85%'), `expected percent segment, got: ${text}`);
  });

  it('returns summary format with 🟢 when summaryCount > 0 and percent < 60 (AC 6)', () => {
    const stats: ContextHandlerStats = {
      strippedCount: 0,
      estimatedTokensSaved: 0,
      summaryCount: 5,
      maxDepth: 2,
    };
    const usage: ContextUsage = { tokens: 1000, contextWindow: 2000, percent: 50 };

    const text = formatStatusBar(stats, usage, 32);

    assert.strictEqual(text, '🟢 50% | 5 summaries (d2) | tail: 32');
  });

  it('returns summary format with 🟡 when summaryCount > 0 and percent in 60–84 (AC 6)', () => {
    const stats: ContextHandlerStats = {
      strippedCount: 0,
      estimatedTokensSaved: 0,
      summaryCount: 3,
      maxDepth: 0,
    };
    const usage: ContextUsage = { tokens: 1400, contextWindow: 2000, percent: 70 };

    const text = formatStatusBar(stats, usage, 8);

    assert.strictEqual(text, '🟡 70% | 3 summaries (d0) | tail: 8');
  });

  it('returns summary format with 🔴 when summaryCount > 0 and percent >= 85 (AC 6)', () => {
    const stats: ContextHandlerStats = {
      strippedCount: 0,
      estimatedTokensSaved: 0,
      summaryCount: 8,
      maxDepth: 1,
    };
    const usage: ContextUsage = { tokens: 1800, contextWindow: 2000, percent: 90 };

    const text = formatStatusBar(stats, usage, 16);

    assert.strictEqual(text, '🔴 90% | 8 summaries (d1) | tail: 16');
  });

  it('returns summary format without percent when summaryCount > 0 and contextUsage is undefined (AC 7)', () => {
    const stats: ContextHandlerStats = {
      strippedCount: 0,
      estimatedTokensSaved: 0,
      summaryCount: 3,
      maxDepth: 1,
    };

    const text = formatStatusBar(stats, undefined, 32);

    assert.strictEqual(text, '🟢 3 summaries (d1) | tail: 32');
  });

  it('returns summary format without percent when summaryCount > 0 and percent is null (AC 7)', () => {
    const stats: ContextHandlerStats = {
      strippedCount: 0,
      estimatedTokensSaved: 0,
      summaryCount: 5,
      maxDepth: 0,
    };
    const usage: ContextUsage = { tokens: null, contextWindow: 2000, percent: null };

    const text = formatStatusBar(stats, usage, 8);

    assert.strictEqual(text, '🟢 5 summaries (d0) | tail: 8');
  });
});
