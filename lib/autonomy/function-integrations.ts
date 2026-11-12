/**
 * Functions that use an integration nobody connected.
 *
 * Production QA (2026-11-09): a function deployed on order updates sent the
 * shipping email through ctx.integrations.email, and the project had no email
 * provider. It logged "NOT SENT: no email provider connected" on every update,
 * succeeded each time, and Overview and readiness stayed green. Nothing
 * compared what a function's code uses with what the project has connected.
 *
 * One finding per function, listing each kind of provider it cannot reach
 * (lib/services/ai-functions/integration-use.ts decides). Never repaired: the
 * key is the owner's to give, and the code is whoever wrote it. A function
 * that is switched off runs nothing and is not reported.
 */

import { prisma } from '@/lib/db/prisma'
import type { RawFinding } from '@/lib/core/types'
import { isFunctionSwitchedOff } from '@/lib/services/ai-functions/status'
import { integrationsUsedBy, missingIntegrations } from '@/lib/services/ai-functions/integration-use'

export async function detectFunctionsMissingIntegrations(projectId: string): Promise<RawFinding[]> {
  const [keys, functions] = await Promise.all([
    prisma.projectIntegrationKey.findMany({ where: { projectId }, select: { integrationId: true } }),
    prisma.aiFunction.findMany({
      where: { projectId },
      select: { id: true, name: true, status: true, triggerType: true, triggerTable: true, generatedCode: true },
      orderBy: { name: 'asc' },
    }),
  ])
  const stored = new Set(keys.map((k) => k.integrationId))

  const findings: RawFinding[] = []
  for (const fn of functions) {
    const code = fn.generatedCode ?? ''
    if (!code || isFunctionSwitchedOff(fn.status)) continue
    const missing = missingIntegrations(integrationsUsedBy(code), stored)
    if (missing.length === 0) continue
    findings.push({
      type: 'function_integration_missing',
      severity: 'warning',
      autoFixable: false,
      details: {
        functionId: fn.id,
        functionName: fn.name,
        trigger: fn.triggerType,
        ...(fn.triggerType.startsWith('on_db_') && fn.triggerTable ? { tableName: fn.triggerTable } : {}),
        missing,
      },
    })
  }
  return findings
}
