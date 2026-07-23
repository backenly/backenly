'use client'

/**
 * Billing & Credits (/app/billing) — IA restructure §5.4.
 *
 * Promoted out of the account Settings tab into its own org-level page. The
 * Paddle-wired logic (checkout, cancel, usage fetch) is preserved verbatim in
 * BillingPanel; only the presentation now uses the locked flat kit (§11) — no
 * gradients, no glows. The per-event credit *ledger history* tab (§5.4) depends
 * on the `CreditLedgerEntry` model, which is Phase 3 data-model work not yet in
 * the schema, so it is intentionally absent rather than faked.
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { OrgShell } from '@/components/shell/OrgShell'
import { SectionTitle } from '@/components/inspector/kit'
import { BillingPanel } from './billing-panel'

export default function BillingPage() {
  const router = useRouter()

  // Own auth guard — the org routes are skipped by the app layout's check.
  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => { if (r.status === 401) router.push('/auth/login?redirect=/app/billing') })
      .catch(() => {})
  }, [router])

  return (
    <OrgShell>
      <div className="mx-auto w-full max-w-[1100px] px-6 py-8 lg:px-10">
        <SectionTitle
          title="Billing"
          description="Your plan and usage. Autonomy, the loop that keeps your backend alive, is company-funded on every tier."
        />
        <BillingPanel />
      </div>
    </OrgShell>
  )
}
