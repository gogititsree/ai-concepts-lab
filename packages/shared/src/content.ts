import { z } from 'zod';

/**
 * Contracts for the authored curriculum files under `content/modules/<order>-<slug>/`:
 *
 *   module.json      -> ModuleFileSchema
 *   lessons/NN-x.md  -> LessonFrontmatterSchema (YAML-ish frontmatter) + Markdown body
 *   exercises.json   -> ExercisesFileSchema
 *   quiz.json        -> QuizFileSchema
 *
 * The seed script (`apps/api/src/db/seed.ts`) validates every file against these before
 * a single row is written, so a typo in content fails at seed time with a file path
 * rather than at runtime with a React crash.
 *
 * Everything is `.strict()`: an unknown key is almost always a typo in a hand-authored
 * file, and silently ignoring it is how content and schema drift apart.
 */

/** Matches the `exercise_kind` Postgres enum in docs/02-schema.md. */
export const ExerciseKindSchema = z.enum([
  'perceptron',
  'mlp',
  'tokenizer',
  'embeddings',
  'attention',
  'prompt',
  'structured_output',
  'agent',
  'harness',
]);
export type ExerciseKind = z.infer<typeof ExerciseKindSchema>;

/** Matches the `question_kind` Postgres enum. */
export const QuestionKindSchema = z.enum([
  'single_choice',
  'multi_choice',
  'numeric',
  'short_text',
]);
export type QuestionKind = z.infer<typeof QuestionKindSchema>;

const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug');

// ------------------------------------------------------------------ module.json ----

export const ModuleFileSchema = z
  .object({
    slug: SlugSchema,
    title: z.string().min(1),
    /** One paragraph, shown on the module card. */
    summary: z.string().min(1),
    orderIndex: z.number().int().positive(),
    /** True for modules 4-6: the UI shows the "run locally" banner. */
    requiresModel: z.boolean().default(false),
    isPublished: z.boolean().default(true),
  })
  .strict();
export type ModuleFile = z.infer<typeof ModuleFileSchema>;

// ------------------------------------------------------------------- lessons/*.md ----

export const LessonFrontmatterSchema = z
  .object({
    slug: SlugSchema,
    title: z.string().min(1),
    orderIndex: z.number().int().positive(),
    estimatedMinutes: z.number().int().positive().max(240).default(10),
  })
  .strict();
export type LessonFrontmatter = z.infer<typeof LessonFrontmatterSchema>;

export interface ParsedLessonFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Deliberately *not* gray-matter: the frontmatter this project authors is a flat block of
 * `key: value` lines, so a real YAML parser would be ~200 KB of dependency to read four
 * scalars, and a hand-written parser keeps the failure modes obvious.
 *
 * Supported: a leading `---` fence, `key: value` pairs, `#` comments, blank lines,
 * optional single/double quotes around the value, and `true`/`false`/numbers/`null`
 * coerced to their JS types. Anything else (nested maps, lists, multi-line strings) is a
 * deliberate non-feature and will surface as a Zod error on the resulting object.
 */
export function parseFrontmatter(raw: string): ParsedLessonFile {
  // Normalise CRLF so Windows-authored files parse identically, and drop a leading
  // UTF-8 BOM -- charCodeAt rather than a regex literal, because a raw U+FEFF in source
  // is invisible and an escape is easy to mangle on a round-trip.
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const text = withoutBom.split('\r\n').join('\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) {
    throw new Error('missing frontmatter: file must start with a --- fenced block');
  }
  const [fence, block] = match;
  const frontmatter: Record<string, unknown> = {};

  for (const [i, line] of (block ?? '').split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const sep = trimmed.indexOf(':');
    if (sep === -1) {
      throw new Error(`frontmatter line ${i + 1} is not "key: value": ${trimmed}`);
    }
    const key = trimmed.slice(0, sep).trim();
    const rawValue = trimmed.slice(sep + 1).trim();
    if (key === '') throw new Error(`frontmatter line ${i + 1} has an empty key`);
    frontmatter[key] = coerceScalar(rawValue);
  }

  return { frontmatter, body: text.slice(fence?.length ?? 0).trim() };
}

function coerceScalar(value: string): unknown {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

// ---------------------------------------------------------------- exercises.json ----

/**
 * How `PUT /progress/exercises/:id` decides an exercise is done. Interpreted server-side
 * (M7) so a learner cannot mark an exercise complete by posting `status: 'completed'`.
 */
export const CompletionRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tasks'), required: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('manual') }).strict(),
]);
export type CompletionRule = z.infer<typeof CompletionRuleSchema>;

/**
 * Per-kind config schemas. M4 only needs "it is an object": every exercise UI is written
 * in a later milestone (M3/M8-M11) and each one tightens its own entry here, which is why
 * this is a map rather than one big union — a milestone touches one key.
 */
