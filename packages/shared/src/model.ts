import { z } from 'zod';

/**
 * The provider-neutral model contracts (M9), transcribed from
 * `docs/01-architecture.md` → "The `ModelProvider` boundary".
 *
 * Two audiences share this file, which is why it is in `packages/shared`:
 *
 *  - **`apps/api/src/model/*`** implements `ModelProvider` against these types. Nothing
 *    here mentions Ollama, a port number, `think`, `keep_alive` or `num_predict` — those
 *    words exist in exactly one file (`apps/api/src/model/ollama.ts`), which is the point
 *    of the seam.
 *  - **`apps/web`** parses `POST /model/chat` and `GET /model/health` responses with the
 *    same schemas the API serialises them with, so a contract change is a type error on
 *    both sides rather than an `undefined` three components deep.
 *
 * Everything is a Zod schema with an inferred type rather than a bare `interface`,
 * because the HTTP routes need runtime validation anyway and two hand-kept copies of the
 * same shape drift.
 */

// ------------------------------------------------------------------ primitives ----

/** Which implementation is wired up. `none` is the deployed free tier (decision 1). */
export const ModelProviderNameSchema = z.enum(['ollama', 'fake', 'none']);
export type ModelProviderName = z.infer<typeof ModelProviderNameSchema>;

export const ChatRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

/**
 * A JSON Schema, carried as an opaque object.
 *
 * Deliberately not modelled field-by-field: the app passes it straight through to the
 * provider as `format` / tool `parameters`, and a partial model of JSON Schema would
 * reject valid schemas for no benefit. `apps/api/src/model/jsonSchema.ts` is the
 * validator that actually interprets the subset this app supports.
 */
export const JsonSchemaObjectSchema = z.record(z.unknown());
export type JsonSchemaObject = z.infer<typeof JsonSchemaObjectSchema>;

// ------------------------------------------------------------------- messages ----

/**
 * One requested tool invocation, already normalised.
 *
 * `args` is whatever the provider gave us (Ollama's `function.arguments` arrives as a
 * **parsed object** on `gemma4:latest`, but the spec allows a JSON string, so the adapter
 * handles both). `rawArgs` keeps the original text whenever we had to parse or recover it,
 * because "what exactly did the model emit" is the only useful thing to look at when a
 * parse fails — and it is what `agent_run_steps.tool_args_raw` stores.
 */
export const ToolCallSchema = z.object({
  /** Providers may not supply one; the adapter mints `call_<n>` in that case. */
  id: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown(),
  rawArgs: z.string().optional(),
  /** False when the arguments did not parse as JSON, or had to be recovered from prose. */
  parseOk: z.boolean(),
  /**
   * True when there was no native `tool_calls` array and the call was dug out of a fenced
   * JSON block in the content (docs/01 → "Parse-failure fallback"). Always accompanied by
   * `parseOk: false`, and counted as `tool_call_parse_failures_total{recovered="true"}`.
   */
  recovered: z.boolean().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string(),
  /** Only on assistant messages. */
  toolCalls: z.array(ToolCallSchema).optional(),
  /** Only on tool messages: which tool produced `content`. */
  toolName: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** A function tool in provider-neutral form; the adapter wraps it for its own API. */
export const ToolDefinitionSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  parameters: JsonSchemaObjectSchema,
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

/** `'json'` is "any JSON"; an object is a schema the decoder is constrained to. */
export const ChatFormatSchema = z.union([z.literal('json'), JsonSchemaObjectSchema]);
export type ChatFormat = z.infer<typeof ChatFormatSchema>;

/**
 * Sampling knobs, plus two that are about *this app* rather than about sampling:
 *
 *  - `scenario` selects a `FakeProvider` script. It is in the neutral options rather than
 *    in a fake-specific type so a test, an E2E run and the Module 4 playground can all
 *    ask for a named behaviour through the ordinary interface. Real providers ignore it.
 *  - `think` is the opt-in for a model's reasoning output. It defaults to **off**, and
 *    that default is load-bearing rather than cosmetic: on `gemma4:latest`, `think:true`
 *    makes the model ignore a `format` schema completely (0/5 valid JSON, versus 5/5 with
 *    it off — decision 16 in docs/07-open-decisions.md). A provider must refuse to send
 *    both at once.
 */
export const ChatOptionsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    maxTokens: z.number().int().positive().max(8192).optional(),
    seed: z.number().int().optional(),
    scenario: z.string().min(1).max(64).optional(),
    think: z.boolean().optional(),
  })
  .strict();
