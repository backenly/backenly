/**
 * NEXT BEST ACTION — Phase 8 (preview / shadow mode)
 * ==================================================
 * Deterministic ranking that turns a list of `HealthFindingPreview` into a
 * short, ordered list of "next best actions" the dashboard can show.
 *
 * Ranking philosophy:
 *   1. Anything that *blocks* live verification ranks first (you can't prove
 *      the backend is correct without these).
 *   2. Within a tier, primary-domain dependencies come first (a 3D Video
 *      SaaS without a video provider can do nothing — rank it above an
 *      auth gap).
 *   3. Severity then tie-breaks within a tier.
 *
 * Strictly deterministic — no LLM, no DB, no network.
 */

import type { ProductUnderstanding } from '../ai/understanding/types'
import type { HealthFindingPreview } from './ai-report-to-health-findings'

export interface NextBestAction {
  /** Stable id, e.g. 'connect_video_provider' */
  id: string
  /** Human-readable display label */
  label: string
  /** One-sentence motivation */
  reason: string
  /** Lower number = higher priority */
  priority: number
  /** Findings that this action would resolve */
  resolvesFindingIds: string[]
}

export interface NextBestActionInput {
  understanding?: ProductUnderstanding
  findings: HealthFindingPreview[]
}

// ─── Domain → priority weight for each integration / runtime ─────────────────
//
// The lower the score, the higher the action ranks. Negative numbers boost
// integrations that *define* the product. Domain-aware weights ensure
// "connect video provider" ranks above "connect Stripe" for a 3D-Video SaaS
// even though both are critical.

const DOMAIN_PRIMARY_INTEGRATION: Record<string, string[]> = {
  ai_video_saas:        ['runway', 'stability', 'kling', 'video provider'],
  ai_image_saas:        ['stability', 'openai', 'image provider'],
  ai_chatbot_platform:  ['openai', 'anthropic'],
  food_delivery_app:    ['stripe', 'payment provider'],
  ecommerce_store:      ['stripe', 'payment provider'],
  marketplace:          ['stripe', 'payment provider'],
  hospital_booking_app: [], // primary concern is double-booking + RLS, not external integration
  learning_platform:    ['stripe', 'payment provider'],
}

function isDomainPrimaryIntegration(
  understanding: ProductUnderstanding | undefined,
  needle: string,
): boolean {
  if (!understanding) return false
  const list = DOMAIN_PRIMARY_INTEGRATION[understanding.primaryDomain] ?? []
  const lower = needle.toLowerCase()
  return list.some(p => lower.includes(p.toLowerCase()))
}

// ─── Action templates ────────────────────────────────────────────────────────

interface ActionAcc {
  id: string
  label: string
  reason: string
  priority: number
  resolvesFindingIds: string[]
}

function severityWeight(s: HealthFindingPreview['severity']): number {
  if (s === 'critical') return 0
  if (s === 'warning')  return 1
  return 2
}

