/**
 * LONG-HORIZON ORCHESTRATOR — AI CTO Layer
 * ==========================================
 * Tracks project evolution across weeks/months — not just single builds.
 *
 * Responsibilities:
 *  - Phase tracking (MVP → Growth → Scale → Mature)
 *  - Technical debt register (accumulation, categorization, prioritization)
 *  - Scaling milestone prediction (bottlenecks before they happen)
 *  - Dependency evolution (how entity relationships change over time)
 *  - Roadmap generation (AI-driven next steps based on trajectory)
 *
 * Storage: extends ProjectMemory.evolution (same architecturalMemory JSON blob)
 * Fast path: updateEvolutionAfterBuild — no LLM, pure heuristics, < 50ms
 * Deep path: analyzeProjectEvolution — LLM-powered, called on-demand or every 5 builds
 */

import { loadProjectMemory, saveProjectMemory } from './project-memory'
import type { BuildResponse } from './build-runtime/types'

// ── Evolution Types ───────────────────────────────────────────────────────────

export interface EvolutionPhase {
  id: string
  name: 'MVP' | 'Growth' | 'Scale' | 'Mature'
  startedAt: string
  completedAt?: string
  entitiesAtStart: number
  entitiesAtEnd?: number
  keyDecisions: string[]
  summary: string
}

export type DebtCategory =
  | 'missing_index'
  | 'weak_rls'
  | 'n_plus_one_risk'
  | 'unbounded_pagination'
  | 'missing_retry_queue'
  | 'schema_coupling'
  | 'auth_gap'
  | 'storage_abuse'
  | 'webhook_replay_risk'
  | 'other'

export type DebtSeverity = 'critical' | 'high' | 'medium' | 'low'

export interface TechnicalDebtItem {
  id: string
  detectedAt: string
  category: DebtCategory
  severity: DebtSeverity
  location: string
  description: string
  recommendation: string
  autoFixable: boolean
  fix?: string
  resolvedAt?: string
}

export interface ScalingMilestone {
  id: string
  predictedAt: string
  type: 'table_size' | 'query_load' | 'auth_bottleneck' | 'storage_growth' | 'api_rate_limit' | 'realtime_scale'
  trigger: string
  currentEstimate: string
  recommendation: string
  urgency: 'now' | 'within_month' | 'within_quarter' | 'future'
  reached?: boolean
  reachedAt?: string
}

export interface RoadmapItem {
  id: string
  generatedAt: string
  phase: 'immediate' | 'next_sprint' | 'next_quarter' | 'future'
  category: 'feature' | 'performance' | 'security' | 'debt' | 'infrastructure'
  title: string
  rationale: string
  effort: 'small' | 'medium' | 'large'
  priority: number
  dependsOn: string[]
  completedAt?: string
}

export interface DependencyNode {
  entity: string
  dependsOn: string[]
  dependedOnBy: string[]
  couplingScore: number
  changeFrequency: number
}

export interface EvolutionState {
  currentPhase: EvolutionPhase
  phases: EvolutionPhase[]
  debtItems: TechnicalDebtItem[]
  totalDebtScore: number
  scalingMilestones: ScalingMilestone[]
  roadmap: RoadmapItem[]
  roadmapGeneratedAt?: string
  entityDependencies: DependencyNode[]
  buildsCount: number
  entitiesAddedThisBuild: number
  firstBuildAt?: string
  lastAnalyzedAt?: string
}

// ── Phase transitions ─────────────────────────────────────────────────────────

function determinePhaseName(entityCount: number, buildsCount: number): EvolutionPhase['name'] {
  if (entityCount <= 5 && buildsCount <= 3) return 'MVP'
  if (entityCount <= 12 || buildsCount <= 10) return 'Growth'
  if (entityCount <= 25 || buildsCount <= 25) return 'Scale'
  return 'Mature'
}

function makePhase(name: EvolutionPhase['name'], entityCount: number): EvolutionPhase {
  return {
    id: `phase-${name.toLowerCase()}-${Date.now()}`,
    name,
    startedAt: new Date().toISOString(),
    entitiesAtStart: entityCount,
    keyDecisions: [],
    summary: PHASE_SUMMARIES[name],
  }
}

