import type {
  ChatFormat,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  StructuredOutputResult,
} from '@lab/shared';

import { validateAgainstSchema } from './jsonSchema.js';
import type { ModelProvider } from './provider.js';

/**
 * Structured output: parse, validate, and retry **once** with the error fed back
 * (decision 16 in docs/07-open-decisions.md).
 *
 * The measurement behind this is worth restating because it is the whole design:
 * with `think:true` the local model ignores the `format` schema completely and replies in
 * prose (0/5 valid); with `think:false` it is 5/5. `OllamaProvider` therefore always
 * sends `think:false`, which makes this retry path *defence in depth* rather than the
 * primary mechanism — but it stays, because "constrained decoding guarantees valid JSON"
 * is a claim about the decoder, not about the schema, and the M0 spike watched the claim
 * fail twice in five tries.
 *
 * The functions below are deliberately split so the interesting one is pure:
 * `validateStructuredOutput` and `buildRetryMessages` can be unit-tested with no
 * provider, no database and no server, and `runStructuredChat` is the thin piece of
 * orchestration left over.
 */

/** Everything the caller needs to persist: both attempts, and the verdict. */
export interface StructuredChatOutcome {
  /** One entry per model call: the first attempt, plus the retry if there was one. */
  attempts: ChatResponse[];
  /** The response to return to the client — the retry's, when there was one. */
  response: ChatResponse;
  result: StructuredOutputResult;
}

export interface ValidationOutcome {
  valid: boolean;
  value?: unknown;
  error?: string;
}

/**
 * `format` is either `'json'` (any JSON will do) or a schema the value must satisfy.
 *
 * Note that the *parse* failure and the *schema* failure produce different messages, and
 * both are shown verbatim in the exercise. "Not JSON at all" and "JSON, but missing
 * `dates`" call for different fixes, and collapsing them into "invalid output" is how a
 * learner concludes the model is simply unreliable.
 */
export function validateStructuredOutput(content: string, format: ChatFormat): ValidationOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown parse error';
    return {
      valid: false,
      error: `The response is not valid JSON (${reason}). First 200 characters: ${content.slice(0, 200)}`,
    };
  }

  if (format === 'json') return { valid: true, value: parsed };

  const { valid, errors } = validateAgainstSchema(parsed, format);
  if (valid) return { valid: true, value: parsed };
  return {
    valid: false,
    value: undefined,
    error: `The response is valid JSON but ${errors.join('; ')}`,
  };
}

/**
 * The retry prompt: the original conversation, the model's own failed answer, and the
 * error — in that order, because the model has to see what it said to see what was wrong
 * with it.
 *
 * Kept blunt on purpose ("Reply with JSON only"). A longer, cleverer repair prompt is a
 * tempting thing to tune, and tuning it is exactly the kind of work that feels productive
 * and is unmeasurable without an eval set.
 */
export function buildRetryMessages(
  messages: ChatMessage[],
  failedContent: string,
  error: string,
): ChatMessage[] {
  return [
    ...messages,
    { role: 'assistant', content: failedContent },
    {
      role: 'user',
      content:
        `Your previous reply did not match the requested JSON schema: ${error}\n\n` +
        'Reply again with JSON only. No prose, no code fences, no explanation.',
    },
  ];
}

/**
 * Runs a `format`-constrained chat, validating and retrying at most once.
 *
 * At most one retry, not "until it works": an unbounded repair loop against a model that
 * takes 45 seconds per call is a denial of service you inflicted on yourself, and if two
 * attempts cannot produce the shape then the schema or the prompt is the problem.
 */
export async function runStructuredChat(
  provider: ModelProvider,
  req: ChatRequest,
  signal?: AbortSignal,
): Promise<StructuredChatOutcome> {
  const format = req.format;
  if (format === undefined) {
    throw new Error('runStructuredChat requires a format; use provider.chat directly otherwise');
  }

  const first = await provider.chat(req, signal);
  const firstCheck = validateStructuredOutput(first.message.content, format);
  if (firstCheck.valid) {
    return {
      attempts: [first],
      response: first,
      result: { valid: true, value: firstCheck.value, retried: false },
    };
  }

  const retryRequest: ChatRequest = {
    ...req,
    messages: buildRetryMessages(
      req.messages,
      first.message.content,
      firstCheck.error ?? 'unknown validation error',
    ),
  };
  const second = await provider.chat(retryRequest, signal);
  const secondCheck = validateStructuredOutput(second.message.content, format);

  return {
    attempts: [first, second],
    response: second,
    result: secondCheck.valid
      ? { valid: true, value: secondCheck.value, retried: true }
      : { valid: false, error: secondCheck.error, retried: true },
  };
}