function bumpAction(
  acc: Map<string, ActionAcc>,
  args: { id: string; label: string; reason: string; priority: number; findingId: string },
): void {
  const existing = acc.get(args.id)
  if (existing) {
    if (args.priority < existing.priority) existing.priority = args.priority
    if (!existing.resolvesFindingIds.includes(args.findingId)) {
      existing.resolvesFindingIds.push(args.findingId)
    }
    return
  }
  acc.set(args.id, {
    id: args.id,
    label: args.label,
    reason: args.reason,
    priority: args.priority,
    resolvesFindingIds: [args.findingId],
  })
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function computeNextBestActions(input: NextBestActionInput): NextBestAction[] {
  const acc = new Map<string, ActionAcc>()
  const understanding = input.understanding

  let blockedVerificationCount = 0

  for (const f of input.findings) {
    const severity = severityWeight(f.severity)

    // ── Integration findings → "Connect <integration>" ─────────────────────
    if (f.type === 'missing_integration') {
      const integration = extractIntegrationName(f)
      const isPrimary = isDomainPrimaryIntegration(understanding, integration)
      // Domain-primary integrations beat everything else.
      // Non-primary critical integrations come next.
      const priority = isPrimary ? 0 + severity : 10 + severity
      bumpAction(acc, {
        id: `connect_${slug(integration)}`,
        label: `Connect ${prettify(integration)}`,
        reason: `Required by ${countRelated(f)} planned scenario(s) — without it, behaviour verification cannot run.`,
        priority,
        findingId: f.id,
      })
    }

    // ── Runtime findings → "Provision <runtime>" ───────────────────────────
    if (f.type === 'missing_runtime') {
      const runtime = extractRuntimeName(f)
      // Queue / worker / event_bus = same tier as primary integrations.
      const isCoreRuntime = /(queue|worker|event[ _]bus|advisory[ _]locks)/i.test(runtime)
      const priority = isCoreRuntime ? 5 + severity : 15 + severity
      bumpAction(acc, {
        id: `provision_${slug(runtime)}`,
        label: `Provision ${prettify(runtime)} runtime`,
        reason: `Async workflows depend on ${prettify(runtime)} — verification cannot exercise this path.`,
        priority,
        findingId: f.id,
      })
    }

    // ── RLS / auth / security gaps ─────────────────────────────────────────
    if (f.type === 'missing_rls' || f.type === 'missing_auth' || f.type === 'security_gap') {
      bumpAction(acc, {
        id: `close_${f.type}`,
        label: f.type === 'missing_rls' ? 'Close RLS gap' :
               f.type === 'missing_auth' ? 'Close auth gap' : 'Close security gap',
        reason: f.recommendation,
        priority: 20 + severity,
        findingId: f.id,
      })
    }

    // ── Plan-only endpoints ────────────────────────────────────────────────
    if (f.type === 'missing_endpoint') {
      bumpAction(acc, {
        id: 'generate_planned_endpoints',
        label: 'Generate planned endpoints',
        reason: 'Phase 6 planned endpoints are not yet generated — handlers must be created.',
        priority: 25 + severity,
        findingId: f.id,
      })
    }

    // ── Verification-blocked counter ───────────────────────────────────────
    if (f.source === 'behavior_verification' && (f.type === 'missing_integration' || f.type === 'missing_runtime')) {
      blockedVerificationCount++
    }

    // ── Workflow / business-rule / state-machine warnings ──────────────────
    if (f.type === 'missing_workflow' || f.type === 'missing_business_rule') {
      bumpAction(acc, {
        id: `clarify_${f.type}`,
        label: f.type === 'missing_workflow' ? 'Clarify missing workflow' : 'Clarify missing business rule',
        reason: f.recommendation,
        priority: 30 + severity,
        findingId: f.id,
      })
    }

    if (f.type === 'readiness_overclaim') {
      bumpAction(acc, {
        id: 'resolve_understanding_warning',
        label: 'Resolve product understanding warnings',
        reason: f.recommendation,
        priority: 35 + severity,
        findingId: f.id,
      })
    }
  }

  // ── Always rank "Run behavior verification" last in the top 5 once all
  //    blockers are clear, OR mid-rank when only a few remain. We always
  //    surface the action so the user knows it exists.
  if (input.findings.length > 0) {
    const verificationPriority =
      blockedVerificationCount === 0 ? 6 : 40 + Math.min(blockedVerificationCount, 5)
    bumpAction(acc, {
      id: 'run_behavior_verification',
      label: 'Run behavior verification',
      reason:
        blockedVerificationCount === 0
          ? 'All blockers cleared — run the planned scenarios end-to-end.'
          : `${blockedVerificationCount} scenario(s) currently blocked by missing integration/runtime.`,
      priority: verificationPriority,
      findingId: '__behavior_verification__',
    })
  }

  return [...acc.values()]
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
}

export function topNextBestActions(input: NextBestActionInput, limit = 5): NextBestAction[] {
  return computeNextBestActions(input).slice(0, limit)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractIntegrationName(f: HealthFindingPreview): string {
  // Title looks like "Missing integration — payment provider"
  const m = f.title.match(/Missing integration\s+—\s+(.+)$/i)
  if (m) return m[1].trim()
  return 'integration'
}

function extractRuntimeName(f: HealthFindingPreview): string {
  const m = f.title.match(/Missing runtime\s+—\s+(.+)$/i)
  if (m) return m[1].trim()
  return 'runtime'
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function prettify(s: string): string {
  return s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
}

function countRelated(f: HealthFindingPreview): number {
  return (f.relatedScenarioIds?.length ?? 0) +
         (f.relatedWorkflowIds?.length ?? 0)
}
