'use client'

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AlertCircle, ArrowRight, Check, ChevronDown } from 'lucide-react'
import { BTN_PRIMARY, BTN_SECONDARY } from '@/components/landing-v8/tokens'
import { TurnstileWidget, isTurnstileEnabled, resetTurnstile } from '@/components/site/TurnstileWidget'
import { CONTACT_EMAIL, CONTACT_LIMITS, CONTACT_TOPICS, type ContactTopic } from '@/lib/contact'

/* ─────────────────────────────────────────────────────────────
   The contact page's message form (founders, 2026-11-15: Contact "like
   Blaxel", whose page leads with a form). It posts to app/api/contact, which
   mails the team's inbox with the sender as Reply-To. Errors say what to do
   next, and the address to write to is always on screen in case the form
   cannot send.
───────────────────────────────────────────────────────────── */

type Field = 'name' | 'email' | 'company' | 'topic' | 'message'
type Errors = Partial<Record<Field | 'form', string>>

const FIELD =
  'w-full rounded-[8px] border bg-white/[0.02] px-[14px] text-[15px] text-zinc-100 placeholder:text-zinc-500 transition-[border-color,box-shadow,background-color] duration-150 focus:border-white/30 focus:bg-white/[0.035] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.08)] focus:outline-none disabled:opacity-60'

function border(error?: string) {
  return error ? 'border-rose-400/60' : 'border-white/[0.10]'
}

function Label({ htmlFor, children, optional }: { htmlFor: string; children: ReactNode; optional?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="flex items-baseline justify-between text-[13.5px] font-medium tracking-[-0.006em] text-zinc-200">
      {children}
      {optional && <span className="text-[12.5px] font-normal text-faint">Optional</span>}
    </label>
  )
}

