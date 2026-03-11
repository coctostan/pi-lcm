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

describe('Bug #038 — hook scaffolding for Upward-style pi-lcm model surface', () => {
  it('should register before_agent_start so the extension can extend the effective system prompt for a turn', async () => {
    const ref = { handlers: {} as Record<string, any> };
    extensionSetup(createMockPi(ref));

    assert.ok(ref.handlers.before_agent_start, 'expected before_agent_start handler to be registered');

    const result = await ref.handlers.before_agent_start(
      {
        type: 'before_agent_start',
        prompt: 'hello',
        images: [],
        systemPrompt: 'BASE SYSTEM PROMPT',
      },
      {},
    );

    assert.equal(typeof result?.systemPrompt, 'string');
    assert.notStrictEqual(result.systemPrompt, 'BASE SYSTEM PROMPT');
  });

  it('should register before_provider_request so the extension can inspect the final provider payload in tests/debug mode', async () => {
    const ref = { handlers: {} as Record<string, any> };
    extensionSetup(createMockPi(ref));

    assert.ok(ref.handlers.before_provider_request, 'expected before_provider_request handler to be registered');

    const payload = {
      system: 'BASE SYSTEM PROMPT',
      messages: [{ role: 'user', content: 'hello' }],
    };
    const result = await ref.handlers.before_provider_request(
      {
        type: 'before_provider_request',
        payload,
      },
      {},
    );

    assert.strictEqual(result, undefined, 'default debug path should inspect without mutating the payload');
  });
});
