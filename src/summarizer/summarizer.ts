import type {
  Api,
  AssistantMessage,
  Model,
  ProviderStreamOptions,
} from '@mariozechner/pi-ai';
import type { ModelRegistry } from '@mariozechner/pi-coding-agent';
import { getCondensePrompt, getLeafPrompt } from './prompts.ts';
import { estimateTokens } from './token-estimator.ts';
import { debugLog } from '../debug.ts';

/**
 * Options for the summarize method.
 * AC 14: includes depth, kind, maxOutputTokens, and optional signal.
 */
export interface SummarizeOptions {
  depth: number;
  kind: 'leaf' | 'condensed';
  maxOutputTokens: number;
  signal?: AbortSignal;
}

/**
 * Summarizer interface — single method abstraction for LLM-based text summarization.
 * AC 13: exposes a single method: summarize(content, opts) → Promise<string>.
 */
export interface Summarizer {
  summarize(content: string, opts: SummarizeOptions): Promise<string>;
}

/** Function signature matching pi-ai complete() for dependency injection. */
export type CompleteFn = (
  model: Model<Api>,
  context: {
    systemPrompt?: string;
    messages: Array<{ role: string; content: string; timestamp: number }>;
  },
  options?: ProviderStreamOptions,
) => Promise<AssistantMessage>;

export interface PiSummarizerOptions {
  modelRegistry: Pick<ModelRegistry, 'find' | 'getApiKeyAndHeaders'>;
  summaryModel: string; // "provider/modelId"
  completeFn?: CompleteFn;
}

export class SummarizationUnavailableError extends Error {
  readonly reason: 'error_response' | 'missing_text';
  readonly stopReason?: string;
  readonly providerErrorMessage?: string;
  constructor(
    reason: 'error_response' | 'missing_text',
    stopReason?: string,
    providerErrorMessage?: string,
  ) {
    super(
      reason === 'error_response'
        ? `Summarization failed: ${providerErrorMessage ?? 'provider returned stopReason="error".'}`
        : 'Summarization returned no text content.',
    );
    this.name = 'SummarizationUnavailableError';
    this.reason = reason;
    this.stopReason = stopReason;
    this.providerErrorMessage = providerErrorMessage;
  }
}

/**
 * PiSummarizer — production Summarizer using pi-ai complete().
 * AC 15: resolves model via modelRegistry.find(provider, modelId), throws if not found.
 */
export class PiSummarizer implements Summarizer {
  private model: Model<Api>;
  private completeFn: CompleteFn;
  private getApiKeyAndHeaders: Pick<ModelRegistry, 'getApiKeyAndHeaders'>['getApiKeyAndHeaders'];

  constructor(opts: PiSummarizerOptions) {
    const slashIdx = opts.summaryModel.indexOf('/');
    if (slashIdx === -1) {
      throw new Error(
        `Invalid summaryModel format: ${opts.summaryModel}. Expected "provider/modelId".`,
      );
    }
    const provider = opts.summaryModel.slice(0, slashIdx);
    const modelId = opts.summaryModel.slice(slashIdx + 1);
    const model = opts.modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(`Model not found: ${opts.summaryModel}`);
    }
    this.model = model;
    this.completeFn =
      opts.completeFn ??
      (() => {
        throw new Error('completeFn not provided');
      });
    this.getApiKeyAndHeaders = opts.modelRegistry.getApiKeyAndHeaders.bind(opts.modelRegistry);
  }

  async summarize(content: string, opts: SummarizeOptions): Promise<string> {
    debugLog('summarize start', {
      kind: opts.kind,
      depth: opts.depth,
      inputChars: content.length,
      inputTokensEstimated: estimateTokens(content),
      maxOutputTokens: opts.maxOutputTokens,
    });
    const systemPrompt = opts.kind === 'leaf' ? getLeafPrompt() : getCondensePrompt(opts.depth);

    const auth = await this.getApiKeyAndHeaders(this.model);
    if (!auth.ok) {
      throw new Error(auth.error);
    }
    const response = await this.completeFn(
      this.model,
      {
        systemPrompt,
        messages: [{ role: 'user', content, timestamp: Date.now() }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: opts.maxOutputTokens,
        signal: opts.signal,
      },
    );

    const textPart = response.content.find((c: any) => c.type === 'text');
    debugLog('summarize response', {
      kind: opts.kind,
      depth: opts.depth,
      stopReason: response.stopReason,
      errorMessage: response.errorMessage,
      usage: response.usage,
      responseParts: response.content.length,
      contentTypes: response.content.map((c: any) => c?.type ?? typeof c),
      textFound: Boolean(textPart && 'text' in textPart),
      outputChars: textPart && 'text' in textPart ? textPart.text.length : 0,
      outputTokensEstimated: textPart && 'text' in textPart ? estimateTokens(textPart.text) : 0,
    });
    if (response.stopReason === 'error') {
      throw new SummarizationUnavailableError(
        'error_response',
        'error',
        response.errorMessage,
      );
    }

    if (!textPart || !('text' in textPart) || textPart.text.trim().length === 0) {
      throw new SummarizationUnavailableError('missing_text');
    }

    return textPart.text;
}
}

/**
 * Three-level escalation for guaranteed summarization convergence.
 * AC 19: Level 1 calls summarizer normally, returns if output tokens < input tokens.
 */
export async function summarizeWithEscalation(
  summarizer: Summarizer,
  content: string,
  opts: SummarizeOptions,
): Promise<string> {
  const inputTokens = estimateTokens(content);

  // Level 1: Normal summarization
  const level1Result = await summarizer.summarize(content, opts);
  if (estimateTokens(level1Result) < inputTokens) {
    return level1Result;
  }

  // Level 2: Aggressive re-prompt with "compress harder" instruction
  const level2Content = `The following summary is still too long. Compress it to be much shorter while preserving only the most critical information:\n\n${level1Result}`;
  const level2Result = await summarizer.summarize(level2Content, opts);
  if (estimateTokens(level2Result) < inputTokens) {
    return level2Result;
  }

  // Level 3: Deterministic binary-search truncation (no LLM call)
  // Find the longest prefix where estimateTokens(prefix) <= maxOutputTokens
  return truncateToTokenLimit(content, opts.maxOutputTokens);
}

/**
 * Binary-search truncation: find the longest prefix of text
 * where estimateTokens(prefix) <= maxTokens.
 * Guaranteed to converge for any input.
 */
function truncateToTokenLimit(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;

  let lo = 0;
  let hi = text.length;

  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return text.slice(0, lo);
}
