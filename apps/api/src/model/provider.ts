import type { ChatRequest, ChatResponse, ModelHealth, ModelProviderName } from '@lab/shared';

import type { Config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { FakeProvider } from './fake.js';
import { OllamaProvider } from './ollama.js';

/**
 * The seam (docs/01-architecture.md → "The `ModelProvider` boundary").
 *
 * The interface is four members and it is the *whole* contract between this app and any
 * large language model. Nothing outside `apps/api/src/model/` may import `ollama.ts`,
 * mention a port, or know that `think` and `keep_alive` exist. The payoff is concrete
 * rather than architectural piety:
 *
 *  - CI has no GPU and no Ollama, so every test runs `FakeProvider` and still exercises
 *    the real route handlers, the real run persistence and the real retry logic.
 *  - The deployed free-tier instance runs `NoneProvider` and degrades to a banner instead
 *    of a stack trace (decision 1).
 *  - When Ollama changes a field name, exactly one file is wrong.
 */
export interface ModelProvider {
  readonly name: ModelProviderName;
  /** One turn. Throws `AppError` with `MODEL_TIMEOUT` / `MODEL_UNAVAILABLE` on failure. */
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  /** One vector per input, in input order. */
  embed(texts: string[], model?: string): Promise<number[][]>;
  /** Cheap liveness probe. Must never throw: a down model is data, not an exception. */
  health(): Promise<ModelHealth>;
}

// ------------------------------------------------------------------- the errors ----

/**
 * The two failure codes `/model/*` is allowed to show a user, minted here so the adapter,
 * the routes and the tests all agree on the spelling. Both are in the error vocabulary in
 * docs/01-architecture.md → Conventions.
 */
export const modelUnavailable = (message = 'The model provider is unavailable'): AppError =>
  new AppError(503, 'MODEL_UNAVAILABLE', message);

export const modelTimeout = (message = 'The model did not respond in time'): AppError =>
  new AppError(504, 'MODEL_TIMEOUT', message);

// ------------------------------------------------------------------------- none ----

/**
 * The provider that is honest about not existing.
 *
 * It is a real implementation rather than a `null` check scattered through the routes,
 * because "no model" is a supported configuration of this app, not an error state. Every
 * method fails the same way, with the code the SPA already knows how to render.
 */
export class NoneProvider implements ModelProvider {
  readonly name = 'none' as const;

  private fail(): never {
    throw modelUnavailable(
      'No model provider is configured on this deployment. Run the app locally with Ollama to use modules 4-6.',
    );
  }

  chat(): Promise<ChatResponse> {
    this.fail();
  }

  embed(): Promise<number[][]> {
    this.fail();
  }

  async health(): Promise<ModelHealth> {
    return {
      ok: false,
      models: [],
      detail: 'MODEL_PROVIDER=none: this deployment has no model attached.',
    };
  }
}

// ---------------------------------------------------------------------- factory ----

/**
 * Builds the provider named by `MODEL_PROVIDER`.
 *
 * A factory rather than a module-level singleton so the integration suite can build two
 * apps in one process with different providers, which is exactly how the
 * "`none` returns 503" test and the "`fake` writes a run" test coexist.
 */
export function createProvider(config: Config): ModelProvider {
  switch (config.MODEL_PROVIDER) {
    case 'ollama':
      return new OllamaProvider({
        baseUrl: config.OLLAMA_BASE_URL,
        chatModel: config.OLLAMA_CHAT_MODEL,
        embedModel: config.OLLAMA_EMBED_MODEL,
        timeoutMs: config.MODEL_TIMEOUT_MS,
      });
    case 'fake':
      return new FakeProvider({ model: config.OLLAMA_CHAT_MODEL });
    case 'none':
      return new NoneProvider();
  }
}