const PHASE_SUMMARIES: Record<EvolutionPhase['name'], string> = {
  MVP: 'Core data model established. Focus on correctness over performance.',
  Growth: 'Product validated. Adding features rapidly — watch for schema coupling.',
  Scale: 'Multiple complex entities. Index strategy and RLS correctness are critical.',
  Mature: 'Stable architecture. Focus on observability, tech debt, and optimization.',
}

function emptyEvolution(): EvolutionState {
  const phase = makePhase('MVP', 0)
  return {
    currentPhase: phase,
    phases: [phase],
    debtItems: [],
    totalDebtScore: 0,
    scalingMilestones: [],
    roadmap: [],
    entityDependencies: [],
    buildsCount: 0,
    entitiesAddedThisBuild: 0,
  }
}

// ── Fast path: update after every build (no LLM) ─────────────────────────────

/**
 * Called from run-build.ts after each successful build.
 * Purely heuristic — no LLM, completes in < 50ms.
 * Fire-and-forget safe.
 */
export async function updateEvolutionAfterBuild(
  projectId: string,
  buildResponse: BuildResponse,
  message: string,
): Promise<void> {
  try {
    const memory = await loadProjectMemory(projectId)
    const ev: EvolutionState = (memory as any).evolution ?? emptyEvolution()

    // ── Metrics
    ev.buildsCount++
    if (!ev.firstBuildAt) ev.firstBuildAt = new Date().toISOString()

    const newEntities = buildResponse.built
      .filter(n => n.id.startsWith('schema.'))
      .map(n => n.id.replace('schema.', ''))

    ev.entitiesAddedThisBuild = newEntities.length

    const totalEntities = memory.builtSoFar.length

    // ── Phase transition check
    const expectedPhase = determinePhaseName(totalEntities, ev.buildsCount)
    if (ev.currentPhase.name !== expectedPhase) {
      // Close current phase
      ev.currentPhase.completedAt = new Date().toISOString()
      ev.currentPhase.entitiesAtEnd = totalEntities

      const key = buildKeyDecision(buildResponse, message)
      if (key) ev.currentPhase.keyDecisions.push(key)

      // Open new phase
      const newPhase = makePhase(expectedPhase, totalEntities)
      ev.currentPhase = newPhase
      ev.phases.push(newPhase)
      console.log(`[LongHorizon] Phase transition: → ${expectedPhase} (${totalEntities} entities, ${ev.buildsCount} builds)`)
    } else {
      // Record key decision in current phase
      const key = buildKeyDecision(buildResponse, message)
      if (key) {
        ev.currentPhase.keyDecisions.push(key)
        if (ev.currentPhase.keyDecisions.length > 10) {
          ev.currentPhase.keyDecisions = ev.currentPhase.keyDecisions.slice(-10)
        }
      }
    }

    // ── Heuristic debt detection
    const newDebt = detectHeuristicDebt(buildResponse, memory.builtSoFar, ev.debtItems)
    for (const item of newDebt) {
      const alreadyExists = ev.debtItems.some(d => d.category === item.category && d.location === item.location)
      if (!alreadyExists) ev.debtItems.push(item)
    }

    // Auto-resolve debt for entities that were just (re)built with fixes
    for (const debtItem of ev.debtItems) {
      if (!debtItem.resolvedAt && newEntities.includes(debtItem.location)) {
        // Node was re-executed — optimistically mark as potentially resolved
        // (production intelligence layer does the real check)
        debtItem.resolvedAt = new Date().toISOString()
      }
    }

    // Cap debt register at 50
    const activeDebt = ev.debtItems.filter(d => !d.resolvedAt)
    ev.totalDebtScore = computeDebtScore(activeDebt)

    // ── Scaling milestone predictions
    const newMilestones = predictScalingMilestones(memory.builtSoFar, ev.scalingMilestones)
    for (const m of newMilestones) {
      const exists = ev.scalingMilestones.some(e => e.type === m.type && e.trigger === m.trigger)
      if (!exists) ev.scalingMilestones.push(m)
    }

    // ── Entity dependency graph update
    ev.entityDependencies = buildDependencyNodes(memory.builtSoFar, buildResponse)

    // ── Trigger deep analysis every 5 builds or on phase transition
    const shouldDeepAnalyze = (ev.buildsCount % 5 === 0) || (ev.currentPhase.entitiesAtStart === totalEntities)
    if (shouldDeepAnalyze && ev.buildsCount > 1) {
      // Fire-and-forget deep analysis
      runDeepAnalysis(projectId, ev, memory.builtSoFar, message).catch(() => {})
    }

    // ── Persist
    ;(memory as any).evolution = ev
    await saveProjectMemory(projectId, memory)

    console.log(
      `[LongHorizon] Evolution updated: phase=${ev.currentPhase.name} ` +
      `builds=${ev.buildsCount} debt=${ev.totalDebtScore} ` +
      `newEntities=${newEntities.length} milestones=${ev.scalingMilestones.length}`,
    )
  } catch (err: any) {
    console.warn('[LongHorizon] updateEvolutionAfterBuild failed (non-fatal):', err?.message)
  }
}

