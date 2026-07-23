/**
 * BLUEPRINT INJECTOR
 * ==================
 * Converts ProductBlueprint dimensions into concrete BuildNodes and injects
 * them into the compiled phase list.
 *
 * Called from compileBuildJob when ctx.productBlueprint is set. Ensures every
 * dimension inferred by the Goal Understanding Engine becomes a real executable
 * node — not just a text hint in the effectiveGoal.
 *
 * Injection rules:
 *  - Storage  : blueprint buckets REPLACE auto-detected storage nodes
 *  - Integrations: blueprint integrations REPLACE auto-detected integration nodes
 *  - Functions: blueprint functions AUGMENT (added if not already present)
 *  - Realtime : blueprint channels REPLACE auto-detected realtime nodes
 *  - Schema   : blueprint entity list used to FILTER/REORDER schema nodes
 *  - Permissions: blueprint permission rules added to the permissions node params
 */

import type { BuildPhase, BuildNode, BlockedReason } from './types'
import type { ProductBlueprint, BlueprintBucket, BlueprintIntegration, BlueprintFunction } from '@/lib/ai/goal-understanding-engine'

// ── Node factory ──────────────────────────────────────────────────────────────

function makeNode(
  id: string,
  label: string,
  type: BuildNode['type'],
  phase: number,
  deps: string[] = [],
  opts: Partial<BuildNode> = {},
): BuildNode {
  return { id, label, type, phase, status: 'pending', dependencies: deps, ...opts }
}

// ── Storage injection ─────────────────────────────────────────────────────────

function blueprintStorageNodes(buckets: BlueprintBucket[], phase: number): BuildNode[] {
  return buckets.map(b => {
    const bucketId = b.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    return makeNode(
      `storage.${bucketId}`,
      `${b.name} bucket`,
      'storage',
      phase,
      [],
      {
        executionParams: {
          bucketName: b.name,
          isPublic: b.isPublic,
          purpose: b.purpose,
        },
      },
    )
  })
}

// ── Integration injection ─────────────────────────────────────────────────────

const INTEGRATION_BLOCKED_HINTS: Record<string, { envVar: string; userAction: string }> = {
  stripe:   { envVar: 'STRIPE_SECRET_KEY',   userAction: 'Paste your Stripe secret key from dashboard.stripe.com → Developers → API Keys' },
  resend:   { envVar: 'RESEND_API_KEY',       userAction: 'Paste your Resend API key from resend.com → API Keys' },
  sendgrid: { envVar: 'SENDGRID_API_KEY',     userAction: 'Paste your SendGrid API key' },
  twilio:   { envVar: 'TWILIO_AUTH_TOKEN',    userAction: 'Paste your Twilio Auth Token from console.twilio.com' },
  openai:   { envVar: 'OPENAI_API_KEY',       userAction: 'Paste your OpenAI API key from platform.openai.com' },
  paypal:   { envVar: 'PAYPAL_CLIENT_SECRET', userAction: 'Paste your PayPal client secret' },
}

function blueprintIntegrationNodes(
  integrations: BlueprintIntegration[],
  availableSecrets: string[],
  phase: number,
  schemaDeps: string[],
): BuildNode[] {
  return integrations.map(integ => {
    const name = integ.name.toLowerCase()
    const hint = INTEGRATION_BLOCKED_HINTS[name]
    const isAvailable = hint ? availableSecrets.includes(hint.envVar) : false

    const blockedReason: BlockedReason | undefined = (!isAvailable && hint)
      ? {
          type: 'missing_credential',
          description: `${integ.name} not connected — ${integ.purpose}`,
          requiredEnvVar: hint.envVar,
          resumeOnIntegration: name,
          userAction: hint.userAction,
        }
      : undefined

    return makeNode(
      `integration.${name}`,
      `${integ.name} integration`,
      'integration',
      phase,
      schemaDeps,
      {
        status: blockedReason ? 'blocked' : 'pending',
        blockedReason,
        executionParams: {
          provider: name,
          purpose: integ.purpose,
          required: integ.required,
          credentialKey: integ.credentialKey,
        },
        optional: !integ.required,
      },
    )
  })
}

// ── Realtime injection ────────────────────────────────────────────────────────

function blueprintRealtimeNodes(channels: string[], phase: number, schemaDeps: string[]): BuildNode[] {
  if (channels.length === 0) return []

  return [
    makeNode(
      'realtime.channels',
      `Realtime: ${channels.join(', ')}`,
      'realtime',
      phase,
      schemaDeps,
      {
        executionParams: {
          tableNames: channels,
          displayLabel: channels.join(', '),
        },
      },
    ),
  ]
}

// ── Function injection ────────────────────────────────────────────────────────

const TRIGGER_TYPE_MAP: Record<string, string> = {
  on_insert:  'on_db_insert',
  on_update:  'on_db_update',
  on_delete:  'on_db_delete',
  webhook:    'on_webhook',
  cron:       'scheduled',
  manual:     'http',
}

function blueprintFunctionNodes(
  functions: BlueprintFunction[],
  phase: number,
  integrationDeps: string[],
): BuildNode[] {
  return functions.map(fn => {
    const triggerType = TRIGGER_TYPE_MAP[fn.trigger] ?? fn.trigger
    const deps = fn.table
      ? [`schema.${fn.table}`, ...integrationDeps]
      : integrationDeps

    return makeNode(
      `function.${fn.name}`,
      fn.name.replace(/_/g, ' '),
      'function',
      phase,
      deps,
      {
        executionParams: {
          name: fn.name,
          description: fn.purpose,
          triggerType,
          triggerTable: fn.table,
        },
      },
    )
  })
}

// ── Phase-level helpers ───────────────────────────────────────────────────────

