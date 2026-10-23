'use client'

/**
 * /app/support/[id]: one support case, as a correspondence timeline.
 *
 * The opening description is the first entry; Backenly AI's instant answer and
 * the team's replies follow in order, each under its author. The AI entry tells
 * the truth about itself: writing (and retrying, which the server does on its
 * own after a transient failure), answered, or not answered, with the reason in
 * the customer's terms and a way to ask again when another attempt can help
 * (lib/support/constants.ts supportAiRetryAllowed, the same rule the API holds).
 *
 * The page polls while the AI answer is being written, then refreshes gently
 * while the tab is visible so a team reply appears without a reload. A polite
 * live region announces those changes; nothing moves focus.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import Link from 'next/link'
import { notFound, useParams, useRouter } from 'next/navigation'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { ArrowUpRight, Check, LifeBuoy, RotateCcw, Send, Sparkles } from 'lucide-react'
import { OrgShell } from '@/components/shell/OrgShell'
import { Avatar, useMe } from '@/components/shell/ConsoleChrome'
import { Logo } from '@/components/Logo'
import {
  Breadcrumbs, EmptyState, KitButton, KitButtonLink, KitCard, KitNote, PageHeader, Skeleton, Spinner, StatusDot, Tag,
} from '@/components/inspector/kit'
import { EDGE, FOCUS, PAGE_GUTTER, PAGE_WIDTH, PLATE, RULE, R_PANEL, WELL } from '@/components/console/tokens'
import {
  getSupportTicket, patchSupportTicket, replyToSupportTicket, SupportApiError, timeAgo,
  type SupportLevel, type TicketDetail, type TicketMessage,
} from '@/lib/api/support'
import {
  SEVERITY_TAG_TONE, STATUS_BADGE, aiShortfall, categoryLabel, docsFor, formatDateTime, severityLabel, teamTargetLabel,
} from '@/components/support/presentation'
import { SupportMarkdown } from '@/components/support/SupportMarkdown'
import { TICKET_BODY_MAX, supportAiRetryAllowed } from '@/lib/support/constants'

/** How long the page treats an unanswered case as "being written": the server's automatic attempts fit inside it. */
const AI_WAIT_MS = 4 * 60_000
const AI_POLL_MS = 3_000
/** While visible, so a team reply shows up without a reload. */
const REFRESH_MS = 30_000

const draftKey = (id: string) => `bk.support.draft.v1.${id}`

export default function SupportCasePage() {
  if (!CLOUD_CONTROL_PLANE) notFound()
  return <SupportCase />
}

type AiPhase = 'writing' | 'retrying' | 'answered' | 'missed' | 'superseded'

/**
 * Where the instant answer stands, as the page shows it. `waitOver` is the
 * page's own patience: past it, an answer still being written reads as missed
 * (the team has the case either way) while the refresh keeps watching for it.
 */
function phaseOf(ticket: TicketDetail, waitOver: boolean): AiPhase {
  const staffReplied = ticket.messages.some((m) => m.author === 'staff')
  if (ticket.aiState === 'replied') return 'answered'
  if (ticket.aiState !== 'none') return staffReplied ? 'superseded' : 'missed'
  if (staffReplied || ticket.status === 'closed') return 'superseded'
  if (waitOver) return 'missed'
  return ticket.aiError ? 'retrying' : 'writing'
}

