'use client'

import { useState, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Icon } from '@iconify/react'
import { registerSiteIcons } from '@/lib/icons/registry'
import { GlobalLoading } from '@/components/ui/GlobalLoading'
import {
  AuthChrome,
  AuthCard,
  AuthFooterNote,
  FieldLabel,
  FieldInput,
  PrimaryButton,
} from '@/components/site/AuthShell'

registerSiteIcons()

function ResetPasswordForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token') || ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({})
  const [success, setSuccess] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  if (!token) {
    return (
      <AuthChrome>
        <AuthCard
          eyebrow="Invalid link"
          title="Reset link invalid"
          subtitle="This password reset link is missing a token or has expired. Please request a new one."
        >
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-4 text-xs text-amber-200 leading-relaxed">
            <Icon icon="solar:danger-triangle-bold" width={20} className="text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-amber-300">Missing recovery token</p>
              <p className="mt-1 text-zinc-300">
                Reset links can only be used once and expire after 1 hour. Request a fresh link to continue.
              </p>
            </div>
          </div>

          <Link
            href="/auth/forgot-password"
            className="group inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-white px-5 text-[15px] font-semibold text-zinc-950 transition hover:bg-zinc-200"
          >
            Request new reset link
            <Icon icon="solar:arrow-right-linear" width={16} className="transition-transform group-hover:translate-x-0.5" />
          </Link>

          <div className="mt-7 pt-6 border-t border-white/[0.06] text-center">
            <Link
              href="/auth/login"
              className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors font-medium inline-flex items-center gap-1"
            >
              Back to sign in
            </Link>
          </div>
        </AuthCard>

        <AuthFooterNote />
      </AuthChrome>
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const newErrors: { password?: string; confirm?: string } = {}

    if (!password) {
      newErrors.password = 'Password is required'
    } else if (password.length < 8) {
      newErrors.password = 'Password must be at least 8 characters'
    }

    if (!confirm) {
      newErrors.confirm = 'Please confirm your password'
    } else if (password !== confirm) {
      newErrors.confirm = 'Passwords do not match'
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }

    setErrors({})
    setIsSubmitting(true)
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const data = await res.json()

      if (!res.ok) {
        setErrors({ password: data.error || 'Failed to reset password' })
        return
      }

      setSuccess(true)
      setTimeout(() => router.push('/auth/login'), 2000)
    } catch {
      setErrors({ password: 'Network error. Please try again.' })
    } finally {
      setIsSubmitting(false)
    }
  }

  if (success) {
    return (
      <AuthChrome>
        <AuthCard
          eyebrow="Success"
          title="Password updated"
          subtitle="Your password has been changed successfully. Redirecting you to sign in..."
        >
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-4 text-xs text-emerald-200 leading-relaxed">
            <Icon icon="solar:check-circle-bold" width={20} className="text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-emerald-300">All set!</p>
              <p className="mt-1 text-zinc-300">
                You can now sign in with your new password.
              </p>
            </div>
          </div>

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

  return (
    <AuthChrome>
      <AuthCard
        eyebrow="Security"
        title="Set a new password"
        subtitle="Make sure your new password is at least 8 characters long."
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 mb-5">
          <FieldLabel htmlFor="password">New password</FieldLabel>
          <FieldInput
            id="password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            disabled={isSubmitting}
            error={errors.password}
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
            type={showConfirm ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Repeat your new password"
            disabled={isSubmitting}
            error={errors.confirm}
            trailing={
              <button
                type="button"
                onClick={() => setShowConfirm((s) => !s)}
                className="text-zinc-500 hover:text-zinc-300 transition-colors"
                aria-label={showConfirm ? 'Hide password' : 'Show password'}
              >
                <Icon icon={showConfirm ? 'ri:eye-off-line' : 'ri:eye-line'} width={16} />
              </button>
            }
          />

          <PrimaryButton type="submit" disabled={isSubmitting} loading={isSubmitting}>
            {isSubmitting ? 'Updating password…' : 'Reset password'}
          </PrimaryButton>
        </form>

        <div className="mt-7 pt-6 border-t border-white/[0.06] text-center">
          <Link
            href="/auth/login"
            className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors font-medium inline-flex items-center gap-1"
          >
            <Icon
              icon="solar:alt-arrow-down-linear"
              width={12}
              className="rotate-90 text-zinc-500"
            />
            Back to sign in
          </Link>
        </div>
      </AuthCard>

      <AuthFooterNote />
    </AuthChrome>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<GlobalLoading />}>
      <ResetPasswordForm />
    </Suspense>
  )
}
