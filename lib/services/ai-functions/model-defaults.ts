/**
 * THE MODELS ctx.integrations CALLS WHEN A FUNCTION NAMES NONE
 * ============================================================
 * ctx.integrations.anthropic.complete(), openai.complete() and openai.embed()
 * call a provider's model with the project's own key. Providers retire models
 * on a schedule, and a helper pinned to a retired model fails on every call:
 * anthropic.complete() was hard-wired to claude-3-5-haiku-20241022, which the
 * Claude API retired on 2026-02-19, so every function that called it threw,
 * the anthropic-chat function a connect wires up included (#607).
 *
 * A function can name its model (complete(prompt, { model })). These are the
 * defaults, and this is the one place to change them: the helpers
 * (integration-context.ts) read them, the code generator's method docs
 * (integration-registry.ts) are written from them, and
 * tests/unit/ai-helpers-call-current-models.spec.ts checks that the agent
 * docs (public/docs/agents/anthropic.md and openai.md) name the same models.
 *
 * The providers' schedules:
 *   https://docs.claude.com/en/docs/about-claude/model-deprecations
 *   https://developers.openai.com/api/docs/deprecations
 */

export const AI_HELPER_DEFAULTS = {
  anthropic: {
    complete: {
      /** Claude Haiku 5.5, the current Haiku, in place of the retired Claude Haiku 3.5. */
      model: 'claude-haiku-5-5',
      /**
       * Current Claude models think before they answer, and the thinking
       * counts toward max_tokens, so the cap leaves room for it as well as the
       * reply. It was 512 when the model did not think.
       */
      maxTokens: 1024,
      /**
       * How much the default model thinks. `low` is its fastest and cheapest
       * level, for a single call inside a function's 10-second run. It is sent
       * only with the default model: a model a function names keeps its own
       * default unless the function passes `effort`, since older models refuse
       * the parameter.
       */
      effort: 'low',
    },
  },
  openai: {
    complete: {
      /**
       * OpenAI has announced this model's shutdown for 2027-01-14 and names
       * gpt-6-luna as its replacement.
       */
      model: 'gpt-4o-mini',
      maxTokens: 256,
    },
    embed: {
      /**
       * Vectors from two embedding models can't be compared, so changing this
       * leaves the vectors a project stored before unmatched with new ones.
       */
      model: 'text-embedding-3-small',
    },
  },
} as const
