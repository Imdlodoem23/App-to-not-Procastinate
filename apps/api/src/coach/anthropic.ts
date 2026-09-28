/**
 * `CoachModel` on top of `@anthropic-ai/sdk` (owner: COACH). docs/API.md §10.
 *
 * - One client, created only when `ANTHROPIC_API_KEY` is set and `AI_ENABLED` is true. Every
 *   option is explicit so no stray environment variable (ANTHROPIC_BASE_URL, ANTHROPIC_LOG,
 *   ANTHROPIC_AUTH_TOKEN…) changes where the key goes or what gets logged.
 * - Structured outputs (`output_config.format` from the zod schema) with a frozen system prompt
 *   marked `cache_control`. Requests are streamed (`client.beta.messages.stream`), and the
 *   usage is read from the events as they arrive, so a call that fails half way still says
 *   what it may have cost. The format is sent without its `parse` function and the text is
 *   parsed here, so `stop_reason` is checked first and a truncated answer still reports its
 *   usage (the SDK's own parsing throws on truncated JSON before usage can be read).
 * - Opus 5 and Fable 5.1 calls opt into server-side refusal fallbacks (`fallbacks: 'default'`):
 *   a request the model declines may be answered by the fallback model Anthropic picks for that
 *   refusal category. Each attempt is priced at its own model's rate.
 * - The SDK does not retry on its own. We retry once, inside the deadline, only what certainly
 *   was not billed: 429 and 529 before any output, and connections that never reached the API.
 * - Every failure carries `billing` and `attempts` (see `CoachBilling` in model.ts).
 */
import Anthropic, { AnthropicError } from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type {
  BetaJSONOutputFormat,
  BetaMessage,
  BetaUsage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Config } from '../config';
import type {
  CoachBilling,
  CoachModel,
  CoachModelAttempt,
  CoachModelRequest,
  CoachModelResult,
} from './model';
import { CoachModelError, SERVER_FALLBACK_TARGETS, worstCaseAttempt } from './model';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
/** Beta header of the `fallbacks: 'default'` form (claude-api skill, 2026-09). */
export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Haiku 4.5 (and older Haiku/Sonnet 4.5) reject `effort`. */
const takesEffort = (model: string): boolean => !/^claude-(haiku-|sonnet-4-5)/.test(model);
/** Sampling parameters are rejected from Opus 4.7 / Sonnet 5 on; Haiku still takes them. */
const takesTemperature = (model: string): boolean => model.startsWith('claude-haiku-');

/** The retry waits at most this long, and only if the deadline leaves room for the call. */
const RETRY_MAX_WAIT_MS = 5_000;
const RETRY_MIN_ROOM_MS = 10_000;

export interface AnthropicCoachOptions {
  /** Tests point it at a local fake server. */
  baseURL?: string;
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
    // Retries are ours (`run`): the SDK would also retry attempts that may have been billed.
    maxRetries: 0,
    timeout: 60_000,
    logLevel: 'off',
  });
  return { run: (request) => run(client, request) };
}

/** The request body, exported for the request-shape tests. */
export function buildParams<T>(request: CoachModelRequest<T>): MessageCreateParamsNonStreaming {
  // Without `parse` the SDK leaves the text alone; we parse it after checking `stop_reason`.
  const { type, schema } = betaZodOutputFormat(request.schema);
  const format: BetaJSONOutputFormat = { type, schema };
  const params: MessageCreateParamsNonStreaming = {
    model: request.model,
    max_tokens: request.maxTokens,
    system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: request.user }],
    metadata: { user_id: request.userHash },
    output_config: {
      format,
      ...(request.effort && takesEffort(request.model) ? { effort: request.effort } : {}),
    },
  };
  // Phrase interpretation wants the most literal reading.
  if (request.feature === 'interpret' && takesTemperature(request.model)) params.temperature = 0;
  if (SERVER_FALLBACK_TARGETS[request.model]) {
    params.betas = [SERVER_FALLBACK_BETA];
    params.fallbacks = 'default';
  }
  return params;
}

