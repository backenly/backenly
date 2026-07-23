/**
 * DOMAIN BLUEPRINTS — TYPES
 * =========================
 * A Blueprint is a *deterministic*, exhaustive specification of the backend
 * for a recognised app domain (social-media, marketplace, SaaS, chat,
 * blog, project management). The agent's LLM still drives clarification +
 * customisation, but the *coverage* of the build comes from the blueprint —
 * not from whatever the model happened to remember in its first draft.
 *
 * This is the standard funded-agent pattern:
 *   • Detect the domain from the user's prompt   →  detectDomain()
 *   • Look up the blueprint for that domain      →  getBlueprint()
 *   • Expand a draft plan with blueprint steps   →  enrichPlan()
 *   • Render plan to the user for confirmation   →  brain agent
 *   • Execute every step deterministically       →  brain agent
 *
 * A BlueprintStep is the concrete call the executor will make — tool name +
 * fully-formed args. No follow-up LLM round-trip is needed to fill them in.
 *
 * Schemas use the brain's create_table column vocabulary:
 *   types: text | int | bigint | boolean | timestamp | uuid | jsonb | numeric
 *   options: nullable?, unique?, fkTo? (referenced table name)
 */

/**
 * Curated keyword-matched domains. These have hand-written blueprints in
 * lib/ai/blueprints/<domain>.ts. The architect-generated blueprints (for any
 * other domain the user invents) carry a free-form domain string instead and
 * are not constrained to this union.
 */
export type CuratedDomain =
  | 'social-media'
  | 'marketplace'
  | 'saas'
  | 'chat-app'
  | 'blog'
  | 'project-mgmt'

/**
 * The runtime domain identifier on a Blueprint — either one of the six
 * curated domains, or any kebab-case label the LLM architect produced for an
 * uncurated domain (e.g. "music-streaming", "telemedicine", "ride-hailing").
 */
export type BlueprintDomain = CuratedDomain | string

/** A single create_table column spec — mirrors the create_table tool's schema. */
export interface BlueprintColumn {
  name: string
  type: 'text' | 'int' | 'bigint' | 'boolean' | 'timestamp' | 'uuid' | 'jsonb' | 'numeric'
  nullable?: boolean
  unique?: boolean
  fkTo?: string
}

/** RLS template names accepted by the add_rls tool. */
export type BlueprintRlsPolicy =
  | 'owner_read_write'
  | 'public_read'
  | 'org_members'
  | 'admin_only'
  | 'all_access'

/**
 * A single executable plan step. `tool` is the brain tool name (same vocabulary
 * the LLM uses); `args` is the fully-formed argument object the dispatcher
 * passes to that tool. `label` is the user-facing description rendered in the
 * proposal card.
 */
export interface BlueprintStep {
  label: string
  tool: string
  args: Record<string, unknown>
  destructive?: boolean
}

/**
 * A complete blueprint for one domain. Steps execute IN ORDER — auth before
 * tables that depend on auth-aware RLS, tables before APIs, APIs before
 * realtime + triggers, buckets last (they have no dependencies).
 */
export interface Blueprint {
  domain: BlueprintDomain
  /** Display title for the proposal card. */
  title: string
  /** One-line summary for the proposal card. */
  summary: string
  /** Ordered, exhaustive list of steps. */
  steps: BlueprintStep[]
  /** Any caveats / warnings to surface in the proposal card. */
  warnings?: string[]
}

/** Result of detecting a domain from the user's free-text prompt. */
export interface BlueprintMatch {
  domain: BlueprintDomain
  /** 0..1 — how confident the keyword + heuristic matcher is. */
  confidence: number
  /** Which signal in the prompt matched (debug + telemetry). */
  matchedOn: string
}
