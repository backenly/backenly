export const dynamic = 'force-dynamic'

/**
 * POST /api/projects/[id]/credentials/verify
 *
 * Runs the checks storing a key runs (checkIntegrationKey: the secret scan,
 * the format, and the provider's own answer) and stores nothing. The
 * Integrations page asks it when a key is entered, so a key the provider
 * refuses is said on the key's own step. Production QA (2026-11-09): Stripe's
 * answer came only after the next step was filled in. Saving checks again;
 * this never stands in for that.
 *
 * Body, as POST ../credentials: { integrationId, values: { [envVar]: key } }
 *   200 { ok: true, checks: [{ envVar, status, detail, formatWarning? }] }
 *   422 { ok: false, envVar, error }   the first value storing would refuse
 *
 * It contacts the provider for the caller, so it needs write access to the
 * project (whoever may connect the integration) and is limited per person.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { checkIntegrationKey, vaultIdForEnvVar, type IntegrationKeyCheck } from '@/lib/services/integrationKeyStore'
import { consume } from '@/lib/security/auth-rate-limit'
import { throttleDecision } from '@/lib/security/rate-limit-decision'

const CHECKS_PER_PERSON = { limit: 20, windowMs: 10 * 60_000 }

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  await props.params
  return withProjectValidation<any>(
    request,
    async ({ userId }) => {
      const budget = await consume(`integration-key-check:${userId}`, CHECKS_PER_PERSON.limit, CHECKS_PER_PERSON.windowMs)
      if (!budget.allowed) {
        const decision = throttleDecision(budget)
        return NextResponse.json(
          { ok: false, error: decision.message, code: decision.code },
          { status: decision.status, headers: decision.headers },
        )
      }

      let body: { integrationId?: unknown; values?: unknown }
      try {
        body = await request.json()
      } catch {
        return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
      }
      const { integrationId, values } = body
      if (typeof integrationId !== 'string' || !integrationId || !values || typeof values !== 'object') {
        return NextResponse.json({ ok: false, error: 'integrationId and values are required' }, { status: 400 })
      }

      const checks: Array<{ envVar: string; status: string; detail: string; formatWarning?: string }> = []
      for (const [envVar, raw] of Object.entries(values as Record<string, unknown>)) {
        const key = typeof raw === 'string' ? raw.trim() : ''
        if (!key) continue
        // Under the vault id storing would use (POST ../credentials).
        const check = await checkIntegrationKey(vaultIdForEnvVar(envVar) ?? integrationId, key)
        if (check.ok === false) {
          // This tsconfig does not narrow on a boolean discriminant.
          const refused = check as Extract<IntegrationKeyCheck, { ok: false }>
          return NextResponse.json({ ok: false, envVar, error: refused.error }, { status: 422 })
        }
        const passed = check as Extract<IntegrationKeyCheck, { ok: true }>
        checks.push({
          envVar,
          status: passed.verification.status,
          detail: passed.verification.detail,
          ...(passed.formatWarning ? { formatWarning: passed.formatWarning } : {}),
        })
      }
      if (checks.length === 0) {
        return NextResponse.json({ ok: false, error: 'Paste a key to check.' }, { status: 400 })
      }
      return NextResponse.json({ ok: true, checks })
    },
    { floor: 'write' },
  )
}
