'use client'

/**
 * The spend limit: the most usage past the plan may cost in a month, paid in
 * advance. Shared by the Billing page, where an owner changes it, and the
 * Usage page, which reads it.
 *
 * Public on purpose. The Billing page belongs to the Cloud overlay, but this
 * control only speaks to the spend-limit routes, so both repositories build it
 * from here and the routes stay the one place the rules live:
 *
 *   - the limit allows usage only up to the prepaid balance;
 *   - lowering it applies at once;
 *   - raising it, or topping the balance back up to it, sends a code to the
 *     owner's email, and when the balance does not cover the limit,
 *     confirming the code opens Stripe Checkout for the difference. The limit
 *     applies once Stripe reports the payment, which brings the owner back to
 *     Billing (?prepay=success&session_id=…).
 *
 * Agents can read the limit and never change it: nothing here has an MCP
 * counterpart.
 */

import { FormEvent, useEffect, useRef, useState } from 'react'
import { KitButton, KitSelect, INPUT_BASE } from '@/components/inspector/kit'
import { PANEL } from '@/components/autonomy/rows'
import { fmtCents, fmtDollars, getJson, scoped, scopedBody } from '@/components/usage/format'

/** The spend limit as GET /api/billing/spend-limit reports it. */
export interface SpendLimitState {
  /** The owner's limit, whole dollars in cents. 0 is off. */
  limitCents: number
  /** Paid in advance and not yet drawn. The limit allows usage only up to it. */
  balanceCents: number
  presetsCents: number[]
  maxCents: number
  /** The smallest payment Stripe is asked to take. */
  minimumPaymentCents: number
  /** off | shadow | enforce, or null when the route did not say. */
  mode: 'off' | 'shadow' | 'enforce' | null
  /** Whether the plan has usage past it at all (never on Free). */
  overageAvailable: boolean
}

const DEFAULT_PRESETS = [0, 5_000, 10_000, 25_000]

/** The route's answer, read defensively: an older server omits the newer fields. */
export function readSpendLimit(d: any): SpendLimitState | null {
  if (!d || typeof d.limitCents !== 'number') return null
  return {
    limitCents: d.limitCents,
    balanceCents: typeof d.balanceCents === 'number' ? d.balanceCents : 0,
    presetsCents: Array.isArray(d.presetsCents) ? d.presetsCents : DEFAULT_PRESETS,
    maxCents: typeof d.maxCents === 'number' ? d.maxCents : 1_000_000,
    minimumPaymentCents: typeof d.minimumPaymentCents === 'number' ? d.minimumPaymentCents : 500,
    mode: d.mode === 'off' || d.mode === 'shadow' || d.mode === 'enforce' ? d.mode : null,
    overageAvailable: d.overageAvailable !== false,
  }
}

/** Read the account's spend limit; null when it could not be read. */
export async function fetchSpendLimit(orgId: string | null | undefined): Promise<SpendLimitState | null> {
  const r = await getJson<any>(scoped('/api/billing/spend-limit', orgId))
  return r.ok ? readSpendLimit(r.data) : null
}

/**
 * What topping the balance up to the limit costs: nothing when the balance
 * covers it, otherwise the shortfall in whole dollars and at least the
 * minimum payment. The same rule the server charges by (lib/billing/prepay).
 */
export function topUpCents(limitCents: number, balanceCents: number, minimumCents = 500): number {
  const short = limitCents - Math.max(0, balanceCents)
  if (short <= 0) return 0
  return Math.max(minimumCents, Math.ceil(short / 100) * 100)
}

/** How a limit reads in the picker and in facts: "Off", "$50". */
export function limitLabel(cents: number): string {
  return cents === 0 ? 'Off' : fmtDollars(cents)
}

// ─── Back from Stripe Checkout ───────────────────────────────────────────────

interface CheckoutReturn {
  outcome: 'success' | 'canceled'
  sessionId: string | null
}

function readCheckoutReturn(): CheckoutReturn | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const outcome = params.get('prepay')
  if (outcome !== 'success' && outcome !== 'canceled') return null
  return { outcome, sessionId: outcome === 'success' ? params.get('session_id') : null }
}

const NOT_CONFIRMED = 'Stripe has not confirmed the payment yet. Your balance updates when it does.'

/**
 * Report a paid Checkout Session when Stripe sends the owner back, so the
 * balance and the limit update now rather than whenever the webhook arrives.
 * Crediting is keyed on the session, so this and the webhook together still
 * credit a payment once. Returns what to tell the owner, and calls `onSettled`
 * once the balance may have moved.
 */
