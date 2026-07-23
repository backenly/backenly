export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { loadBuildLedger, updateBuildLedger } from '@/lib/ai/build-ledger'
import { collectProof } from '@/lib/ai/proof-system'
import { hasIntegrationKey } from '@/lib/services/integrationKeyStore'
import { prisma } from '@/lib/db/prisma'

/**
 * GET /api/projects/[id]/build-status
 *
 * Returns a unified backend build status combining:
 *   - BuildLedger (what the AI actually executed: built/planned/blocked/failed)
 *   - ProofBlock  (live DB read-back: tables, apis, auth, buckets, integrations)
 *
 * The UI uses this to render the BackendStatusPanel without relying on chat history.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const sessionToken = request.cookies.get('auth-token')?.value
    if (!sessionToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const decoded = await verifyToken(sessionToken)
    const userId = decoded.userId
    const projectId = params.id

    // Verify ownership
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Load both sources in parallel
    const [ledger, proof] = await Promise.all([
      loadBuildLedger(projectId),
      collectProof(projectId),
    ])

    // ── BUILT section ────────────────────────────────────────────────────────
    // Merge ledger.built + live proof so nothing is missing if ledger is behind
    const builtTableNames = new Set([
      ...proof.tables,
      ...ledger.built.filter(i => i.type === 'table').map(i => i.name),
    ])
    const builtApiNames = new Set([
      ...proof.apis.map(a => a.tableName),
      ...ledger.built.filter(i => i.type === 'api').map(i => i.name),
    ])

    const built = {
      tables: [...builtTableNames],
      apis: [...builtApiNames],
      auth: proof.authEnabled
        ? { enabled: true, providers: proof.authProviders }
        : null,
      functions: [
        ...ledger.built.filter(i => i.type === 'function').map(i => i.name),
      ],
      triggers: [
        ...ledger.built.filter(i => i.type === 'trigger').map(i => i.name),
      ],
    }

    // ── CONFIGURED section ───────────────────────────────────────────────────
    const configured = {
      storage: proof.buckets,
      integrations: proof.integrations,
      rlsPolicies: proof.rlsPolicies.map(p => `${p.table} — ${p.operation}`),
    }

    // ── BLOCKED section ──────────────────────────────────────────────────────
    // Cross-check every ledger-blocked item against the key vault.
    // If the credential is already stored, the entry is stale — remove it and
    // clean the ledger in the background so future loads are also accurate.
    const staleNames: string[] = []
    const freshBlocked: Array<{ name: string; type: string; reason: string }> = []

    for (const b of ledger.blocked) {
      // Derive the integration ID from blockedBy (e.g. "RESEND_API_KEY" → "resend")
      const rawBlockedBy = (b.blockedBy ?? '').toLowerCase()
      const integId = rawBlockedBy
        .replace(/_api_key|_secret_key|_webhook_secret|_key$/, '')
        .replace(/_/g, '_') // keep underscores intact for compound IDs like stripe_webhook_secret

      // Check canonical ID and env-var-lowercased alias
      const [storedById, storedByEnvVar] = await Promise.all([
        hasIntegrationKey(projectId, integId),
        hasIntegrationKey(projectId, rawBlockedBy),
      ])

      if (storedById || storedByEnvVar) {
        staleNames.push(b.name) // credential is stored — block is stale
      } else {
        freshBlocked.push({ name: b.name, type: b.type, reason: b.blockedBy })
      }
    }

    // Remove stale blocked entries from the ledger asynchronously
    if (staleNames.length > 0) {
      updateBuildLedger(
        projectId,
        staleNames.map(name => ({ op: 'unblock' as const, name })),
      ).catch(() => {})
    }

    const blocked = freshBlocked

    // ── PARTIAL section ──────────────────────────────────────────────────────
    // Items that were attempted but only partially completed (e.g. roles on some tables)
    const partial = ledger.built
      .filter((i: any) => i.status === 'partial')
      .map((i: any) => ({
        name: i.name,
        type: i.type,
        detail: i.detail || '',
      }))

    // ── NOT YET ADDED section ────────────────────────────────────────────────
    const notYetAdded = ledger.planned.map(p => ({
      name: p.name,
      type: p.type,
      reason: p.reason,
    }))

    // ── FAILED section ───────────────────────────────────────────────────────
    const failed = ledger.failed.map(f => ({
      name: f.name,
      type: f.type,
      error: f.error,
    }))

    // ── Summary stats ────────────────────────────────────────────────────────
    const totalBuilt =
      built.tables.length +
      built.apis.length +
      (built.auth ? 1 : 0) +
      built.functions.length +
      built.triggers.length +
      configured.storage.length +
      configured.integrations.length

    // isReady = core backend complete: has tables, APIs, auth enabled, nothing failed/blocked,
    // and no critical items are only partially configured
    const criticalPartial = partial.filter((p: any) => ['permissions', 'roles', 'rls'].includes(p.type))
    const isReady =
      built.tables.length >= 2 &&
      built.apis.length > 0 &&
      built.auth?.enabled === true &&
      blocked.length === 0 &&
      failed.length === 0 &&
      criticalPartial.length === 0

    // Run the deep scan to get the authoritative verdict + score for the badge.
    // This replaces the previous heuristic-only label so the dashboard never
    // claims "Production ready" when the readiness scorer or production
    // intelligence checks have flagged blockers.
    let badgeLabel: string | null = null
    let badgeVerdict: string | null = null
    let readinessScore: number | null = null
    try {
      const { runDeepScan } = await import('@/lib/ai/scan/deep-scan')
      const scan = await runDeepScan(projectId)
      readinessScore = scan.score
      badgeVerdict = scan.verdict
      badgeLabel =
        scan.verdict === 'production_ready'   ? 'Production ready' :
        scan.verdict === 'needs_launch_fixes' ? 'Needs launch fixes' :
        scan.verdict === 'credentials_needed' ? 'Credentials needed' :
        scan.verdict === 'structure_ready'    ? 'Structure ready' :
        'Not started'
    } catch (err) {
      console.warn('[BuildStatus] deep scan failed — falling back to heuristic label:', (err as Error).message)
    }

    // Heuristic fallback when the deep scan could not run (DB hiccup, etc.).
    // Uses the same vocabulary so the UI never sees the legacy labels.
    const fallbackLabel =
      blocked.length > 0 && failed.length > 0 ? 'Needs launch fixes' :
      blocked.length > 0 ? 'Credentials needed' :
      failed.length > 0 ? 'Needs launch fixes' :
      criticalPartial.length > 0 ? 'Needs launch fixes' :
      isReady ? 'Structure ready' :
      built.tables.length > 0 ? 'Building…' : 'Not started'

    const statusLabel = badgeLabel ?? fallbackLabel

    return NextResponse.json({
      built,
      configured,
      partial,
      blocked,
      notYetAdded,
      failed,
      summary: {
        totalBuilt,
        isReady,
        hasBlockers: blocked.length > 0,
        hasPartial: partial.length > 0,
        statusLabel,
        verdict: badgeVerdict,
        readinessScore,
        lastUpdated: ledger.updatedAt,
      },
    })
  } catch (err: any) {
    console.error('[BuildStatus] Error:', err)
    return NextResponse.json({ error: 'Failed to load build status' }, { status: 500 })
  }
}
