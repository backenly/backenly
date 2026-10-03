'use client'

/**
 * The two pieces every "we emailed you a code" step shares: the code field and
 * a resend control that waits out the server's cooldown instead of inviting a
 * click the server will refuse.
 */
import { useEffect, useState } from 'react'
import { FieldInput, FieldLabel } from '@/components/site/AuthShell'

export const CODE_LENGTH = 6

/** Keep only digits, so a pasted "123 456" or "123-456" still fits. */
export function cleanCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, CODE_LENGTH)
}

export function CodeField({
  value,
  onChange,
  disabled,
  error,
}: {
  value: string
  onChange: (code: string) => void
  disabled?: boolean
  error?: string
}) {
  return (
    <>
      <FieldLabel htmlFor="code">Verification code</FieldLabel>
      <FieldInput
        id="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={CODE_LENGTH + 2}
        autoFocus
        value={value}
        onChange={(e) => onChange(cleanCode(e.target.value))}
        placeholder="123456"
        disabled={disabled}
        error={error}
        className="font-mono text-[18px] tracking-[0.4em]"
      />
    </>
  )
}

/** Seconds left before another code may be requested, counting down to zero. */
export function useCooldown(initialSeconds: number): [number, (seconds: number) => void] {
  const [left, setLeft] = useState(initialSeconds)
  useEffect(() => {
    if (left <= 0) return
    const t = setTimeout(() => setLeft((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [left])
  return [left, setLeft]
}

export function ResendCodeButton({
  secondsLeft,
  sending,
  onResend,
}: {
  secondsLeft: number
  sending: boolean
  onResend: () => void
}) {
  const waiting = secondsLeft > 0
  return (
    <button
      type="button"
      onClick={onResend}
      disabled={waiting || sending}
      className="text-xs font-medium text-violet-300 transition-colors hover:text-violet-200 disabled:cursor-not-allowed disabled:text-zinc-500"
    >
      {sending ? 'Sending…' : waiting ? `Send a new code in ${secondsLeft}s` : 'Send a new code'}
    </button>
  )
}