function findPhaseByType(phases: BuildPhase[], nodeType: BuildNode['type']): BuildPhase | undefined {
  return phases.find(p => p.nodes.some(n => n.type === nodeType))
}

function findOrCreatePhase(phases: BuildPhase[], name: string, targetPhase: number): BuildPhase {
  const existing = phases.find(p => p.name.toLowerCase() === name.toLowerCase())
  if (existing) return existing
  const newPhase: BuildPhase = { number: targetPhase, name, nodes: [] }
  phases.push(newPhase)
  return newPhase
}

function schemaNodeIds(phases: BuildPhase[]): string[] {
  return phases
    .flatMap(p => p.nodes)
    .filter(n => n.type === 'schema')
    .map(n => n.id)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Inject ProductBlueprint nodes into a compiled phase list.
 *
 * Called after compileBuildJob builds its initial phases. Blueprint nodes
 * replace auto-detected equivalents so every GUE inference becomes a real node.
 */
export function injectBlueprintNodes(
  phases: BuildPhase[],
  blueprint: ProductBlueprint,
  availableSecrets: string[] = [],
): BuildPhase[] {
  const schemaDeps = schemaNodeIds(phases)
  const lastPhaseNum = Math.max(...phases.map(p => p.number), 3)

  // ── 1. Storage ──────────────────────────────────────────────────────────────
  if (blueprint.storageBuckets.length > 0) {
    // Remove existing auto-detected storage nodes
    phases = phases.map(p => ({
      ...p,
      nodes: p.nodes.filter(n => n.type !== 'storage'),
    }))

    const storagePhase = findOrCreatePhase(phases, 'Storage', lastPhaseNum + 1)
    storagePhase.nodes.push(...blueprintStorageNodes(blueprint.storageBuckets, storagePhase.number))
  }

  // ── 2. Integrations ─────────────────────────────────────────────────────────
  if (blueprint.integrations.length > 0) {
    // Remove existing integration nodes
    phases = phases.map(p => ({
      ...p,
      nodes: p.nodes.filter(n => n.type !== 'integration'),
    }))

    const integPhase = findOrCreatePhase(phases, 'Integrations', lastPhaseNum + 2)
    integPhase.nodes.push(
      ...blueprintIntegrationNodes(blueprint.integrations, availableSecrets, integPhase.number, schemaDeps),
    )
  }

  // ── 3. Realtime ─────────────────────────────────────────────────────────────
  if (blueprint.realtimeChannels.length > 0) {
    // Remove existing realtime nodes (will be replaced with blueprint channels)
    phases = phases.map(p => ({
      ...p,
      nodes: p.nodes.filter(n => n.type !== 'realtime'),
    }))

    const rtPhase = findPhaseByType(phases, 'flow') ?? findOrCreatePhase(phases, 'Business Flows', 3)
    rtPhase.nodes.push(...blueprintRealtimeNodes(blueprint.realtimeChannels, rtPhase.number, schemaDeps))
  }

  // ── 4. Functions ─────────────────────────────────────────────────────────────
  if (blueprint.functions.length > 0) {
    const integrationNodeIds = phases
      .flatMap(p => p.nodes)
      .filter(n => n.type === 'integration')
      .map(n => n.id)

    const existingFunctionNames = new Set(
      phases.flatMap(p => p.nodes).filter(n => n.type === 'function').map(n => n.id),
    )

    // Add functions not already present
    const newFunctions = blueprint.functions.filter(
      fn => !existingFunctionNames.has(`function.${fn.name}`),
    )

    if (newFunctions.length > 0) {
      const fnPhase = findOrCreatePhase(phases, 'Automation', lastPhaseNum + 3)
      fnPhase.nodes.push(...blueprintFunctionNodes(newFunctions, fnPhase.number, integrationNodeIds))
    }
  }

  // ── 5. Permission rules hint ─────────────────────────────────────────────────
  // Attach blueprint permission rules to existing permissions nodes so the
  // executor can surface them in its system prompt when applying RLS.
  if (blueprint.permissions.length > 0) {
    phases = phases.map(p => ({
      ...p,
      nodes: p.nodes.map(n => {
        if (n.type !== 'permissions') return n
        return {
          ...n,
          executionParams: {
            ...n.executionParams,
            blueprintPermissions: blueprint.permissions,
          },
        }
      }),
    }))
  }

  return phases
}

/**
 * Filter schema nodes down to the blueprint entity list when the blueprint
 * is highly confident. Prevents the domain template from adding tables the
 * blueprint doesn't want (e.g., saas template adding `webhooks` when the
 * user's product has no webhook concept).
 *
 * Only filters when blueprint.entities has ≥ 5 entities (indicating the GUE
 * produced a real product-level spec rather than a partial fallback).
 */
export function filterSchemaToBlueprintEntities(
  phases: BuildPhase[],
  blueprint: ProductBlueprint,
  exclusions: string[] = [],
): BuildPhase[] {
  if (blueprint.entities.length < 5) return phases

  const allowed = new Set([
    ...blueprint.entities.map(e => e.name.toLowerCase()),
    // Always keep users table
    'users',
  ])

  // Remove explicitly excluded entities
  exclusions.forEach(ex => allowed.delete(ex.toLowerCase()))

  return phases.map(p => ({
    ...p,
    nodes: p.nodes.map(n => {
      if (n.type !== 'schema') return n
      const tableName = n.id.replace(/^schema\./, '').toLowerCase()
      if (!allowed.has(tableName)) {
        console.log(`[BlueprintInjector] Filtering schema node ${n.id} — not in blueprint entity list`)
        return { ...n, status: 'blocked' as const, blockedReason: { type: 'manual_step' as const, description: 'Excluded by blueprint entity filter' } }
      }
      return n
    }),
  }))
}