const LooseConfigSchema = z.record(z.unknown());

/**
 * The dataset generators in `@lab/nn-core`'s `DATASET_KINDS`.
 *
 * Spelled out here rather than imported: `packages/shared` is the contract layer and must
 * stay dependency-free of the ML math (the API imports shared, and has no business pulling
 * in a neural network). The cost of the duplication is one list; the protection is that a
 * content file naming a dataset that does not exist fails at seed time rather than as an
 * empty canvas.
 */
const DatasetKindSchema = z.enum([
  'blobs',
  'diagonal',
  'xor',
  'xor-noisy',
  'circle',
  'moons',
  'spiral',
]);

/**
 * A threshold written the way the curriculum doc writes it: `">=20"`, `"<0.05"`, `">0.95"`.
 *
 * The alternative — `{ op: 'gte', value: 20 }` — is more honest JSON and much worse to author
 * and to read in a diff. The regex is the whole guard, and the exercise UI parses it with the
 * same grammar (`apps/web/src/features/exercises/checkRules.ts`).
 */
const ComparisonSchema = z
  .string()
  .regex(/^(>=|<=|>|<|==)\s*-?\d+(\.\d+)?$/, 'must be a comparison such as ">=20" or "<0.05"');

/** Every auto-checked task carries an id, a label for the checklist and an optional hint. */
const TaskBaseShape = {
  id: SlugSchema,
  label: z.string().min(1),
  hintMd: z.string().min(1).optional(),
};

/**
 * Module 1's `perceptron` exercise (M3). Tightened from the loose record so that a typo in a
 * dataset name, a task with no check at all, or a learning rate of `"0.1"` is a seed-time
 * error with a path, not a playground that silently does nothing.
 */
