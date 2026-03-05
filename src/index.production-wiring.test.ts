import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import extensionSetup from './index.ts';

describe('production wiring: eager tool registration with dagReady gate (AC 7, AC 8)', () => {
  it('registers all three DAG tools without _internal and gates lcm_grep/lcm_describe before session_start', async () => {
    const tools: Record<string, any> = {};

    const mockPi = {
      on(_event: string, _handler: any) {},
      registerTool(tool: any) {
        tools[tool.name] = tool;
      },
      appendEntry() {},
    } as any;

    extensionSetup(mockPi);

    // AC 7: All three DAG tools registered eagerly
    assert.ok(tools['lcm_expand'], 'lcm_expand should be registered');
    assert.ok(tools['lcm_grep'], 'lcm_grep should be registered');
    assert.ok(tools['lcm_describe'], 'lcm_describe should be registered');

    // AC 8: lcm_grep returns "LCM initializing" before session_start
    const grepResult = await tools['lcm_grep'].execute('c1', { query: 'test' }, new AbortController().signal, () => {}, {} as any);
    const grepText = grepResult.content[0].text;
    assert.ok(grepText.includes('LCM initializing'), `Expected "LCM initializing" in grep response, got: ${grepText}`);

    // AC 8: lcm_describe returns "LCM initializing" before session_start
    const descResult = await tools['lcm_describe'].execute('c2', { id: 'sum_1' }, new AbortController().signal, () => {}, {} as any);
    const descText = descResult.content[0].text;
    assert.ok(descText.includes('LCM initializing'), `Expected "LCM initializing" in describe response, got: ${descText}`);
  });
});

describe('production wiring: session_start creates SqliteStore + PiSummarizer (AC 1-6, 9)', () => {
  const testDir = join(tmpdir(), `lcm-prod-wiring-test-${process.pid}`);

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('creates SqliteStore and PiSummarizer in session_start, sets dagReady, tools operate against real store', async () => {
    const tools: Record<string, any> = {};
    const handlers: Record<string, any> = {};

    const mockPi = {
      on(event: string, handler: any) {
        handlers[event] = handler;
      },
      registerTool(tool: any) {
        tools[tool.name] = tool;
      },
      appendEntry() {},
    } as any;

    const mockCompleteFn = async (_model: any, _ctx: any, _opts: any) => ({
      content: [{ type: 'text' as const, text: 'mock summary' }],
    });

    const mockModel = { id: 'gemini-2.5-flash', provider: 'google', api: 'google' } as any;
    const mockModelRegistry = {
      find(provider: string, modelId: string) {
        if (provider === 'google' && modelId === 'gemini-2.5-flash') return mockModel;
        return undefined;
      },
    } as any;

    // Initialize WITHOUT _internal.dagStore — production path
    extensionSetup(mockPi, undefined, { dbDir: testDir, completeFn: mockCompleteFn } as any);

    // Before session_start: lcm_grep should return "LCM initializing"
    const beforeResult = await tools['lcm_grep'].execute('c1', { query: 'test' }, new AbortController().signal, () => {}, {} as any);
    assert.ok(beforeResult.content[0].text.includes('LCM initializing'));

    // Fire session_start
    const mockCtx = {
      sessionManager: {
        getSessionId: () => 'test-session-prod',
        getBranch: () => [],
      },
      cwd: '/tmp/test-cwd',
      modelRegistry: mockModelRegistry,
      ui: { setStatus() {} },
      getContextUsage: () => undefined,
    } as any;

    await handlers['session_start']({ type: 'session_start' }, mockCtx);

    // AC 1: SqliteStore created at dbDir/<sessionId>.db
    assert.ok(existsSync(join(testDir, 'test-session-prod.db')), 'SQLite DB file should exist');

    // AC 2: Directory created automatically
    assert.ok(existsSync(testDir), 'DB directory should exist');

    // AC 6, 9: After dagReady, lcm_grep no longer returns "LCM initializing" (it operates against real store)
    const afterResult = await tools['lcm_grep'].execute('c2', { query: 'test' }, new AbortController().signal, () => {}, {} as any);
    assert.ok(!afterResult.content[0].text.includes('LCM initializing'), `Expected real grep result, got: ${afterResult.content[0].text}`);

    // Cleanup: fire session_shutdown
    await handlers['session_shutdown']({ type: 'session_shutdown' }, {} as any);
  });
});

