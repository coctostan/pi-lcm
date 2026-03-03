import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { TextContent, ImageContent } from '@mariozechner/pi-ai';

export type SessionToolName = 'read' | 'bash' | 'grep';
export type SessionContentSize = 'small' | 'medium' | 'large';

export interface BuildSessionOptions {
  contentSize?: SessionContentSize;
  toolTypes?: SessionToolName[];
  includeErrors?: boolean;
  includeImages?: boolean;
}

const BASE_TS = 1_700_000_000_000; // deterministic, no Date.now()

function makeUsage() {
  return {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function minCharsForSize(size: SessionContentSize): number {
  switch (size) {
    case 'small':
      return 200;
    case 'medium':
      return 1500;
    case 'large':
      return 5 * 1024;
  }
}

function repeatToMinLength(prefix: string, minLen: number): string {
  if (prefix.length >= minLen) return prefix;
  const chunk = '\n' + '0123456789abcdef'.repeat(32);
  let out = prefix;
  while (out.length < minLen) out += chunk;
  return out.slice(0, minLen);
}

export function buildSession(turns: number, options: BuildSessionOptions = {}): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const contentSize: SessionContentSize = options.contentSize ?? 'small';
  const toolTypes: SessionToolName[] = options.toolTypes?.length ? options.toolTypes : ['read'];
  const includeErrors = options.includeErrors ?? false;
  const includeImages = options.includeImages ?? false;

  for (let turn = 0; turn < turns; turn++) {
    const ts = BASE_TS + turn * 1000;

    messages.push({
      role: 'user' as const,
      content: `User turn ${turn}`,
      timestamp: ts,
    });

    messages.push({
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: `Assistant turn ${turn}` }],
      api: 'anthropic-messages' as const,
      provider: 'anthropic',
      model: 'claude-sonnet',
      usage: makeUsage(),
      stopReason: 'stop' as const,
      timestamp: ts + 1,
    } as AgentMessage);

    const toolCallId = `toolu_${String(turn).padStart(3, '0')}_0`;
    const toolName = toolTypes[turn % toolTypes.length];
    const minLen = minCharsForSize(contentSize);
    const text = repeatToMinLength(`${toolName} result for turn ${turn} (${contentSize})\n`, minLen);

    const isError = includeErrors && turn % 2 === 0;

    const content: (TextContent | ImageContent)[] = [{ type: 'text' as const, text }];
    if (includeImages) {
      content.push({
        type: 'image' as const,
        data: `BASE64_${toolCallId}`,
        mimeType: 'image/png',
      });
    }

    messages.push({
      role: 'toolResult' as const,
      toolCallId,
      toolName,
      content,
      isError,
      timestamp: ts + 2,
    } as AgentMessage);
  }

  return messages;
}