export const PerceptronConfigSchema = z
  .object({
    datasets: z.array(DatasetKindSchema).min(1),
    defaultLr: z.number().positive().max(10),
    /** Fixed so "reset" gives the same points and the same initial line twice. */
    seed: z.number().int().nonnegative().default(42),
    /** Shown once every task passes; the "what did you notice?" prompt from docs/04. */
    reflectionMd: z.string().min(1).optional(),
    tasks: z
      .array(
        z
          .object({
            ...TaskBaseShape,
            check: z
              .object({
                dataset: DatasetKindSchema,
                /** Exact target accuracy, e.g. `1.0` for "separate the blobs". */
                accuracy: z.number().min(0).max(1).optional(),
                epochsRun: ComparisonSchema.optional(),
              })
              .strict()
              .refine(
                (check) => check.accuracy !== undefined || check.epochsRun !== undefined,
                'a check needs at least one of accuracy or epochsRun',
              ),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type PerceptronConfig = z.infer<typeof PerceptronConfigSchema>;

/**
 * Module 2's `mlp` exercise (M3). `record: 'hiddenSize'` marks the one task whose answer is a
 * measurement the learner reports rather than a pass/fail — `circle-hidden-size` in docs/04.
 */
export const MlpConfigSchema = z
  .object({
    datasets: z.array(DatasetKindSchema).min(1),
    hiddenSizes: z.array(z.number().int().min(1).max(16)).min(1),
    activations: z.array(z.enum(['sigmoid', 'tanh', 'relu'])).min(1),
    defaultLr: z.number().positive().max(10),
    defaultHiddenSize: z.number().int().min(1).max(16).optional(),
    seed: z.number().int().nonnegative().default(42),
    reflectionMd: z.string().min(1).optional(),
    tasks: z
      .array(
        z
          .object({
            ...TaskBaseShape,
            check: z
              .object({
                dataset: DatasetKindSchema.optional(),
                loss: ComparisonSchema.optional(),
                accuracy: ComparisonSchema.optional(),
                maxEpochs: z.number().int().positive().optional(),
                singleSteps: ComparisonSchema.optional(),
                record: z.enum(['hiddenSize']).optional(),
              })
              .strict()
              .refine(
                (check) =>
                  check.loss !== undefined ||
                  check.accuracy !== undefined ||
                  check.singleSteps !== undefined,
                'a check needs at least one of loss, accuracy or singleSteps',
              ),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (
      config.defaultHiddenSize !== undefined &&
      !config.hiddenSizes.includes(config.defaultHiddenSize)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultHiddenSize'],
        message: `defaultHiddenSize ${config.defaultHiddenSize} is not one of hiddenSizes`,
      });
    }
  });
export type MlpConfig = z.infer<typeof MlpConfigSchema>;

/**
 * Module 4's `prompt` exercise (M9). The playground is a thin shell around
 * `POST /api/v1/model/chat`; everything that makes it an *exercise* — the starting
 * prompts, the sampling defaults, the four auto-checked tasks and the JSON Schema used as
 * `format` — is authored here.
 *
 * Three of the four checks run client-side against the response text. The fourth
 * (`structured`) cannot: the schema is sent to the model as `format` and validated by the
 * server, so the task passes on the server's verdict (`structuredOutput.valid`) rather
 * than on anything the browser could fake. That split is deliberate and is the same one
 * docs/04-curriculum.md describes.
 */
const PromptCheckSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('regex'),
      pattern: z.string().min(1),
      /** JS regex flags; `m` for the three-bullets check, `i` for the refusal. */
      flags: z
        .string()
        .regex(/^[gimsuy]*$/)
        .default(''),
    })
    .strict(),
  z
    .object({
      type: z.literal('not_contains'),
      value: z.string().min(1),
      caseSensitive: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      /** Passes when the server's structured-output validation succeeded. */
      type: z.literal('structured'),
      /** Sent verbatim as `ChatRequest.format`. */
      schema: z.record(z.unknown()),
      /** Extra shape assertions the schema alone cannot express, e.g. "three dates". */
      minItems: z.record(z.number().int().nonnegative()).optional(),
    })
    .strict(),
]);

export const PromptConfigSchema = z
  .object({
    defaults: z
      .object({
        temperature: z.number().min(0).max(2).default(0.7),
        topP: z.number().min(0).max(1).default(0.9),
        /** `null` means "no seed": the model samples freely. */
        seed: z.number().int().nullable().default(null),
        systemPrompt: z.string().default(''),
        userPrompt: z.string().default(''),
      })
      .strict(),
    structuredOutput: z
      .object({
        enabled: z.boolean().default(true),
        /** Pre-filled into the schema editor. */
        defaultSchema: z.record(z.unknown()),
        defaultPrompt: z.string().default(''),
      })
      .strict(),
    reflectionMd: z.string().min(1).optional(),
    tasks: z
      .array(
        z
          .object({
            ...TaskBaseShape,
            /** Loaded into the prompt boxes by the "load this task" button. */
            systemPrompt: z.string().optional(),
            userPrompt: z.string().optional(),
            /** True for the task that must be run in structured-output mode. */
            structured: z.boolean().default(false),
            check: PromptCheckSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type PromptConfig = z.infer<typeof PromptConfigSchema>;
export type PromptCheck = z.infer<typeof PromptCheckSchema>;
export type PromptTask = PromptConfig['tasks'][number];

// ------------------------------------------------------ Module 5 config (M10) ----

/**
 * Module 5's `agent` exercise (M10).
 *
 * The four checks are the four in docs/04-curriculum.md, written as a discriminated
 * union because they ask genuinely different questions of a finished run: one about a
 * number in the final answer, one about the *order* of two steps, one about which tool
 * was called, and one about whether the learner watched something fail. A bag of
 * optional fields would let a content typo produce a task that can never pass.
 *
 * Every check is evaluated against the **completed run's steps** (`agent_run_steps`),
 * never against anything the browser computed for itself. The trace is the evidence, and
 * it is the same trace `/runs/:id` shows — so a learner can always see exactly why a task
 * did or did not pass.
 */
const AgentCheckSchema = z.discriminatedUnion('type', [
  z
    .object({
      /** A `tool_call` to `toolCalled`, and a final answer within `withinPercent` of `expected`. */
      type: z.literal('numeric-answer'),
      toolCalled: z.string().min(1),
      expected: z.number(),
      withinPercent: z.number().positive().max(100),
    })
    .strict(),
  z
    .object({
      /** A `tool_call` step naming `toolName` must appear *before* the `final` step. */
      type: z.literal('tool-before-final'),
      toolName: z.string().min(1),
    })
    .strict(),
  z
    .object({
      /** A successfully parsed `tool_call` to a tool that is not in the server catalog. */
      type: z.literal('mock-tool-called'),
    })
    .strict(),
  z
    .object({
      /** A `tool_result` step with `is_error`, plus a written reflection. */
      type: z.literal('error-observed'),
      requiresReflection: z.boolean().default(true),
    })
    .strict(),
]);
export type AgentCheck = z.infer<typeof AgentCheckSchema>;

/** A mock tool as *authored* (the "add mock tool" form is pre-filled from it). */
const MockToolTemplateSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'must be a valid function name'),
    description: z.string().min(1).max(1024),
    parameters: z.record(z.unknown()),
    response: z.unknown(),
  })
  .strict();
export type MockToolTemplate = z.infer<typeof MockToolTemplateSchema>;

export const AgentConfigSchema = z
  .object({
    /** The catalog names the tool picker offers. Must be a subset of the server's. */
    toolCatalog: z.array(z.string().min(1)).min(1),
    allowMockTools: z.boolean().default(true),
    /** 15 is the server's hard cap (`AGENT_MAX_ITERATIONS_CAP`); content may not exceed it. */
    defaultMaxIterations: z.number().int().min(1).max(15).default(8),
    defaults: z
      .object({
        systemPrompt: z.string().default(''),
        userPrompt: z.string().default(''),
        /** Pre-ticked in the picker. */
        tools: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    mockToolTemplate: MockToolTemplateSchema.optional(),
    reflectionMd: z.string().min(1).optional(),
    tasks: z
      .array(
        z
          .object({
            ...TaskBaseShape,
            /** Loaded into the editors by the "load this task" button. */
            systemPrompt: z.string().optional(),
            userPrompt: z.string().optional(),
            tools: z.array(z.string().min(1)).optional(),
            maxIterations: z.number().int().min(1).max(15).optional(),
            /** True for the task that needs the mock-tool form filled in. */
            addsMockTool: z.boolean().default(false),
            check: AgentCheckSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((config, ctx) => {
    const catalog = new Set(config.toolCatalog);
    config.defaults.tools.forEach((name, index) => {
      if (!catalog.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defaults', 'tools', index],
          message: `"${name}" is not in toolCatalog`,
        });
      }
    });
    config.tasks.forEach((task, index) => {
      (task.tools ?? []).forEach((name, toolIndex) => {
        if (!catalog.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tasks', index, 'tools', toolIndex],
            message: `"${name}" is not in toolCatalog`,
          });
        }
      });
      // A check that names a tool the picker cannot offer is a task nobody can pass.
      const named =
        task.check.type === 'numeric-answer'
          ? task.check.toolCalled
          : task.check.type === 'tool-before-final'
            ? task.check.toolName
            : null;
      if (named !== null && !catalog.has(named)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', index, 'check'],
          message: `the check requires "${named}", which is not in toolCatalog`,
        });
      }
      if (task.check.type === 'mock-tool-called' && !config.allowMockTools) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', index, 'check'],
          message: 'a mock-tool-called check needs allowMockTools: true',
        });
      }
    });
  });
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentTask = AgentConfig['tasks'][number];

// ------------------------------------------------- Module 6 config (M11) ----

/**
 * The three scripted scenarios the in-worker fake model plays (docs/04-curriculum.md →
 * Module 6). They are named here rather than in the web app because the exercise config
 * references them, and a content file naming a fourth scenario nobody implemented should
 * fail at seed time rather than as a check that never goes green.
 */
export const HARNESS_SCENARIO_IDS = ['single-tool', 'malformed-args', 'never-stops'] as const;
export const HarnessScenarioIdSchema = z.enum(HARNESS_SCENARIO_IDS);
export type HarnessScenarioId = z.infer<typeof HarnessScenarioIdSchema>;

/**
 * The three auto-checks, and the scenarios each one needs in order to mean anything.
 *
 * The map is the reason `scriptedScenarios` and `tasks` cannot drift apart: the
 * refinement below reads it, so a config that offers a check without the scenario it
 * inspects is a seed-time error naming both.
 */
export const HARNESS_CHECK_IDS = ['terminates', 'appends-tool-message', 'max-iterations'] as const;
export const HarnessCheckIdSchema = z.enum(HARNESS_CHECK_IDS);
export type HarnessCheckId = z.infer<typeof HarnessCheckIdSchema>;

export const HARNESS_CHECK_SCENARIOS: Record<HarnessCheckId, readonly HarnessScenarioId[]> = {
  terminates: ['single-tool'],
  // Two scenarios on purpose: appending a *successful* result is the easy half, and
  // appending the *error* from a malformed call is the half that separates a loop which
  // treats failures as observations from one that throws them away.
  'appends-tool-message': ['single-tool', 'malformed-args'],
  'max-iterations': ['never-stops'],
};

const HarnessCheckSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('scripted'), check: HarnessCheckIdSchema }).strict(),
  /**
   * One completed run against the real model. Encouraged, never required: local
   * inference is 10-70 s per call (docs/spike-notes.md) and Module 6 has to stay
   * completable on a laptop with no Ollama, so `completionRule.required` is 3.
   */
  z.object({ type: z.literal('real-run') }).strict(),
]);
export type HarnessCheck = z.infer<typeof HarnessCheckSchema>;

