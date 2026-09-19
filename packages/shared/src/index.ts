export { HealthCheckSchema, HealthResponseSchema } from './health.js';
export type { HealthCheck, HealthResponse } from './health.js';

export {
  AttentionConfigSchema,
  ChoiceCorrectSchema,
  CompletionRuleSchema,
  EmbeddingsConfigSchema,
  ExerciseConfigSchemas,
  ExerciseFileEntrySchema,
  ExerciseKindSchema,
  ExercisesFileSchema,
  LessonFrontmatterSchema,
  ModuleFileSchema,
  NumericCorrectSchema,
  parseFrontmatter,
  PrecomputedEmbeddingsSchema,
  PromptConfigSchema,
  QuestionKindSchema,
  QuizFileSchema,
  QuizOptionSchema,
  QuizQuestionSchema,
  ShortTextCorrectSchema,
  TokenizerConfigSchema,
  TokenizerTabConfigSchema,
} from './content.js';
export type {
  AttentionConfig,
  CompletionRule,
  EmbeddingsConfig,
  ExerciseFileEntry,
  ExerciseKind,
  ExercisesFile,
  LessonFrontmatter,
  ModuleFile,
  ParsedLessonFile,
  PrecomputedEmbeddings,
  PromptCheck,
  PromptConfig,
  PromptTask,
  QuestionKind,
  QuizFile,
  QuizOption,
  QuizQuestionFile,
  TokenizerCheck,
  TokenizerConfig,
  TokenizerTabConfig,
} from './content.js';

// M5 auth contracts (schemas, types, password policy, common-password list).
export * from './auth.js';

// M7 content + progress API contracts (module/lesson/exercise/quiz payloads, grading
// results, progress updates). Exported wholesale: every name in the file is part of the
// wire contract, and listing them twice is a merge conflict waiting to happen.
export * from './progress.js';

// M9 model contracts (provider-neutral chat types, /model/chat, /model/health,
// /model/runs). Same wholesale-export reasoning as progress.ts.
export * from './model.js';