function SupportCase() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const ticketId = typeof params?.id === 'string' ? params.id : ''
  const [ticket, setTicket] = useState<TicketDetail | null>(null)
  const [level, setLevel] = useState<SupportLevel | null>(null)
  const [missing, setMissing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'status' | 'retry' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [waitOver, setWaitOver] = useState(false)
  const waitStartRef = useRef<number | null>(null)
  // The phase the page opened in, so only a change is announced.
  const [openedPhase, setOpenedPhase] = useState<AiPhase | null>(null)

  const load = useCallback(async () => {
    if (!ticketId) return
    try {
      const r = await getSupportTicket(ticketId)
      setTicket(r.ticket)
      setOpenedPhase((p) => p ?? phaseOf(r.ticket, false))
      if (r.level) setLevel(r.level)
      setLoadError(null)
    } catch (e) {
      if (e instanceof SupportApiError && e.status === 401) {
        router.push(`/auth/login?redirect=/app/support/${ticketId}`)
        return
      }
      if (e instanceof SupportApiError && e.status === 404) {
        setMissing(true)
        return
      }
      setLoadError(e instanceof Error ? e.message : 'Could not load the case')
    }
  }, [ticketId, router])

  useEffect(() => {
    load()
  }, [load])

  const phase: AiPhase | null = ticket ? phaseOf(ticket, waitOver) : null
  const aiPending = phase === 'writing' || phase === 'retrying'

  // Poll briefly while the answer is being written, then let the thread rest.
  useEffect(() => {
    if (!aiPending) return
    if (waitStartRef.current === null) waitStartRef.current = Date.now()
    const remaining = AI_WAIT_MS - (Date.now() - waitStartRef.current)
    const poll = setInterval(() => load(), AI_POLL_MS)
    const giveUp = setTimeout(() => setWaitOver(true), Math.max(0, remaining))
    return () => {
      clearInterval(poll)
      clearTimeout(giveUp)
    }
  }, [aiPending, load])

  // A team reply arrives without a reload, while someone is looking.
  const loaded = ticket !== null
  const closed = ticket?.status === 'closed'
  useEffect(() => {
    if (!loaded || closed || aiPending) return
    const tick = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, REFRESH_MS)
    return () => clearInterval(tick)
  }, [loaded, closed, aiPending, load])

  // What the live region says: the work in progress, or what changed since the
  // page opened. A state the page opened in is not news, so it is not read out.
  const announcement =
    phase === 'writing'
      ? 'Backenly AI is writing an answer to your case.'
      : phase === 'retrying'
        ? 'The instant answer is taking longer than usual. Backenly AI is trying again.'
        : phase === openedPhase
          ? ''
          : phase === 'answered'
            ? 'Backenly AI answered your case.'
            : phase === 'missed'
              ? 'No instant answer this time. The Backenly team has your case.'
              : ''

  const act = async (kind: 'status' | 'retry', fn: () => Promise<unknown>) => {
    setBusy(kind)
    setActionError(null)
    try {
      await fn()
      if (kind === 'retry') {
        waitStartRef.current = Date.now()
        setWaitOver(false)
      }
      await load()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'That did not work')
    } finally {
      setBusy(null)
    }
  }

  if (missing) {
    return (
      <OrgShell>
        <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} py-10`}>
          <KitCard>
            <EmptyState
              icon={LifeBuoy}
              title="Case not found"
              description="It may belong to another account, or the link is wrong."
              action={<KitButtonLink href="/app/support">Back to Support</KitButtonLink>}
            />
          </KitCard>
        </div>
      </OrgShell>
    )
  }

  if (!ticket) {
    return (
      <OrgShell>
        <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pt-7 sm:pt-9`} aria-busy="true">
          {loadError ? (
            <KitCard>
              <EmptyState
                icon={LifeBuoy}
                title="Could not load the case"
                description={loadError}
                action={<KitButton onClick={load}>Try again</KitButton>}
              />
            </KitCard>
          ) : (
            <>
              <Skeleton className="h-[14px] w-32" />
              <Skeleton className="mt-4 h-[26px] w-[420px] max-w-full" />
              <Skeleton className="mt-3 h-[14px] w-56" />
              <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
                <div className="space-y-6">
                  <Skeleton className="h-[120px] w-full" />
                  <Skeleton className="h-[160px] w-full" />
                </div>
                <Skeleton className="h-[280px] w-full" />
              </div>
            </>
          )}
        </div>
      </OrgShell>
    )
  }

  const status = STATUS_BADGE[ticket.status] ?? { tone: 'neutral' as const, label: ticket.status }
  const aiMessage = ticket.messages.find((m) => m.author === 'ai')
  const afterOpening = ticket.messages
  // The AI entry sits where its answer would be: right after the opening
  // message, ahead of any later correspondence.
  const showAiEntry = !aiMessage && phase !== 'superseded'
  const canRetry = supportAiRetryAllowed(ticket) && phase === 'missed'

  return (
    <OrgShell>
      <PageHeader
        breadcrumb={<Breadcrumbs items={[{ label: 'Support', href: '/app/support' }, { label: `Case #${ticket.caseNumber}` }]} />}
        title={ticket.subject}
        meta={null}
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
            <StatusDot tone={status.tone} label={<span className="text-[13px]">{status.label}</span>} />
            <span className="text-faint">
              Opened{' '}
              <time dateTime={ticket.createdAt} title={formatDateTime(ticket.createdAt)}>
                {timeAgo(ticket.createdAt)}
              </time>
            </span>
            {ticket.project && (
              <span className="text-faint">
                Project{' '}
                <Link
                  href={`/app/projects/${ticket.project.id}`}
                  className={`rounded-[3px] text-zinc-300 underline decoration-white/20 underline-offset-[3px] hover:text-zinc-100 ${FOCUS}`}
                >
                  {ticket.project.name}
                </Link>
              </span>
            )}
          </span>
        }
        actions={
          ticket.status === 'resolved' ? (
            <KitButton icon={RotateCcw} loading={busy === 'status'} onClick={() => act('status', () => patchSupportTicket(ticketId, 'reopen'))}>
              Reopen case
            </KitButton>
          ) : ticket.status !== 'closed' ? (
            <KitButton icon={Check} loading={busy === 'status'} onClick={() => act('status', () => patchSupportTicket(ticketId, 'resolve'))}>
              Mark resolved
            </KitButton>
          ) : null
        }
      />

      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </p>

        {actionError && (
          <div className="mb-5">
            <KitNote tone="danger" title="That did not work">
              {actionError}
            </KitNote>
          </div>
        )}

        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section aria-label="Correspondence" className="min-w-0">
            {ticket.status === 'resolved' && (
              <div className="mb-6">
                <KitNote tone="success" title="Resolved">
                  {ticket.resolvedBy === 'staff' ? 'The team marked this case resolved.' : 'You marked this case resolved.'} Reply if the
                  problem is back; replying reopens it.
                </KitNote>
              </div>
            )}

            <ol className="relative">
              <ThreadEntry author="user" at={ticket.createdAt} label="opened the case">
                <PlainBody text={ticket.message} />
              </ThreadEntry>

              {showAiEntry && (
                <ThreadEntry author="ai" at={null} label="instant answer">
                  {aiPending ? (
                    <AiWriting retrying={phase === 'retrying'} />
                  ) : (
                    <AiMissed
                      ticket={ticket}
                      level={level}
                      canRetry={canRetry}
                      retrying={busy === 'retry'}
                      stillWorking={ticket.aiState === 'none'}
                      onRetry={() => act('retry', () => patchSupportTicket(ticketId, 'retry_ai'))}
                    />
                  )}
                </ThreadEntry>
              )}

              {afterOpening.map((m) => (
                <ThreadEntry key={m.id} author={m.author} at={m.createdAt}>
                  {m.author === 'user' ? <PlainBody text={m.body} /> : <SupportMarkdown>{m.body}</SupportMarkdown>}
                </ThreadEntry>
              ))}

              <li className="relative flex gap-3.5">
                {closed ? (
                  <div className="ml-[46px] min-w-0 flex-1">
                    <KitNote title="This case is closed">
                      Closed cases are read-only.{' '}
                      <Link href="/app/support/new" className="text-violet-300 underline underline-offset-2 hover:text-violet-200">
                        Open a new case
                      </Link>{' '}
                      if the problem is back.
                    </KitNote>
                  </div>
                ) : (
                  <ReplyComposer
                    ticketId={ticketId}
                    resolved={ticket.status === 'resolved'}
                    onSent={load}
                  />
                )}
              </li>
            </ol>
          </section>

          <CaseDetails ticket={ticket} level={level} />
        </div>
      </div>
    </OrgShell>
  )
}

