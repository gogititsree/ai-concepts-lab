export { HealthCheckSchema, HealthResponseSchema } from './health.js';
export type { HealthCheck, HealthResponse } from './health.js';

export {
  ChoiceCorrectSchema,
  CompletionRuleSchema,
  ExerciseConfigSchemas,
  ExerciseFileEntrySchema,
  ExerciseKindSchema,
  ExercisesFileSchema,
  LessonFrontmatterSchema,
  ModuleFileSchema,
  NumericCorrectSchema,
  parseFrontmatter,
  QuestionKindSchema,
  QuizFileSchema,
  QuizOptionSchema,
  QuizQuestionSchema,
  ShortTextCorrectSchema,
} from './content.js';
export type {
  CompletionRule,
  ExerciseFileEntry,
  ExerciseKind,
  ExercisesFile,
  LessonFrontmatter,
  ModuleFile,
  ParsedLessonFile,
  QuestionKind,
  QuizFile,
  QuizOption,
  QuizQuestionFile,
} from './content.js';

// M5 auth contracts (schemas, types, password policy, common-password list).
export * from './auth.js';

// M7 content + progress API contracts (module/lesson/exercise/quiz payloads, grading
// results, progress updates). Exported wholesale: every name in the file is part of the
// wire contract, and listing them twice is a merge conflict waiting to happen.
export * from './progress.js';
