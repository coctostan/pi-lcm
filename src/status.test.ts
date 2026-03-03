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
});
