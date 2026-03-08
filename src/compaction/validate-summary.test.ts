import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSummaryContent } from './validate-summary.ts';

describe('validateSummaryContent', () => {
  it('returns invalid for apology openers', () => {
    assert.deepStrictEqual(
      validateSummaryContent("I apologize, but I cannot summarize that.", 'leaf'),
      { valid: false, reason: 'apology_opener' },
    );

    assert.deepStrictEqual(
      validateSummaryContent("I'm sorry, but here is a summary.", 'condensed'),
      { valid: false, reason: 'apology_opener' },
    );
  });

  it('returns invalid for capability disclaimers', () => {
    assert.deepStrictEqual(
      validateSummaryContent("I don't have access to the repository state.", 'leaf'),
      { valid: false, reason: 'capability_disclaimer' },
    );

    assert.deepStrictEqual(
      validateSummaryContent('I cannot execute that command from here.', 'condensed'),
      { valid: false, reason: 'capability_disclaimer' },
    );
  });

  it('returns invalid for role-played tool markers', () => {
    assert.deepStrictEqual(
      validateSummaryContent('[toolCall:read {"path":"src/index.ts"}]', 'leaf'),
      { valid: false, reason: 'tool_roleplay_marker' },
    );

    assert.deepStrictEqual(
      validateSummaryContent('[tool_use: bash {"command":"git status"}]', 'condensed'),
      { valid: false, reason: 'tool_roleplay_marker' },
    );
  });

  it('returns invalid for assistant self-narration', () => {
    assert.deepStrictEqual(
      validateSummaryContent('I need to read the file before I can summarize it.', 'leaf'),
      { valid: false, reason: 'assistant_self_narration' },
    );

    assert.deepStrictEqual(
      validateSummaryContent('Let me do that and then I will report back.', 'condensed'),
      { valid: false, reason: 'assistant_self_narration' },
    );
  });

  it('returns valid for factual technical summaries that mention tools, commands, reads, or errors', () => {
    assert.deepStrictEqual(
      validateSummaryContent(
        'Read src/index.ts, ran git status, and fixed the import error before rerunning tests successfully.',
        'leaf',
      ),
      { valid: true },
    );

    assert.deepStrictEqual(
      validateSummaryContent(
        'The summary covers bash output, file reads, and an earlier error without role-played tool text.',
        'condensed',
      ),
      { valid: true },
    );
  });
});
