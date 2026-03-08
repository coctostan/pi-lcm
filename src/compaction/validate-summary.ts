import type { SummaryKind } from '../store/types.ts';

export type SummaryValidationResult =
  | { valid: true }
  | {
      valid: false;
      reason:
        | 'apology_opener'
        | 'capability_disclaimer'
        | 'tool_roleplay_marker'
        | 'assistant_self_narration';
    };

const APOLOGY_OPENERS = [/^\s*i apologize\b/i, /^\s*i['’]?m sorry\b/i];
const CAPABILITY_DISCLAIMERS = [/\bi don't have access\b/i, /\bi cannot execute\b/i];
const TOOL_ROLEPLAY_MARKERS = [/\[toolCall:/i, /\[tool_use:/i];
const ASSISTANT_SELF_NARRATION = [/\bi need to read\b/i, /\blet me do that\b/i];

export function validateSummaryContent(
  content: string,
  _kind: SummaryKind,
): SummaryValidationResult {
  for (const pattern of APOLOGY_OPENERS) {
    if (pattern.test(content)) return { valid: false, reason: 'apology_opener' };
  }

  for (const pattern of CAPABILITY_DISCLAIMERS) {
    if (pattern.test(content)) return { valid: false, reason: 'capability_disclaimer' };
  }

  for (const pattern of TOOL_ROLEPLAY_MARKERS) {
    if (pattern.test(content)) return { valid: false, reason: 'tool_roleplay_marker' };
  }

  for (const pattern of ASSISTANT_SELF_NARRATION) {
    if (pattern.test(content)) return { valid: false, reason: 'assistant_self_narration' };
  }

  return { valid: true };
}
