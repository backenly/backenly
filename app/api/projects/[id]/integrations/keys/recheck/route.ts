export const dynamic = 'force-dynamic'

/**
 * POST /api/projects/:id/integrations/keys/recheck  { integrationId }
 *
 * Ask the provider again about a key that is already stored: the
 * Integrations page's "Check again" (project console rebuild, 2026-11-16).
 *
 * Verification is a snapshot, not a property: a key revoked in the provider's
 * dashboard yesterday still reads `verified` until someone asks again, and a
 * provider that could not be reached at connect time reads `unreachable` for
 * ever. Until now only the agent could ask (recheckIntegrationKey); the
 * console could only show the old answer.
 *
 * The same floor and the same budget as checking a key before it is stored
 * (../../../credentials/verify): a DEVELOPER may connect a provider, so may
 * ask about its key, and every check is a call to a third party made in the
 * project's name, so it shares that route's per-person budget. The answer
 * carries the masked key and the verdict, never the key.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { recheckIntegrationKey } from '@/lib/services/integrationKeyStore'
import { consume } from '@/lib/security/auth-rate-limit'
import { throttleDecision } from '@/lib/security/rate-limit-decision'

/** Shared with credentials/verify: one budget for every key check a person makes. */
const CHECKS_PER_PERSON = { limit: 20, windowMs: 10 * 60_000 }
const VAULT_ID = /^[a-z][a-z0-9_]{0,39}$/

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  await props.params
  return withProjectValidation<any>(
    request,
    async ({ projectId, userId }) => {
      const budget = await consume(`integration-key-check:${userId}`, CHECKS_PER_PERSON.limit, CHECKS_PER_PERSON.windowMs)
      if (!budget.allowed) {
        const decision = throttleDecision(budget)
        return NextResponse.json({ ok: false, error: decision.message, code: decision.code }, { status: decision.status, headers: decision.headers })
      }

      const body = await request.json().catch(() => null)
      const integrationId = typeof body?.integrationId === 'string' ? body.integrationId.trim().toLowerCase() : ''
      if (!VAULT_ID.test(integrationId)) {
        return NextResponse.json({ ok: false, error: 'integrationId is required' }, { status: 400 })
      }

      const key = await recheckIntegrationKey(projectId, integrationId)
      if (!key) {
        return NextResponse.json({ ok: false, error: 'No key is stored for this provider.' }, { status: 404 })
      }
      return NextResponse.json({ ok: true, key })
    },
    { floor: 'write' },
  )
}
