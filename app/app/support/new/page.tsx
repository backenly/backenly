'use client'

/**
 * /app/support/new: file a support case (Backenly Cloud).
 *
 * AWS-shaped form: category, severity (production severities need a paid
 * plan), optional project, subject, description. On submit the case opens and
 * Backenly AI writes the first response into its thread.
 *
 * The form validates when a field is left and when it is sent, never by
 * disabling the button: an incomplete send shows what is missing and moves
 * focus to the first gap. `?category=` and `?project=` prefill it, so a page
 * that knows the context can link here without making anyone retype it.
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { notFound, useRouter, useSearchParams } from 'next/navigation'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { useOrgHrefs } from '@cloud/org-routing'
import { AlertTriangle, ArrowUpRight, ChevronDown, Send, Sparkles } from 'lucide-react'
import { OrgShell } from '@/components/shell/OrgShell'
import {
  Breadcrumbs, INPUT_BASE, KitButton, KitButtonLink, KitInput, KitNote, PageHeader, Tag,
} from '@/components/inspector/kit'
import { EDGE, FOCUS, PAGE_GUTTER, PAGE_WIDTH, PLATE, RULE, R_CONTROL, R_PANEL, WELL } from '@/components/console/tokens'
import { getProjects, type Project } from '@/lib/api/projects'
import { createSupportTicket, listSupportTickets, SupportApiError, type SupportLevel } from '@/lib/api/support'
import {
  SUPPORT_CATEGORIES, SUPPORT_SEVERITIES, TICKET_BODY_MAX, TICKET_BODY_MIN, TICKET_SUBJECT_MAX, isSupportCategory,
} from '@/lib/support/constants'
import { teamTargetLabel } from '@/components/support/presentation'

export default function NewSupportCasePage() {
  if (!CLOUD_CONTROL_PLANE) notFound()
  return <NewCaseForm />
}

type Field = 'category' | 'subject' | 'message'

function validate(values: { category: string; subject: string; message: string }): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {}
  if (!values.category) errors.category = 'Choose what the case is about.'
  const subject = values.subject.trim()
  if (!subject) errors.subject = 'Give the case a subject.'
  else if (subject.length > TICKET_SUBJECT_MAX) errors.subject = `Keep the subject under ${TICKET_SUBJECT_MAX} characters.`
  const message = values.message.trim()
  if (message.length < TICKET_BODY_MIN) errors.message = `Describe what happened in at least ${TICKET_BODY_MIN} characters.`
  return errors
}

function NewCaseForm() {
  const router = useRouter()
  const search = useSearchParams()
  const orgHrefs = useOrgHrefs()
  const [level, setLevel] = useState<SupportLevel | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [category, setCategory] = useState<string>(() => {
    const c = search?.get('category')
    return isSupportCategory(c) ? c : ''
  })
  const [severity, setSeverity] = useState('normal')
  const [projectId, setProjectId] = useState(() => search?.get('project') ?? '')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({})
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = { category: useId(), project: useId(), subject: useId(), message: useId(), severity: useId() }
  const categoryRef = useRef<HTMLSelectElement>(null)
  const subjectRef = useRef<HTMLInputElement>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    listSupportTickets('open')
      .then((r) => setLevel(r.level))
      .catch((e) => {
        if (e instanceof SupportApiError && e.status === 401) {
          router.push('/auth/login?redirect=/app/support/new')
        }
      })
    getProjects()
      .then((list) => {
        setProjects(list)
        // A prefilled project the caller cannot see is dropped, not sent.
        setProjectId((p) => (p && !list.some((x) => x.id === p) ? '' : p))
      })
      .catch(() => setProjects([]))
  }, [router])

  const allowed = useMemo(() => new Set(level?.allowedSeverities ?? ['low', 'normal']), [level])
  const errors = validate({ category, subject, message })
  const shown = (f: Field) => (submitted || touched[f] ? errors[f] : undefined)
  const blur = (f: Field) => () => setTouched((t) => ({ ...t, [f]: true }))

  const submit = async () => {
    if (busy) return
    setSubmitted(true)
    const first = (['category', 'subject', 'message'] as const).find((f) => errors[f])
    if (first) {
      const firstRef = first === 'category' ? categoryRef : first === 'subject' ? subjectRef : messageRef
      firstRef.current?.focus()
      return
    }
    if (!allowed.has(severity)) {
      setError('Production severities come with Pro and Enterprise. Choose “System impaired”, or upgrade first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { ticket } = await createSupportTicket({
        subject: subject.trim(),
        message: message.trim(),
        category,
        severity,
        projectId: projectId || null,
      })
      router.push(`/app/support/${ticket.id}`)
    } catch (e) {
      if (e instanceof SupportApiError && e.status === 401) {
        router.push('/auth/login?redirect=/app/support/new')
        return
      }
      setError(e instanceof Error ? e.message : 'The case was not opened')
      setBusy(false)
    }
  }

  return (
    <OrgShell>
      <PageHeader
        breadcrumb={<Breadcrumbs items={[{ label: 'Support', href: '/app/support' }, { label: 'New case' }]} />}
        title="Open a support case"
        description="Tell us what is happening. Backenly AI answers in the case thread within seconds, and a person on the team reads every case."
      />

      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <form
            noValidate
            className={`min-w-0 overflow-hidden ${PLATE} border ${EDGE} ${R_PANEL}`}
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <FormSection title="What is it about?">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FieldShell label="Category" required htmlFor={ids.category} error={shown('category')} errorId={`${ids.category}-error`}>
                  <SelectBox>
                    <select
                      id={ids.category}
                      ref={categoryRef}
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      onBlur={blur('category')}
                      required
                      aria-invalid={shown('category') ? true : undefined}
                      aria-describedby={shown('category') ? `${ids.category}-error` : undefined}
                      className={`${INPUT_BASE} h-[36px] appearance-none pl-3 pr-8 sm:h-[32px] ${category ? '' : 'text-faint'}`}
                      disabled={busy}
                    >
                      <option value="" disabled>
                        Choose a category…
                      </option>
                      {SUPPORT_CATEGORIES.map((c) => (
                        <option key={c.id} value={c.id} className="text-zinc-100">
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </SelectBox>
                </FieldShell>
                <FieldShell label="Project" htmlFor={ids.project} hint="Optional. Lets Backenly AI check its tables and agent connections." hintId={`${ids.project}-hint`}>
                  <SelectBox>
                    <select
                      id={ids.project}
                      value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                      aria-describedby={`${ids.project}-hint`}
                      className={`${INPUT_BASE} h-[36px] appearance-none pl-3 pr-8 sm:h-[32px]`}
                      disabled={busy}
                    >
                      <option value="">Not about one project</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </SelectBox>
                </FieldShell>
              </div>
              {category === 'agent' && <AgentConnectionTips />}
            </FormSection>

            <FormSection>
              <fieldset>
                <legend className="text-[13px] font-semibold text-zinc-100">How bad is it?</legend>
                <p className="mt-0.5 text-[12.5px] text-faint">The team works through cases by severity, then by plan.</p>
                <div className={`mt-3 divide-y divide-white/[0.06] overflow-hidden ${R_CONTROL} border ${EDGE} ${WELL}`}>
                  {SUPPORT_SEVERITIES.map((s) => {
                    const enabled = allowed.has(s.id)
                    const selected = severity === s.id
                    return (
                      <label
                        key={s.id}
                        className={`flex items-start gap-3 px-3.5 py-3 transition-colors duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-violet-300/60 ${
                          enabled ? 'cursor-pointer hover:bg-white/[0.025]' : 'cursor-not-allowed'
                        } ${selected ? 'bg-white/[0.035]' : ''}`}
                      >
                        <input
                          type="radio"
                          name={ids.severity}
                          value={s.id}
                          checked={selected}
                          disabled={!enabled || busy}
                          onChange={() => setSeverity(s.id)}
                          className="sr-only"
                        />
                        <span
                          aria-hidden
                          className={`mt-[3px] flex h-[16px] w-[16px] flex-shrink-0 items-center justify-center rounded-full border transition-colors duration-150 ${
                            selected ? 'border-violet-300 bg-violet-400/20' : enabled ? 'border-white/25' : 'border-white/10'
                          }`}
                        >
                          {selected && <span className="h-[6px] w-[6px] rounded-full bg-violet-200" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className={`text-[13px] font-medium ${enabled ? 'text-zinc-100' : 'text-zinc-400'}`}>{s.label}</span>
                            {s.paidOnly && !enabled && <Tag>Pro and Enterprise</Tag>}
                          </span>
                          <span className="mt-0.5 block text-[12.5px] leading-[18px] text-faint">{s.blurb}</span>
                        </span>
                      </label>
                    )
                  })}
                </div>
                {level && level.allowedSeverities.length < SUPPORT_SEVERITIES.length && (
                  <p className="mt-2 text-[12.5px] text-faint">
                    Is a live backend down?{' '}
                    <Link
                      href={orgHrefs.billing}
                      className={`rounded-[3px] text-zinc-300 underline decoration-white/20 underline-offset-[3px] hover:text-zinc-100 ${FOCUS}`}
                    >
                      Upgrade
                    </Link>{' '}
                    for the production severities the team handles first.
                  </p>
                )}
              </fieldset>
            </FormSection>

            <FormSection title="What happened?">
              <div className="space-y-4">
                <FieldShell
                  label="Subject"
                  required
                  htmlFor={ids.subject}
                  counter={`${subject.length}/${TICKET_SUBJECT_MAX}`}
                  error={shown('subject')}
                  errorId={`${ids.subject}-error`}
                >
                  <KitInput
                    id={ids.subject}
                    ref={subjectRef}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    onBlur={blur('subject')}
                    maxLength={TICKET_SUBJECT_MAX}
                    required
                    autoComplete="off"
                    aria-invalid={shown('subject') ? true : undefined}
                    aria-describedby={shown('subject') ? `${ids.subject}-error` : undefined}
                    placeholder="e.g. Claude Code does not see Backenly’s tools…"
                    disabled={busy}
                  />
                </FieldShell>
                <FieldShell
                  label="Description"
                  required
                  htmlFor={ids.message}
                  counter={`${message.length}/${TICKET_BODY_MAX}`}
                  hint="What you did, what you expected, what happened instead, with the exact error text. Never paste passwords or API keys."
                  hintId={`${ids.message}-hint`}
                  error={shown('message')}
                  errorId={`${ids.message}-error`}
                >
                  <textarea
                    id={ids.message}
                    ref={messageRef}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onBlur={blur('message')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        submit()
                      }
                    }}
                    maxLength={TICKET_BODY_MAX}
                    rows={8}
                    required
                    aria-invalid={shown('message') ? true : undefined}
                    aria-describedby={`${shown('message') ? `${ids.message}-error ` : ''}${ids.message}-hint`}
                    placeholder="Steps to reproduce, the agent or client you use, and the exact error…"
                    className={`${INPUT_BASE} resize-y px-3 py-2.5 leading-[20px]`}
                    disabled={busy}
                  />
                </FieldShell>
              </div>
            </FormSection>

            {error && (
              <div className="px-5 pb-1 sm:px-6">
                <KitNote icon={AlertTriangle} tone="danger" title="The case was not opened">
                  {error}
                </KitNote>
              </div>
            )}

            <div className={`flex flex-col-reverse gap-3 border-t ${RULE} ${WELL} px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-6`}>
              <p className="inline-flex items-center gap-1.5 text-[12.5px] text-faint">
                <Sparkles aria-hidden className="h-3.5 w-3.5 text-violet-300" strokeWidth={1.75} />
                Backenly AI answers in the thread within seconds.
              </p>
              <div className="flex items-center justify-end gap-2">
                <KitButtonLink href="/app/support" variant="ghost">
                  Cancel
                </KitButtonLink>
                <KitButton type="submit" variant="primary" icon={Send} loading={busy}>
                  {busy ? 'Opening case…' : 'Open case'}
                </KitButton>
              </div>
            </div>
          </form>

          <WhatHappensNext level={level} />
        </div>
      </div>
    </OrgShell>
  )
}

/* ── Form parts ───────────────────────────────────────────────────────────── */

function FormSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className={`border-b ${RULE} px-5 py-5 last-of-type:border-b-0 sm:px-6`}>
      {title && <h2 className="mb-3.5 text-[13px] font-semibold text-zinc-100">{title}</h2>}
      {children}
    </section>
  )
}

function FieldShell({
  label,
  required = false,
  htmlFor,
  hint,
  hintId,
  counter,
  error,
  errorId,
  children,
}: {
  label: string
  required?: boolean
  htmlFor: string
  hint?: string
  hintId?: string
  counter?: string
  error?: string
  errorId?: string
  children: ReactNode
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-[12.5px] font-medium leading-[18px] text-zinc-300">
          {label}
          {required && (
            <span aria-hidden className="ml-0.5 text-zinc-500">
              *
            </span>
          )}
        </label>
        {counter && (
          <span aria-hidden className="text-[12px] tabular-nums text-faint">
            {counter}
          </span>
        )}
      </div>
      {children}
      {error && (
        <p id={errorId} className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-rose-300">
          <AlertTriangle aria-hidden className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2} />
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className="mt-1.5 text-[12px] leading-[17px] text-faint">
          {hint}
        </p>
      )}
    </div>
  )
}

/** A native select with the console's chevron, so it reads like the other inputs. */
function SelectBox({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      {children}
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500"
        strokeWidth={2}
      />
    </div>
  )
}

