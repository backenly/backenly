'use client'

import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Icon } from '@iconify/react'
import { registerSiteIcons } from '@/lib/icons/registry'
import { GlobalLoading } from '@/components/ui/GlobalLoading'
import { PASSWORD_MIN_LENGTH, PASSWORD_POLICY_HINT, validatePasswordStrength } from '@/lib/auth/password-policy'
import { AuthRequestError, requestPasswordResetCode, resetPasswordWithCode } from '@/lib/api/auth'
import { CODE_LENGTH, CodeField, ResendCodeButton, useCooldown } from '@/components/site/EmailCodeFields'
import {
  AuthChrome,
  AuthCard,
  AuthFooterNote,
  FieldLabel,
  FieldInput,
  PrimaryButton,
} from '@/components/site/AuthShell'

registerSiteIcons()

type Step = 'email' | 'code' | 'done'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Account recovery in one page: the address, then the emailed code with the
 * new password, then done.
 *
 * It says "sent" only when the server said so. When this deployment cannot
 * send email at all, it says that instead, and tells the operator of a
 * self-hosted install how to reset a password from the server.
 */
function ForgotPasswordForm() {
  const searchParams = useSearchParams()
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState(() => searchParams.get('email')?.trim() || '')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)

  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<{ code?: string; password?: string; confirm?: string }>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [isResetting, setIsResetting] = useState(false)
  const [resendIn, setResendIn] = useCooldown(0)

  // Asked up front so nobody types an address and waits for an email this
  // server has no way to send. The request below is still authoritative.
  useEffect(() => {
    fetch('/api/auth/platform-providers')
      .then((res) => res.json())
      .then((data) => {
        if (data?.emailDelivery === false) {
          setUnavailable(
            "Email isn't set up on this server, so reset codes can't be sent. If you run this server, " +
              'reset a password from it with: npm run auth:reset-password -- --email you@example.com. ' +
              'Otherwise, contact the person who runs it.',
          )
        }
      })
      .catch(() => {})
  }, [])

  const sendCode = async (): Promise<boolean> => {
    const target = email.trim().toLowerCase()
    try {
      const r = await requestPasswordResetCode(target)
      setEmail(target)
      setResendIn(r.resendAfterSec)
      return true
    } catch (error) {
      if (error instanceof AuthRequestError && error.code === 'EMAIL_DELIVERY_UNAVAILABLE') {
        setUnavailable(error.message)
      } else if (step === 'email') {
        setEmailError(error instanceof Error ? error.message : 'Could not send a reset code')
      } else {
        setErrors({ code: error instanceof Error ? error.message : 'Could not send a new code' })
      }
      return false
    }
  }

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return setEmailError('Email is required')
    if (!EMAIL_RE.test(email.trim())) return setEmailError('Please enter a valid email address')
    setEmailError(null)
    setIsSending(true)
    const ok = await sendCode()
    setIsSending(false)
    if (ok) {
      setCode('')
      setErrors({})
      setNotice(null)
      setStep('code')
    }
  }

  const handleResend = async () => {
    setIsSending(true)
    setErrors({})
    setNotice(null)
    const ok = await sendCode()
    setIsSending(false)
    if (ok) {
      setCode('')
      setNotice(`A new code is on its way to ${email}.`)
    }
  }

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault()
    const next: { code?: string; password?: string; confirm?: string } = {}
    if (code.length !== CODE_LENGTH) next.code = `Enter the ${CODE_LENGTH}-digit code from the email.`
    if (!password) {
      next.password = 'Password is required'
    } else {
      const strength = validatePasswordStrength(password)
      if (!strength.valid) next.password = strength.message || 'Choose a stronger password'
    }
    if (!confirm) next.confirm = 'Please confirm your password'
    else if (password !== confirm) next.confirm = 'Passwords do not match'
    if (Object.keys(next).length > 0) return setErrors(next)

    setErrors({})
    setNotice(null)
    setIsResetting(true)
    try {
      await resetPasswordWithCode(email, code, password)
      setStep('done')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not reset the password'
      if (error instanceof AuthRequestError && error.code === 'CODE_REJECTED') setErrors({ code: message })
      else setErrors({ password: message })
    } finally {
      setIsResetting(false)
    }
  }

  const backToSignIn = (
    <div className="mt-7 pt-6 border-t border-white/[0.06] text-center">
      <Link
        href="/auth/login"
        className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors font-medium inline-flex items-center gap-1"
      >
        <Icon icon="solar:alt-arrow-down-linear" width={12} className="rotate-90 text-zinc-500" />
        Back to sign in
      </Link>
    </div>
  )

  if (unavailable) {
    return (
      <AuthChrome>
        <AuthCard
          eyebrow="Account recovery"
          title="Email can't be sent"
          subtitle="No reset code was sent, so there is nothing to wait for."
        >
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-4 text-xs leading-relaxed text-amber-200">
            <Icon icon="solar:danger-triangle-bold" width={20} className="mt-0.5 shrink-0 text-amber-400" />
            <p className="break-words text-zinc-300">{unavailable}</p>
          </div>
          <PrimaryButton type="button" onClick={() => setUnavailable(null)}>
            Try again
          </PrimaryButton>
          {backToSignIn}
        </AuthCard>
        <AuthFooterNote />
      </AuthChrome>
    )
  }

  if (step === 'done') {
    return (
      <AuthChrome>
        <AuthCard
          eyebrow="Success"
          title="Password updated"
          subtitle="Every device that was signed in has been signed out. Sign in with your new password."
        >
          <Link
            href="/auth/login"
            className="group inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-white px-5 text-[15px] font-semibold text-zinc-950 transition hover:bg-zinc-200"
          >
            Go to sign in
            <Icon icon="solar:arrow-right-linear" width={16} className="transition-transform group-hover:translate-x-0.5" />
          </Link>
        </AuthCard>
        <AuthFooterNote />
      </AuthChrome>
    )
  }

  if (step === 'code') {
    return (
      <AuthChrome>
        <AuthCard
          eyebrow="Check your email"
          title="Set a new password"
          subtitle={`If ${email} has a Backenly account, we sent it a ${CODE_LENGTH}-digit code. It expires in 10 minutes.`}
        >
          <form onSubmit={handleReset} className="flex flex-col gap-4 mb-5">
            <CodeField value={code} onChange={setCode} disabled={isResetting} error={errors.code} />

            <FieldLabel htmlFor="password">New password</FieldLabel>
            <FieldInput
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
              disabled={isResetting}
              error={errors.password}
              helper={errors.password ? undefined : PASSWORD_POLICY_HINT}
              trailing={
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="text-zinc-500 hover:text-zinc-300 transition-colors"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  <Icon icon={showPassword ? 'ri:eye-off-line' : 'ri:eye-line'} width={16} />
                </button>
              }
            />

            <FieldLabel htmlFor="confirm">Confirm new password</FieldLabel>
            <FieldInput
              id="confirm"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat your new password"
              disabled={isResetting}
              error={errors.confirm}
            />

            {notice && !errors.code && <p className="text-[11px] text-emerald-300">{notice}</p>}

            <PrimaryButton type="submit" disabled={isResetting} loading={isResetting}>
              {isResetting ? 'Updating password…' : 'Reset password'}
            </PrimaryButton>
          </form>

          <div className="flex items-center justify-between gap-3">
            <ResendCodeButton secondsLeft={resendIn} sending={isSending} onResend={handleResend} />
            <button
              type="button"
              onClick={() => setStep('email')}
              className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Use a different email
            </button>
          </div>

          <p className="mt-6 text-[11px] leading-relaxed text-zinc-500">
            No email? Check your spam folder. Accounts created with Google or GitHub can set a password
            here too.
          </p>

          {backToSignIn}
        </AuthCard>
        <AuthFooterNote />
      </AuthChrome>
    )
  }

  return (
    <AuthChrome>
      <AuthCard
        eyebrow="Account recovery"
        title="Reset your password"
        subtitle="Enter your account's email and we'll send you a code to choose a new password."
      >
        <form onSubmit={handleEmailSubmit} className="flex flex-col gap-4 mb-5">
          <FieldLabel htmlFor="email">Email address</FieldLabel>
          <FieldInput
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              if (emailError) setEmailError(null)
            }}
            placeholder="you@example.com"
            disabled={isSending}
            error={emailError || undefined}
          />

          <PrimaryButton type="submit" disabled={isSending} loading={isSending}>
            {isSending ? 'Sending code…' : 'Send reset code'}
          </PrimaryButton>
        </form>

        <div className="mt-7 pt-6 border-t border-white/[0.06] text-center">
          <p className="text-xs text-zinc-400">
            Remember your password?{' '}
            <Link
              href="/auth/login"
              className="text-violet-300 hover:text-violet-200 transition-colors font-medium inline-flex items-center gap-1"
            >
              Sign in
              <Icon icon="solar:arrow-right-up-linear" width={11} />
            </Link>
          </p>
        </div>
      </AuthCard>

      <AuthFooterNote />
    </AuthChrome>
  )
}

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<GlobalLoading />}>
      <ForgotPasswordForm />
    </Suspense>
  )
}