export type ChatOptions = z.infer<typeof ChatOptionsSchema>;

// ------------------------------------------------------------ request/response ----

/** Ceilings so one playground request cannot post a megabyte of context. */
export const CHAT_MAX_MESSAGES = 50;
export const CHAT_MAX_CONTENT_CHARS = 20_000;
export const CHAT_MAX_TOOLS = 10;

export const ChatRequestSchema = z
  .object({
    /** Defaults to `OLLAMA_CHAT_MODEL` when omitted. */
    model: z.string().min(1).max(128).optional(),
    messages: z
      .array(ChatMessageSchema.extend({ content: z.string().max(CHAT_MAX_CONTENT_CHARS) }))
      .min(1)
      .max(CHAT_MAX_MESSAGES),
    tools: z.array(ToolDefinitionSchema).max(CHAT_MAX_TOOLS).optional(),
    format: ChatFormatSchema.optional(),
    options: ChatOptionsSchema.optional(),
  })
  .strict();
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const TokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const ChatResponseSchema = z.object({
  message: ChatMessageSchema,
  usage: TokenUsageSchema,
  /** Wall-clock for the call, measured by the adapter, not reported by the provider. */
  latencyMs: z.number().int().nonnegative(),
  /**
   * Raw provider timings and oddities — `thinking`, `prompt_eval_cached_count`,
   * `total_duration`, `done_reason`. Stored in `agent_run_steps.raw`. Anything the
   * provider invents that we do not model goes here instead of crashing the mapping.
   */
  providerMeta: z.record(z.unknown()).optional(),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

/** What `ModelProvider.health()` returns. Never carries a base URL — see `/model/health`. */
export const ModelHealthSchema = z.object({
  ok: z.boolean(),
  models: z.array(z.string()),
  detail: z.string().optional(),
});
export type ModelHealth = z.infer<typeof ModelHealthSchema>;

// ------------------------------------------------------------------ HTTP: chat ----

const UuidSchema = z.string().uuid();
const IsoTimestampSchema = z.string().datetime();

/**
 * `POST /api/v1/model/chat` — a `ChatRequest` plus where to file the trace.
 *
 * `exerciseId` links the run to the Module 4 exercise so the playground can deep-link to
 * it. `runId` appends this call to a run that already exists (the Module 6 harness in
 * M11 drives the loop from the browser and reports each call against one run).
 */
export const ModelChatRequestSchema = ChatRequestSchema.extend({
  exerciseId: UuidSchema.optional(),
  runId: UuidSchema.optional(),
});
export type ModelChatRequest = z.infer<typeof ModelChatRequestSchema>;

/**
 * The server-side verdict on a `format`-constrained response (decision 16).
 *
 * `retried` says whether the first attempt failed validation and a second call was made
 * with the validation error fed back as a user message. Both attempts are in the run as
 * separate `model_call` steps, so "it only worked on the retry" is visible rather than
 * hidden behind a green tick.
 */
export const StructuredOutputResultSchema = z.object({
  valid: z.boolean(),
  /** The parsed, schema-conforming value. Absent when `valid` is false. */
  value: z.unknown().optional(),
  /** The validation or parse error, verbatim — the lesson is that you show it. */
  error: z.string().optional(),
  retried: z.boolean(),
});
export type StructuredOutputResult = z.infer<typeof StructuredOutputResultSchema>;

export const ModelChatResponseSchema = ChatResponseSchema.extend({
  runId: UuidSchema,
  provider: ModelProviderNameSchema,
  model: z.string(),
  /** Present only when the request carried a `format`. */
  structuredOutput: StructuredOutputResultSchema.optional(),
});
export type ModelChatResponse = z.infer<typeof ModelChatResponseSchema>;

// ---------------------------------------------------------------- HTTP: health ----

/**
 * `GET /api/v1/model/health` — public, because the UI banner has to be drawable before
 * anyone logs in.
 *
 * Note what is *not* in it: `OLLAMA_BASE_URL`. An unauthenticated endpoint that echoes an
 * internal address is a free bit of reconnaissance, and the banner does not need it —
 * "run the app locally with Ollama" is the whole message.
 */
export const ModelHealthResponseSchema = z.object({
  provider: ModelProviderNameSchema,
  ok: z.boolean(),
  /** Model tags the provider reports. Empty when it is down or `none`. */
  models: z.array(z.string()),
  /** The configured chat model, so the UI can say which tag is missing. */
  model: z.string(),
  detail: z.string().optional(),
});
export type ModelHealthResponse = z.infer<typeof ModelHealthResponseSchema>;

// ------------------------------------------------------------------ HTTP: runs ----

export const RunKindSchema = z.enum(['prompt', 'structured', 'agent', 'harness']);
export type RunKind = z.infer<typeof RunKindSchema>;

export const RunStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
  'max_iterations',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunStepKindSchema = z.enum([
  'model_call',
  'tool_call',
  'tool_result',
  'final',
  'error',
]);
export type RunStepKind = z.infer<typeof RunStepKindSchema>;

export const RunStepSchema = z.object({
  id: z.number().int(),
  stepIndex: z.number().int().nonnegative(),
  kind: RunStepKindSchema,
  iteration: z.number().int().nonnegative(),
  content: z.string().nullable(),
  toolName: z.string().nullable(),
  toolArgs: z.unknown(),
  toolArgsRaw: z.string().nullable(),
  parseOk: z.boolean().nullable(),
  toolResult: z.unknown(),
  isError: z.boolean(),
  latencyMs: z.number().int().nullable(),
  promptTokens: z.number().int().nullable(),
  completionTokens: z.number().int().nullable(),
  /** `ChatResponse.providerMeta` as stored. This is where `thinking` ends up. */
  raw: z.unknown(),
  createdAt: IsoTimestampSchema,
});
export type RunStep = z.infer<typeof RunStepSchema>;

export const RunSummarySchema = z.object({
  id: UuidSchema,
  exerciseId: UuidSchema.nullable(),
  kind: RunKindSchema,
  provider: z.string(),
  model: z.string(),
  status: RunStatusSchema,
  iterationCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  toolParseFailureCount: z.number().int().nonnegative(),
  promptTokensTotal: z.number().int().nonnegative(),
  completionTokensTotal: z.number().int().nonnegative(),
  modelLatencyMsTotal: z.number().int().nonnegative(),
  finalOutput: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: IsoTimestampSchema,
  finishedAt: IsoTimestampSchema.nullable(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunDetailSchema = RunSummarySchema.extend({
  systemPrompt: z.string(),
  userPrompt: z.string(),
  tools: z.unknown(),
  options: z.unknown(),
  maxIterations: z.number().int(),
  requestId: z.string(),
  steps: z.array(RunStepSchema),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

export const RunListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Cursor = the `startedAt` of the last row seen; runs come back newest first. */
  cursor: IsoTimestampSchema.optional(),
});
export type RunListQuery = z.infer<typeof RunListQuerySchema>;

export const RunListResponseSchema = z.object({
  runs: z.array(RunSummarySchema),
  nextCursor: IsoTimestampSchema.nullable(),
});
export type RunListResponse = z.infer<typeof RunListResponseSchema>;