/**
 * Module 6's `harness` exercise (M11).
 *
 * The learner's own `runAgent` runs in a Web Worker in their browser, so this config
 * carries the two things the worker needs and nothing it does not: the starter source it
 * is pre-filled with, and which deterministic scenarios the scripted model may play.
 *
 * `workerTools` is a *browser* tool set, not the server catalog: these are implemented in
 * `apps/web/src/features/exercises/harness/workerTools.ts` and executed in the worker.
 * See `docs/adr/0003-harness-worker-deviations.md` for why `lookup_glossary`, which
 * docs/04 lists, is not among them.
 */
export const HarnessWorkerToolNameSchema = z.enum(['calculator', 'get_current_time']);
export type HarnessWorkerToolName = z.infer<typeof HarnessWorkerToolNameSchema>;

export const HarnessConfigSchema = z
  .object({
    /** Only one runtime exists, and naming it in content keeps decision 4 visible. */
    runtime: z.literal('web-worker'),
    /** The stub the editor opens with, TODO comments and all. */
    starterCode: z.string().min(1).max(8000),
    workerTools: z.array(HarnessWorkerToolNameSchema).min(1),
    scriptedScenarios: z.array(HarnessScenarioIdSchema).min(1),
    /** The cap handed to the learner's loop in scripted mode; `max-iterations` counts to it. */
    scriptedMaxIterations: z.number().int().min(2).max(15).default(6),
    /** What the optional real run sends. Deliberately a short question: see the latencies. */
    realRun: z
      .object({
        systemPrompt: z.string().max(4000).default(''),
        userPrompt: z.string().min(1).max(4000),
        maxIterations: z.number().int().min(1).max(15).default(4),
      })
      .strict(),
    reflectionMd: z.string().min(1).optional(),
    tasks: z
      .array(z.object({ ...TaskBaseShape, check: HarnessCheckSchema }).strict())
      .min(1)
      .max(10),
  })
  .strict()
  .superRefine((config, ctx) => {
    const scenarios = new Set(config.scriptedScenarios);
    if (scenarios.size !== config.scriptedScenarios.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scriptedScenarios'],
        message: 'scriptedScenarios must not repeat a scenario',
      });
    }
    const seenChecks = new Set<string>();
    config.tasks.forEach((task, index) => {
      if (task.check.type !== 'scripted') return;
      if (seenChecks.has(task.check.check)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', index, 'check', 'check'],
          message: `two tasks both claim the "${task.check.check}" check`,
        });
      }
      seenChecks.add(task.check.check);
      for (const needed of HARNESS_CHECK_SCENARIOS[task.check.check]) {
        if (!scenarios.has(needed)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tasks', index, 'check'],
            message: `the "${task.check.check}" check reads the "${needed}" scenario, which is not in scriptedScenarios`,
          });
        }
      }
    });
    // The starter must not accidentally ship the answer. A stub that already loops is
    // the one content mistake that would silently make every check pass on day one.
    if (!/runAgent/.test(config.starterCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['starterCode'],
        message: 'the starter code must define a function called runAgent',
      });
    }
  });
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type HarnessTask = HarnessConfig['tasks'][number];

