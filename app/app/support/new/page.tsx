'use client'

/**
 * /app/support/new: file a support case (Backenly Cloud).
 *
 *   Support / New case
 *   New case
 *   ┌ Category        [Choose a category ▾]   ┐   Docs for Database
 *   │ Project         [Not about a project ▾] │   Database
 *   │ How bad is it?  ( ) General guidance …  │
 *   │ Subject         [                    ]  │
 *   │ Description     [                    ]  │
 *   └                         [Cancel] [Send] ┘
 *
 * One panel of label-left rows, like the New project dialog. Severity is
 * AWS-shaped; the production severities need a paid plan, and on Free one line
 * says so instead of a tag on each. Once a category is chosen, the docs most
 * likely to answer it sit beside the form (under it on a phone).
 *
 * The form validates when a field is left and when it is sent, never by
 * disabling the button: an incomplete send shows what is missing and moves
 * focus to the first gap. `?category=` and `?project=` prefill it, so a page
 * that knows the context can link here without making anyone retype it.
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { notFound, useRouter, useSearchParams } from 'next/navigation'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { useOrgHrefs } from '@cloud/org-routing'
import { AlertTriangle } from 'lucide-react'
import { OrgShell } from '@/components/shell/OrgShell'
import { Breadcrumbs, INPUT_BASE, KitButton, KitButtonLink, KitInput, KitSelect, PageHeader } from '@/components/inspector/kit'
import { EDGE, PAGE_GUTTER, PAGE_WIDTH, PLATE, RULE, R_PANEL } from '@/components/console/tokens'
import { getProjects, type Project } from '@/lib/api/projects'
import { createSupportTicket, listSupportTickets, SupportApiError, type SupportLevel } from '@/lib/api/support'
import {
  SUPPORT_CATEGORIES, SUPPORT_SEVERITIES, TICKET_BODY_MAX, TICKET_BODY_MIN, TICKET_SUBJECT_MAX, isSupportCategory,
} from '@/lib/support/constants'
import { categoryLabel, docsFor } from '@/components/support/presentation'
import { ExternalLink, InlineLink } from '@/components/support/parts'

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

/** A count is noise until the limit is near: past 80% of it. */
function counterFor(length: number, max: number): string | null {
  return length > max * 0.8 ? `${length.toLocaleString()} / ${max.toLocaleString()}` : null
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
  const [severity, setSeverity] = useState('low')
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
  const productionLocked = level !== null && level.allowedSeverities.length < SUPPORT_SEVERITIES.length
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
      setError('Production severities come with Pro. Choose “System impaired”, or upgrade first.')
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
      setError(e instanceof Error ? e.message : 'Try again in a moment.')
      setBusy(false)
    }
  }

  const subjectCount = counterFor(subject.length, TICKET_SUBJECT_MAX)
  const messageCount = counterFor(message.length, TICKET_BODY_MAX)

  return (
    <OrgShell>
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
        <PageHeader
          flush
          breadcrumb={<Breadcrumbs items={[{ label: 'Support', href: '/app/support' }, { label: 'New case' }]} />}
          title="New case"
        />

        <div className="grid items-start gap-x-[40px] gap-y-[28px] lg:grid-cols-[minmax(0,1fr)_232px]">
          <form
            noValidate
            aria-label="New case"
            className={`min-w-0 ${PLATE} border ${EDGE} ${R_PANEL}`}
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <div className="divide-y divide-white/[0.06]">
              <FormRow label="Category" htmlFor={ids.category}>
                <KitSelect
                  id={ids.category}
                  ref={categoryRef}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  onBlur={blur('category')}
                  required
                  aria-invalid={shown('category') ? true : undefined}
                  aria-describedby={shown('category') ? `${ids.category}-error` : undefined}
                  className={category ? '' : '!text-faint'}
                  disabled={busy}
                >
                  <option value="" disabled>
                    Choose a category
                  </option>
                  {SUPPORT_CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </KitSelect>
                <FieldError id={`${ids.category}-error`} error={shown('category')} />
              </FormRow>

              <FormRow label="Project" hint="Optional" hintId={`${ids.project}-hint`} htmlFor={ids.project}>
                <KitSelect
                  id={ids.project}
                  aria-describedby={`${ids.project}-hint`}
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  disabled={busy}
                >
                  <option value="">Not about a project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </KitSelect>
              </FormRow>

              <FormRow label="How bad is it?" labelId={`${ids.severity}-label`}>
                <div role="radiogroup" aria-labelledby={`${ids.severity}-label`} className="-my-[4px] space-y-[2px]">
                  {SUPPORT_SEVERITIES.map((s) => (
                    <SeverityOption
                      key={s.id}
                      name={ids.severity}
                      value={s.id}
                      label={s.label}
                      blurb={s.blurb}
                      checked={severity === s.id}
                      enabled={allowed.has(s.id) && !busy}
                      locked={!allowed.has(s.id)}
                      onChange={() => setSeverity(s.id)}
                    />
                  ))}
                </div>
                {productionLocked && (
                  <p className="mt-[10px] text-[12.5px] leading-[18px] text-faint">
                    Production severities come with Pro.{' '}
                    <InlineLink href={orgHrefs.billing} className="whitespace-nowrap font-medium">
                      Upgrade to Pro
                    </InlineLink>
                  </p>
                )}
              </FormRow>

              <FormRow label="Subject" htmlFor={ids.subject}>
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
                  placeholder="e.g. Claude Code does not see Backenly’s tools"
                  disabled={busy}
                />
                <FieldFoot id={`${ids.subject}-error`} error={shown('subject')} counter={subjectCount} />
              </FormRow>

              <FormRow label="Description" hint="Never paste passwords or API keys." hintId={`${ids.message}-hint`} htmlFor={ids.message}>
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
                  rows={7}
                  required
                  aria-invalid={shown('message') ? true : undefined}
                  aria-describedby={`${shown('message') ? `${ids.message}-error ` : ''}${ids.message}-hint`}
                  placeholder="What you did, what you expected, and the exact error"
                  className={`${INPUT_BASE} block resize-y px-[12px] py-[9px] leading-[20px]`}
                  disabled={busy}
                />
                <FieldFoot id={`${ids.message}-error`} error={shown('message')} counter={messageCount} />
              </FormRow>
            </div>

            <div
              className={`flex flex-col-reverse gap-[12px] rounded-b-[10px] border-t ${RULE} bg-white/[0.015] px-[16px] py-[14px] sm:flex-row sm:items-center sm:justify-end sm:px-[20px]`}
            >
              {error && (
                <p role="alert" className="min-w-0 text-[12.5px] leading-[18px] text-rose-300 [overflow-wrap:anywhere] sm:mr-auto">
                  The case was not opened. {error}
                </p>
              )}
              <div className="flex items-center justify-end gap-[8px]">
                <KitButtonLink href="/app/support" variant="ghost">
                  Cancel
                </KitButtonLink>
                <KitButton type="submit" variant="primary" loading={busy}>
                  {busy ? 'Sending…' : 'Send'}
                </KitButton>
              </div>
            </div>
          </form>

          <CategoryDocs category={category} />
        </div>
      </div>
    </OrgShell>
  )
}