/* ── Timeline ─────────────────────────────────────────────────────────────── */

const AUTHOR: Record<TicketMessage['author'], { name: string; role?: string }> = {
  user: { name: 'You' },
  ai: { name: 'Backenly AI', role: 'AI' },
  staff: { name: 'Backenly team', role: 'Support' },
}

function AuthorMark({ author }: { author: TicketMessage['author'] }) {
  const me = useMe()
  if (author === 'user') return <Avatar user={me} size={32} />
  if (author === 'ai') {
    return (
      <span
        aria-hidden
        className="flex h-[32px] w-[32px] flex-shrink-0 items-center justify-center rounded-full bg-[#141518] text-violet-300 ring-1 ring-inset ring-violet-300/25"
      >
        <Sparkles className="h-[15px] w-[15px]" strokeWidth={1.75} />
      </span>
    )
  }
  return (
    <span
      aria-hidden
      className="flex h-[32px] w-[32px] flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#141518] ring-1 ring-inset ring-white/[0.12] [&_svg]:h-[18px] [&_svg]:w-[18px]"
    >
      <Logo />
    </span>
  )
}

/**
 * One entry: who, when, what. A hairline rail joins the entries, because the
 * thread is a real sequence. Customer text sits plain; replies sit on a panel.
 */
function ThreadEntry({
  author,
  at,
  label,
  children,
}: {
  author: TicketMessage['author']
  at: string | null
  label?: string
  children: ReactNode
}) {
  const meta = AUTHOR[author] ?? AUTHOR.user
  return (
    <li className="relative flex gap-3.5 pb-7">
      <span aria-hidden className="absolute bottom-0 left-[15.5px] top-[40px] w-px bg-white/[0.07]" />
      <div className="relative z-[1] pt-px">
        <AuthorMark author={author} />
      </div>
      <article className={`min-w-0 flex-1 overflow-hidden ${PLATE} border ${EDGE} ${R_PANEL}`}>
        <header className={`flex flex-wrap items-center gap-x-2 gap-y-1 border-b ${RULE} bg-white/[0.015] px-4 py-2.5`}>
          <span className="text-[13px] font-semibold text-zinc-100">{meta.name}</span>
          {meta.role && <Tag tone={author === 'ai' ? 'violet' : 'neutral'}>{meta.role}</Tag>}
          {label && <span className="text-[12.5px] text-faint">{label}</span>}
          {at && (
            <time dateTime={at} title={formatDateTime(at)} className="ml-auto text-[12px] tabular-nums text-faint">
              {timeAgo(at)}
            </time>
          )}
        </header>
        <div className="px-4 py-3.5">{children}</div>
      </article>
    </li>
  )
}