// ── Deep path: full LLM-powered analysis ─────────────────────────────────────

/**
 * Full evolution analysis — runs LLM reasoning over the entire project trajectory.
 * Called every 5 builds or on-demand via the evolution API.
 * Results stored back in architecturalMemory.
 */
export async function analyzeProjectEvolution(projectId: string): Promise<EvolutionState> {
  const memory = await loadProjectMemory(projectId)
  const ev: EvolutionState = (memory as any).evolution ?? emptyEvolution()

  if (ev.buildsCount === 0) return ev

  try {
    const OpenAI = (await import('openai')).default
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

    const context = buildEvolutionContext(ev, memory.builtSoFar, memory.decisions ?? [])

    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 2000,
      messages: [
        {
          role: 'system',
          content: `You are an AI CTO analyzing a backend project's evolution.
Return JSON matching this exact schema:
{
  "phaseAssessment": "2-3 sentence assessment of current phase and trajectory",
  "roadmap": [
    {
      "phase": "immediate|next_sprint|next_quarter|future",
      "category": "feature|performance|security|debt|infrastructure",
      "title": "short action title",
      "rationale": "why this matters now",
      "effort": "small|medium|large",
      "priority": 1-10
    }
  ],
  "scalingRisks": [
    {
      "type": "table_size|query_load|auth_bottleneck|storage_growth|api_rate_limit|realtime_scale",
      "trigger": "specific threshold or condition",
      "currentEstimate": "where you are now",
      "recommendation": "what to do",
      "urgency": "now|within_month|within_quarter|future"
    }
  ],
  "architecturalInsights": ["insight 1", "insight 2", "insight 3"]
}
Return ONLY valid JSON — no markdown, no explanation.`,
        },
        {
          role: 'user',
          content: context,
        },
      ],
    })

    const raw = response.choices[0]?.message?.content?.trim() ?? '{}'
    const parsed = JSON.parse(raw)

    // Merge roadmap items
    const newRoadmapItems: RoadmapItem[] = (parsed.roadmap ?? []).map((r: any, i: number) => ({
      id: `roadmap-${Date.now()}-${i}`,
      generatedAt: new Date().toISOString(),
      phase: r.phase ?? 'next_sprint',
      category: r.category ?? 'feature',
      title: r.title ?? 'Untitled',
      rationale: r.rationale ?? '',
      effort: r.effort ?? 'medium',
      priority: r.priority ?? 5,
      dependsOn: [],
    }))

    // Replace roadmap (keep completed items)
    const completed = ev.roadmap.filter(r => r.completedAt)
    ev.roadmap = [...completed, ...newRoadmapItems]
    ev.roadmapGeneratedAt = new Date().toISOString()

    // Merge new scaling predictions
    const newMilestones: ScalingMilestone[] = (parsed.scalingRisks ?? []).map((r: any, i: number) => ({
      id: `scale-${Date.now()}-${i}`,
      predictedAt: new Date().toISOString(),
      type: r.type ?? 'query_load',
      trigger: r.trigger ?? '',
      currentEstimate: r.currentEstimate ?? '',
      recommendation: r.recommendation ?? '',
      urgency: r.urgency ?? 'future',
    }))

    for (const m of newMilestones) {
      const exists = ev.scalingMilestones.some(e => e.type === m.type && !e.reached)
      if (!exists) ev.scalingMilestones.push(m)
    }

    // Record phase assessment as key decision
    if (parsed.phaseAssessment) {
      ev.currentPhase.summary = parsed.phaseAssessment
    }

    ev.lastAnalyzedAt = new Date().toISOString()

    // Persist enriched state
    ;(memory as any).evolution = ev
    await saveProjectMemory(projectId, memory)

    console.log(`[LongHorizon] Deep analysis complete: ${newRoadmapItems.length} roadmap items, ${newMilestones.length} scaling risks`)
  } catch (err: any) {
    console.warn('[LongHorizon] Deep analysis failed (non-fatal):', err?.message)
  }

  return ev
}