// ------------------------------------------------------- Module 3 config (M8) ----

/**
 * Module 3 is one exercise record of kind `tokenizer` with three tabs, so its config is
 * three sub-configs plus the shared task list. The sub-configs are exported and reused as
 * the `embeddings` and `attention` entries in the registry below: those kinds exist in
 * the Postgres enum and a later module may want one on its own, and having them share a
 * definition means a tab can be split out later without re-authoring anything.
 *
 * Everything the three tabs draw is authored here rather than hard-coded in the React
 * components, for the same reason the perceptron's datasets are: the content file is the
 * thing a non-programmer edits, and a bad edit should fail at seed time with a path.
 */

/** A filename inside the module's own content directory. No slashes: no path traversal. */
const contentFileName = (extension: string) =>
  z
    .string()
    .regex(
      new RegExp(`^[a-z0-9]+(?:-[a-z0-9]+)*\\.${extension}$`),
      `must be a kebab-case *.${extension} filename inside the module directory`,
    );

const SampleSentenceSchema = z
  .object({ id: SlugSchema, text: z.string().min(1).max(400) })
  .strict();

/**
 * The tokenizer tab. The corpus is given either inline (`corpusText`) or as a sibling
 * file (`corpusFile`) — a 5 KB paragraph is unreadable as a JSON string literal, so the
 * shipped content uses the file, and the inline form exists so a test can build a tiny
 * config without touching the filesystem.
 */
export const TokenizerTabConfigSchema = z
  .object({
    corpusFile: contentFileName('txt').optional(),
    corpusText: z.string().min(50).optional(),
    /** `[min, max]` for the merge slider; docs/04 asks for 50…500. */
    mergeRange: z.tuple([z.number().int().min(1).max(5000), z.number().int().min(1).max(5000)]),
    defaultMerges: z.number().int().min(1).max(5000),
    /** The three sentences the `tokenize-three` task asks for. */
    sampleSentences: z.array(SampleSentenceSchema).min(3).max(8),
    /** Pre-filled into the text area on first mount. */
    defaultText: z.string().min(1).max(400),
  })
  .strict()
  .superRefine((config, ctx) => {
    if ((config.corpusFile === undefined) === (config.corpusText === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['corpusFile'],
        message: 'give exactly one of corpusFile or corpusText',
      });
    }
    const [min, max] = config.mergeRange;
    if (min >= max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mergeRange'],
        message: `mergeRange must be increasing, got [${min}, ${max}]`,
      });
    }
    if (config.defaultMerges < min || config.defaultMerges > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultMerges'],
        message: `defaultMerges ${config.defaultMerges} is outside mergeRange [${min}, ${max}]`,
      });
    }
    const ids = new Set(config.sampleSentences.map((sentence) => sentence.id));
    if (ids.size !== config.sampleSentences.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sampleSentences'],
        message: 'sample sentence ids must be unique',
      });
    }
  });
