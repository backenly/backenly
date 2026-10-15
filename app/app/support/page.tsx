'use client'

/**
 * /app/support: the account's support cases (Backenly Cloud).
 *
 * The AWS-Support-shaped center: every case gets an instant AI first response
 * in its thread and the team follows up within the plan's target. Off Cloud
 * the surface does not exist (notFound, like /app/usage) — a self-hosted
 * install has no support team behind it.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { notFound, useRouter } from 'next/navigation'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { LifeBuoy, Plus, Sparkles } from 'lucide-react'
import { OrgShell } from '@/components/shell/OrgShell'
import {
  EmptyState, KitBadge, KitButton, KitCard, KitTab, KitTabs, SectionTitle, Skeleton, Tag,
} from '@/components/inspector/kit'
import { PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import {
  listSupportTickets, timeAgo, SupportApiError,
  type SupportLevel, type TicketSummary,
} from '@/lib/api/support'
import { SEVERITY_TAG_TONE, STATUS_BADGE, categoryLabel } from '@/components/support/presentation'

type TabId = 'open' | 'resolved' | 'all'

export default function SupportPage() {
  if (!CLOUD_CONTROL_PLANE) notFound()
  return <SupportCenter />
}

function SupportCenter() {
  const router = useRouter()
  const [tab, setTab] = useState<TabId>('open')
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null)
  const [level, setLevel] = useState<SupportLevel | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (which: TabId) => {
    try {
      const r = await listSupportTickets(which)
      setTickets(r.tickets)
      setLevel(r.level)
      setError(null)
    } catch (e) {
      if (e instanceof SupportApiError && e.status === 401) {
        router.push('/auth/login?redirect=/app/support')
        return
      }
      setError(e instanceof Error ? e.message : 'Could not load cases')
    }
  }, [router])

  useEffect(() => {
    load(tab)
  }, [tab, load])

  const switchTab = (next: TabId) => {
    if (next === tab) return
    setTab(next)
    setTickets(null)
  }

  return (
    <OrgShell>
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} py-8`}>
        <SectionTitle
          title="Support"
          description="File a case, get an instant AI first response, and the team follows up. Every case is read by a person."
          actions={
            <Link href="/app/support/new">
              <KitButton variant="primary" icon={Plus}>New case</KitButton>
            </Link>
          }
        />

        {level && (
          <div className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px] text-zinc-400">
            <span className="font-medium text-zinc-200">{level.plan} plan support</span>
            <span className="text-zinc-700">·</span>
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-violet-300" />
              AI first response within seconds
            </span>
            <span className="text-zinc-700">·</span>
            <span>
              {level.targetResponseHours
                ? `Team target: first reply within ${level.targetResponseHours}h`
                : 'Team replies best effort'}
            </span>
            {level.priority && (
              <>
                <span className="text-zinc-700">·</span>
                <Tag tone="violet">Priority queue</Tag>
              </>
            )}
          </div>
        )}

        <KitTabs className="mb-4">
          <KitTab active={tab === 'open'} onClick={() => switchTab('open')}>Open</KitTab>
          <KitTab active={tab === 'resolved'} onClick={() => switchTab('resolved')}>Resolved</KitTab>
          <KitTab active={tab === 'all'} onClick={() => switchTab('all')}>All</KitTab>
        </KitTabs>

        {error ? (
          <KitCard>
            <EmptyState
              icon={LifeBuoy}
              title="Could not load your cases"
              description={error}
              action={<KitButton onClick={() => load(tab)}>Try again</KitButton>}
            />
          </KitCard>
        ) : tickets === null ? (
          <KitCard>
            <div className="space-y-3 p-4">
              <Skeleton className="h-[38px] w-full" />
              <Skeleton className="h-[38px] w-full" />
              <Skeleton className="h-[38px] w-2/3" />
            </div>
          </KitCard>
        ) : tickets.length === 0 ? (
          <KitCard>
            <EmptyState
              icon={LifeBuoy}
              title={tab === 'open' ? 'No open cases' : tab === 'resolved' ? 'No resolved cases yet' : 'No cases yet'}
              description="Stuck on something, or found a problem? File a case — Backenly AI answers immediately and the team follows up."
              action={
                <Link href="/app/support/new">
                  <KitButton variant="primary" icon={Plus}>New case</KitButton>
                </Link>
              }
            />
          </KitCard>
        ) : (
          <KitCard>
            <ul className="divide-y divide-white/[0.05]">
              {tickets.map((t) => {
                const status = STATUS_BADGE[t.status] ?? { tone: 'neutral' as const, label: t.status }
                return (
                  <li key={t.id}>
                    <Link
                      href={`/app/support/${t.id}`}
                      className="flex w-full items-center gap-3 px-4 py-[11px] transition-colors duration-150 hover:bg-white/[0.025]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-zinc-200">{t.subject}</div>
                        <div className="mt-0.5 truncate text-[12px] text-zinc-500">
                          Case #{t.caseNumber} · {categoryLabel(t.category)}
                          {t.aiState === 'replied' && ' · AI answered'}
                          {' · '}{timeAgo(t.lastMessageAt)}
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-2.5">
                        {(t.severity === 'high' || t.severity === 'urgent') && (
                          <Tag tone={SEVERITY_TAG_TONE[t.severity]}>{t.severity === 'urgent' ? 'Production down' : 'Production impaired'}</Tag>
                        )}
                        <KitBadge tone={status.tone}>{status.label}</KitBadge>
                      </div>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </KitCard>
        )}
      </div>
    </OrgShell>
  )
}