/** One call with its deadline, retried once when the first try certainly was not billed. */
async function run<T>(
  client: Anthropic,
  request: CoachModelRequest<T>,
): Promise<CoachModelResult<T>> {
  const endsAt = Date.now() + request.deadlineMs;
  const signal = AbortSignal.timeout(request.deadlineMs);
  try {
    return await streamOnce(client, request, signal, request.deadlineMs);
  } catch (err) {
    const wait = err instanceof CoachModelError ? retryWaitMs(err) : null;
    if (wait === null || endsAt - Date.now() < wait + RETRY_MIN_ROOM_MS) throw err;
    await new Promise((resolve) => setTimeout(resolve, wait));
    return streamOnce(client, request, signal, Math.max(1, endsAt - Date.now()));
  }
}

/** What the stream showed before it ended or failed. */
export interface Observed {
  /** The API answered 200 and the stream opened. */
  opened: boolean;
  /** `message_start`: the model serving the answer and its input usage. */
  start: { model: string; usage: BetaUsage } | null;
  /** Models a `fallback` block handed the answer to in the middle of the stream. */
  switchedTo: string[];
  /** `message_delta` arrived: the snapshot holds the final usage. */
  finished: boolean;
}

async function streamOnce<T>(
  client: Anthropic,
  request: CoachModelRequest<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CoachModelResult<T>> {
  const observed: Observed = { opened: false, start: null, switchedTo: [], finished: false };
  const stream = client.beta.messages.stream(buildParams(request), {
    timeout: timeoutMs,
    signal,
  });
  stream.on('connect', () => {
    observed.opened = true;
  });
  stream.on('streamEvent', (event) => {
    if (event.type === 'message_start') {
      observed.start = { model: event.message.model, usage: event.message.usage };
    } else if (event.type === 'content_block_start' && event.content_block.type === 'fallback') {
      observed.switchedTo.push(event.content_block.to.model);
    } else if (event.type === 'message_delta') {
      observed.finished = true;
    }
  });
  let message: BetaMessage;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    throw toModelError(err, billedOnFailure(err, request, observed, stream.currentMessage));
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
  // With a fallback the content may start with a `fallback` marker (and, after a switch in the
  // middle of the answer, the declined partial text); the answer is the last text block.
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

/** Statuses the API answers without running the model. */
const UNBILLED_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 402, 403, 404, 409, 413, 422, 429, 529,
]);
/** The same failures as an `error` event at the start of a stream. */
const UNBILLED_ERROR_TYPES: ReadonlySet<string> = new Set([
  'invalid_request_error',
  'authentication_error',
  'billing_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'overloaded_error',
]);
/** Network errors raised before the request left this machine. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** True when a code of `NOT_SENT_CODES` appears in the error's cause chain. */
function neverSent(err: unknown, depth = 0): boolean {
  if (depth > 5 || typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === 'string' && NOT_SENT_CODES.has(e.code)) return true;
  if (Array.isArray(e.errors) && e.errors.some((inner) => neverSent(inner, depth + 1))) {
    return true;
  }
  return neverSent(e.cause, depth + 1);
}

/** The API certainly did not run the model: nothing was billed. */
function certainlyUnbilled(err: unknown, observed: Observed): boolean {
  // Once `message_start` arrived the model may be writing.
  if (observed.start) return false;
  if (err instanceof Anthropic.APIConnectionError) {
    return (
      !(err instanceof Anthropic.APIConnectionTimeoutError) && !observed.opened && neverSent(err)
    );
  }
  if (err instanceof Anthropic.APIUserAbortError) return false;
  if (err instanceof Anthropic.APIError) {
    if (typeof err.status === 'number') return UNBILLED_STATUSES.has(err.status);
    return err.type !== null && UNBILLED_ERROR_TYPES.has(err.type);
  }
  return false;
}

/** What a failed call may have cost (see `CoachBilling`). Exported for tests. */
export function billedOnFailure(
  err: unknown,
  request: Pick<CoachModelRequest<unknown>, 'model' | 'maxTokens' | 'inputTokensBound'>,
  observed: Observed,
  snapshot: BetaMessage | undefined,
): { billing: CoachBilling; attempts: CoachModelAttempt[] } {
  if (observed.finished && snapshot) return { billing: 'exact', attempts: attemptsOf(snapshot) };
  if (certainlyUnbilled(err, observed)) return { billing: 'none', attempts: [] };
  return { billing: 'bound', attempts: boundAttempts(request, observed) };
}