export type TokenizerTabConfig = z.infer<typeof TokenizerTabConfigSchema>;

/** One plotted word. `cluster` is only a colour and a legend entry — PCA never sees it. */
const EmbeddingWordSchema = z
  .object({
    word: z
      .string()
      .regex(/^[a-z]+$/, 'must be a single lowercase word')
      .min(1)
      .max(32),
    cluster: SlugSchema,
  })
  .strict();

export const EmbeddingsConfigSchema = z
  .object({
    words: z.array(EmbeddingWordSchema).min(6).max(200),
    /** Shipped vectors, used whenever `POST /model/embed` is unavailable. */
    fallbackFile: contentFileName('json'),
    /** Seeds the `a - b + c` boxes so the tab is interesting before anyone types. */
    defaultAnalogy: z
      .object({ a: z.string().min(1), b: z.string().min(1), c: z.string().min(1) })
      .strict(),
    /** How many nearest words the analogy readout lists. */
    neighbourCount: z.number().int().min(1).max(10).default(3),
  })
  .strict()
  .superRefine((config, ctx) => {
    const words = new Set(config.words.map((entry) => entry.word));
    if (words.size !== config.words.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['words'],
        message: 'word list must not repeat a word',
      });
    }
    for (const [key, word] of Object.entries(config.defaultAnalogy)) {
      if (!words.has(word)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defaultAnalogy', key],
          message: `"${word}" is not in the word list`,
        });
      }
    }
  });
export type EmbeddingsConfig = z.infer<typeof EmbeddingsConfigSchema>;

const NumberMatrixSchema = z.array(z.array(z.number()).min(1)).min(2);

/**
 * The attention tab's hand-authored example. `Q`, `K` and `V` are written out in full
 * rather than generated, because the whole point of the tab is that every number on the
 * screen can be checked with a calculator — and Lesson 3.3 does exactly that for the
 * query row of the last word.
 */
export const AttentionConfigSchema = z
  .object({
    words: z.array(z.string().min(1).max(24)).min(2).max(16),
    /** Query/key dimension. Also the `d_k` under the square root. */
    dk: z.number().int().min(1).max(16),
    Q: NumberMatrixSchema,
    K: NumberMatrixSchema,
    V: NumberMatrixSchema,
    defaultTemperature: z.number().positive().max(10).default(1),
    defaultScale: z.boolean().default(true),
    /** Row labels for the three 3-column matrices in the "edit vectors" panel. */
    dimensionLabels: z.array(z.string().min(1).max(24)).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const n = config.words.length;
    for (const name of ['Q', 'K', 'V'] as const) {
      const matrix = config[name];
      if (matrix.length !== n) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `${name} has ${matrix.length} rows but there are ${n} words`,
        });
        continue;
      }
      // Q and K are dotted together, so both must be d_k wide. V may be any width:
      // d_v is independent of d_k, and saying so here is cheaper than a lesson aside.
      const expected = name === 'V' ? (matrix[0]?.length ?? 0) : config.dk;
      matrix.forEach((row, index) => {
        if (row.length !== expected) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name, index],
            message: `row ${index} has ${row.length} entries, expected ${expected}`,
          });
        }
      });
    }
    if (config.dimensionLabels && config.dimensionLabels.length !== config.dk) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimensionLabels'],
        message: `dimensionLabels must have dk (${config.dk}) entries`,
      });
    }
  });
export type AttentionConfig = z.infer<typeof AttentionConfigSchema>;

/**
 * One check per tab, as a discriminated union rather than a bag of optional fields.
 * The three tasks measure genuinely different things (a count and a choice, a word, a
 * matrix index), and a union means each `checks.ts` receives a narrowed type instead of
 * asserting that the field it cares about is set.
 */
const TokenizerCheckSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('tokenize'),
      /** How many of `sampleSentences` must have been run through the tokenizer. */
      sentencesTokenized: z.number().int().positive(),
      /** The sample sentence that produces the most tokens — the "count question". */
      answerSentenceId: SlugSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('neighbour'),
      targetWord: z.string().min(1),
      /**
       * More than one may be accepted: the tab prefers live vectors from Ollama and falls
       * back to the shipped ones, and the two need not agree on a near-tie.
       */
      acceptable: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('attention-row'),
      /** Index into `attention.words` of the row being read. */
      queryIndex: z.number().int().nonnegative(),
      /** Index, not a word: the sample sentence contains "the" twice. */
      expectedKeyIndex: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type TokenizerCheck = z.infer<typeof TokenizerCheckSchema>;

