/**
 * `CoachModel` on top of `@anthropic-ai/sdk` (owner: COACH). docs/API.md §10.
 *
 * - One client, created only when `ANTHROPIC_API_KEY` is set and `AI_ENABLED` is true. Every
 *   option is explicit so no stray environment variable (ANTHROPIC_BASE_URL, ANTHROPIC_LOG,
 *   ANTHROPIC_AUTH_TOKEN…) changes where the key goes or what gets logged.
 * - Structured outputs (`output_config.format` from the zod schema) with a frozen system prompt
 *   marked `cache_control`. The request goes through `messages.create` and the text is parsed
 *   here, so `stop_reason` is checked first and a truncated answer still reports its usage (the
 *   `parse()` helper throws on truncated JSON before usage can be read).
 * - Opus 5 and Fable 5.1 calls opt into server-side refusal fallbacks (`fallbacks: 'default'`):
 *   a request the model declines may be answered by the fallback model Anthropic picks for that
 *   refusal category. Each attempt is priced at its own model's rate.
 * - The SDK retries once (429, 529, 5xx, network) inside a hard deadline.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Config } from '../config';
import type { CoachModel, CoachModelAttempt, CoachModelRequest, CoachModelResult } from './model';
import { CoachModelError } from './model';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
/** Beta header of the `fallbacks: 'default'` form (claude-api skill, 2026-09). */
export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Models documented to take `fallbacks: 'default'`. Other ids run without it. */
const SERVER_FALLBACK_MODELS: ReadonlySet<string> = new Set(['claude-opus-5', 'claude-fable-5-1']);

/** Haiku 4.5 (and older Haiku/Sonnet 4.5) reject `effort`. */
const takesEffort = (model: string): boolean => !/^claude-(haiku-|sonnet-4-5)/.test(model);
/** Sampling parameters are rejected from Opus 4.7 / Sonnet 5 on; Haiku still takes them. */
const takesTemperature = (model: string): boolean => model.startsWith('claude-haiku-');

export interface AnthropicCoachOptions {
  /** Tests point it at a local fake server. */
  baseURL?: string;
  maxRetries?: number;
}

/** The production model, or null when the key is missing or the kill switch is on. */
export function createAnthropicCoachModel(
  ai: Config['ai'],
  options: AnthropicCoachOptions = {},
): CoachModel | null {
  if (!ai.apiKey || !ai.enabled) return null;
  const client = new Anthropic({
    apiKey: ai.apiKey,
    authToken: null,
    baseURL: options.baseURL ?? ANTHROPIC_BASE_URL,
    maxRetries: options.maxRetries ?? 1,
    timeout: 60_000,
    logLevel: 'off',
  });
  return { run: (request) => runOnce(client, request) };
}

/** The request body, exported for the request-shape tests. */
export function buildParams<T>(request: CoachModelRequest<T>): MessageCreateParamsNonStreaming {
  const fallbacks = SERVER_FALLBACK_MODELS.has(request.model);
  const params: MessageCreateParamsNonStreaming = {
    model: request.model,
    max_tokens: request.maxTokens,
    system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: request.user }],
    metadata: { user_id: request.userHash },
    output_config: {
      format: betaZodOutputFormat(request.schema),
      ...(request.effort && takesEffort(request.model) ? { effort: request.effort } : {}),
    },
  };
  // Phrase interpretation wants the most literal reading.
  if (request.feature === 'interpret' && takesTemperature(request.model)) params.temperature = 0;
  if (fallbacks) {
    params.betas = [SERVER_FALLBACK_BETA];
    params.fallbacks = 'default';
  }
  return params;
}

async function runOnce<T>(
  client: Anthropic,
  request: CoachModelRequest<T>,
): Promise<CoachModelResult<T>> {
  let message: BetaMessage;
  try {
    message = await client.beta.messages.create(buildParams(request), {
      timeout: request.deadlineMs,
      signal: AbortSignal.timeout(request.deadlineMs),
    });
  } catch (err) {
    throw toModelError(err);
  }
  return readMessage(message, request);
}

/** Maps the answer to ok / refused / incomplete. Exported for tests. */
export function readMessage<T>(
  message: BetaMessage,
  request: Pick<CoachModelRequest<T>, 'schema'>,
): CoachModelResult<T> {
  const attempts = attemptsOf(message);
  // Always check the stop reason before reading content.
  if (message.stop_reason === 'refusal') return { kind: 'refused', attempts };
  if (message.stop_reason !== 'end_turn') return { kind: 'incomplete', attempts };
  // With a fallback the content may start with a `fallback` marker; the answer is the last
  // text block.
  let text: string | null = null;
  for (const block of message.content) if (block.type === 'text') text = block.text;
  if (text === null) return { kind: 'incomplete', attempts };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'incomplete', attempts };
  }
  const parsed = request.schema.safeParse(json);
  if (!parsed.success) return { kind: 'incomplete', attempts };
  return { kind: 'ok', output: parsed.data, attempts };
}

/**
 * Billed attempts. `usage.iterations` lists every attempt when fallbacks ran; otherwise the
 * top-level usage is the only one.
 */
export function attemptsOf(message: BetaMessage): CoachModelAttempt[] {
  const usage = message.usage;
  const out: CoachModelAttempt[] = [];
  for (const it of usage.iterations ?? []) {
    if (it.type !== 'message' && it.type !== 'fallback_message') continue;
    out.push({
      model: it.model ?? message.model,
      inputTokens: it.input_tokens,
      outputTokens: it.output_tokens,
      cacheReadTokens: it.cache_read_input_tokens ?? 0,
      cacheWriteTokens: it.cache_creation_input_tokens ?? 0,
    });
  }
  if (out.length > 0) return out;
  return [
    {
      model: message.model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    },
  ];
}

/** Most specific first. Only class names and status codes survive (never messages). */
export function toModelError(err: unknown): CoachModelError {
  if (err instanceof CoachModelError) return err;
  const type = err instanceof Error ? err.constructor.name : 'unknown';
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return new CoachModelError('misconfigured', type, err.status);
  }
  if (err instanceof Anthropic.RateLimitError) return new CoachModelError('unavailable', type, 429);
  if (err instanceof Anthropic.InternalServerError) {
    return new CoachModelError('unavailable', type, err.status);
  }
  // Timeouts, aborts (our deadline) and network failures. Checked before APIError: in the
  // TypeScript SDK they are subclasses of it.
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.APIUserAbortError) {
    return new CoachModelError('unavailable', type, null);
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : null;
    // 408/409 and anything ≥ 500 not typed above (529 overloaded) are transient.
    if (status !== null && (status >= 500 || status === 408 || status === 409)) {
      return new CoachModelError('unavailable', type, status);
    }
    return new CoachModelError('rejected', type, status);
  }
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new CoachModelError('unavailable', type, null);
  }
  return new CoachModelError('rejected', type, null);
}