/* ── Form parts ───────────────────────────────────────────────────────────── */

/** One row of the form: what it is on the left, the control on the right (stacked on a phone). */
function FormRow({
  label,
  hint,
  hintId,
  htmlFor,
  labelId,
  children,
}: {
  label: string
  hint?: string
  hintId?: string
  htmlFor?: string
  labelId?: string
  children: ReactNode
}) {
  return (
    <div className="grid gap-[8px] px-[16px] py-[16px] sm:grid-cols-[164px_minmax(0,1fr)] sm:gap-[24px] sm:px-[20px]">
      <div className="min-w-0 sm:pt-[6px]">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-[13px] font-medium leading-[20px] text-zinc-100">
            {label}
          </label>
        ) : (
          <p id={labelId} className="text-[13px] font-medium leading-[20px] text-zinc-100">
            {label}
          </p>
        )}
        {hint && (
          <p id={hintId} className="mt-[2px] text-[12px] leading-[17px] text-faint [text-wrap:pretty]">
            {hint}
          </p>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null
  return (
    <p id={id} className="mt-[8px] flex items-center gap-[6px] text-[12.5px] leading-[18px] text-rose-300">
      <AlertTriangle aria-hidden className="h-3.5 w-3.5 flex-shrink-0 text-zinc-50" strokeWidth={2} />
      {error}
    </p>
  )
}

/** Under a text field: its error, and its count once the limit is near. */
function FieldFoot({ id, error, counter }: { id: string; error?: string; counter: string | null }) {
  if (!error && !counter) return null
  return (
    <div className="flex items-start justify-between gap-[12px]">
      <FieldError id={id} error={error} />
      {counter && (
        <span aria-hidden className="ml-auto mt-[8px] text-[12px] leading-[18px] tabular-nums text-faint">
          {counter}
        </span>
      )}
    </div>
  )
}

/**
 * One severity: a white radio, its name and what it means. Native radio inputs
 * underneath, so the arrow keys move between the ones that can be chosen.
 */
function SeverityOption({
  name,
  value,
  label,
  blurb,
  checked,
  enabled,
  locked,
  onChange,
}: {
  name: string
  value: string
  label: string
  blurb: string
  checked: boolean
  enabled: boolean
  /** Not on this plan, rather than only paused while sending. */
  locked: boolean
  onChange: () => void
}) {
  return (
    <label
      className={`-mx-[10px] flex items-start gap-[12px] rounded-[7px] px-[10px] py-[7px] transition-colors duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-white/70 ${
        enabled ? 'cursor-pointer hover:bg-white/[0.03]' : 'cursor-not-allowed'
      }`}
    >
      <input type="radio" name={name} value={value} checked={checked} disabled={!enabled} onChange={onChange} className="peer sr-only" />
      <span
        aria-hidden
        className={`mt-[2px] flex h-[16px] w-[16px] flex-shrink-0 items-center justify-center rounded-full border transition-colors duration-150 ${
          checked ? 'border-white' : locked ? 'border-white/[0.12]' : 'border-white/30'
        }`}
      >
        {checked && <span className="h-[8px] w-[8px] rounded-full bg-white" />}
      </span>
      <span className="min-w-0">
        <span className={`block text-[13px] font-medium leading-[20px] ${locked ? 'text-zinc-500' : 'text-zinc-100'}`}>{label}</span>
        <span className={`block text-[12.5px] leading-[18px] ${locked ? 'text-zinc-600' : 'text-faint'}`}>{blurb}</span>
      </span>
    </label>
  )
}

/**
 * The docs most likely to answer a case of the chosen category, plus the three
 * causes behind most "my agent will not connect" cases (from the connection
 * docs), so the answer can arrive before the case is sent.
 */
function CategoryDocs({ category }: { category: string }) {
  if (!category) return <div aria-hidden className="hidden lg:block" />
  return (
    <aside aria-labelledby="category-docs" className="min-w-0 lg:sticky lg:top-[calc(var(--console-bar)+24px)] lg:pt-[2px]">
      <h2 id="category-docs" className="text-[13px] font-medium leading-[20px] text-zinc-100">
        Docs for {categoryLabel(category)}
      </h2>
      <ul className="mt-[8px] space-y-[6px]">
        {docsFor(category).map((d) => (
          <li key={d.href} className="text-[13px] leading-[20px]">
            <ExternalLink href={d.href}>{d.title}</ExternalLink>
          </li>
        ))}
      </ul>
      {category === 'agent' && (
        <>
          <h3 className="mt-[22px] text-[13px] font-medium leading-[20px] text-zinc-100">Check these first</h3>
          <ul className="mt-[8px] space-y-[8px] text-[12.5px] leading-[18px] text-zinc-400 [&_code]:font-mono [&_code]:text-[11.5px] [&_code]:text-zinc-200">
            <li>Start a new agent session after adding Backenly. Agents load MCP servers when a session starts.</li>
            <li>
              Send the key as <code>x-api-key</code>. As a Bearer token it is refused with <code>INVALID_TOKEN</code>.
            </li>
            <li>
              <code>INVALID_KEY</code> means it was revoked or mistyped. Make a new one in the project’s Connect tab.
            </li>
          </ul>
        </>
      )}
    </aside>
  )
}