// ── Heuristic debt detection ──────────────────────────────────────────────────

function detectHeuristicDebt(
  buildResponse: BuildResponse,
  allTables: string[],
  existingDebt: TechnicalDebtItem[],
): TechnicalDebtItem[] {
  const debt: TechnicalDebtItem[] = []
  const now = new Date().toISOString()

  // Check for tables without RLS (high-risk tables by name heuristic)
  const sensitiveTablePatterns = /^(users?|payments?|orders?|invoices?|secrets?|tokens?|sessions?|credentials?)$/i
  for (const table of allTables) {
    if (sensitiveTablePatterns.test(table)) {
      const hasRls = buildResponse.built.some(n => n.id === `permissions.${table}` || n.id.includes('permissions'))
      if (!hasRls) {
        debt.push({
          id: `debt-rls-${table}-${now}`,
          detectedAt: now,
          category: 'weak_rls',
          severity: 'high',
          location: table,
          description: `Sensitive table "${table}" has no verified RLS policy.`,
          recommendation: `Add row-level security: only owners can SELECT/UPDATE their own rows.`,
          autoFixable: true,
          fix: `ALTER TABLE workspace.${table} ENABLE ROW LEVEL SECURITY;\nCREATE POLICY "${table}_owner" ON workspace.${table} USING (user_id = auth.uid());`,
        })
      }
    }
  }

  // Pagination risk: > 5 tables and no pagination hints in any API
  if (allTables.length > 5) {
    const hasUnboundedRisk = !existingDebt.some(d => d.category === 'unbounded_pagination')
    if (hasUnboundedRisk) {
      debt.push({
        id: `debt-pagination-${now}`,
        detectedAt: now,
        category: 'unbounded_pagination',
        severity: 'medium',
        location: 'api',
        description: 'APIs with > 5 tables risk returning unbounded result sets.',
        recommendation: 'Add ?limit and ?offset to all list endpoints. Cap at 100 rows server-side.',
        autoFixable: false,
      })
    }
  }

  // Missing retry queue: if integrations exist without a retry table
  const hasIntegrations = buildResponse.built.some(n => n.id.startsWith('integration.'))
  const hasRetryQueue = allTables.some(t => /retry|queue|job|task/.test(t.toLowerCase()))
  if (hasIntegrations && !hasRetryQueue && !existingDebt.some(d => d.category === 'missing_retry_queue')) {
    debt.push({
      id: `debt-retry-${now}`,
      detectedAt: now,
      category: 'missing_retry_queue',
      severity: 'medium',
      location: 'integrations',
      description: 'External integrations (webhooks, email, payments) have no retry queue for transient failures.',
      recommendation: 'Add a job_queue table: id, type, payload, attempts, next_retry_at, status.',
      autoFixable: false,
    })
  }

  // Storage abuse risk
  const hasStorage = buildResponse.built.some(n => n.id.startsWith('storage.'))
  const hasSizeLimit = allTables.some(t => /file|upload|attachment|media|asset/.test(t.toLowerCase()))
  if (hasStorage && hasSizeLimit && !existingDebt.some(d => d.category === 'storage_abuse')) {
    debt.push({
      id: `debt-storage-${now}`,
      detectedAt: now,
      category: 'storage_abuse',
      severity: 'low',
      location: 'storage',
      description: 'Storage buckets have no enforced per-user or per-org size limits.',
      recommendation: 'Add quota enforcement on upload: check total storage before accepting files.',
      autoFixable: false,
    })
  }

  return debt
}