describe('production wiring: graceful degradation on SqliteStore failure (AC 10, 12)', () => {
  it('dagReady stays false and Phase 1 behavior continues when SqliteStore creation fails', async () => {
    const tools: Record<string, any> = {};
    const handlers: Record<string, any> = {};

    const mockPi = {
      on(event: string, handler: any) {
        handlers[event] = handler;
      },
      registerTool(tool: any) {
        tools[tool.name] = tool;
      },
      appendEntry() {},
    } as any;

    const mockCompleteFn = async (_model: any, _ctx: any, _opts: any) => ({
      content: [{ type: 'text' as const, text: 'mock summary' }],
    });

    // Use a file path as dbDir — mkdirSync will fail because it's not a directory
    const blockingFile = join(tmpdir(), `lcm-blocking-file-${process.pid}-${Date.now()}`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(blockingFile, 'not a directory');

    const logged: string[] = [];
    const origError = console.error;
    console.error = (...args: any[]) => {
      logged.push(args.map(String).join(' '));
    };

    try {
      extensionSetup(mockPi, undefined, { dbDir: blockingFile, completeFn: mockCompleteFn } as any);

      const mockCtx = {
        sessionManager: {
          getSessionId: () => 'fail-session',
          getBranch: () => [],
        },
        cwd: '/tmp/test-cwd',
        modelRegistry: { find: () => ({}) } as any,
        ui: { setStatus() {} },
        getContextUsage: () => undefined,
      } as any;

      // Should not throw
      await handlers['session_start']({ type: 'session_start' }, mockCtx);

      // AC 10: dagReady stays false — lcm_grep still returns "LCM initializing"
      const grepResult = await tools['lcm_grep'].execute('c1', { query: 'test' }, new AbortController().signal, () => {}, {} as any);
      assert.ok(grepResult.content[0].text.includes('LCM initializing'), 'dagReady should stay false after SqliteStore failure');

      // AC 12: Failure logged with pi-lcm: prefix
      assert.ok(logged.some(msg => msg.includes('pi-lcm:')), `Expected pi-lcm: prefix in logged errors, got: ${JSON.stringify(logged)}`);

      // Phase 1 lcm_expand still works (no crash)
      const expandResult = await tools['lcm_expand'].execute('c2', { id: 'nonexistent' }, new AbortController().signal, () => {}, {} as any);
      assert.ok(expandResult.content[0].text.includes('No content found'), 'Phase 1 lcm_expand should still work');
    } finally {
      console.error = origError;
      try {
        rmSync(blockingFile, { force: true });
      } catch {}
    }
  });
});


describe('production wiring: graceful degradation on PiSummarizer failure (AC 11, 12)', () => {
  const testDir = join(tmpdir(), `lcm-summarizer-fail-test-${process.pid}`);

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('dagReady stays false when PiSummarizer construction fails (model not found)', async () => {
    const tools: Record<string, any> = {};
    const handlers: Record<string, any> = {};

    const mockPi = {
      on(event: string, handler: any) {
        handlers[event] = handler;
      },
      registerTool(tool: any) {
        tools[tool.name] = tool;
      },
      appendEntry() {},
    } as any;

    const mockCompleteFn = async (_model: any, _ctx: any, _opts: any) => ({
      content: [{ type: 'text' as const, text: 'mock summary' }],
    });

    // modelRegistry.find returns undefined — PiSummarizer will throw "Model not found"
    const failingModelRegistry = {
      find: () => undefined,
    } as any;

    const logged: string[] = [];
    const origError = console.error;
    console.error = (...args: any[]) => {
      logged.push(args.map(String).join(' '));
    };

    try {
      extensionSetup(mockPi, undefined, { dbDir: testDir, completeFn: mockCompleteFn } as any);

      const mockCtx = {
        sessionManager: {
          getSessionId: () => 'fail-summarizer-session',
          getBranch: () => [],
        },
        cwd: '/tmp/test-cwd',
        modelRegistry: failingModelRegistry,
        ui: { setStatus() {} },
        getContextUsage: () => undefined,
      } as any;

      // Should not throw
      await handlers['session_start']({ type: 'session_start' }, mockCtx);

      // AC 11: dagReady stays false — lcm_grep still returns "LCM initializing"
      const grepResult = await tools['lcm_grep'].execute('c1', { query: 'test' }, new AbortController().signal, () => {}, {} as any);
      assert.ok(grepResult.content[0].text.includes('LCM initializing'), 'dagReady should stay false after PiSummarizer failure');

      // AC 12: Failure logged with pi-lcm: prefix
      assert.ok(logged.some(msg => msg.includes('pi-lcm:')), `Expected pi-lcm: prefix in logged errors, got: ${JSON.stringify(logged)}`);
    } finally {
      console.error = origError;
    }
  });
});


describe('production wiring: session_shutdown closes production store (AC 18)', () => {
  const testDir = join(tmpdir(), `lcm-shutdown-test-${process.pid}`);

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('closes the production SqliteStore on session_shutdown', async () => {
    const tools: Record<string, any> = {};
    const handlers: Record<string, any> = {};

    const mockPi = {
      on(event: string, handler: any) {
        handlers[event] = handler;
      },
      registerTool(tool: any) {
        tools[tool.name] = tool;
      },
      appendEntry() {},
    } as any;

    const mockCompleteFn = async (_model: any, _ctx: any, _opts: any) => ({
      content: [{ type: 'text' as const, text: 'mock summary' }],
    });

    const mockModel = { id: 'gemini-2.5-flash', provider: 'google', api: 'google' } as any;
    const mockModelRegistry = {
      find(provider: string, modelId: string) {
        if (provider === 'google' && modelId === 'gemini-2.5-flash') return mockModel;
        return undefined;
      },
    } as any;

    extensionSetup(mockPi, undefined, { dbDir: testDir, completeFn: mockCompleteFn } as any);

    const mockCtx = {
      sessionManager: {
        getSessionId: () => 'shutdown-test-session',
        getBranch: () => [],
      },
      cwd: '/tmp/test-cwd',
      modelRegistry: mockModelRegistry,
      ui: { setStatus() {} },
      getContextUsage: () => undefined,
    } as any;

    await handlers['session_start']({ type: 'session_start' }, mockCtx);

    // Verify store is working before shutdown
    const grepResult = await tools['lcm_grep'].execute('c1', { query: 'test' }, new AbortController().signal, () => {}, {} as any);
    assert.ok(!grepResult.content[0].text.includes('LCM initializing'), 'Store should be active before shutdown');

    // Fire session_shutdown
    await handlers['session_shutdown']({ type: 'session_shutdown' }, {} as any);

    // DB file exists and shutdown path completed without throwing
    assert.ok(existsSync(join(testDir, 'shutdown-test-session.db')), 'DB file should exist');
  });
});