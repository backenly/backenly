'use client'

import Link from 'next/link'
import { Icon } from '@iconify/react'
import { BrandMark } from '@/components/site/BrandMark'

/* ─────────────────────────────────────────────────────────────
   Shared auth-page chrome.
   Used by app/auth/login/page.tsx and app/auth/signup/page.tsx.
   Design language is kept in lockstep with the marketing landing
   page (app/page.tsx): flat controls, a zinc palette, a mono pill
   eyebrow, and violet reserved for focus/attention. A slim
   premium-gradient brand panel (logo only) on the left, a wide dark
   auth column with a clean centered form on the right.
───────────────────────────────────────────────────────────── */

export function AuthChrome({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="bg-[#0a0a0c] text-white antialiased relative min-h-screen overflow-x-hidden selection:bg-violet-500/30 selection:text-white flex"
      style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}
    >
      {/* ── Left: slim premium-gradient brand panel — logo only (lg+) ── */}
      <AuthBrandPanel />

      {/* ── Right: wide dark auth column with centered form ── */}
      <div className="relative z-20 ml-auto flex w-full flex-col overflow-hidden bg-[#0a0a0c] px-5 py-8 sm:px-8 lg:w-[70%] lg:px-12 lg:py-10">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute right-[-18%] top-[10%] h-[460px] w-[460px] rounded-full bg-white/[0.04] blur-[130px]" />
          <div className="absolute bottom-[-22%] left-[26%] h-[360px] w-[360px] rounded-full bg-indigo-400/[0.04] blur-[120px]" />
          <div className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(to_right,transparent,rgba(255,255,255,0.18),transparent)]" />
        </div>

        {/* Wordmark — only on mobile, where the brand panel is hidden */}
        <Link href="/" aria-label="Backenly" className="relative z-10 flex items-center gap-2.5 self-start lg:hidden">
          <BrandMark size={24} />
          <span className="text-[15px] font-semibold tracking-tighter text-white lowercase">
            backenly
          </span>
        </Link>

        <div className="relative z-10 flex flex-1 flex-col items-center justify-center py-10">
          <div className="flex w-full max-w-[420px] flex-col items-center">{children}</div>
        </div>
      </div>
    </div>
  )
}

function AuthBrandPanel() {
  return (
    <div className="relative z-20 hidden lg:flex lg:w-[30%] items-center justify-center overflow-hidden bg-gradient-to-br from-violet-500 via-violet-700 to-indigo-900">
      {/* Layered translucent shapes for a premium, dimensional gradient */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_28%_18%,rgba(255,255,255,0.22),transparent_55%)]" />
        <div className="absolute -top-32 -right-24 h-[360px] w-[360px] rotate-[24deg] rounded-[80px] bg-white/10 blur-2xl" />
        <div className="absolute top-1/3 -left-40 h-[520px] w-[520px] rounded-full bg-white/[0.06] blur-[120px]" />
        <div className="absolute -bottom-40 -right-20 h-[460px] w-[460px] rounded-full bg-fuchsia-500/25 blur-[130px]" />
      </div>

      {/* Seam highlight */}
      <div aria-hidden className="pointer-events-none absolute right-0 top-0 h-full w-px bg-white/10" />

      {/* Centered logo + wordmark */}
      <Link href="/" aria-label="Backenly" className="relative z-10 flex items-center gap-3">
        <BrandMark size={40} />
        <span className="text-[28px] font-semibold tracking-tighter text-white lowercase">backenly</span>
      </Link>
    </div>
  )
}

export function AuthCard({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow?: string
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div className="w-full">
      <div className="mb-8 flex flex-col items-center text-center">
        {eyebrow && (
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5">
            <span className="h-1 w-1 rounded-full bg-violet-400" aria-hidden />
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-400">
              {eyebrow}
            </span>
          </div>
        )}
        <h1 className="text-[30px] font-semibold leading-[1.05] tracking-tight text-white md:text-[34px]">
          {title}
        </h1>
        <p className="mx-auto mt-3 max-w-[340px] text-[15px] leading-6 text-zinc-400">
          {subtitle}
        </p>
      </div>
      {children}
    </div>
  )
}