function PlainBody({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap text-[13.5px] leading-[22px] text-zinc-200 [overflow-wrap:anywhere]">{text}</p>
  )
}

/** The answer being written: what it is doing, in a sentence, over a quiet placeholder. */
function AiWriting({ retrying }: { retrying: boolean }) {
  return (
    <div aria-busy="true">
      <p className="flex items-center gap-2 text-[13px] text-zinc-300">
        <Spinner className="h-3.5 w-3.5 text-violet-300" />
        {retrying
          ? 'Taking longer than usual. Trying again…'
          : 'Reading your case and the docs that cover it…'}
      </p>
      <div className="mt-3 space-y-2" aria-hidden>
        <Skeleton className="h-[10px] w-[92%]" />
        <Skeleton className="h-[10px] w-[78%]" />
        <Skeleton className="h-[10px] w-[64%]" />
      </div>
    </div>
  )
}

/**
 * No instant answer: why, in the customer's terms; that the team has the case;
 * the docs most likely to help meanwhile; and "try again" when another attempt
 * can get past what stopped this one.
 */
function AiMissed({
  ticket,
  level,
  canRetry,
  retrying,
  stillWorking,
  onRetry,
}: {
  ticket: TicketDetail
  level: SupportLevel | null
  canRetry: boolean
  retrying: boolean
  stillWorking: boolean
  onRetry: () => void
}) {
  const target = level?.targetResponseHours
  return (
    <div>
      <p className="text-[13.5px] font-medium text-zinc-100">
        {stillWorking ? 'Still working on an instant answer.' : 'No instant answer this time.'}
      </p>
      <p className="mt-1 max-w-[62ch] text-[13px] leading-[20px] text-zinc-400 [text-wrap:pretty]">
        {stillWorking ? 'It will appear here when it is ready.' : aiShortfall(ticket.aiState, ticket.aiError)} The Backenly team has your
        case and replies in this thread{target ? `, usually ${teamTargetLabel(target).toLowerCase()}` : ''}.
      </p>
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        {canRetry && (
          <KitButton size="sm" icon={Sparkles} loading={retrying} onClick={onRetry}>
            Try the instant answer again
          </KitButton>
        )}
        {docsFor(ticket.category).map((d) => (
          <a
            key={d.href}
            href={d.href}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex h-[28px] items-center gap-1.5 rounded-[7px] px-2.5 text-[12px] font-medium text-zinc-300 transition-colors duration-150 hover:bg-white/[0.05] hover:text-zinc-100 ${FOCUS}`}
          >
            {d.title}
            <ArrowUpRight aria-hidden className="h-3.5 w-3.5 text-zinc-500" strokeWidth={1.75} />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ))}
      </div>
    </div>
  )
}

/* ── Reply ────────────────────────────────────────────────────────────────── */

/**
 * The saved draft for a case. The composer mounts only once the case has loaded
 * in the browser, never in the server render, so reading storage here cannot
 * mismatch hydration. Storage can be blocked; then there is simply no draft.
 */
function readDraft(ticketId: string): string {
  if (typeof window === 'undefined') return ''
  try {
    return localStorage.getItem(draftKey(ticketId)) ?? ''
  } catch {
    return ''
  }
}

function ReplyComposer({ ticketId, resolved, onSent }: { ticketId: string; resolved: boolean; onSent: () => Promise<void> }) {
  // A draft survives a reload or a wander to the docs.
  const [text, setText] = useState(() => readDraft(ticketId))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const isMac = useIsMac()

  useEffect(() => {
    try {
      if (text) localStorage.setItem(draftKey(ticketId), text)
      else localStorage.removeItem(draftKey(ticketId))
    } catch {
      // ignore
    }
  }, [text, ticketId])

  // Grow with what is written, up to a point.
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 104), 360)}px`
  }, [text])

  const send = async () => {
    if (sending) return
    const body = text.trim()
    if (!body) {
      setError('Write a reply first.')
      areaRef.current?.focus()
      return
    }
    setSending(true)
    setError(null)
    try {
      await replyToSupportTicket(ticketId, body)
      setText('')
      await onSent()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The reply was not sent')
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <div className="relative z-[1] pt-px">
        <AuthorMark author="user" />
      </div>
      <form
        className={`min-w-0 flex-1 overflow-hidden ${PLATE} border ${EDGE} ${R_PANEL} transition-[border-color] duration-150 focus-within:border-white/[0.16]`}
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <label htmlFor="case-reply" className="sr-only">
          Reply to the Backenly team
        </label>
        <textarea
          id="case-reply"
          ref={areaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              send()
            }
          }}
          maxLength={TICKET_BODY_MAX}
          rows={4}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'case-reply-error' : 'case-reply-hint'}
          placeholder={resolved ? 'Still broken? Describe what you see. Replying reopens the case…' : 'Reply to the team. Paste exact errors where you can…'}
          className={`block w-full resize-none bg-transparent px-4 py-3.5 text-[16px] leading-[22px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none sm:text-[13.5px]`}
          disabled={sending}
        />
        <div className={`flex flex-wrap items-center justify-between gap-3 border-t ${RULE} ${WELL} px-3 py-2.5 sm:px-4`}>
          {error ? (
            <p id="case-reply-error" role="alert" className="text-[12.5px] text-rose-300">
              {error}
            </p>
          ) : (
            <p id="case-reply-hint" className="text-[12px] text-faint">
              Replies go to the Backenly team.{' '}
              <span className="hidden sm:inline">
                <kbd className="font-sans">{isMac ? '⌘' : 'Ctrl'}</kbd>&nbsp;<kbd className="font-sans">Enter</kbd> to send.
              </span>
            </p>
          )}
          <KitButton type="submit" variant="primary" icon={Send} loading={sending}>
            {sending ? 'Sending…' : 'Send reply'}
          </KitButton>
        </div>
      </form>
    </>
  )
}

