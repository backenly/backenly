'use client'

/**
 * /app/support/[id]: one support case, read as a thread.
 *
 *   Support / #1043
 *   Webhook retries stopped after the region move                [Mark resolved]
 *   ◆ Waiting on you   Production impaired   API & runtime   checkout-api   Opened Nov 15, 8:31 PM
 *
 *   (AJ) You  5h ago
 *        Since moving checkout-api to N. Virginia yesterday, …
 *   (▣)  Backenly AI  Answered 41 s after you opened the case
 *        ┌ the answer, on a panel lit violet along its top edge ┐
 *   (▤)  Backenly team  First reply 3 h 12 m after you opened it
 *        ┌ the reply, on a panel ┐
 *   (AJ) [ reply composer ]
 *
 * One column, no side panel: what a side panel used to repeat (status,
 * severity, category, project, opened) is the facts line under the title.
 * Your own words sit plain; Backenly's replies sit on panels, the AI's marked
 * by its sparkle and a violet edge, the team's by the logo.
 *
 * The AI entry tells the truth about itself: writing (and retrying, which the
 * server does on its own after a transient failure), answered, or not
 * answered, with the reason in the customer's terms and a way to ask again
 * when another attempt can help (lib/support/constants.ts
 * supportAiRetryAllowed, the same rule the API holds).
 *
 * The page polls while the AI answer is being written, then refreshes gently
 * while the tab is visible so a team reply appears without a reload. A polite
 * live region announces those changes; nothing moves focus.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { notFound, useParams, useRouter } from 'next/navigation'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { RotateCcw } from 'lucide-react'
import { ActorMark } from '@/components/console/ActorMark'
import { OrgShell } from '@/components/shell/OrgShell'
import { Avatar, useMe } from '@/components/shell/ConsoleChrome'
import { Logo } from '@/components/Logo'
import { Breadcrumbs, KitButton, KitNote, PageHeader, Skeleton, Spinner } from '@/components/inspector/kit'
import { EDGE, PAGE_GUTTER, PAGE_WIDTH, PLATE, RULE, R_PANEL, WELL } from '@/components/console/tokens'
import {
  getSupportTicket, patchSupportTicket, replyToSupportTicket, SupportApiError, timeAgo,
  type SupportLevel, type TicketDetail, type TicketMessage,
} from '@/lib/api/support'
import {
  aiShortfall, caseState, categoryLabel, docsFor, formatDateTime, formatSpan, formatWhen, isProductionSeverity,
  severityLabel, teamTargetLabel,
} from '@/components/support/presentation'
import { CaseGlyph, ExternalLink, InlineLink, SeverityTag } from '@/components/support/parts'
import { SupportMarkdown } from '@/components/support/SupportMarkdown'
import { TICKET_BODY_MAX, supportAiRetryAllowed } from '@/lib/support/constants'

/** How long the page treats an unanswered case as "being written": the server's automatic attempts fit inside it. */
const AI_WAIT_MS = 4 * 60_000
const AI_POLL_MS = 3_000
/** While visible, so a team reply shows up without a reload. */
const REFRESH_MS = 30_000
/** The reading column: a thread is read, not scanned. */
const COLUMN = 'max-w-[760px]'

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
  const [loadError, setLoadError] = useState(false)
  const [retryingLoad, setRetryingLoad] = useState(false)
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
      setLoadError(false)
    } catch (e) {
      if (e instanceof SupportApiError && e.status === 401) {
        router.push(`/auth/login?redirect=/app/support/${ticketId}`)
        return
      }
      if (e instanceof SupportApiError && e.status === 404) {
        setMissing(true)
        return
      }
      setLoadError(true)
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
      setActionError(e instanceof Error ? e.message : 'That did not work. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const retryLoad = async () => {
    setRetryingLoad(true)
    await load()
    setRetryingLoad(false)
  }

  if (missing || (!ticket && loadError)) {
    return (
      <OrgShell>
        <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
          <div className={COLUMN}>
            <PageHeader
              flush
              breadcrumb={<Breadcrumbs items={[{ label: 'Support', href: '/app/support' }, { label: 'Case' }]} />}
              title={missing ? 'Case not found' : 'Case'}
            />
            <div className={`${PLATE} border ${EDGE} ${R_PANEL} flex flex-wrap items-center gap-x-[12px] gap-y-[8px] px-[16px] py-[15px] text-[13px] leading-[20px] text-zinc-300 sm:px-[20px]`}>
              {missing ? (
                <span>
                  It may belong to another account, or the link is wrong.{' '}
                  <InlineLink href="/app/support">Back to Support</InlineLink>
                </span>
              ) : (
                <>
                  <span className="min-w-0 flex-1">Could not load the case.</span>
                  <KitButton size="sm" onClick={retryLoad} loading={retryingLoad}>
                    Try again
                  </KitButton>
                </>
              )}
            </div>
          </div>
        </div>
      </OrgShell>
    )
  }

  if (!ticket) {
    return (
      <OrgShell>
        <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`} aria-busy="true" aria-label="Loading the case">
          <div className={`${COLUMN} pt-[28px] sm:pt-[36px]`}>
            <Skeleton className="h-[12px] w-[96px]" />
            <Skeleton className="mt-[16px] h-[24px] w-[440px] max-w-full" />
            <Skeleton className="mt-[12px] h-[12px] w-[360px] max-w-full" />
            <div className="mt-[36px] space-y-[28px]">
              {[0, 1].map((i) => (
                <div key={i} className="flex gap-[14px]">
                  <Skeleton className="h-[28px] w-[28px] flex-shrink-0 !rounded-full" />
                  <div className="flex-1 space-y-[10px] pt-[6px]">
                    <Skeleton className="h-[12px] w-[160px]" />
                    <Skeleton className={i ? 'h-[96px] w-full' : 'h-[44px] w-4/5'} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </OrgShell>
    )
  }

  const state = caseState(ticket.status)
  const aiMessage = ticket.messages.find((m) => m.author === 'ai')
  const firstStaff = ticket.messages.find((m) => m.author === 'staff')
  // The AI entry sits where its answer would be: right after the opening
  // message, ahead of any later correspondence.
  const showAiEntry = !aiMessage && phase !== 'superseded'
  const canRetry = supportAiRetryAllowed(ticket) && phase === 'missed'
  const opened = new Date(ticket.createdAt).getTime()

  /** "Answered 41 s after you opened the case", from the message times. */
  const sinceOpened = (at: string): string => formatSpan(new Date(at).getTime() - opened)

  const whenFor = (m: TicketMessage): ReactNode => {
    if (m.id === aiMessage?.id && sinceOpened(m.createdAt)) {
      return `Answered ${sinceOpened(m.createdAt)} after you opened the case`
    }
    if (m.id === firstStaff?.id) {
      const at = ticket.firstStaffReplyAt ?? m.createdAt
      if (sinceOpened(at)) return `First reply ${sinceOpened(at)} after you opened it`
    }
    return timeAgo(m.createdAt)
  }

  return (
    <OrgShell>
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
        <div className={COLUMN}>
          <PageHeader
            flush
            breadcrumb={<Breadcrumbs items={[{ label: 'Support', href: '/app/support' }, { label: `#${ticket.caseNumber}` }]} />}
            title={<span className="block text-[24px] leading-[30px] tracking-[-0.025em] [overflow-wrap:anywhere]">{ticket.subject}</span>}
            description={
              <span className="mt-[4px] flex flex-wrap items-center gap-x-[16px] gap-y-[6px] text-[13px] leading-[20px] text-faint">
                <CaseGlyph state={state} showLabel={state === 'waiting'} />
                {isProductionSeverity(ticket.severity) ? (
                  <SeverityTag severity={ticket.severity} />
                ) : (
                  <span>{severityLabel(ticket.severity)}</span>
                )}
                <span>{categoryLabel(ticket.category)}</span>
                {ticket.project && <InlineLink href={`/app/projects/${ticket.project.id}`}>{ticket.project.name}</InlineLink>}
                <span>
                  Opened{' '}
                  <time dateTime={ticket.createdAt} title={formatDateTime(ticket.createdAt)} className="tabular-nums">
                    {formatWhen(ticket.createdAt)}
                  </time>
                </span>
                {state === 'resolved' && ticket.resolvedAt && (
                  <span>
                    Resolved{' '}
                    <time dateTime={ticket.resolvedAt} title={formatDateTime(ticket.resolvedAt)} className="tabular-nums">
                      {formatWhen(ticket.resolvedAt)}
                    </time>
                  </span>
                )}
              </span>
            }
            actions={
              state === 'resolved' ? (
                <KitButton loading={busy === 'status'} onClick={() => act('status', () => patchSupportTicket(ticketId, 'reopen'))}>
                  Reopen case
                </KitButton>
              ) : state !== 'closed' ? (
                <KitButton loading={busy === 'status'} onClick={() => act('status', () => patchSupportTicket(ticketId, 'resolve'))}>
                  Mark resolved
                </KitButton>
              ) : null
            }
          />

          <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {announcement}
          </p>

          {actionError && (
            <div className="mb-[20px]">
              <KitNote tone="danger" title="That did not work">
                {actionError}
              </KitNote>
            </div>
          )}

          <ol aria-label="Correspondence" className="relative">
            <Entry author="user" meta={<When at={ticket.createdAt}>{timeAgo(ticket.createdAt)}</When>}>
              <PlainBody text={ticket.message} />
            </Entry>

            {showAiEntry && (
              <Entry author="ai" meta={aiPending ? 'Writing an answer' : 'No instant answer'}>
                <ReplyPanel ai>
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
                </ReplyPanel>
              </Entry>
            )}

            {ticket.messages.map((m) => (
              <Entry key={m.id} author={m.author} meta={<When at={m.createdAt}>{whenFor(m)}</When>}>
                {m.author === 'user' ? (
                  <PlainBody text={m.body} />
                ) : (
                  <ReplyPanel ai={m.author === 'ai'}>
                    <SupportMarkdown>{m.body}</SupportMarkdown>
                  </ReplyPanel>
                )}
              </Entry>
            ))}

            <li className="relative flex gap-[14px]">
              {closed ? (
                <p className="ml-[42px] text-[13px] leading-[20px] text-faint">
                  This case is closed. <InlineLink href="/app/support/new">Open a new case</InlineLink> if the problem is back.
                </p>
              ) : (
                <ReplyComposer ticketId={ticketId} resolved={state === 'resolved'} onSent={load} />
              )}
            </li>
          </ol>
        </div>
      </div>
    </OrgShell>
  )
}

/* ── Thread ───────────────────────────────────────────────────────────────── */

const AUTHOR_NAME: Record<TicketMessage['author'], string> = {
  user: 'You',
  ai: 'Backenly AI',
  staff: 'Backenly team',
}

function AuthorMark({ author }: { author: TicketMessage['author'] }) {
  const me = useMe()
  if (author === 'user') return <Avatar user={me} size={28} className="text-[10.5px]" />
  if (author === 'ai') {
    // Backenly's own tile mark: the instant answer is Backenly replying, not a generic "AI" sparkle.
    return <ActorMark actor={{ type: 'backenly', label: 'Backenly' }} size={28} />
  }
  return (
    <span
      aria-hidden
      className="flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#141518] ring-1 ring-inset ring-white/[0.12] [&_svg]:h-[16px] [&_svg]:w-[16px]"
    >
      <Logo />
    </span>
  )
}

/** A time with its full date on hover. */
function When({ at, children }: { at: string; children: ReactNode }) {
  return (
    <time dateTime={at} title={formatDateTime(at)}>
      {children}
    </time>
  )
}

/**
 * One entry: who and when on one line, then what they wrote. A hairline joins
 * the marks, because the thread is a real sequence.
 */
function Entry({ author, meta, children }: { author: TicketMessage['author']; meta: ReactNode; children: ReactNode }) {
  return (
    <li className="relative flex gap-[14px] pb-[28px]">
      <span aria-hidden className="absolute bottom-[4px] left-[13.5px] top-[36px] w-px bg-white/[0.07]" />
      <div className="relative z-[1]">
        <AuthorMark author={author} />
      </div>
      <article className="min-w-0 flex-1">
        <header className="flex min-h-[28px] flex-wrap items-center gap-x-[10px] gap-y-[2px]">
          <h2 className="text-[13px] font-medium leading-[20px] text-zinc-100">{AUTHOR_NAME[author] ?? AUTHOR_NAME.user}</h2>
          <span className="text-[12.5px] leading-[18px] tabular-nums text-faint">{meta}</span>
        </header>
        <div className="mt-[6px]">{children}</div>
      </article>
    </li>
  )
}

/** Backenly's words sit on a panel; the AI's carries a violet top edge, Backenly acting. */
function ReplyPanel({ ai = false, children }: { ai?: boolean; children: ReactNode }) {
  return (
    <div
      className={`${PLATE} border ${EDGE} ${R_PANEL} px-[16px] py-[14px] sm:px-[18px] ${
        ai ? 'shadow-[inset_0_1px_0_rgba(167,139,250,0.7)]' : ''
      }`}
    >
      {children}
    </div>
  )
}

function PlainBody({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap text-[13.5px] leading-[22px] text-zinc-200 [overflow-wrap:anywhere]">{text}</p>
}

/** The answer being written: what it is doing, in a sentence, over a quiet placeholder. */
function AiWriting({ retrying }: { retrying: boolean }) {
  return (
    <div aria-busy="true">
      <p className="flex items-center gap-[8px] text-[13px] leading-[20px] text-zinc-300">
        <Spinner className="h-3.5 w-3.5 text-violet-300" />
        {retrying ? 'Taking longer than usual. Trying again.' : 'Reading your case and the docs that cover it.'}
      </p>
      <div className="mt-[12px] space-y-[8px]" aria-hidden>
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
      <p className="text-[13.5px] font-medium leading-[21px] text-zinc-100">
        {stillWorking ? 'Still working on an instant answer.' : 'No instant answer this time.'}
      </p>
      <p className="mt-[4px] max-w-[62ch] text-[13px] leading-[20px] text-zinc-400 [text-wrap:pretty]">
        {stillWorking ? 'It will appear here when it is ready.' : aiShortfall(ticket.aiState, ticket.aiError)} The Backenly team has your
        case and replies in this thread{target ? `, usually ${teamTargetLabel(target).toLowerCase()}` : ''}.
      </p>
      <div className="mt-[12px] flex flex-wrap items-center gap-x-[16px] gap-y-[8px] text-[13px] leading-[20px]">
        {canRetry && (
          <KitButton size="sm" icon={RotateCcw} loading={retrying} onClick={onRetry}>
            Try the instant answer again
          </KitButton>
        )}
        {docsFor(ticket.category).map((d) => (
          <ExternalLink key={d.href} href={d.href}>
            {d.title}
          </ExternalLink>
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
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 96), 360)}px`
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
      setError(e instanceof Error ? e.message : 'The reply was not sent. Try again.')
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <div className="relative z-[1]">
        <AuthorMark author="user" />
      </div>
      <form
        className={`min-w-0 flex-1 overflow-hidden ${PLATE} border ${EDGE} ${R_PANEL} transition-[border-color,box-shadow] duration-150 focus-within:border-white/30 focus-within:ring-[3px] focus-within:ring-white/[0.08]`}
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
          placeholder={resolved ? 'Still broken? Describe what you see. Replying reopens the case.' : 'Reply to the team. Paste exact errors where you can.'}
          className="block w-full resize-none bg-transparent px-[16px] py-[13px] text-[16px] leading-[22px] text-zinc-100 placeholder:text-faint focus:outline-none sm:text-[13.5px]"
          disabled={sending}
        />
        <div className={`flex flex-wrap items-center justify-between gap-[12px] border-t ${RULE} ${WELL} py-[10px] pl-[16px] pr-[10px]`}>
          {error ? (
            <p id="case-reply-error" role="alert" className="text-[12.5px] leading-[18px] text-rose-300">
              {error}
            </p>
          ) : (
            <p id="case-reply-hint" className="text-[12px] leading-[18px] text-faint">
              Replies go to the Backenly team.{' '}
              <span className="hidden sm:inline">
                <kbd className="font-sans">{isMac ? '⌘' : 'Ctrl'}</kbd>&nbsp;<kbd className="font-sans">Enter</kbd> sends.
              </span>
            </p>
          )}
          <KitButton type="submit" variant="primary" loading={sending}>
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