export function AuthFooterNote() {
  return (
    <p className="mt-7 max-w-[360px] text-center text-[11px] text-zinc-500">
      Secured with industry-standard encryption.{' '}
      <Link href="/terms" className="text-zinc-300 transition-colors hover:text-white">
        Terms
      </Link>
      {' · '}
      <Link href="/privacy" className="text-zinc-300 transition-colors hover:text-white">
        Privacy
      </Link>
    </p>
  )
}

/* Shared control geometry — kept identical across every button so the
   stack reads as one system (matches the landing page CTAs). */
const CONTROL_BASE =
  'group inline-flex h-12 w-full items-center justify-center gap-2.5 rounded-lg px-5 text-[15px] font-semibold transition duration-200 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0c]'

export function OAuthButton({
  onClick,
  variant,
  children,
}: {
  onClick: () => void
  variant: 'light' | 'dark'
  children: React.ReactNode
}) {
  if (variant === 'light') {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${CONTROL_BASE} bg-white text-zinc-950 shadow-[0_12px_40px_-16px_rgba(255,255,255,0.35)] hover:bg-zinc-200`}
      >
        {children}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${CONTROL_BASE} border border-white/[0.12] bg-white/[0.03] text-white hover:border-white/25 hover:bg-white/[0.06]`}
    >
      {children}
    </button>
  )
}

export function EmailOptionButton({
  onClick,
  icon = 'solar:letter-linear',
  children,
}: {
  onClick: () => void
  icon?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${CONTROL_BASE} border border-white/[0.12] bg-white/[0.03] text-white hover:border-white/25 hover:bg-white/[0.06]`}
    >
      <Icon icon={icon} width={17} className="text-violet-300" />
      {children}
    </button>
  )
}

export function Divider({ label }: { label: string }) {
  return (
    <div className="relative my-5">
      <div className="absolute inset-0 flex items-center">
        <div className="h-px w-full bg-white/[0.07]" />
      </div>
      <div className="relative flex justify-center">
        <span className="bg-[#0a0a0c] px-3 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
          {label}
        </span>
      </div>
    </div>
  )
}

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-400"
    >
      {children}
    </label>
  )
}

export function FieldInput({
  id,
  type,
  value,
  onChange,
  placeholder,
  disabled,
  error,
  trailing,
  helper,
}: {
  id: string
  type: string
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
  disabled?: boolean
  error?: string
  trailing?: React.ReactNode
  helper?: string
}) {
  return (
    <div>
      <div
        className={`flex h-12 items-center gap-2 rounded-lg border bg-[#0c0c0e] px-4 transition-all focus-within:border-violet-400/50 focus-within:bg-[#101013] focus-within:shadow-[0_0_0_3px_rgba(139,92,246,0.16)] ${
          error ? 'border-rose-500/50' : 'border-white/[0.1]'
        }`}
      >
        <input
          id={id}
          type={type}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          disabled={disabled}
          className="flex-1 bg-transparent text-[15px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:opacity-50"
        />
        {trailing}
      </div>
      {error ? (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-rose-300">
          <Icon icon="solar:shield-warning-linear" width={12} />
          {error}
        </p>
      ) : helper ? (
        <p className="mt-1.5 text-[11px] text-zinc-500">{helper}</p>
      ) : null}
    </div>
  )
}

export function PrimaryButton({
  type,
  disabled,
  loading,
  onClick,
  children,
}: {
  type?: 'button' | 'submit'
  disabled?: boolean
  loading?: boolean
  onClick?: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type={type || 'button'}
      disabled={disabled}
      onClick={onClick}
      className={`${CONTROL_BASE} mt-2 bg-white text-zinc-950 shadow-[0_12px_40px_-16px_rgba(255,255,255,0.35)] hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-white`}
    >
      {loading && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-950/25 border-t-zinc-950" />
      )}
      {children}
    </button>
  )
}

export function GoogleSvg() {
  return (
    <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  )
}