function computeDebtScore(activeDebt: TechnicalDebtItem[]): number {
  const weights: Record<DebtSeverity, number> = { critical: 25, high: 10, medium: 5, low: 2 }
  const total = activeDebt.reduce((s, d) => s + (weights[d.severity] ?? 2), 0)
  return Math.min(100, total)
}

// ── Scaling milestone prediction ──────────────────────────────────────────────

function predictScalingMilestones(
  allTables: string[],
  existing: ScalingMilestone[],
): ScalingMilestone[] {
  const milestones: ScalingMilestone[] = []
  const now = new Date().toISOString()

  // High-volume tables
  const volumePatterns = /^(events?|logs?|activities?|notifications?|analytics|impressions?|clicks?|messages?|feed)$/i
  const volumeTables = allTables.filter(t => volumePatterns.test(t))

  for (const table of volumeTables) {
    if (!existing.some(m => m.type === 'table_size' && m.trigger.includes(table))) {
      milestones.push({
        id: `scale-table-${table}-${now}`,
        predictedAt: now,
        type: 'table_size',
        trigger: `${table} reaches 10M rows`,
        currentEstimate: 'Not yet measurable — early stage',
        recommendation: `Partition ${table} by created_at month. Add composite index on (user_id, created_at DESC).`,
        urgency: 'within_quarter',
      })
    }
  }

  // Realtime scale risk
  const hasRealtime = allTables.some(t => /notification|message|feed|event|presence/.test(t.toLowerCase()))
  if (hasRealtime && allTables.length > 8 && !existing.some(m => m.type === 'realtime_scale')) {
    milestones.push({
      id: `scale-realtime-${now}`,
      predictedAt: now,
      type: 'realtime_scale',
      trigger: '> 500 concurrent realtime connections',
      currentEstimate: 'Not yet measurable — early stage',
      recommendation: 'Add connection pooler (PgBouncer) and consider dedicated realtime service for > 1K users.',
      urgency: 'within_quarter',
    })
  }

  // Auth bottleneck (many tables = many JWT validation calls)
  if (allTables.length > 15 && !existing.some(m => m.type === 'auth_bottleneck')) {
    milestones.push({
      id: `scale-auth-${now}`,
      predictedAt: now,
      type: 'auth_bottleneck',
      trigger: 'JWT validation overhead at > 1K req/s',
      currentEstimate: 'Not yet at scale',
      recommendation: 'Cache JWT payloads in Redis (TTL = remaining token lifetime). Add Redis URL to env.',
      urgency: 'future',
    })
  }

  return milestones
}

// ── Entity dependency graph ───────────────────────────────────────────────────

function buildDependencyNodes(
  allTables: string[],
  buildResponse: BuildResponse,
): DependencyNode[] {
  return allTables.map(entity => {
    // Infer dependencies from naming conventions
    const inferredDeps = allTables.filter(other =>
      other !== entity &&
      (entity.toLowerCase().includes(other.toLowerCase().replace(/s$/, '')) ||
       other.toLowerCase().includes(entity.toLowerCase().replace(/s$/, '')))
    )

    // Count how frequently this entity appears across all build responses
    const builtThisBuild = buildResponse.built.some(n => n.id === `schema.${entity}`)

    return {
      entity,
      dependsOn: inferredDeps.slice(0, 5),
      dependedOnBy: allTables.filter(t =>
        t !== entity && inferredDeps.includes(t) === false &&
        t.toLowerCase().includes(entity.toLowerCase().replace(/s$/, ''))
      ).slice(0, 5),
      couplingScore: Math.min(10, inferredDeps.length * 2),
      changeFrequency: builtThisBuild ? 1 : 0,
    }
  })
}

