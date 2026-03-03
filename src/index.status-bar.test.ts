import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import extensionSetup from './index.ts';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { DEFAULT_CONFIG } from './config.ts';

describe('src/index.ts status bar wiring (AC 12)', () => {
  it('clears status via ctx.ui.setStatus("lcm", undefined) when strippedCount is 0', async () => {
    let capturedContextHandler: ((event: any, ctx: any) => Promise<void>) | null = null;

    const mockPi = {
      on(event: string, handler: any) {
        if (event === 'context') capturedContextHandler = handler;
      },
      registerTool(_tool: any) {},
    } as any;

    extensionSetup(mockPi, { ...DEFAULT_CONFIG });

    assert.ok(capturedContextHandler, 'context handler was registered');
    const handler = capturedContextHandler as (event: any, ctx: any) => Promise<void>;

    const calls: Array<[string, string | undefined]> = [];
    const ctx = {
      ui: {
        setStatus(key: string, text: string | undefined) {
          calls.push([key, text]);
        },
      },
      getContextUsage() {
        return undefined;
      },
    } as any;

    // messages.length <= freshTailCount => handler.process() returns strippedCount=0
    const event = {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    };

    await handler(event, ctx);

    assert.deepStrictEqual(calls, [['lcm', undefined]]);
  });
});


describe('src/index.ts status bar wiring (AC 11)', () => {
  it('sets ctx.ui.setStatus("lcm", text) after handler.process() when stripping occurs', async () => {
    let capturedContextHandler: ((event: any, ctx: any) => Promise<void>) | null = null;

    const mockPi = {
      on(event: string, handler: any) {
        if (event === 'context') capturedContextHandler = handler;
      },
      registerTool(_tool: any) {},
    } as any;

    extensionSetup(mockPi, { ...DEFAULT_CONFIG });
    assert.ok(capturedContextHandler, 'context handler was registered');
    const handler = capturedContextHandler as (event: any, ctx: any) => Promise<void>;

    // Build 35 messages => old zone length 3 with default freshTailCount=32.
    // Put one toolResult in the old zone so strippedCount becomes 1.
    const messages: AgentMessage[] = [
      {
        role: 'toolResult' as const,
        toolCallId: 'toolu_status',
        toolName: 'read_file',
        content: [{ type: 'text' as const, text: 'big tool result content' }],
        isError: false,
        timestamp: 0,
      },
    ];
    for (let i = 1; i < 35; i++) {
      messages.push({ role: 'user' as const, content: `msg ${i}`, timestamp: i } as AgentMessage);
    }

    const calls: Array<[string, string | undefined]> = [];
    const ctx = {
      ui: {
        setStatus(key: string, text: string | undefined) {
          calls.push([key, text]);
        },
      },
      getContextUsage() {
        return { tokens: 700, contextWindow: 1000, percent: 70 };
      },
    } as any;

    const event = { messages };
    await handler(event, ctx);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], 'lcm');
    assert.ok(typeof calls[0][1] === 'string', 'expected a string status when stripping occurs');

    const text = calls[0][1] as string;
    assert.ok(text.startsWith('🟡'), `expected 🟡 prefix, got: ${text}`);
    assert.ok(text.includes('70%'), `expected percent segment, got: ${text}`);
    assert.ok(text.includes('1 stripped'), `expected stripped count segment, got: ${text}`);
    assert.ok(text.includes('tail: 32'), `expected tail segment, got: ${text}`);
  });
});
