/**
 * PROOF SYSTEM — Phase 6: Truthful State
 * ========================================
 * Every Build response must be evidence-based.
 * This module queries REAL project state after a build and returns
 * a structured proof block that replaces vague success messages.
 *
 * Fields:
 *   tables       — actual tables in workspace_{projectId} schema
 *   apis         — ApiDefinition rows for the project
 *   authEnabled  — whether auth (jwtSecret or users table) is configured
 *   rlsPolicies  — PermissionPolicy rows
 *   integrations — ProjectIntegrationKey rows (names only, never keys)
 *   verifiedAt   — timestamp if a verification check was run this session
 *
 * Hard rules:
 *   - Never report an artifact that does not exist in the DB.
 *   - If nothing exists → "Project created, backend not built yet."
 *   - No vague "success" without at least one concrete proof item.
 */

import { prisma } from '@/lib/db/prisma'
import { isReservedWorkspaceTable } from '@/lib/security/workspace-schema'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProofBlock {
  tables: string[]
  apis: Array<{ method: string; path: string; tableName: string }>
  authEnabled: boolean
  authProviders: string[]          // e.g. ['email', 'google', 'github']
  rlsPolicies: Array<{ table: string; operation: string; policyName: string }>
  integrations: string[]           // integration names, no keys
  buckets: string[]                // storage bucket names from live DB — never from BackendGraph
  realtimeTables: string[]         // tables with a live backenly_realtime NOTIFY trigger — ground truth, never a proxy
  verifiedAt?: string              // ISO timestamp if verification ran
  nothingBuilt: boolean            // true when all arrays empty + auth disabled
}

export interface ProofResponseResult {
  proofBlock: ProofBlock
  /** Formatted markdown string ready to append to or replace a build response */
  formatted: string
}

// ── State readers (each queries real DB) ─────────────────────────────────────

async function readTables(projectId: string): Promise<string[]> {
  try {
    // Catalog is the single source of truth. Reading prisma.table (a metadata copy
    // written after CREATE_TABLE) could drift from the real schema — an agent would
    // then reason about a table that no longer exists (or miss one adopted via
    // external DDL). information_schema can never drift from the live schema.
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
      `workspace_${projectId}`,
    )
    // Exclude reserved internal plumbing (_token_blacklist / _email_verifications …).
    return rows.map(r => r.table_name).filter((n): n is string => !!n && !isReservedWorkspaceTable(n))
  } catch {
    return []
  }
}

async function readApis(
  projectId: string,
): Promise<Array<{ method: string; path: string; tableName: string }>> {
  try {
    // Auto-exposure: every CRUD-exposable table HAS a full REST API, derived from
    // the catalog — not from prisma.apiDefinition (a materialized record that can
    // lag the schema). "APIs" == exposed tables, minus the auth `users` table
    // (managed via /auth/*, never a /db/users endpoint). Always in sync.
    const { isAuthManagedTable } = await import('@/lib/mcp/schema-introspection')
    const tables = (await readTables(projectId)).filter(n => !isAuthManagedTable(n))
    return tables.map(name => ({ method: 'REST', path: `/${name}`, tableName: name }))
  } catch {
    return []
  }
}

async function readAuth(
  projectId: string,
): Promise<{ enabled: boolean; providers: string[] }> {
  try {
    // Auth is enabled if the project has a jwtSecret set
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { jwtSecret: true },
    })
    const jwtEnabled = !!(project?.jwtSecret)

    // Check OAuth providers
    const oauthConfigs = await prisma.workspaceOAuthConfig.findMany({
      where: { projectId, enabled: true },
      select: { provider: true },
    })
    const providers: string[] = []
    if (jwtEnabled) providers.push('email/password')
    for (const o of oauthConfigs) providers.push(o.provider)

    return { enabled: jwtEnabled || oauthConfigs.length > 0, providers }
  } catch {
    return { enabled: false, providers: [] }
  }
}

async function readRls(
  projectId: string,
): Promise<Array<{ table: string; operation: string; policyName: string }>> {
  try {
    const policies = await prisma.permissionPolicy.findMany({
      where: { projectId },
      select: { tableName: true, operation: true, policyName: true },
      orderBy: { createdAt: 'asc' },
    })
    return policies.map(p => ({
      table: p.tableName,
      operation: p.operation,
      policyName: p.policyName,
    }))
  } catch {
    return []
  }
}

