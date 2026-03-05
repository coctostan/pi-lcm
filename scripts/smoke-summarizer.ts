/**
 * Live smoke test: verifies Haiku 4.5 produces non-empty summaries.
 * Run with:  node --experimental-strip-types scripts/smoke-summarizer.ts
 */

import { complete, getModel, registerBuiltInApiProviders } from '@mariozechner/pi-ai';
import { PiSummarizer } from '../src/summarizer/summarizer.ts';
import { estimateTokens } from '../src/summarizer/token-estimator.ts';

registerBuiltInApiProviders();

const MODEL_ID = 'anthropic/claude-haiku-4-5';
const [provider, modelId] = MODEL_ID.split('/');

const model = getModel(provider, modelId);
if (!model) {
  console.error(`✗ Model not found: ${MODEL_ID}`);
  process.exit(1);
}
console.log(`✓ Model resolved: ${model.name} (${model.api})`);

const mockRegistry = {
  find(p: string, m: string) {
    if (p === provider && m === modelId) return model;
    return undefined;
  },
};

const summarizer = new PiSummarizer({
  modelRegistry: mockRegistry as any,
  summaryModel: MODEL_ID,
  completeFn: complete as any,
});

// Sample content that resembles a real conversation chunk
const SAMPLE_CONTENT = `
[user] Read the handoff.md file and tell me what's in it.
[assistant] The handoff describes the pi-lcm project status. Key points: PR #10 merged, 330 tests green, stress test suite added, live DB inspector added. The summaryModel was changed from google/gemini-2.5-flash to anthropic/claude-haiku-4-5 because no Google auth was configured.
[toolResult: read] # pi-lcm Real-World Testing Handoff. Created 2026-03-05. The project now has 330/330 tests passing, 21 stress tests covering high-volume ingestion, tool round-trips, and edge cases.
[assistant] Here's the summary of the handoff: 330 tests green, stress tests added, inspector added, bug fixes for FTS5 crash, lcm_expand routing, and tokenCount=0.
[user] yes, we need to test this thoroughly
[assistant] Let me kick off the test checklist: running full suite, stress tests, and the live DB inspector.
[toolResult: npm test] 330 pass, 0 fail, duration 2103ms
[toolResult: stress.test.ts] 21 pass, 0 fail, duration 877ms
[assistant] Both suites green. The inspector shows 8 databases. All have FTS5 functional and SQLite integrity OK. Old sessions have tokenCount=0 summaries from the Google model era.
`.trim();

console.log(`\nInput content: ${SAMPLE_CONTENT.length} chars, ~${estimateTokens(SAMPLE_CONTENT)} tokens`);
console.log('Calling Haiku 4.5 for leaf summarization...\n');

const t0 = Date.now();
try {
  const result = await summarizer.summarize(SAMPLE_CONTENT, {
    depth: 0,
    kind: 'leaf',
    maxOutputTokens: 500,
  });

  const elapsed = Date.now() - t0;
  const resultTokens = estimateTokens(result);

  if (!result || result.trim().length === 0) {
    console.error('✗ FAIL: summarizer returned empty string');
    process.exit(1);
  }

  if (resultTokens >= estimateTokens(SAMPLE_CONTENT)) {
    console.warn(`⚠ WARNING: output (${resultTokens} tok) >= input (${estimateTokens(SAMPLE_CONTENT)} tok) — escalation would fire`);
  }

  console.log(`✓ PASS: got ${result.length} chars / ~${resultTokens} tokens in ${elapsed}ms`);
  console.log('\n─── Summary output ───────────────────────────────────');
  console.log(result);
  console.log('──────────────────────────────────────────────────────');
} catch (err) {
  console.error(`✗ FAIL: summarizer threw`, err);
  process.exit(1);
}