/**
 * Upper bound of a call whose final usage never arrived: every model that may have run, each
 * with `maxTokens` of output (the output count only comes with `message_delta`). The input is
 * the one `message_start` reported, or the service's estimate. A `message_start` naming another
 * model means the requested one declined before writing anything; a `fallback` block in the
 * middle of the answer means a second model continued, reading the partial text as input.
 */
function boundAttempts(
  request: Pick<CoachModelRequest<unknown>, 'model' | 'maxTokens' | 'inputTokensBound'>,
  observed: Observed,
): CoachModelAttempt[] {
  const { maxTokens, inputTokensBound } = request;
  const start = observed.start;
  if (!start) return [worstCaseAttempt(request.model, inputTokensBound, maxTokens)];
  const out: CoachModelAttempt[] = [];
  if (start.model !== request.model) out.push(worstCaseAttempt(request.model, inputTokensBound, 0));
  out.push({
    model: start.model,
    inputTokens: start.usage.input_tokens,
    cacheReadTokens: start.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: start.usage.cache_creation_input_tokens ?? 0,
    outputTokens: maxTokens,
  });
  for (const model of observed.switchedTo) {
    out.push(worstCaseAttempt(model, inputTokensBound + maxTokens, maxTokens));
  }
  return out;
}

/**
 * How long to wait before the one retry, or null when the failure must not be retried: only
 * 429 and 529 (also as an `error` event before any output) and connections that never left.
 */
function retryWaitMs(err: CoachModelError): number | null {
  if (err.billing !== 'none' || err.reason !== 'unavailable') return null;
  if (err.retryAfterMs !== null)
    return err.retryAfterMs <= RETRY_MAX_WAIT_MS ? err.retryAfterMs : null;
  return 500;
}

/** `retry-after-ms` or `retry-after` (seconds) of an API error, if any. */
function retryAfterOf(err: unknown): number | null {
  if (!(err instanceof Anthropic.APIError) || !err.headers) return null;
  const ms = Number(err.headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms >= 0 && err.headers.get('retry-after-ms') !== null) return ms;
  const seconds = Number(err.headers.get('retry-after'));
  if (Number.isFinite(seconds) && seconds >= 0 && err.headers.get('retry-after') !== null) {
    return seconds * 1000;
  }
  return null;
}

/** Most specific first. Only class names and status codes survive (never messages). */
export function toModelError(
  err: unknown,
  billed: { billing: CoachBilling; attempts: readonly CoachModelAttempt[] } = {
    billing: 'none',
    attempts: [],
  },
): CoachModelError {
  if (err instanceof CoachModelError) return err;
  const type = err instanceof Error ? err.constructor.name : 'unknown';
  const make = (reason: CoachModelError['reason'], status: number | null) =>
    new CoachModelError(reason, type, status, billed, retryAfterOf(err));
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return make('misconfigured', err.status);
  }
  if (err instanceof Anthropic.RateLimitError) return make('unavailable', 429);
  if (err instanceof Anthropic.InternalServerError) return make('unavailable', err.status);
  // Timeouts, aborts (our deadline) and network failures. Checked before APIError: in the
  // TypeScript SDK they are subclasses of it.
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.APIUserAbortError) {
    return make('unavailable', null);
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : null;
    // 408/409 and anything ≥ 500 not typed above (529 overloaded) are transient.
    if (status !== null && (status >= 500 || status === 408 || status === 409)) {
      return make('unavailable', status);
    }
    if (status === null) {
      // An `error` event inside the stream: its type says what went wrong.
      if (err.type === 'authentication_error' || err.type === 'permission_error') {
        return make('misconfigured', null);
      }
      if (
        err.type === 'invalid_request_error' ||
        err.type === 'not_found_error' ||
        err.type === 'billing_error'
      ) {
        return make('rejected', null);
      }
      return make('unavailable', null);
    }
    return make('rejected', status);
  }
  if (err instanceof Error && err.name === 'TimeoutError') return make('unavailable', null);
  // The stream wraps a body cut off half way (or a stream that ended early) in AnthropicError.
  if (err instanceof AnthropicError) return make('unavailable', null);
  return make('rejected', null);
}