async function readIntegrations(projectId: string): Promise<string[]> {
  try {
    const keys = await prisma.projectIntegrationKey.findMany({
      where: { projectId },
      select: { integrationId: true },
      orderBy: { connectedAt: 'asc' },
    })
    return keys.map(k => k.integrationId)
  } catch {
    return []
  }
}

/**
 * Read storage buckets directly from DB — never from BackendGraph or cache.
 * This is the single source of truth for storage state.
 */
async function readBuckets(projectId: string): Promise<string[]> {
  try {
    const buckets = await prisma.storageBucket.findMany({
      where: { projectId },
      select: { name: true },
      orderBy: { createdAt: 'asc' },
    })
    return buckets.map(b => b.name)
  } catch {
    return []
  }
}

/**
 * Read which workspace tables have a live realtime NOTIFY trigger installed.
 * Ground truth from `information_schema.triggers` — never inferred from a
 * proxy ("tables exist, so realtime is available" is a lie).
 */
async function readRealtime(projectId: string): Promise<string[]> {
  try {
    const { listTablesWithRealtimeTriggers } = await import('@/lib/services/realtimeTriggers')
    const tables = await listTablesWithRealtimeTriggers(projectId)
    return tables.filter(n => !n.endsWith('_apis'))
  } catch {
    return []
  }
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Collect full proof state for a project in parallel.
 * All queries are non-fatal — failures return empty arrays.
 */
export async function collectProof(
  projectId: string,
  verifiedAt?: string,
): Promise<ProofBlock> {
  const [tables, apis, auth, rlsPolicies, integrations, buckets, realtimeTables] = await Promise.all([
    readTables(projectId),
    readApis(projectId),
    readAuth(projectId),
    readRls(projectId),
    readIntegrations(projectId),
    readBuckets(projectId),
    readRealtime(projectId),
  ])

  // `realtimeTables` is intentionally NOT part of nothingBuilt — realtime
  // cannot exist without a table, so a non-empty realtime set always implies
  // a non-empty tables set, which already trips the flag.
  const nothingBuilt =
    tables.length === 0 &&
    apis.length === 0 &&
    !auth.enabled &&
    rlsPolicies.length === 0 &&
    integrations.length === 0 &&
    buckets.length === 0

  return {
    tables,
    apis,
    authEnabled: auth.enabled,
    authProviders: auth.providers,
    rlsPolicies,
    integrations,
    buckets,
    realtimeTables,
    verifiedAt,
    nothingBuilt,
  }
}

/**
 * Format a ProofBlock into a concise markdown state block.
 *
 * Rules:
 *   - Every section only appears if it has data.
 *   - If nothingBuilt: returns a specific "nothing built" message.
 *   - No section says "0 X" — absence = omission.
 */
export function formatProof(proof: ProofBlock): string {
  if (proof.nothingBuilt) {
    return 'Project created, backend not built yet.'
  }

  const lines: string[] = ['**Backend state**', '']

  if (proof.tables.length > 0) {
    lines.push(`**Tables** · ${proof.tables.length}`)
    lines.push(proof.tables.join(', '))
    lines.push('')
  }

  if (proof.apis.length > 0) {
    const byTable: Record<string, string[]> = {}
    for (const api of proof.apis) {
      const key = api.tableName || 'misc'
      ;(byTable[key] ??= []).push(api.method)
    }
    const tableNames = Object.keys(byTable)
    const allRest = Object.values(byTable).every(m => m.length === 1 && m[0] === 'REST')
    if (allRest) {
      lines.push(`**APIs** · ${proof.apis.length} REST endpoints`)
      lines.push(tableNames.join(', '))
    } else {
      lines.push(`**APIs** · ${proof.apis.length}`)
      lines.push(Object.entries(byTable).map(([t, methods]) => `${t}: ${methods.join(', ')}`).join(' · '))
    }
    lines.push('')
  }

  if (proof.authEnabled) {
    const providerStr = proof.authProviders.length > 0
      ? proof.authProviders.join(', ')
      : 'enabled'
    lines.push('**Auth**')
    lines.push(providerStr)
    lines.push('')
  }

  if (proof.rlsPolicies.length > 0) {
    const policyTables = [...new Set(proof.rlsPolicies.map(p => p.table))]
    lines.push(`**Row-Level Security** · ${proof.rlsPolicies.length} policies`)
    lines.push(`Across ${policyTables.length} table${policyTables.length === 1 ? '' : 's'}: ${policyTables.join(', ')}`)
    lines.push('')
  }

  if (proof.buckets.length > 0) {
    lines.push(`**Storage** · ${proof.buckets.length} bucket${proof.buckets.length === 1 ? '' : 's'}`)
    lines.push(proof.buckets.join(', '))
    lines.push('')
  }

  if (proof.realtimeTables.length > 0) {
    lines.push(`**Realtime** · streaming on ${proof.realtimeTables.length} table${proof.realtimeTables.length === 1 ? '' : 's'}`)
    lines.push(proof.realtimeTables.join(', '))
    lines.push('')
  }

  if (proof.integrations.length > 0) {
    lines.push('**Integrations**')
    lines.push(formatIntegrationsForDisplay(proof.integrations))
    lines.push('')
  }

  if (proof.verifiedAt) {
    lines.push(`Verified at ${new Date(proof.verifiedAt).toLocaleTimeString()}`)
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  return lines.join('\n')
}

// ── Integration display sanitizer ─────────────────────────────────────────────

const _INTEGRATION_DISPLAY: Record<string, string> = {
  stripe: 'Stripe',
  resend: 'Resend',
  sendgrid: 'SendGrid',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  twilio: 'Twilio',
  slack: 'Slack',
  mailchimp: 'Mailchimp',
  posthog: 'PostHog',
  plausible: 'Plausible',
  google: 'Google',
  github: 'GitHub',
}

function _getBaseService(id: string): string {
  for (const key of Object.keys(_INTEGRATION_DISPLAY)) {
    if (id === key || id.startsWith(key + '_')) return key
  }
  return id
}

/**
 * Convert raw integrationId array (e.g. ['stripe','stripe_secret_key','stripe_webhook_secret'])
 * into human-readable grouped labels. Never exposes vault/key identifiers.
 */
export function formatIntegrationsForDisplay(ids: string[]): string {
  const groups = new Map<string, Set<string>>()
  for (const id of ids) {
    const base = _getBaseService(id)
    if (!groups.has(base)) groups.set(base, new Set())
    if (id !== base) {
      const suffix = id.slice(base.length + 1).replace(/_/g, ' ')
      if (suffix) groups.get(base)!.add(suffix)
    }
  }

  const parts: string[] = []
  for (const [base, extras] of groups) {
    const label = _INTEGRATION_DISPLAY[base] ?? base.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    const extraKeys = [...extras]
    const notes: string[] = []
    if (extraKeys.some(e => e.includes('webhook'))) notes.push('webhook')
    if (extraKeys.some(e => e.includes('secret key') || e.includes('secret'))) notes.push('secret key')
    parts.push(notes.length ? `${label} (${notes.join(', ')})` : label)
  }
  return parts.join(', ')
}

// ── Integration Status Block (Issue 10) ──────────────────────────────────────

/**
 * KNOWN_INTEGRATION_CATEGORIES maps integration names (as stored in
 * ProjectIntegrationKey.integrationId) to their display category.
 * Used to build the readiness dashboard from live DB state.
 */
const INTEGRATION_CATEGORIES: Record<string, { label: string; category: string }> = {
  stripe:    { label: 'Stripe',    category: 'Payments' },
  resend:    { label: 'Resend',    category: 'Email' },
  sendgrid:  { label: 'SendGrid',  category: 'Email' },
  openai:    { label: 'OpenAI',    category: 'AI' },
  anthropic: { label: 'Anthropic', category: 'AI' },
  posthog:   { label: 'PostHog',   category: 'Analytics' },
  plausible: { label: 'Plausible', category: 'Analytics' },
  twilio:    { label: 'Twilio',    category: 'SMS' },
}

/**
 * Build a compact integration readiness section from live proof state.
 * Shows configured integrations with ✓ and key missing ones with ✗.
 *
 * Example output:
 *   INTEGRATION STATUS
 *     Auth         email/password ✓ | Google ✗ (no credentials) | GitHub ✗
 *     Payments     Stripe ✓
 *     Email        Resend ✗ (no key)
 *     Backend readiness: 5/9 features active
 */
export function buildIntegrationStatusBlock(proof: ProofBlock): string {
  const lines: string[] = ['**INTEGRATION STATUS**']

  // Auth
  if (proof.authEnabled && proof.authProviders.length > 0) {
    const authLine = proof.authProviders.map(p => `${p} ✓`).join(' | ')
    lines.push(`  Auth         ${authLine}`)
  } else {
    lines.push('  Auth         ✗ not configured')
  }

  // Integrations by category
  const storedSet = new Set(proof.integrations)
  const categorySummary: Record<string, string[]> = {}

  for (const [id, { label, category }] of Object.entries(INTEGRATION_CATEGORIES)) {
    if (!categorySummary[category]) categorySummary[category] = []
    if (storedSet.has(id)) {
      categorySummary[category].push(`${label} ✓`)
    } else {
      categorySummary[category].push(`${label} ✗`)
    }
  }

  for (const [category, items] of Object.entries(categorySummary)) {
    lines.push(`  ${category.padEnd(12)} ${items.join(' | ')}`)
  }

  // Storage
  if (proof.buckets.length > 0) {
    lines.push(`  Storage      ${proof.buckets.length} bucket${proof.buckets.length !== 1 ? 's' : ''} ✓`)
  } else {
    lines.push('  Storage      ✗ no buckets')
  }

  // Realtime — actual NOTIFY-trigger count, never a "tables exist" proxy
  if (proof.realtimeTables.length > 0) {
    lines.push(`  Realtime     ${proof.realtimeTables.length} table${proof.realtimeTables.length !== 1 ? 's' : ''} streaming ✓`)
  } else if (proof.tables.length > 0) {
    lines.push('  Realtime     ✗ off (no tables streaming — run enable_realtime)')
  } else {
    lines.push('  Realtime     ✗ no tables')
  }

  // Readiness score
  let active = 0
  const total = 9
  if (proof.authEnabled) active++
  if (storedSet.has('stripe')) active++
  if (storedSet.has('resend') || storedSet.has('sendgrid')) active++
  if (storedSet.has('openai') || storedSet.has('anthropic')) active++
  if (storedSet.has('posthog') || storedSet.has('plausible')) active++
  if (proof.buckets.length > 0) active++
  if (proof.tables.length > 0) active++
  if (proof.apis.length > 0) active++
  if (proof.rlsPolicies.length > 0) active++

  lines.push(`\n  Backend coverage: ${active}/${total} features configured`)

  return lines.join('\n')
}

/**
 * Build a complete Phase 6 response: action summary + real-state proof.
 *
 * @param actionSummary   What the agent attempted (from loop steps)
 * @param projectId       For proof queries
 * @param opts.verifiedAt Optional: ISO timestamp if verification ran this request
 * @param opts.noArtifactsCreated  True when loop completed 0 steps
 * @param opts.includeIntegrationStatus  Include the full integration status block (Issue 10)
 */
export async function buildProofResponse(
  actionSummary: string,
  projectId: string,
  opts: { verifiedAt?: string; noArtifactsCreated?: boolean; includeIntegrationStatus?: boolean } = {},
): Promise<string> {
  const proof = await collectProof(projectId, opts.verifiedAt)

  // Hard rule: if the agent loop produced zero steps, routing failed — be explicit
  if (opts.noArtifactsCreated) {
    return '[BLOCKED] Could not determine execution intent. Describe what you want built and I will execute it.'
  }

  // Strip advisory phrases from actionSummary (Build mode enforcer)
  const { stripAdvisoryPhrases } = await import('./text-utils')
  const cleanSummary = stripAdvisoryPhrases(actionSummary)

  if (proof.nothingBuilt) {
    // Issue 4: Execution claimed success but DB shows nothing — explicit warning
    return `${cleanSummary}\n\n[WARN] Execution reported success but no artifacts could be verified. State may be inconsistent — retry or check the database manually.`
  }

  const proofStr = formatProof(proof)

  // Issue 10: append integration status block when caller opts in
  const integrationBlock = opts.includeIntegrationStatus ? `\n\n${buildIntegrationStatusBlock(proof)}` : ''

  return `${cleanSummary}\n\n${proofStr}${integrationBlock}`
}
