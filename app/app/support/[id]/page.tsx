'use client'

/**
 * /app/support/[id]: one support case, as a correspondence thread.
 *
 * The opening description is the first entry; Backenly AI's instant answer and
 * the team's replies follow in order. While the AI answer is still being
 * written the page polls briefly, then stops and says the team follows up —
 * truthfully, since `aiState` records unavailable/failed instead of spinning
 * forever.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { notFound, useParams, useRouter } from 'next/navigation'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { AlertTriangle, ArrowLeft, Check, LifeBuoy, RotateCcw, Send, Sparkles, User } from 'lucide-react'
import { OrgShell } from '@/components/shell/OrgShell'
import {
  EmptyState, KitBadge, KitButton, KitCard, KitCardBody, KitNote, KitTextarea, SectionLabel, Skeleton, Spinner, Tag,
} from '@/components/inspector/kit'
import { PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import {
  getSupportTicket, patchSupportTicket, replyToSupportTicket, SupportApiError, timeAgo,
  type TicketDetail, type TicketMessage,
} from '@/lib/api/support'
import { SEVERITY_TAG_TONE, STATUS_BADGE, categoryLabel, severityLabel } from '@/components/support/presentation'
import { TICKET_BODY_MAX } from '@/lib/support/constants'

/** Poll this long for the AI first response before letting the thread rest. */
const AI_POLL_WINDOW_MS = 90_000
const AI_POLL_INTERVAL_MS = 3_000

export default function SupportCasePage() {
  if (!CLOUD_CONTROL_PLANE) notFound()
  return <SupportCase />
}

const AUTHOR_META: Record<TicketMessage['author'], { label: string; dot: string }> = {
  user: { label: 'You', dot: 'bg-zinc-500' },
  ai: { label: 'Backenly AI', dot: 'bg-violet-400' },
  staff: { label: 'Backenly team', dot: 'bg-white' },
}

