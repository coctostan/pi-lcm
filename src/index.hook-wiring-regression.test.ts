import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import extensionSetup from './index.ts';
import { MemoryStore } from './store/memory-store.ts';

function collectHandlers(opts?: { dagStore?: any }) {
  const handlers: Record<string, any> = {};
  const tools: string[] = [];
  const mockPi = {
    on(event: string, handler: any) {
      handlers[event] = handler;
    },
    registerTool(tool: any) {
      tools.push(tool.name);
    },
    appendEntry() {},
  } as any;

  const internal = opts?.dagStore ? { dagStore: opts.dagStore } : undefined;
  extensionSetup(mockPi, undefined, internal);

  return { handlers, tools };
}

const EXPECTED_HANDLERS = [
  'agent_end',
  'before_agent_start',
  'before_provider_request',
  'context',
  'session_before_compact',
  'session_shutdown',
  'session_start',
  'session_tree',
  'tool_result',
].sort();

describe('Hook wiring regression — all handlers registered on both init paths', () => {
  it('registers all 9 handlers on default path (no dagStore)', () => {
    const { handlers } = collectHandlers();
    const registered = Object.keys(handlers).sort();
    assert.deepStrictEqual(registered, EXPECTED_HANDLERS);
  });

  it('registers all 9 handlers when _internal.dagStore is provided', () => {
    const dagStore = new MemoryStore();
    dagStore.openConversation('sess_1', '/tmp/test');
    const { handlers } = collectHandlers({ dagStore });
    const registered = Object.keys(handlers).sort();
    assert.deepStrictEqual(registered, EXPECTED_HANDLERS);
  });

  it('registers all 3 tools on default path', () => {
    const { tools } = collectHandlers();
    assert.ok(tools.includes('lcm_expand'), 'lcm_expand registered');
    assert.ok(tools.includes('lcm_grep'), 'lcm_grep registered');
    assert.ok(tools.includes('lcm_describe'), 'lcm_describe registered');
  });
});