export const TokenizerConfigSchema = z
  .object({
    /** Tab order, left to right. */
    tabs: z
      .array(z.enum(['tokenizer', 'embeddings', 'attention']))
      .min(1)
      .max(3),
    tokenizer: TokenizerTabConfigSchema,
    embeddings: EmbeddingsConfigSchema,
    attention: AttentionConfigSchema,
    reflectionMd: z.string().min(1).optional(),
    tasks: z.array(z.object({ ...TaskBaseShape, check: TokenizerCheckSchema }).strict()).min(1),
  })
  .strict()
  .superRefine((config, ctx) => {
    const tabs = new Set(config.tabs);
    if (tabs.size !== config.tabs.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tabs'], message: 'tabs must be unique' });
    }
    config.tasks.forEach((task, index) => {
      const at = (field: string) => ['tasks', index, 'check', field];
      if (task.check.kind === 'tokenize') {
        const ids = config.tokenizer.sampleSentences.map((sentence) => sentence.id);
        if (!ids.includes(task.check.answerSentenceId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: at('answerSentenceId'),
            message: `"${task.check.answerSentenceId}" is not a sample sentence id`,
          });
        }
        if (task.check.sentencesTokenized > config.tokenizer.sampleSentences.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: at('sentencesTokenized'),
            message: 'asks for more sentences than sampleSentences provides',
          });
        }
      }
      if (task.check.kind === 'neighbour') {
        const words = new Set(config.embeddings.words.map((entry) => entry.word));
        for (const word of [task.check.targetWord, ...task.check.acceptable]) {
          if (!words.has(word)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: at('targetWord'),
              message: `"${word}" is not in the embeddings word list`,
            });
          }
        }
      }
      if (task.check.kind === 'attention-row') {
        const n = config.attention.words.length;
        for (const [field, value] of [
          ['queryIndex', task.check.queryIndex],
          ['expectedKeyIndex', task.check.expectedKeyIndex],
        ] as const) {
          if (value >= n) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: at(field),
              message: `${field} ${value} is out of range for ${n} words`,
            });
          }
        }
      }
    });
  });
export type TokenizerConfig = z.infer<typeof TokenizerConfigSchema>;

/**
 * `content/modules/03-how-llms-work/embeddings-precomputed.json`, generated by
 * `pnpm content:embeddings` and shipped with the app so the embeddings tab works with
 * `MODEL_PROVIDER=none`.
 *
 * It is validated in three places for three different reasons: the generator validates
 * what it wrote, a web test validates the committed file, and the browser validates it at
 * import time — because a truncated vector would otherwise surface as a PCA of `NaN`.
 */
export const PrecomputedEmbeddingsSchema = z
  .object({
    model: z.string().min(1),
    dimensions: z.number().int().positive(),
    generatedAt: z.string().datetime(),
    vectors: z.record(z.array(z.number().finite()).min(1)),
  })
  .strict()
  .superRefine((file, ctx) => {
    for (const [word, vector] of Object.entries(file.vectors)) {
      if (vector.length !== file.dimensions) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vectors', word],
          message: `has ${vector.length} components, expected ${file.dimensions}`,
        });
      }
    }
  });
export type PrecomputedEmbeddings = z.infer<typeof PrecomputedEmbeddingsSchema>;

/**
 * `satisfies` rather than a type annotation: the annotation would widen every entry to
 * `z.ZodType<Record<string, unknown>>` and the web app could no longer do
 * `z.infer<typeof ExerciseConfigSchemas.perceptron>` to get its typed config for free.
 */
export const ExerciseConfigSchemas = {
  perceptron: PerceptronConfigSchema,
  mlp: MlpConfigSchema,
  tokenizer: TokenizerConfigSchema,
  // Module 3 ships one record of kind `tokenizer` carrying all three tabs. These two
  // kinds are the same tab configs standing alone, ready for a module that wants only
  // one of them; nothing in `content/` uses them yet.
  embeddings: EmbeddingsConfigSchema,
  attention: AttentionConfigSchema,
  prompt: PromptConfigSchema,
  // Module 4's structured-output mode is a *sub-mode* of the `prompt` exercise rather
  // than a second exercise row, so this kind shares its config schema. The enum keeps
  // the kind because docs/02-schema.md defines it and a later module may want it alone.
  structured_output: PromptConfigSchema,
  // M10: Module 5. Tightened from the loose record so a task whose check names a tool
  // the picker never offers fails at seed time rather than as a task nobody can pass.
  agent: AgentConfigSchema,
  // M11: Module 6. The learner's loop runs in a Web Worker; the config carries the
  // starter source and which deterministic scenarios the scripted model may play.
  harness: HarnessConfigSchema,
} satisfies Record<ExerciseKind, z.ZodTypeAny>;