function Message({ author, body, at }: { author: TicketMessage['author']; body: string; at: string }) {
  const meta = AUTHOR_META[author] ?? AUTHOR_META.user
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${meta.dot}`} aria-hidden />
        <span className="text-[12.5px] font-semibold text-zinc-200">{meta.label}</span>
        <span className="text-[11.5px] text-zinc-600">{timeAgo(at)}</span>
      </div>
      <div className="mt-1.5 whitespace-pre-wrap pl-3.5 text-[13px] leading-relaxed text-zinc-300">{body}</div>
    </div>
  )
}

function SupportCase() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const ticketId = typeof params?.id === 'string' ? params.id : ''
  const [ticket, setTicket] = useState<TicketDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState<'reply' | 'status' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // When the brief wait for the AI first response gave up (page-load relative,
  // so an old case never shows a spinner).
  const [aiExpired, setAiExpired] = useState(false)
  const pollStartRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    if (!ticketId) return
    try {
      const r = await getSupportTicket(ticketId)
      setTicket(r.ticket)
    } catch (e) {
      if (e instanceof SupportApiError && e.status === 401) {
        router.push(`/auth/login?redirect=/app/support/${ticketId}`)
        return
      }
      if (e instanceof SupportApiError && e.status === 404) {
        setMissing(true)
        return
      }
      setError(e instanceof Error ? e.message : 'Could not load the case')
    }
  }, [ticketId, router])

  useEffect(() => {
    load()
  }, [load])

  // Brief poll while the AI first response is still being written, then stop
  // and let the thread say the team follows up.
  const aiPending = ticket?.aiState === 'none' && ticket.status !== 'closed' && !aiExpired
  useEffect(() => {
    if (!aiPending) return
    if (pollStartRef.current === null) pollStartRef.current = Date.now()
    const remaining = AI_POLL_WINDOW_MS - (Date.now() - pollStartRef.current)
    if (remaining <= 0) {
      setAiExpired(true)
      return
    }
    const poll = setInterval(() => load(), AI_POLL_INTERVAL_MS)
    const giveUp = setTimeout(() => setAiExpired(true), remaining)
    return () => {
      clearInterval(poll)
      clearTimeout(giveUp)
    }
  }, [aiPending, load])

  const act = async (fn: () => Promise<unknown>, kind: 'reply' | 'status') => {
    setBusy(kind)
    setError(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work')
    } finally {
      setBusy(null)
    }
  }

  const sendReply = () =>
    act(async () => {
      await replyToSupportTicket(ticketId, reply.trim())
      setReply('')
    }, 'reply')

  if (missing) {
    return (
      <OrgShell>
        <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} py-8`}>
          <KitCard>
            <EmptyState
              icon={LifeBuoy}
              title="Case not found"
              description="It may belong to another account, or the link is wrong."
              action={
                <Link href="/app/support">
                  <KitButton>Back to Support</KitButton>
                </Link>
              }
            />
          </KitCard>
        </div>
      </OrgShell>
    )
  }

  if (!ticket) {
    return (
      <OrgShell>
        <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} max-w-[840px] space-y-3 py-8`}>
          <Skeleton className="h-[14px] w-24" />
          <Skeleton className="h-[26px] w-96" />
          <Skeleton className="h-[160px] w-full" />
        </div>
      </OrgShell>
    )
  }

  const status = STATUS_BADGE[ticket.status] ?? { tone: 'neutral' as const, label: ticket.status }
  const canReply = ticket.status !== 'closed'

  return (
    <OrgShell>
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} max-w-[840px] py-8`}>
        <Link
          href="/app/support"
          className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] text-zinc-500 transition-colors hover:text-zinc-200"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Support
        </Link>

        <SectionLabel>Case #{ticket.caseNumber}</SectionLabel>
        <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <h2 className="min-w-0 text-[18px] font-semibold leading-snug tracking-[-0.01em] text-zinc-50 [text-wrap:balance]">
            {ticket.subject}
          </h2>
          <div className="flex flex-shrink-0 items-center gap-2">
            {ticket.status === 'resolved' ? (
              <KitButton size="sm" icon={RotateCcw} onClick={() => act(() => patchSupportTicket(ticketId, 'reopen'), 'status')} loading={busy === 'status'}>
                Reopen
              </KitButton>
            ) : ticket.status !== 'closed' ? (
              <KitButton size="sm" icon={Check} onClick={() => act(() => patchSupportTicket(ticketId, 'resolve'), 'status')} loading={busy === 'status'}>
                Mark resolved
              </KitButton>
            ) : null}
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <KitBadge tone={status.tone}>{status.label}</KitBadge>
          <Tag tone={SEVERITY_TAG_TONE[ticket.severity] ?? 'neutral'}>{severityLabel(ticket.severity)}</Tag>
          <Tag>{categoryLabel(ticket.category)}</Tag>
          {ticket.project && <Tag mono>{ticket.project.name}</Tag>}
        </div>

        {ticket.status === 'resolved' && (
          <div className="mt-4">
            <KitNote tone="success" title="Resolved">
              {ticket.resolvedBy === 'staff' ? 'The team marked this case resolved.' : 'You marked this case resolved.'} Replying reopens it.
            </KitNote>
          </div>
        )}

        <KitCard className="mt-5">
          <div className="divide-y divide-white/[0.05]">
            <Message author="user" body={ticket.message} at={ticket.createdAt} />
            {ticket.messages.map((m) => (
              <Message key={m.id} author={m.author} body={m.body} at={m.createdAt} />
            ))}
            {aiPending && (
              <div className="flex items-center gap-2.5 px-4 py-3.5 text-[12.5px] text-zinc-500">
                <Spinner className="h-3.5 w-3.5 text-violet-300" />
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-violet-300" /> Backenly AI is reading your case…
                </span>
              </div>
            )}
            {(ticket.aiState === 'unavailable' || ticket.aiState === 'failed' || aiExpired) && ticket.messages.length === 0 && (
              <div className="px-4 py-3.5 text-[12.5px] text-zinc-500">
                The AI responder could not answer this one. The team has the case and replies directly.
              </div>
            )}
          </div>
        </KitCard>

        {canReply ? (
          <KitCard className="mt-4">
            <KitCardBody className="space-y-3">
              <KitTextarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                maxLength={TICKET_BODY_MAX}
                rows={4}
                placeholder={
                  ticket.status === 'resolved'
                    ? 'Still broken? Describe what you see — replying reopens the case.'
                    : 'Reply to the team. Paste exact errors where you can.'
                }
                disabled={busy === 'reply'}
              />
              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-rose-400" />
                  <p className="text-[12px] leading-snug text-rose-300">{error}</p>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <p className="inline-flex items-center gap-1.5 text-[12px] text-zinc-600">
                  <User className="h-3.5 w-3.5" /> Replies go to the team, not the AI.
                </p>
                <KitButton
                  variant="primary"
                  icon={Send}
                  onClick={sendReply}
                  disabled={busy === 'reply' || reply.trim().length === 0}
                  loading={busy === 'reply'}
                >
                  Send reply
                </KitButton>
              </div>
            </KitCardBody>
          </KitCard>
        ) : (
          <div className="mt-4">
            <KitNote title="This case is closed">
              Closed cases are read-only.{' '}
              <Link href="/app/support/new" className="text-violet-300 underline underline-offset-2 hover:text-violet-200">
                Open a new case
              </Link>{' '}
              if the problem is back.
            </KitNote>
          </div>
        )}
      </div>
    </OrgShell>
  )
}