export function useCheckoutReturn(orgId: string | null | undefined, onSettled: () => void): string | null {
  // Read once in the browser. Nothing it decides renders before the page's
  // data has loaded, so the server render never differs.
  const [checkout] = useState(readCheckoutReturn)
  const [notice, setNotice] = useState<string | null>(
    checkout?.outcome === 'canceled' ? 'Payment canceled. Your spend limit and prepaid balance did not change.' : null,
  )
  const settled = useRef(onSettled)
  useEffect(() => {
    settled.current = onSettled
  })

  useEffect(() => {
    if (!checkout) return
    const url = new URL(window.location.href)
    url.searchParams.delete('prepay')
    url.searchParams.delete('session_id')
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    if (!checkout.sessionId) return
    let cancelled = false
    fetch('/api/billing/spend-limit/prepay', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: scopedBody({ sessionId: checkout.sessionId }, orgId),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) setNotice(data.error || NOT_CONFIRMED)
        else if (data.outcome === 'unpaid') setNotice('Stripe is still processing the payment. Your balance updates when it clears.')
        else setNotice(`Payment received. Your prepaid balance is ${fmtCents(data.balanceCents ?? 0)}.`)
      })
      .catch(() => {
        if (!cancelled) setNotice(NOT_CONFIRMED)
      })
      .finally(() => {
        if (!cancelled) settled.current()
      })
    return () => {
      cancelled = true
    }
  }, [checkout, orgId])

  return notice
}

// ─── The control ─────────────────────────────────────────────────────────────

interface Pending {
  requestedCents: number
  paymentCents: number
  sentTo: string
}

type Message = { tone: 'info' | 'error'; text: string }

/**
 * The owner's spend limit as one row: the limit, Save, the prepaid balance and
 * a top-up, with the emailed code asked for underneath when a change needs one.
 */
