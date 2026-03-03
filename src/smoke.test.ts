/**
 * Real usage smoke test — simulates a full pi session lifecycle with pi-lcm loaded.
 *
 * This test exercises the complete flow:
 * 1. Extension loads and registers handlers + tools
 * 2. Short session (< freshTailCount) — zero interference
 * 3. Long session (> freshTailCount) — old tool results stripped
 * 4. Model calls lcm_expand to retrieve stripped content
 * 5. Status bar updates correctly at each step
 * 6. Multiple context events (simulating multi-turn) with accumulating strips
 * 7. Re-processing same messages is idempotent (no double-strip)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import extensionSetup from './index.ts';
import { DEFAULT_CONFIG } from './config.ts';

interface CapturedTool {
	name: string;
	description: string;
	execute: (toolCallId: string, params: any, signal?: any, onUpdate?: any, ctx?: any) => Promise<any>;
}

function createMockPi() {
	const handlers: Record<string, (event: any, ctx: any) => Promise<void>> = {};
	const tools: CapturedTool[] = [];

	return {
		pi: {
			on(event: string, handler: any) {
				handlers[event] = handler;
			},
			registerTool(tool: any) {
				tools.push(tool);
			},
		} as any,
		handlers,
		tools,
	};
}

function createMockCtx(contextPercent?: number) {
	const statusCalls: Array<[string, string | undefined]> = [];
	return {
		ctx: {
			ui: {
				setStatus(key: string, text: string | undefined) {
					statusCalls.push([key, text]);
				},
			},
			getContextUsage() {
				if (contextPercent === undefined) return undefined;
				return { tokens: contextPercent * 10, contextWindow: 1000, percent: contextPercent };
			},
		} as any,
		statusCalls,
	};
}

/** Build a realistic multi-turn session with user→assistant→toolResult turns */
function buildRealisticSession(turnCount: number): AgentMessage[] {
	const msgs: AgentMessage[] = [];
	for (let i = 0; i < turnCount; i++) {
		msgs.push({
			role: 'user' as const,
			content: `Turn ${i}: Please read the file src/module-${i}.ts`,
			timestamp: i * 3,
		} as AgentMessage);
		msgs.push({
			role: 'assistant' as const,
			content: `I'll read src/module-${i}.ts for you.`,
			toolCalls: [{ id: `toolu_${i}`, name: 'read', arguments: { path: `src/module-${i}.ts` } }],
			timestamp: i * 3 + 1,
		} as unknown as AgentMessage);
		msgs.push({
			role: 'toolResult' as const,
			toolCallId: `toolu_${i}`,
			toolName: 'read',
			content: [{
				type: 'text' as const,
				text: `// src/module-${i}.ts\nexport function handler${i}() {\n  // ${
					'x'.repeat(500) // ~500 chars of content per tool result
				}\n  return ${i};\n}\n`,
			}],
			isError: false,
			timestamp: i * 3 + 2,
		} as AgentMessage);
	}
	return msgs;
}

