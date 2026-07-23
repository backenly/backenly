/**
 * UNDERSTANDING — Shared types
 * ============================
 * Phase 1 of the architecture upgrade. These types describe what Backenly
 * *understood* about a product before it generates schema, APIs, or runtime.
 *
 * Phase 1 is shadow-mode only: the modules that produce these values do not
 * change execution behaviour. They emit a structured object via SSE so the
 * dashboard (Phase 9) can render a "Product Understanding" card and the
 * verifier (Phase 7) can check that what was generated matches what was
 * understood.
 *
 * No type here is consumed by the executor yet. They live independently of
 * IntentGraph (lib/ai/intent-planner.ts) and TablePurpose
 * (lib/ai/semantic-domain-analyzer.ts) on purpose — those describe *how*
 * Backenly will build, while these describe *what* the user actually wants.
 */

// ─── Backend Patterns ─────────────────────────────────────────────────────────
//
// A backend pattern is a recurring shape of system architecture. A single
// product usually combines several. The 3D Video SaaS example needs
// saas + async_job_system + credit_wallet + media_storage +
// ai_provider_integration + admin_console + notifications.

export type BackendPattern =
  | 'saas'
  | 'marketplace'
  | 'ecommerce'
  | 'content_platform'
  | 'social'
  | 'messaging'
  | 'media_storage'
  | 'async_job_system'
  | 'ai_provider_integration'
  | 'credit_wallet'
  | 'subscription_billing'
  | 'one_time_payments'
  | 'admin_console'
  | 'notifications'
  | 'realtime'
  | 'webhook_ingestion'
  | 'analytics'
  | 'booking_system'
  | 'logistics'
  | 'healthcare_records'
  | 'education_lms'
  | 'fintech_ledger'
  | 'iot_telemetry'
  | 'crm'

// ─── Critical Capabilities ────────────────────────────────────────────────────
//
// Capabilities are the high-level things a backend *must do well*. They are
// the units the dashboard's Workflow Readiness card will check against and
// the verifier will run scenarios against.

export type CriticalCapability =
  | 'auth'
  | 'admin'
  | 'credits'
  | 'subscriptions'
  | 'payments'
  | 'order_management'
  | 'inventory'
  | 'shipping'
  | 'booking'
  | 'storage'
  | 'ai_jobs'
  | 'video_generation_jobs'
  | 'workflow_engine'
  | 'notifications'
  | 'realtime'
  | 'messaging'
  | 'webhooks'
  | 'search'
  | 'ratings_reviews'
  | 'analytics'
  | 'reporting'
  | 'audit_logs'

// ─── Confidence ───────────────────────────────────────────────────────────────

export interface CapabilityConfidence {
  /** 0..1 — derived from the number of distinct evidence signals */
  score: number
  band: 'high' | 'medium' | 'low'
}

// ─── Capability Graph ─────────────────────────────────────────────────────────
//
// A directed graph of CriticalCapability nodes plus the relationships that
// run between them (e.g. ai_jobs depends_on storage + credits + auth).
// Phase 6 (Domain-Aware API Generator) will read this to figure out which
// extra endpoints / workers / triggers a given capability needs.

export type CapabilityRelationship = 'depends_on' | 'triggers' | 'enriches'

export type CapabilityNodeStatus = 'inferred' | 'confirmed' | 'missing'

export interface CapabilityNode {
  id: CriticalCapability
  label: string
  /** Human-readable explanation of why this capability is in the graph */
  reason: string
  /** Backend patterns that introduced this capability */
  patterns: BackendPattern[]
  status: CapabilityNodeStatus
}

export interface CapabilityEdge {
  from: CriticalCapability
  to: CriticalCapability
  relationship: CapabilityRelationship
  /** Plain-English description of the relationship */
  description: string
}

export interface CapabilityGraph {
  nodes: CapabilityNode[]
  edges: CapabilityEdge[]
}

// ─── Product Understanding ────────────────────────────────────────────────────

export interface ProductUnderstanding {
  /** Human-readable label, e.g. "3D Video Generation SaaS" */
  productLabel: string
  /**
   * Snake-case primary domain identifier — richer than IntentGraph.app_type.
   * Examples: ai_video_saas, food_delivery_app, hospital_booking_app,
   * learning_platform, ecommerce_store, marketplace, internal_crm,
   * ai_chatbot_platform.
   */
  primaryDomain: string
  /** Recurring backend shapes this product needs, in inferred order of importance */
  backendPatterns: BackendPattern[]
  /** Critical capabilities derived from those patterns */
  criticalCapabilities: CriticalCapability[]
  /** Capability dependency graph */
  graph: CapabilityGraph
  /** Composite confidence across all signals */
  confidence: CapabilityConfidence
  /** Concrete signals from the prompt that supported each pattern detection */
  evidence: string[]
  /** Ambiguities, conflicts, or missing context the user should resolve */
  warnings: string[]
  /** Snake-case label of the prompt that produced this understanding */
  promptHash: string
  /**
   * Always true in Phase 1 — flips to false when the executor starts consuming
   * this structure (Phase 6+). Surfaced so the dashboard can render a "Shadow
   * mode" badge until then.
   */
  shadowMode: boolean
}