function FieldError({ id, children }: { id: string; children?: string }) {
  if (!children) return null
  return (
    <p id={id} className="mt-[8px] flex items-start gap-[6px] text-[12.5px] leading-[1.45] text-rose-300">
      <AlertCircle aria-hidden className="mt-[2px] h-[13px] w-[13px] shrink-0" />
      {children}
    </p>
  )
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validate(values: Record<Field, string>): Errors {
  const errors: Errors = {}
  if (!EMAIL_SHAPE.test(values.email.trim())) errors.email = 'Enter an email address we can reply to.'
  if (values.message.trim().length < CONTACT_LIMITS.messageMin) errors.message = 'Tell us a little more, at least a sentence.'
  return errors
}

export function ContactForm() {
  const [values, setValues] = useState<Record<Field, string>>({
    name: '',
    email: '',
    company: '',
    topic: CONTACT_TOPICS[0],
    message: '',
  })
  const [website, setWebsite] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [errors, setErrors] = useState<Errors>({})
  const [sending, setSending] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const doneRef = useRef<HTMLHeadingElement>(null)

  // Move focus to the confirmation, so a screen reader hears it at once.
  useEffect(() => {
    if (sentTo) doneRef.current?.focus()
  }, [sentTo])

  const set = (field: Field) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [field]: e.target.value }))
    if (errors[field]) setErrors((x) => ({ ...x, [field]: undefined }))
  }

  const focusFirstError = (next: Errors) => {
    const first = (['name', 'email', 'company', 'topic', 'message'] as Field[]).find((f) => next[f])
    if (first) formRef.current?.querySelector<HTMLElement>(`#contact-${first}`)?.focus()
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const local = validate(values)
    if (local.email || local.message) {
      setErrors(local)
      focusFirstError(local)
      return
    }
    if (isTurnstileEnabled && !token) {
      setErrors({ form: 'Complete the verification check above, then send.' })
      return
    }
    setErrors({})
    setSending(true)
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, website, ...(token ? { turnstileToken: token } : {}) }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setSentTo(values.email.trim())
        return
      }
      const fields = (data?.fields ?? {}) as Errors
      if (Object.keys(fields).length) {
        setErrors(fields)
        focusFirstError(fields)
        return
      }
      // The route's own words when it gave any (a limit, the check), else where to write instead.
      const said = res.status !== 404 && typeof data?.error === 'string' ? data.error : null
      setErrors({ form: said ?? `We could not send your message just now. Email ${CONTACT_EMAIL} instead.` })
    } catch {
      setErrors({ form: `We could not reach Backenly just now. Email ${CONTACT_EMAIL} instead.` })
    } finally {
      setSending(false)
      setToken(null)
      resetTurnstile()
    }
  }

  if (sentTo) {
    return (
      <div role="status" className="mt-[28px] rounded-[8px] border border-white/[0.10] bg-white/[0.02] p-[24px] sm:p-[28px]">
        <span className="flex h-[36px] w-[36px] items-center justify-center rounded-[8px] border border-white/[0.12] bg-white/[0.04]">
          <Check aria-hidden className="h-[17px] w-[17px] text-white" strokeWidth={2} />
        </span>
        <h3 ref={doneRef} tabIndex={-1} className="mt-[18px] text-[19px] font-medium tracking-[-0.015em] text-white focus:outline-none">
          Message sent
        </h3>
        <p className="mt-[8px] text-[15px] leading-[1.6] text-zinc-300">
          We reply to <span className="text-white">{sentTo}</span> within two business days.
        </p>
        <button
          type="button"
          onClick={() => {
            setSentTo(null)
            setValues((v) => ({ ...v, message: '' }))
          }}
          className={`mt-[24px] ${BTN_SECONDARY} h-[40px] px-[16px] text-[14px]`}
        >
          Send another message
        </button>
      </div>
    )
  }

  const described = (f: Field) => (errors[f] ? `contact-${f}-error` : undefined)

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="mt-[28px] grid gap-[20px]">
      <div className="grid gap-[20px] sm:grid-cols-2">
        <div>
          <Label htmlFor="contact-name" optional>
            Name
          </Label>
          <input
            id="contact-name"
            name="name"
            autoComplete="name"
            maxLength={CONTACT_LIMITS.name}
            value={values.name}
            onChange={set('name')}
            disabled={sending}
            aria-invalid={!!errors.name}
            aria-describedby={described('name')}
            className={`mt-[8px] h-[44px] ${FIELD} ${border(errors.name)}`}
          />
          <FieldError id="contact-name-error">{errors.name}</FieldError>
        </div>
        <div>
          <Label htmlFor="contact-email">Email</Label>
          <input
            id="contact-email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            maxLength={CONTACT_LIMITS.email}
            value={values.email}
            onChange={set('email')}
            disabled={sending}
            required
            aria-invalid={!!errors.email}
            aria-describedby={described('email')}
            className={`mt-[8px] h-[44px] ${FIELD} ${border(errors.email)}`}
          />
          <FieldError id="contact-email-error">{errors.email}</FieldError>
        </div>
      </div>

      <div className="grid gap-[20px] sm:grid-cols-2">
        <div>
          <Label htmlFor="contact-company" optional>
            Company
          </Label>
          <input
            id="contact-company"
            name="company"
            autoComplete="organization"
            maxLength={CONTACT_LIMITS.company}
            value={values.company}
            onChange={set('company')}
            disabled={sending}
            aria-invalid={!!errors.company}
            aria-describedby={described('company')}
            className={`mt-[8px] h-[44px] ${FIELD} ${border(errors.company)}`}
          />
          <FieldError id="contact-company-error">{errors.company}</FieldError>
        </div>
        <div>
          <Label htmlFor="contact-topic">Topic</Label>
          <div className="relative mt-[8px]">
            <select
              id="contact-topic"
              name="topic"
              value={values.topic}
              onChange={(e) => setValues((v) => ({ ...v, topic: e.target.value as ContactTopic }))}
              disabled={sending}
              className={`h-[44px] appearance-none pr-[40px] ${FIELD} ${border(errors.topic)} [&>option]:bg-[#16171b] [&>option]:text-zinc-100`}
            >
              {CONTACT_TOPICS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden className="pointer-events-none absolute right-[14px] top-1/2 h-[16px] w-[16px] -translate-y-1/2 text-zinc-400" />
          </div>
        </div>
      </div>

      <div>
        <Label htmlFor="contact-message">Message</Label>
        <textarea
          id="contact-message"
          name="message"
          rows={6}
          maxLength={CONTACT_LIMITS.messageMax}
          placeholder="What are you building, and how can we help?"
          value={values.message}
          onChange={set('message')}
          disabled={sending}
          required
          aria-invalid={!!errors.message}
          aria-describedby={described('message')}
          className={`mt-[8px] block min-h-[148px] resize-y py-[12px] leading-[1.55] ${FIELD} ${border(errors.message)}`}
        />
        <FieldError id="contact-message-error">{errors.message}</FieldError>
      </div>

      {/* Only bots fill this in; the route drops their messages without saying so. */}
      <div aria-hidden="true" className="absolute left-[-10000px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="contact-website">Website</label>
        <input id="contact-website" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </div>

      <TurnstileWidget onToken={setToken} />

      {errors.form && (
        <div role="alert" className="flex items-start gap-[10px] rounded-[8px] border border-rose-400/30 bg-rose-500/[0.06] px-[14px] py-[12px] text-[14px] leading-[1.5] text-rose-200">
          <AlertCircle aria-hidden className="mt-[3px] h-[15px] w-[15px] shrink-0" />
          <span>{errors.form}</span>
        </div>
      )}

      <div className="flex flex-col gap-[14px] sm:flex-row sm:items-center sm:justify-between">
        <button type="submit" disabled={sending} className={`${BTN_PRIMARY} disabled:cursor-not-allowed disabled:opacity-60`}>
          {sending && <span aria-hidden className="h-[14px] w-[14px] animate-spin rounded-full border-2 border-black/25 border-t-black" />}
          {sending ? 'Sending…' : 'Send message'}
          {!sending && <ArrowRight aria-hidden className="h-[16px] w-[16px] transition-transform duration-150 group-hover:translate-x-[2px]" />}
        </button>
        <p className="text-[13.5px] text-faint">
          Or email{' '}
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="rounded-[3px] text-zinc-300 underline decoration-white/25 underline-offset-[3px] transition-colors hover:text-white hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            {CONTACT_EMAIL}
          </a>
        </p>
      </div>
    </form>
  )
}
