'use client'

/**
 * Referral (/app/referral) — IA restructure §5.5, now LIVE.
 *
 * Real referral program (flat-grant model, §17 decision): the user's stable code
 * + shareable link, real referral/credit stats from ReferralGrant, and the
 * reward explainer. A friend who signs up with the link gets +200 bonus credits
 * immediately; the referrer gets +500 when that friend first upgrades. Every
 * grant flows through the credit ledger and shows in Billing → Credit activity.
 * Flat kit, no gradient banner (locked).
 */

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Gift, Copy, Check, Link2, Loader2 } from 'lucide-react'
import { OrgShell } from '@/components/shell/OrgShell'
import { SectionTitle, KitCard, KitNote } from '@/components/inspector/kit'

interface ReferralData {
  code: string
  url: string
  referrals: number
  paidReferrals: number
  creditsEarned: number
}

// HIDDEN 2026-07-19 — referral program parked for now. The page redirects to
// /app; the backend (signup ?ref=, /api/referral, ReferralGrant credit flow)
// is untouched. To restore: set this to false and uncomment the sidebar row
// in components/shell/OrgShell.tsx.
const REFERRAL_HIDDEN: boolean = true

export default function ReferralPage() {
  const router = useRouter()
  const [data, setData] = useState<ReferralData | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (REFERRAL_HIDDEN) { router.replace('/app'); return }
    fetch('/api/referral', { credentials: 'include' })
      .then((r) => {
        if (r.status === 401) { router.push('/auth/login?redirect=/app/referral'); return null }
        return r.ok ? r.json() : null
      })
      .then((j) => { if (j?.success) setData(j.data) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [router])

  if (REFERRAL_HIDDEN) return null

  const copy = async () => {
    if (!data) return
    try {
      await navigator.clipboard.writeText(data.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* clipboard blocked — no-op */ }
  }

  return (
    <OrgShell>
      <div className="mx-auto w-full max-w-[820px] px-6 py-8 lg:px-10">
        <SectionTitle
          title="Referral"
          description="Share Backenly, earn credits. Every grant lands in your credit ledger."
        />

        {/* Share link */}
        <KitCard className="px-4 py-4">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
            <Link2 className="h-3 w-3" />
            Your referral link
          </div>
          <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 truncate rounded-md border border-white/[0.08] bg-black/30 px-3 py-2 font-mono text-[12.5px] text-zinc-200">
              {loading ? <span className="text-zinc-600">Loading…</span> : data?.url ?? '—'}
            </div>
            <button
              onClick={copy}
              disabled={!data}
              className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md bg-white px-3.5 text-[12.5px] font-semibold text-black transition-colors hover:bg-zinc-200 disabled:opacity-50"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
          {data?.code && (
            <p className="mt-2 text-[11.5px] text-zinc-500">
              Code <span className="font-mono text-zinc-300">{data.code}</span> — share the link or the code.
            </p>
          )}
        </KitCard>

        {/* Stats */}
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard label="Referrals" value={data?.referrals} loading={loading} />
          <StatCard label="Upgraded" value={data?.paidReferrals} loading={loading} />
          <StatCard label="Credits earned" value={data?.creditsEarned} loading={loading} accent />
        </div>

        <div className="mt-5">
          <KitNote icon={Gift} tone="info" title="How rewards work">
            A friend who signs up with your link gets <span className="text-zinc-200">+200 bonus credits</span> right away.
            You get <span className="text-zinc-200">+500 credits</span> when they first upgrade to a paid plan. Bonus credits
            extend your monthly assistant-credit budget and never expire — they show up in Billing → Credit activity.
          </KitNote>
        </div>
      </div>
    </OrgShell>
  )
}

function StatCard({ label, value, loading, accent }: { label: string; value?: number; loading: boolean; accent?: boolean }) {
  return (
    <KitCard className="px-4 py-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">{label}</p>
      <p className={`mt-2 font-mono text-[24px] font-medium tabular-nums leading-none ${accent ? 'text-violet-200' : 'text-white'}`}>
        {loading ? <Loader2 className="h-5 w-5 animate-spin text-zinc-600" /> : (value ?? 0).toLocaleString()}
      </p>
    </KitCard>
  )
}