/** Indexing the map above gives a union of schema types; this collapses it to something callable. */
function configSchemaFor(kind: ExerciseKind): z.ZodTypeAny {
  return ExerciseConfigSchemas[kind];
}

export const ExerciseFileEntrySchema = z
  .object({
    slug: SlugSchema,
    title: z.string().min(1),
    kind: ExerciseKindSchema,
    orderIndex: z.number().int().positive(),
    /** Optional anchor: the lesson this exercise appears after, by slug. */
    lessonSlug: SlugSchema.optional(),
    config: LooseConfigSchema,
    completionRule: CompletionRuleSchema,
  })
  .strict()
  // Re-validate `config` through the per-kind schema so tightening a kind later is a
  // one-line change here and every existing content file is checked against it.
  .superRefine((exercise, ctx) => {
    const result = configSchemaFor(exercise.kind).safeParse(exercise.config);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: ['config', ...issue.path] });
      }
    }
  });
export type ExerciseFileEntry = z.infer<typeof ExerciseFileEntrySchema>;

export const ExercisesFileSchema = z.array(ExerciseFileEntrySchema).min(1);
export type ExercisesFile = z.infer<typeof ExercisesFileSchema>;

// --------------------------------------------------------------------- quiz.json ----

export const QuizOptionSchema = z
  .object({ id: z.string().min(1), textMd: z.string().min(1) })
  .strict();
export type QuizOption = z.infer<typeof QuizOptionSchema>;

/** The four `correct` shapes from docs/02-schema.md, one per question kind. */
export const ChoiceCorrectSchema = z
  .object({ optionIds: z.array(z.string().min(1)).min(1) })
  .strict();
export const NumericCorrectSchema = z
  .object({ value: z.number(), tolerance: z.number().nonnegative() })
  .strict();
export const ShortTextCorrectSchema = z
  .object({
    acceptable: z.array(z.string().min(1)).min(1),
    normalize: z.enum(['lower_trim', 'none']).default('lower_trim'),
  })
  .strict();

export const QuizQuestionSchema = z
  .object({
    kind: QuestionKindSchema,
    promptMd: z.string().min(1),
    options: z.array(QuizOptionSchema).min(2).optional(),
    /**
     * A union rather than `unknown` so the *shape* is checked (and `normalize` gets its
     * default) before the refinement below checks that the shape matches `kind`.
     */
    correct: z.union([ChoiceCorrectSchema, NumericCorrectSchema, ShortTextCorrectSchema]),
    explanationMd: z.string().min(1),
    points: z.number().int().positive().default(1),
  })
  .strict()
  /**
   * `correct` is typed per `kind`, and for the choice kinds every referenced option id
   * must actually exist. This refinement is the reason quiz authoring mistakes show up at
   * seed time instead of as a quiz nobody can pass.
   */
  .superRefine((question, ctx) => {
    const needsOptions = question.kind === 'single_choice' || question.kind === 'multi_choice';
    if (needsOptions && !question.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: `options are required for kind "${question.kind}"`,
      });
    }
    if (!needsOptions && question.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: `options are not allowed for kind "${question.kind}"`,
      });
    }

    const schema =
      question.kind === 'numeric'
        ? NumericCorrectSchema
        : question.kind === 'short_text'
          ? ShortTextCorrectSchema
          : ChoiceCorrectSchema;
    const parsed = schema.safeParse(question.correct);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ ...issue, path: ['correct', ...issue.path] });
      }
      return;
    }

    if (question.kind === 'single_choice') {
      const { optionIds } = parsed.data as z.infer<typeof ChoiceCorrectSchema>;
      if (optionIds.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['correct', 'optionIds'],
          message: 'single_choice must have exactly one correct option id',
        });
      }
    }
    if (needsOptions) {
      const { optionIds } = parsed.data as z.infer<typeof ChoiceCorrectSchema>;
      const known = new Set((question.options ?? []).map((o) => o.id));
      for (const id of optionIds) {
        if (!known.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['correct', 'optionIds'],
            message: `unknown option id "${id}"`,
          });
        }
      }
    }
  });
export type QuizQuestionFile = z.infer<typeof QuizQuestionSchema>;

export const QuizFileSchema = z
  .object({
    title: z.string().min(1),
    /** Fraction correct required to pass; 0.7 across the course. */
    passThreshold: z.number().min(0).max(1).default(0.7),
    questions: z.array(QuizQuestionSchema).min(1),
  })
  .strict();
export type QuizFile = z.infer<typeof QuizFileSchema>;