export function SpendLimitControl({
  orgId,
  limit,
  notice,
  onChanged,
}: {
  orgId?: string | null
  limit: SpendLimitState
  /** Said on arrival: the outcome of a return from Stripe Checkout. */
  notice?: string | null
  onChanged: () => void
}) {
  const current = limit.limitCents
  // null follows the saved limit, so a reload after a change or a payment
  // moves the picker with it; a value is one being chosen.
  const [picked, setPicked] = useState<string | null>(null)
  const [custom, setCustom] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'save' | 'topup' | 'confirm' | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  // The arrival notice stands until the owner does something here.
  const [acted, setActed] = useState(false)
  const choice = picked ?? String(current)
  const shown: Message | null = message ?? (!acted && notice ? { tone: 'info', text: notice } : null)

  // A custom limit set earlier is listed as itself, not as the first preset.
  const options = limit.presetsCents.includes(current)
    ? limit.presetsCents
    : [...limit.presetsCents, current].sort((a, b) => a - b)
  const chosenCents = choice === 'custom' ? (custom ? Number(custom) * 100 : NaN) : Number(choice)
  const changed = choice === 'custom' ? custom !== '' && chosenCents !== current : chosenCents !== current
  const topUp = current > 0 ? topUpCents(current, limit.balanceCents, limit.minimumPaymentCents) : 0

  async function request(cents: number, kind: 'save' | 'topup') {
    if (!Number.isInteger(cents) || cents < 0 || cents > limit.maxCents) {
      setMessage({ tone: 'error', text: `Enter a whole-dollar amount up to ${fmtDollars(limit.maxCents)}.` })
      return
    }
    setBusy(kind)
    setMessage(null)
    setActed(true)
    try {
      const res = await fetch('/api/billing/spend-limit', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: scopedBody({ limitCents: cents }, orgId),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 202) {
        setPending({ requestedCents: data.requestedCents ?? cents, paymentCents: data.paymentCents ?? 0, sentTo: data.sentTo ?? 'your email' })
        setCode('')
      } else if (!res.ok) {
        setMessage({ tone: 'error', text: data.error || 'The limit did not change. Try again.' })
      } else {
        setMessage({ tone: 'info', text: cents < current ? `Spend limit lowered to ${limitLabel(cents)}.` : 'Spend limit saved.' })
        setPicked(null)
        setCustom('')
        onChanged()
      }
    } catch {
      setMessage({ tone: 'error', text: 'The limit did not change. Try again.' })
    } finally {
      setBusy(null)
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault()
    if (!pending) return
    setBusy('confirm')
    setMessage(null)
    setActed(true)
    try {
      const res = await fetch('/api/billing/spend-limit/confirm', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: scopedBody({ code: code.replace(/\D/g, '') }, orgId),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMessage({ tone: 'error', text: data.error || 'That code did not work.' })
        return
      }
      if (typeof data.checkoutUrl === 'string') {
        // The limit changes once Stripe reports the payment, not before.
        setMessage({ tone: 'info', text: 'Opening Stripe to take the payment.' })
        window.location.assign(data.checkoutUrl)
        return
      }
      setPending(null)
      setCode('')
      setPicked(null)
      setCustom('')
      setMessage({ tone: 'info', text: `Spend limit set to ${limitLabel(pending.requestedCents)}.` })
      onChanged()
    } catch {
      setMessage({ tone: 'error', text: 'That code could not be checked. Try again.' })
    } finally {
      setBusy(null)
    }
  }

  const locked = busy !== null || pending !== null

  return (
    <div className={PANEL}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3 px-5 py-4">
        <KitSelect
          aria-label="Spend limit"
          wrapperClassName="w-[132px]"
          className="tabular-nums"
          value={choice}
          disabled={locked}
          onChange={(e) => {
            setPicked(e.target.value === String(current) ? null : e.target.value)
            setMessage(null)
            setActed(true)
          }}
        >
          {options.map((c) => (
            <option key={c} value={String(c)}>
              {limitLabel(c)}
            </option>
          ))}
          <option value="custom">Custom</option>
        </KitSelect>
        {choice === 'custom' && (
          <div className="relative w-[112px]">
            <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-faint">
              $
            </span>
            <input
              className={`${INPUT_BASE} h-[36px] pl-[22px] pr-3 tabular-nums sm:h-[32px]`}
              aria-label="Spend limit in whole US dollars"
              placeholder="500"
              inputMode="numeric"
              autoFocus
              value={custom}
              disabled={locked}
              onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, '').slice(0, 7))}
            />
          </div>
        )}
        <KitButton onClick={() => request(chosenCents, 'save')} disabled={!changed || locked} loading={busy === 'save'}>
          Save
        </KitButton>
        {/* The balance and its top-up keep together: a second line of their own on a phone. */}
        <div className="flex min-w-0 flex-[1_1_100%] items-center justify-between gap-3 sm:flex-1 sm:pl-2">
          <p className="text-[13px] text-faint">
            Prepaid <span className="tabular-nums text-zinc-200">{fmtCents(limit.balanceCents)}</span>
          </p>
          {topUp > 0 && (
            <KitButton onClick={() => request(current, 'topup')} disabled={locked} loading={busy === 'topup'}>
              Top up {fmtDollars(topUp)}
            </KitButton>
          )}
        </div>
      </div>

      {pending && (
        <form onSubmit={confirm} className="border-t border-white/[0.06] px-5 py-4">
          <p className="text-[13px] leading-[20px] text-zinc-300">
            We sent a code to {pending.sentTo}.{' '}
            {pending.paymentCents > 0
              ? `After you confirm, Stripe takes ${fmtDollars(pending.paymentCents)} for your prepaid balance.`
              : `It sets your limit to ${limitLabel(pending.requestedCents)}.`}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="w-[128px]">
              <input
                className={`${INPUT_BASE} h-[36px] px-3 font-mono tracking-[0.2em] sm:h-[32px]`}
                aria-label="Six-digit code from your email"
                placeholder="000000"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={7}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <KitButton type="submit" variant="primary" disabled={busy !== null || code.replace(/\D/g, '').length !== 6} loading={busy === 'confirm'}>
              {pending.paymentCents > 0 ? `Confirm and pay ${fmtDollars(pending.paymentCents)}` : 'Confirm'}
            </KitButton>
            <KitButton
              variant="ghost"
              disabled={busy !== null}
              onClick={() => {
                setPending(null)
                setCode('')
                setPicked(null)
                setCustom('')
              }}
            >
              Cancel
            </KitButton>
          </div>
        </form>
      )}

      {shown && (
        <p
          role={shown.tone === 'error' ? 'alert' : 'status'}
          className={`border-t border-white/[0.06] px-5 py-3 text-[13px] leading-[20px] ${shown.tone === 'error' ? 'text-rose-300' : 'text-zinc-300'}`}
        >
          {shown.text}
        </p>
      )}
    </div>
  )
}
