import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import extensionSetup from './index.ts';

describe('src/index.ts wiring (AC 15)', () => {
  it('registers lcm_expand tool and shares store with ContextHandler', async () => {
    let capturedContextHandler: ((event: any, ctx: any) => Promise<any>) | null = null;
    let capturedTool: any = null;

    const mockPi = {
      on(event: string, handler: any) {
        if (event === 'context') capturedContextHandler = handler;
      },
      registerTool(tool: any) {
        if (tool.name === 'lcm_expand') capturedTool = tool;
      },
    } as any;

    extensionSetup(mockPi);

    // AC 15: verify the tool was registered
    assert.ok(capturedTool !== null, 'lcm_expand tool was registered');
    assert.strictEqual(capturedTool.name, 'lcm_expand');
    assert.ok(capturedContextHandler !== null, 'context handler was registered');

    // AC 15: verify ContextHandler and lcm_expand share the same store
    // Build 35 messages so the tool result at index 0 falls into the "old" zone
    // (default freshTailCount=32, so indices 0-2 are old with 35 total)
    const messages: AgentMessage[] = [
      {
        role: 'toolResult' as const,
        toolCallId: 'toolu_AC15',
        toolName: 'read_file',
        content: [{ type: 'text' as const, text: 'shared store content' }],
        isError: false,
        timestamp: 0,
      },
    ];
    for (let i = 1; i < 35; i++) {
      messages.push({ role: 'user' as const, content: `msg ${i}`, timestamp: i } as AgentMessage);
    }

    // Run context handler — should strip toolu_AC15 into the shared store
    const event = { messages };
    const ctx = {
      ui: { setStatus(_key: string, _text: string | undefined) {} },
      getContextUsage() {
        return undefined;
      },
    } as any;
    const handler = capturedContextHandler as unknown as (event: any, ctx: any) => Promise<any>;
    const handlerResult = await handler(event, ctx);

    // Pi uses the RETURN VALUE to get modified messages
    assert.ok(handlerResult, 'Handler must return a ContextEventResult');
    assert.ok(handlerResult.messages, 'Return value must include messages');

    const stripped = (handlerResult.messages[0] as any).content[0].text;
    assert.ok(
      stripped.startsWith('[Content stripped by LCM.'),
      `Expected stripped placeholder, got: ${stripped}`
    );

    // lcm_expand uses the SAME store — must retrieve the stripped content
    const expandResult = await capturedTool.execute('c1', { id: 'toolu_AC15' }, null, null, null);
    const text = expandResult.content[0].text;
    assert.ok(
      text.includes('shared store content'),
      `Expected expand to retrieve stored content, got: ${text}`
    );
  });
});