const noSubscription = () => () => {}

/** Whether to say ⌘ or Ctrl. Read from the browser, never in the server render (that says ⌘). */
function useIsMac(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
    () => true,
  )
}

/* ── Details ──────────────────────────────────────────────────────────────── */

function CaseDetails({ ticket, level }: { ticket: TicketDetail; level: SupportLevel | null }) {
  const status = STATUS_BADGE[ticket.status] ?? { tone: 'neutral' as const, label: ticket.status }
  const aiLabel =
    ticket.aiState === 'replied'
      ? 'Answered'
      : ticket.aiState === 'none'
        ? ticket.messages.some((m) => m.author === 'staff')
          ? 'Not needed'
          : 'Being written'
        : 'Not answered'
  return (
    <aside className="space-y-4 lg:sticky lg:top-[calc(var(--console-bar)+24px)]" aria-label="Case details">
      <section className={`${PLATE} border ${EDGE} ${R_PANEL}`}>
        <h2 className={`border-b ${RULE} px-4 py-3 text-[13px] font-semibold text-zinc-100`}>Case details</h2>
        <dl className="divide-y divide-white/[0.05] px-4">
          <Detail term="Status">
            <StatusDot tone={status.tone} label={<span className="text-[13px] text-zinc-200">{status.label}</span>} />
          </Detail>
          <Detail term="Severity">
            <Tag tone={SEVERITY_TAG_TONE[ticket.severity] ?? 'neutral'}>{severityLabel(ticket.severity)}</Tag>
          </Detail>
          <Detail term="Category">{categoryLabel(ticket.category)}</Detail>
          {ticket.project && (
            <Detail term="Project">
              <Link
                href={`/app/projects/${ticket.project.id}`}
                className={`truncate rounded-[3px] underline decoration-white/20 underline-offset-[3px] hover:text-zinc-50 ${FOCUS}`}
              >
                {ticket.project.name}
              </Link>
            </Detail>
          )}
          <Detail term="Case">
            <span className="tabular-nums">#{ticket.caseNumber}</span>
          </Detail>
          <Detail term="Opened">
            <time dateTime={ticket.createdAt} className="tabular-nums">
              {formatDateTime(ticket.createdAt)}
            </time>
          </Detail>
          <Detail term="Last update">
            <time dateTime={ticket.lastMessageAt} title={formatDateTime(ticket.lastMessageAt)} className="tabular-nums">
              {timeAgo(ticket.lastMessageAt)}
            </time>
          </Detail>
          <Detail term="Instant answer">{aiLabel}</Detail>
        </dl>
      </section>

      {level && (
        <section className={`${PLATE} border ${EDGE} ${R_PANEL} px-4 py-3.5`}>
          <h2 className="text-[13px] font-semibold text-zinc-100">Your support</h2>
          <dl className="mt-2 space-y-1.5 text-[12.5px]">
            <div className="flex justify-between gap-3">
              <dt className="text-faint">Plan</dt>
              <dd className="text-zinc-300">{level.plan}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-faint">Team reply</dt>
              <dd className="text-zinc-300">{teamTargetLabel(level.targetResponseHours)}</dd>
            </div>
            {level.priority && (
              <div className="flex justify-between gap-3">
                <dt className="text-faint">Queue</dt>
                <dd className="text-zinc-300">Priority</dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </aside>
  )
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[40px] items-center justify-between gap-3 py-2">
      <dt className="flex-shrink-0 text-[12.5px] text-faint">{term}</dt>
      <dd className="flex min-w-0 justify-end text-right text-[13px] text-zinc-200">{children}</dd>
    </div>
  )
}
