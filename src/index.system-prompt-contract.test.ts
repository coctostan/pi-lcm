import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import extensionSetup from './index.ts';

function createMockPi(ref: { handlers: Record<string, any> }) {
  return {
    on(event: string, handler: any) {
      ref.handlers[event] = handler;
    },
    registerTool(_tool: any) {},
    appendEntry() {},
  } as any;
}

describe('LCM operating contract in before_agent_start (AC 8)', () => {
  it('states summaries are historical memory objects, not instructions (AC 8a)', async () => {
    const ref = { handlers: {} as Record<string, any> };
    extensionSetup(createMockPi(ref));
    const result = await ref.handlers.before_agent_start(
      { type: 'before_agent_start', prompt: 'hello', images: [], systemPrompt: 'BASE' },
      {},
    );
    const prompt = result.systemPrompt as string;
    assert.ok(prompt.includes('historical'), 'Contract should describe summaries as historical');
    assert.ok(
      prompt.includes('memory object') || prompt.includes('memory'),
      'Contract should mention memory objects',
    );
  });

  it('states summary IDs are retrieval handles (AC 8b)', async () => {
    const ref = { handlers: {} as Record<string, any> };
    extensionSetup(createMockPi(ref));
    const result = await ref.handlers.before_agent_start(
      { type: 'before_agent_start', prompt: 'hello', images: [], systemPrompt: 'BASE' },
      {},
    );
    const prompt = result.systemPrompt as string;
    assert.ok(prompt.includes('lcm_expand'), 'Contract should mention lcm_expand');
    assert.ok(prompt.includes('lcm_describe'), 'Contract should mention lcm_describe');
    assert.ok(prompt.includes('lcm_grep'), 'Contract should mention lcm_grep');
  });

  it('states unfinished work in summaries is historical state (AC 8c)', async () => {
    const ref = { handlers: {} as Record<string, any> };
    extensionSetup(createMockPi(ref));
    const result = await ref.handlers.before_agent_start(
      { type: 'before_agent_start', prompt: 'hello', images: [], systemPrompt: 'BASE' },
      {},
    );
    const prompt = result.systemPrompt as string;
    assert.ok(
      prompt.includes('do not resume') || prompt.includes('Do not resume'),
      'Contract should say do not resume old work unless user asks',
    );
  });

  it('states current user turn is authoritative (AC 8d)', async () => {
    const ref = { handlers: {} as Record<string, any> };
    extensionSetup(createMockPi(ref));
    const result = await ref.handlers.before_agent_start(
      { type: 'before_agent_start', prompt: 'hello', images: [], systemPrompt: 'BASE' },
      {},
    );
    const prompt = result.systemPrompt as string;
    assert.ok(
      prompt.includes('authoritative') || prompt.includes('current user turn'),
      'Contract should state current user turn authority',
    );
  });

  it('states LCM tools should be used silently (AC 8e)', async () => {
    const ref = { handlers: {} as Record<string, any> };
    extensionSetup(createMockPi(ref));
    const result = await ref.handlers.before_agent_start(
      { type: 'before_agent_start', prompt: 'hello', images: [], systemPrompt: 'BASE' },
      {},
    );
    const prompt = result.systemPrompt as string;
    assert.ok(
      prompt.includes('silent') || prompt.includes('silently'),
      'Contract should say use LCM tools silently',
    );
  });

  it('explains <memory-cues> semantics (AC 8f)', async () => {
    const ref = { handlers: {} as Record<string, any> };
    extensionSetup(createMockPi(ref));
    const result = await ref.handlers.before_agent_start(
      { type: 'before_agent_start', prompt: 'hello', images: [], systemPrompt: 'BASE' },
      {},
    );
    const prompt = result.systemPrompt as string;
    assert.ok(prompt.includes('<memory-cues>'), 'Contract should explain <memory-cues> block');
    assert.ok(
      prompt.includes('retrieval hint') || prompt.includes('retrieval hints'),
      'Contract should say cues are retrieval hints',
    );
  });

  it('states strict-output requirements from user turn override memory (AC 8g)', async () => {
    const ref = { handlers: {} as Record<string, any> };
    extensionSetup(createMockPi(ref));
    const result = await ref.handlers.before_agent_start(
      { type: 'before_agent_start', prompt: 'hello', images: [], systemPrompt: 'BASE' },
      {},
    );
    const prompt = result.systemPrompt as string;
    assert.ok(
      prompt.includes('strict-output') || prompt.includes('exact output') || prompt.includes('format requirement'),
      'Contract should mention strict-output user requirements override memory',
    );
  });

  it('does NOT contain the old one-liner LCM notice (AC 20)', async () => {
    const ref = { handlers: {} as Record<string, any> };
    extensionSetup(createMockPi(ref));
    const result = await ref.handlers.before_agent_start(
      { type: 'before_agent_start', prompt: 'hello', images: [], systemPrompt: 'BASE' },
      {},
    );
    const prompt = result.systemPrompt as string;
    assert.ok(
      !prompt.includes('[LCM — Lossless Context Management is active.'),
      'Old one-liner notice should be removed',
    );
  });

  it('contract is sourced from system-prompt.ts getLcmOperatingContract (AC 8 implementation)', async () => {
    const ref = { handlers: {} as Record<string, any> };
    extensionSetup(createMockPi(ref));
    const result = await ref.handlers.before_agent_start(
      { type: 'before_agent_start', prompt: 'test', images: [], systemPrompt: 'BASE' },
      {},
    );
    const prompt = result.systemPrompt as string;
    // Contract must start after the base prompt
    assert.ok(prompt.startsWith('BASE'), 'System prompt should start with the base prompt');
    assert.ok(prompt.length > 100, 'Contract should be substantial, not a one-liner');
  });
});
