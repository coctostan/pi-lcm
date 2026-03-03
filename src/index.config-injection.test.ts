import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

function createMockPi() {
  let capturedContextHandler: ((event: any, ctx: any) => Promise<void>) | null = null;

  const statusCalls: Array<[string, string | undefined]> = [];
  const ctx = {
    ui: {
      setStatus(key: string, text: string | undefined) {
        statusCalls.push([key, text]);
      },
    },
    getContextUsage() {
      return undefined;
    },
  } as any;

  const pi = {
    on(event: string, handler: any) {
      if (event === 'context') capturedContextHandler = handler;
    },
    registerTool(_tool: any) {},
  } as any;

  return { pi, ctx, statusCalls, getContextHandler: () => capturedContextHandler };
}

describe('extensionSetup config injection (test isolation)', () => {
  const originalHome = process.env.HOME;
  const testHome = join(tmpdir(), `pi-lcm-home-${Date.now()}`);

  after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    rmSync(testHome, { recursive: true, force: true });
  });

  it('uses the provided config and does not read ~/.pi/agent/extensions/pi-lcm.config.json', async () => {
    // Arrange: create a fake HOME that contains a non-default config file.
    process.env.HOME = testHome;
    const configDir = join(testHome, '.pi', 'agent', 'extensions');
    mkdirSync(configDir, { recursive: true });

    // If extensionSetup reads from disk, freshTailCount becomes 4 and it will strip below.
    writeFileSync(join(configDir, 'pi-lcm.config.json'), JSON.stringify({ freshTailCount: 4 }));

    // Import AFTER HOME is set (config.ts computes DEFAULT_CONFIG_PATH at module eval time).
    const { DEFAULT_CONFIG } = await import(`./config.ts?x=${Date.now()}`);
    const { default: extensionSetup } = await import(`./index.ts?x=${Date.now()}`);

    const { pi, ctx, statusCalls, getContextHandler } = createMockPi();

    // Act: inject defaults explicitly.
    extensionSetup(pi, { ...DEFAULT_CONFIG });

    const handler = getContextHandler();
    assert.ok(handler, 'context handler registered');

    // 10 messages is well under DEFAULT freshTailCount=32 => should be a no-op.
    const event = {
      messages: [
        {
          role: 'toolResult' as const,
          toolCallId: 'toolu_0',
          toolName: 'read',
          content: [{ type: 'text' as const, text: 'very large tool output' }],
          isError: false,
          timestamp: 0,
        },
        ...Array.from({ length: 9 }, (_, i) => ({
          role: 'user' as const,
          content: `msg ${i + 1}`,
          timestamp: i + 1,
        } as AgentMessage)),
      ],
    };

    await handler(event, ctx);

    // Assert: nothing stripped, status cleared.
    const first = event.messages[0] as any;
    assert.ok(!first.content[0].text.includes('[Content stripped by LCM.'), 'toolResult must not be stripped');
    assert.deepStrictEqual(statusCalls, [['lcm', undefined]]);
  });
});