describe('🔥 Real usage smoke test', () => {
	it('Scenario 1: Short session — zero interference', async () => {
		const { pi, handlers, tools } = createMockPi();
		extensionSetup(pi, { ...DEFAULT_CONFIG });

		assert.ok(handlers['context'], 'context handler registered');
		assert.ok(tools.find(t => t.name === 'lcm_expand'), 'lcm_expand tool registered');

		// 5-turn session (15 messages) — well under freshTailCount of 32
		const session = buildRealisticSession(5);
		const event = { messages: [...session] };
		const { ctx, statusCalls } = createMockCtx(30);

		await handlers['context'](event, ctx);

		// Messages should be completely unchanged
		assert.strictEqual(event.messages.length, session.length);
		for (let i = 0; i < session.length; i++) {
			const orig = session[i];
			const result = event.messages[i];
			if ('role' in orig && orig.role === 'toolResult' && 'role' in result && result.role === 'toolResult') {
				const origContent = (orig as any).content;
				const resContent = (result as any).content;
				assert.deepStrictEqual(resContent, origContent, `toolResult at index ${i} should be unchanged`);
			}
		}

		// Status bar should be cleared (undefined) since nothing was stripped
		assert.deepStrictEqual(statusCalls, [['lcm', undefined]]);
	});

	it('Scenario 2: Long session — old tool results stripped, lcm_expand retrieves them', async () => {
		const { pi, handlers, tools } = createMockPi();
		extensionSetup(pi, { ...DEFAULT_CONFIG });

		// 20-turn session (60 messages) — exceeds freshTailCount of 32
		const session = buildRealisticSession(20);
		const originalToolResults = new Map<string, string>();

		// Save original tool result content for verification
		for (const msg of session) {
			if ('role' in msg && msg.role === 'toolResult') {
				const tr = msg as any;
				originalToolResults.set(tr.toolCallId, tr.content[0].text);
			}
		}

		const event = { messages: [...session] };
		const { ctx, statusCalls } = createMockCtx(72);

		await handlers['context'](event, ctx);

		// Message count should be the same
		assert.strictEqual(event.messages.length, session.length);

		// Check that old tool results are stripped and fresh tail ones are not
		const freshTailStart = session.length - 32;
		let strippedCount = 0;
		const strippedIds: string[] = [];

		for (let i = 0; i < event.messages.length; i++) {
			const msg = event.messages[i];
			if ('role' in msg && msg.role === 'toolResult') {
				const tr = msg as any;
				if (i < freshTailStart) {
					// Old zone — should be stripped
					assert.strictEqual(tr.content.length, 1);
					assert.ok(
						tr.content[0].text.includes('[Content stripped by LCM.'),
						`Old toolResult at index ${i} should be stripped, got: ${tr.content[0].text.slice(0, 80)}`
					);
					assert.ok(
						tr.content[0].text.includes('lcm_expand'),
						'Placeholder should mention lcm_expand'
					);
					strippedCount++;
					strippedIds.push(tr.toolCallId);
				} else {
					// Fresh tail — should be unchanged
					assert.ok(
						!tr.content[0].text.includes('[Content stripped by LCM.'),
						`Fresh tail toolResult at index ${i} should NOT be stripped`
					);
				}
			}
		}

		assert.ok(strippedCount > 0, `Expected some stripped results, got ${strippedCount}`);
		console.log(`  ✓ ${strippedCount} tool results stripped from old zone`);

		// Status bar should show stripping info
		assert.strictEqual(statusCalls.length, 1);
		assert.strictEqual(statusCalls[0][0], 'lcm');
		const statusText = statusCalls[0][1]!;
		assert.ok(statusText.includes('🟡'), `Expected 🟡 for 72%, got: ${statusText}`);
		assert.ok(statusText.includes('72%'), `Expected 72%, got: ${statusText}`);
		assert.ok(statusText.includes('stripped'), `Expected 'stripped', got: ${statusText}`);
		console.log(`  ✓ Status bar: ${statusText}`);

		// Now simulate model calling lcm_expand to retrieve stripped content
		const expandTool = tools.find(t => t.name === 'lcm_expand')!;
		for (const id of strippedIds) {
			const result = await expandTool.execute(`call_${id}`, { id });
			assert.ok(result.content, 'expand result should have content');
			const text = result.content[0].text;
			const original = originalToolResults.get(id)!;
			// The expanded text should match the original (possibly truncated)
			assert.ok(
				original.startsWith(text) || text === original,
				`Expanded content for ${id} should match original`
			);
		}
		console.log(`  ✓ lcm_expand successfully retrieved ${strippedIds.length} stripped entries`);
	});

	it('Scenario 3: Multi-turn accumulation — context event fires each turn, strips accumulate', async () => {
		const { pi, handlers } = createMockPi();
		extensionSetup(pi, { ...DEFAULT_CONFIG });

		// Start with 33 messages (just 1 in old zone)
		const session = buildRealisticSession(11); // 33 msgs
		let event = { messages: [...session] };
		let { ctx, statusCalls } = createMockCtx(50);

		await handlers['context'](event, ctx);

		let statusText = statusCalls[0]?.[1];
		console.log(`  Turn 11 (33 msgs): ${statusText ?? 'hidden'}`);

		// Add 3 more turns (now 42 messages, 10 in old zone)
		const moreTurns = buildRealisticSession(14); // 42 msgs total
		event = { messages: [...moreTurns] };
		({ ctx, statusCalls } = createMockCtx(65));

		await handlers['context'](event, ctx);

		statusText = statusCalls[0]?.[1];
		assert.ok(statusText, 'Status should be visible after stripping');
		assert.ok(statusText!.includes('🟡'), 'Expected 🟡 at 65%');
		console.log(`  Turn 14 (42 msgs): ${statusText}`);

		// Add lots more (now 90 messages)
		const bigSession = buildRealisticSession(30); // 90 msgs
		event = { messages: [...bigSession] };
		({ ctx, statusCalls } = createMockCtx(92));

		await handlers['context'](event, ctx);

		statusText = statusCalls[0]?.[1];
		assert.ok(statusText!.includes('🔴'), 'Expected 🔴 at 92%');
		console.log(`  Turn 30 (90 msgs): ${statusText}`);
	});

	it('Scenario 4: Idempotency — re-processing same stripped messages does not double-strip', async () => {
		const { pi, handlers } = createMockPi();
		extensionSetup(pi, { ...DEFAULT_CONFIG });

		const session = buildRealisticSession(15); // 45 msgs, 13 in old zone
		const event1 = { messages: [...session] };
		const { ctx: ctx1 } = createMockCtx(60);

		await handlers['context'](event1, ctx1);

		// Now feed the ALREADY-STRIPPED messages back through context event
		// (simulates what happens if pi calls context again with the same messages)
		const event2 = { messages: [...event1.messages] };
		const { ctx: ctx2, statusCalls: statusCalls2 } = createMockCtx(60);

		await handlers['context'](event2, ctx2);

		// Should still work — placeholders should pass through unchanged
		for (let i = 0; i < event1.messages.length; i++) {
			const msg1 = event1.messages[i];
			const msg2 = event2.messages[i];
			if ('role' in msg1 && msg1.role === 'toolResult') {
				assert.deepStrictEqual(
					(msg2 as any).content,
					(msg1 as any).content,
					`Message at ${i} should be identical after re-processing`
				);
			}
		}
		console.log(`  ✓ Re-processing 45 messages produced identical output`);
	});

	it('Scenario 5: lcm_expand with unknown ID gives helpful error', async () => {
		const { pi, tools } = createMockPi();
		extensionSetup(pi, { ...DEFAULT_CONFIG });

		const expandTool = tools.find(t => t.name === 'lcm_expand')!;
		const result = await expandTool.execute('call_1', { id: 'nonexistent_id' });
		const text = result.content[0].text;

		assert.ok(text.includes('No content found'), `Expected 'No content found', got: ${text}`);
		console.log(`  ✓ Error message: ${text.slice(0, 80)}`);
	});

	it('Scenario 6: Mixed message types — only toolResults stripped, user/assistant preserved', async () => {
		const { pi, handlers } = createMockPi();
		extensionSetup(pi, { ...DEFAULT_CONFIG });

		const session = buildRealisticSession(15);
		const event = { messages: [...session] };
		const { ctx } = createMockCtx(55);

		await handlers['context'](event, ctx);

		const freshTailStart = session.length - 32;
		for (let i = 0; i < Math.min(freshTailStart, event.messages.length); i++) {
			const msg = event.messages[i];
			if ('role' in msg) {
				if (msg.role === 'user') {
					// User messages should never be modified
					assert.strictEqual(
						(msg as any).content,
						(session[i] as any).content,
						`User message at ${i} should be unchanged`
					);
				}
				if (msg.role === 'assistant') {
					// Assistant messages should never be modified
					assert.strictEqual(
						(msg as any).content,
						(session[i] as any).content,
						`Assistant message at ${i} should be unchanged`
					);
				}
			}
		}
		console.log(`  ✓ User and assistant messages in old zone are untouched`);
	});
});
