import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import extensionSetup from './index.ts';
import { MemoryStore } from './store/memory-store.ts';
import { ExpandResultSchema } from './schemas.ts';

describe('src/index.ts — ContextBuilder wiring (AC 24)', () => {
  it('uses ContextBuilder with DAG Store in context event handler', async () => {
    let capturedContextHandler: ((event: any, ctx: any) => Promise<any>) | null = null;

    const mockPi = {
      on(event: string, handler: any) {
        if (event === 'context') capturedContextHandler = handler;
      },
      registerTool(_tool: any) {},
    } as any;

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    const summaryId = dagStore.insertSummary({
      depth: 0,
      kind: 'leaf',
      content: 'Summary of early messages about project setup.',
      tokenCount: 30,
      earliestAt: 100,
      latestAt: 200,
      descendantCount: 3,
      createdAt: 300,
    });
    dagStore.replaceContextItems([{ kind: 'summary', summaryId }]);

    extensionSetup(mockPi, undefined, { dagStore });

    assert.ok(capturedContextHandler !== null, 'context handler was registered');
    const messages: AgentMessage[] = [
      { role: 'user' as const, content: 'latest message', timestamp: 1000 } as AgentMessage,
    ];
    const event = { messages };
    const ctx = {
      ui: { setStatus(_key: string, _text: string | undefined) {} },
      getContextUsage() {
        return undefined;
      },
    } as any;
    const handler = capturedContextHandler as unknown as (event: any, ctx: any) => Promise<any>;
    const handlerResult = await handler(event, ctx);

    // Pi uses the RETURN VALUE, not event.messages mutation
    assert.ok(handlerResult, 'Handler must return a ContextEventResult');
    assert.ok(handlerResult.messages, 'Return value must include messages');

    const summaryMsg = handlerResult.messages.find(
      (m: any) => m.role === 'assistant' && Array.isArray(m.content) && m.content[0]?.type === 'text',
    );
    assert.ok(summaryMsg, 'Expected assistant summary message in return value');
    const parsed = JSON.parse((summaryMsg as any).content[0].text);
    assert.strictEqual(parsed.id, summaryId);
  });

  it('falls back to Phase 1 behavior when no DAG Store', async () => {
    let capturedContextHandler: ((event: any, ctx: any) => Promise<any>) | null = null;

    const mockPi = {
      on(event: string, handler: any) {
        if (event === 'context') capturedContextHandler = handler;
      },
      registerTool(_tool: any) {},
    } as any;

    extensionSetup(mockPi);

    const messages: AgentMessage[] = [
      { role: 'user' as const, content: 'hello', timestamp: 1 } as AgentMessage,
    ];
    const event = { messages };
    const ctx = {
      ui: { setStatus(_key: string, _text: string | undefined) {} },
      getContextUsage() {
        return undefined;
      },
    } as any;

    assert.ok(capturedContextHandler !== null, 'context handler was registered');
    const handler = capturedContextHandler as unknown as (event: any, ctx: any) => Promise<any>;
    const handlerResult = await handler(event, ctx);

    // Pi uses the RETURN VALUE, not event.messages mutation
    assert.ok(handlerResult, 'Handler must return a ContextEventResult');
    assert.ok(handlerResult.messages, 'Return value must include messages');
    assert.strictEqual(handlerResult.messages.length, 1);
    assert.strictEqual((handlerResult.messages[0] as any).content, 'hello');
  });
});

describe('src/index.ts — conditional tool registration (AC 25)', () => {
  it('registers lcm_grep and lcm_describe when DAG Store is available', () => {
    const registeredTools: string[] = [];
    const mockPi = {
      on(_event: string, _handler: any) {},
      registerTool(tool: any) {
        registeredTools.push(tool.name);
      },
    } as any;

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    extensionSetup(mockPi, undefined, { dagStore });

    assert.ok(registeredTools.includes('lcm_expand'), 'lcm_expand should always be registered');
    assert.ok(registeredTools.includes('lcm_grep'), 'lcm_grep should be registered with DAG Store');
    assert.ok(registeredTools.includes('lcm_describe'), 'lcm_describe should be registered with DAG Store');
  });

  it('registers lcm_grep and lcm_describe eagerly even when no DAG Store (gated by dagReady)', () => {
    const registeredTools: string[] = [];
    const mockPi = {
      on(_event: string, _handler: any) {},
      registerTool(tool: any) {
        registeredTools.push(tool.name);
      },
    } as any;
    extensionSetup(mockPi);
    assert.ok(registeredTools.includes('lcm_expand'), 'lcm_expand should always be registered');
    assert.ok(registeredTools.includes('lcm_grep'), 'lcm_grep should be registered eagerly (gated by dagReady)');
    assert.ok(registeredTools.includes('lcm_describe'), 'lcm_describe should be registered eagerly (gated by dagReady)');
  });

  it('keeps legacy plain-text lcm_expand output when no DAG Store is available (AC 28 guard)', async () => {
    let capturedExpandTool: any = null;

    const mockPi = {
      on(_event: string, _handler: any) {},
      registerTool(tool: any) {
        if (tool.name === 'lcm_expand') capturedExpandTool = tool;
      },
    } as any;

    extensionSetup(mockPi);

    assert.ok(capturedExpandTool !== null, 'lcm_expand should be registered');

    const result = await capturedExpandTool.execute('c1', { id: 'missing_id' }, null, null, null);
    const text = result.content[0].text;

    assert.ok(text.includes('No content found for ID "missing_id"'));
    assert.strictEqual(text.trim().startsWith('{'), false, 'No-DAG path should remain plain text, not JSON');
  });
});

describe('src/index.ts — lcm_expand DAG Store wiring (AC 26)', () => {
  it('lcm_expand can serve sum_ IDs when DAG Store is wired', async () => {
    let capturedExpandTool: any = null;

    const mockPi = {
      on(_event: string, _handler: any) {},
      registerTool(tool: any) {
        if (tool.name === 'lcm_expand') capturedExpandTool = tool;
      },
    } as any;

    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/project');

    extensionSetup(mockPi, undefined, { dagStore });

    assert.ok(capturedExpandTool !== null, 'lcm_expand should be registered');

    // Call with a sum_ prefixed ID that doesn't exist — proves DAG path is active
    const result = await capturedExpandTool.execute('c1', { id: 'sum_fake' }, null, null, null);
    const text = result.content[0].text;
    const parsed = JSON.parse(text);

    const validated = ExpandResultSchema.parse(parsed);
    assert.ok('error' in validated, 'Should get structured error from DAG path');
    assert.strictEqual((validated as any).error, 'Summary not found');
    assert.strictEqual((validated as any).id, 'sum_fake');
  });
});
