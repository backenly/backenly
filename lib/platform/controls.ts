/**
 * The founder console's write path for the platform kill switches.
 *
 * This is all that is left of the old lib/platform/controls.ts. Everything that
 * READS or ENFORCES a kill switch moved to lib/platform-controls, along with
 * the self-hosted signup slot, the operator blocklist, the security-event
 * recorder and project lockdown, because those are things a deployment does for
 * itself. What stayed is Backenly's own admin mutation surface, whose only
 * caller is app/api/admin/controls.
 *
 * A self-host UI for toggling these switches can be added deliberately later.
 * It should not arrive by accident because the founder endpoint happened to be
 * public.
 */
import { prisma } from '@/lib/db/prisma'
import {
  invalidatePlatformControlsCache,
  type ControlPatch,
  type PlatformControlState,
} from '@/lib/platform-controls/state'
import { recordSecurityEvent } from '@/lib/platform-controls/security-events'

export type { ControlPatch }

export async function setPlatformControls(
  patch: ControlPatch,
  actor: { userId: string; userEmail: string },
): Promise<PlatformControlState> {
  const existing = await prisma.platformControl.findUnique({ where: { id: 'singleton' } })

  const next = await prisma.platformControl.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      aiFrozen: patch.aiFrozen ?? false,
      signupsDisabled: patch.signupsDisabled ?? false,
      maintenanceMode: patch.maintenanceMode ?? false,
      readOnly: patch.readOnly ?? false,
      note: patch.note ?? null,
      updatedBy: actor.userId,
    },
    update: {
      ...(patch.aiFrozen !== undefined ? { aiFrozen: patch.aiFrozen } : {}),
      ...(patch.signupsDisabled !== undefined ? { signupsDisabled: patch.signupsDisabled } : {}),
      ...(patch.maintenanceMode !== undefined ? { maintenanceMode: patch.maintenanceMode } : {}),
      ...(patch.readOnly !== undefined ? { readOnly: patch.readOnly } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      updatedBy: actor.userId,
    },
  })

  invalidatePlatformControlsCache()

  // Record what changed as both an AuditLog (admin trail) and a SecurityEvent
  // (so it shows up on the Security feed alongside attacks/anomalies).
  const diff: string[] = []
  if (existing?.aiFrozen !== next.aiFrozen) diff.push(`aiFrozen=${next.aiFrozen}`)
  if (existing?.signupsDisabled !== next.signupsDisabled) diff.push(`signupsDisabled=${next.signupsDisabled}`)
  if (existing?.maintenanceMode !== next.maintenanceMode) diff.push(`maintenanceMode=${next.maintenanceMode}`)
  if (existing?.readOnly !== next.readOnly) diff.push(`readOnly=${next.readOnly}`)
  const summary = diff.length ? diff.join(', ') : 'no functional change'

  try {
    await prisma.auditLog.create({
      data: {
        action: 'PLATFORM_CONTROLS_UPDATED',
        type: 'admin',
        userId: actor.userId,
        userEmail: actor.userEmail,
        details: summary,
        metadata: patch as object,
      },
    })
  } catch { /* non-fatal */ }

  if (next.aiFrozen || next.maintenanceMode || next.readOnly) {
    await recordSecurityEvent({
      kind: 'kill_switch',
      severity: 'critical',
      userId: actor.userId,
      userEmail: actor.userEmail,
      summary: `Founder toggled platform controls: ${summary}`,
      detail: { state: next as unknown as Record<string, unknown> },
    }).catch(() => {})
  }

  return {
    aiFrozen: next.aiFrozen,
    signupsDisabled: next.signupsDisabled,
    maintenanceMode: next.maintenanceMode,
    readOnly: next.readOnly,
    note: next.note,
    updatedAt: next.updatedAt,
    updatedBy: next.updatedBy,
  }
}