/**
 * The three causes behind most "my agent will not connect" cases, from the
 * connection docs (public/docs/agents/client-setup.md, lib/mcp/auth.ts), shown
 * before the case is filed rather than after.
 */
function AgentConnectionTips() {
  return (
    <div className={`mt-4 ${R_CONTROL} border border-white/[0.08] bg-white/[0.02] px-4 py-3.5`}>
      <p className="text-[13px] font-medium text-zinc-100">Most agent connection problems are one of these</p>
      <ul className="mt-2.5 space-y-2 text-[12.5px] leading-[19px] text-zinc-400 [&_code]:rounded-[4px] [&_code]:bg-white/[0.06] [&_code]:px-1 [&_code]:font-mono [&_code]:text-[11.5px] [&_code]:text-zinc-200">
        <li>
          <span className="font-medium text-zinc-200">The conversation was already open.</span> Agents load MCP servers when a session
          starts. Add Backenly in a terminal, then start a new session.
        </li>
        <li>
          <span className="font-medium text-zinc-200">The key went in the wrong header.</span> An MCP key belongs in{' '}
          <code>x-api-key</code>. Sent as <code>Authorization: Bearer</code>, it is read as a sign-in token and refused with{' '}
          <code>INVALID_TOKEN</code>.
        </li>
        <li>
          <span className="font-medium text-zinc-200">The key was revoked or mistyped.</span> <code>INVALID_KEY</code> means it: generate a
          new one in the project’s Connect tab.
        </li>
      </ul>
      <p className="mt-2.5 text-[12.5px] text-zinc-400">
        In Claude Code, <code className="rounded-[4px] bg-white/[0.06] px-1 font-mono text-[11.5px] text-zinc-200">/mcp</code> lists
        backenly when the connection works.{' '}
        <a
          href="/docs/connect"
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center gap-0.5 rounded-[3px] text-violet-300 underline decoration-violet-300/40 underline-offset-[3px] hover:text-violet-200 ${FOCUS}`}
        >
          Connection guide
          <ArrowUpRight aria-hidden className="h-3 w-3" strokeWidth={2} />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </p>
    </div>
  )
}

/** The sequence a case goes through, so nobody wonders what happens after sending. */
function WhatHappensNext({ level }: { level: SupportLevel | null }) {
  const steps = [
    {
      title: 'Backenly AI answers',
      body: 'Within seconds, in the case thread, from the docs and your project’s own records.',
    },
    {
      title: 'A person reads the case',
      body: level?.targetResponseHours
        ? `Every case reaches the team, with a first reply ${teamTargetLabel(level.targetResponseHours).toLowerCase()}.`
        : 'Every case reaches the team, and someone replies as soon as they can.',
    },
    {
      title: 'Replies come to you',
      body: 'The team answers in the thread, with an in-app notification and an email if your settings allow it.',
    },
  ]
  return (
    <aside className="lg:sticky lg:top-[calc(var(--console-bar)+24px)]" aria-labelledby="next-steps-title">
      <div className={`${PLATE} border ${EDGE} ${R_PANEL}`}>
        <h2 id="next-steps-title" className={`border-b ${RULE} px-4 py-3 text-[13px] font-semibold text-zinc-100`}>
          What happens next
        </h2>
        <ol className="px-4 py-1">
          {steps.map((s, i) => (
            <li key={s.title} className="relative flex gap-3 py-3">
              {i < steps.length - 1 && (
                <span aria-hidden className="absolute bottom-[-12px] left-[11.5px] top-[36px] w-px bg-white/[0.07]" />
              )}
              <span
                aria-hidden
                className="relative flex h-[24px] w-[24px] flex-shrink-0 items-center justify-center rounded-full border border-white/[0.10] bg-[#141518] text-[11.5px] font-medium tabular-nums text-zinc-300"
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium leading-[20px] text-zinc-100">{s.title}</p>
                <p className="mt-0.5 text-[12.5px] leading-[18px] text-zinc-400">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </aside>
  )
}