// ── Context builder for LLM ───────────────────────────────────────────────────

function buildEvolutionContext(
  ev: EvolutionState,
  allTables: string[],
  decisions: Array<{ when: string; category: string; decision: string; rationale: string }>,
): string {
  const lines: string[] = []

  lines.push(`## Project Evolution State`)
  lines.push(`Phase: ${ev.currentPhase.name} | Builds: ${ev.buildsCount} | Tables: ${allTables.length}`)
  lines.push(`Tables: ${allTables.join(', ')}`)
  lines.push(``)

  if (ev.phases.length > 1) {
    lines.push(`## Phase History`)
    for (const p of ev.phases.slice(-3)) {
      lines.push(`- ${p.name} (${p.startedAt.slice(0, 10)}${p.completedAt ? ` → ${p.completedAt.slice(0, 10)}` : ' → now'}): ${p.summary}`)
    }
    lines.push(``)
  }

  if (ev.debtItems.length > 0) {
    const active = ev.debtItems.filter(d => !d.resolvedAt)
    lines.push(`## Technical Debt (${active.length} active items, score: ${ev.totalDebtScore}/100)`)
    for (const d of active.slice(0, 5)) {
      lines.push(`- [${d.severity.toUpperCase()}] ${d.category} on ${d.location}: ${d.description}`)
    }
    lines.push(``)
  }

  if (decisions.length > 0) {
    lines.push(`## Recent Decisions`)
    for (const d of decisions.slice(-5)) {
      lines.push(`- [${d.when}] ${d.decision} (${d.rationale.slice(0, 100)})`)
    }
    lines.push(``)
  }

  const highCoupling = ev.entityDependencies.filter(e => e.couplingScore >= 6)
  if (highCoupling.length > 0) {
    lines.push(`## Coupling Risk`)
    for (const e of highCoupling.slice(0, 3)) {
      lines.push(`- ${e.entity} (coupling: ${e.couplingScore}/10, deps: ${e.dependsOn.join(', ')})`)
    }
    lines.push(``)
  }

  lines.push(`Based on this trajectory, generate a prioritized roadmap and identify scaling risks.`)

  return lines.join('\n')
}

// ── Deep analysis async runner ────────────────────────────────────────────────

async function runDeepAnalysis(
  projectId: string,
  ev: EvolutionState,
  allTables: string[],
  _message: string,
): Promise<void> {
  // Delegate to the public entry point (handles save internally)
  await analyzeProjectEvolution(projectId)
}

// ── Key decision extractor ────────────────────────────────────────────────────

function buildKeyDecision(buildResponse: BuildResponse, message: string): string | null {
  const built = buildResponse.built
  if (built.length === 0) return null

  const schemaCount = built.filter(n => n.id.startsWith('schema.')).length
  const hasAuth = built.some(n => n.id.startsWith('auth.'))
  const hasIntegration = built.some(n => n.id.startsWith('integration.'))
  const hasRealtime = built.some(n => n.id.startsWith('realtime.'))

  const parts: string[] = []
  if (schemaCount > 0) parts.push(`${schemaCount} tables`)
  if (hasAuth) parts.push('auth')
  if (hasIntegration) parts.push('integrations')
  if (hasRealtime) parts.push('realtime')

  if (parts.length === 0) return null
  return `Built ${parts.join(', ')}: ${message.slice(0, 80)}`
}

// ── Public read helper ────────────────────────────────────────────────────────

/**
 * Load the current evolution state for a project without triggering analysis.
 */
export async function loadEvolutionState(projectId: string): Promise<EvolutionState | null> {
  try {
    const memory = await loadProjectMemory(projectId)
    return (memory as any).evolution ?? null
  } catch {
    return null
  }
}
