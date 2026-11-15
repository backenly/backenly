'use client'

import Link from 'next/link'
import { Icon } from '@iconify/react'
import { BrandMark } from '@/components/site/BrandMark'
import { ClosingLight } from '@/components/landing-v8/ClosingLight'
import { openCookiePreferences } from '@/lib/consent'

/* ─────────────────────────────────────────────────────────────
   Shared auth-page chrome.
   Used by app/auth/login, app/auth/signup and app/auth/forgot-password, and
   by Backenly Cloud's invite and Enterprise sign-in pages.

   2026-11-15, third pass (founders: "everything except the signup and sign
   in is perfect"). Two split layouts were tried and dropped: a brand panel
   beside a form lost in a wide empty field, then a form column beside a
   dense product slide that competed with it. Now the page does one thing,
   the way Vercel, Linear and Clerk set theirs: one framed form, centred on
   black, with the landing's own dawn low behind it (the horizon the landing
   ends on, just before "Start free"), dimmed so it stays a backdrop. The
   logo sits top left, Terms and Privacy at the foot; fields and buttons are
   44px with the landing's corners and a white focus ring.
───────────────────────────────────────────────────────────── */

const YEAR = new Date().getFullYear()

export function AuthChrome({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative isolate flex min-h-screen flex-col overflow-hidden bg-[#08090a] text-white antialiased selection:bg-violet-500/30 selection:text-white"
      style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}
    >
      {/* The landing's closing dawn, held at the foot of the screen and dimmed. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[560px] opacity-[0.5]">
        <div className="relative h-full">
          <ClosingLight />
        </div>
      </div>

      <div className="flex items-center px-5 pt-6 sm:px-8 sm:pt-8 lg:px-12">
        <Link
          href="/"
          className="flex w-fit items-center gap-[10px] rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <BrandMark size={28} decorative />
          <span className="text-[17px] font-medium tracking-[-0.02em] text-white">Backenly</span>
        </Link>
      </div>

      {/* The page's one main landmark, so assistive tech can jump straight to the form. */}
      <main id="main-content" className="flex flex-1 items-center justify-center px-4 py-10 sm:py-14">
        <div className="w-full max-w-[420px] rounded-[10px] border border-white/[0.10] bg-[#0b0c0f] px-[24px] py-[32px] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_40px_80px_-30px_rgba(0,0,0,0.9)] sm:px-[36px] sm:py-[40px]">
          {children}
        </div>
      </main>

      <p className="flex items-center justify-center gap-x-[16px] pb-[28px] text-[12.5px] text-zinc-300">
        <span>© {YEAR} Backenly</span>
        <Link href="/terms" className="rounded-[3px] transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">
          Terms
        </Link>
        <Link href="/privacy" className="rounded-[3px] transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">
          Privacy
        </Link>
        <button
          type="button"
          onClick={openCookiePreferences}
          className="rounded-[3px] transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          Cookies
        </button>
      </p>
    </div>
  )
}

export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div className="w-full">
      <div className="mb-[28px] text-center">
        <h1 className="text-[26px] font-normal leading-[1.12] tracking-[-0.03em] text-white [text-wrap:balance] sm:text-[28px]">{title}</h1>
        <p className="mx-auto mt-[10px] max-w-[40ch] text-[14.5px] leading-[1.6] text-zinc-400 [text-wrap:balance]">{subtitle}</p>
      </div>
      {children}
    </div>
  )
}

/** Terms and Privacy now sit in the chrome's own footer (AuthChrome); kept so existing pages keep compiling. */
export function AuthFooterNote() {
  return null
}

/* Shared control geometry — kept identical across every button so the
   stack reads as one system (matches the landing page CTAs). */
const CONTROL_BASE =
  'group inline-flex h-[44px] w-full items-center justify-center gap-2.5 rounded-[6px] px-5 text-[15px] font-medium tracking-[-0.01em] transition duration-150 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c0f]'

export function OAuthButton({
  onClick,
  variant,
  children,
}: {
  onClick: () => void
  variant: 'light' | 'dark'
  children: React.ReactNode
}) {
  // 'light' was a white Google button; both providers are now outlined, so the
  // one white button on the page is the form's own action. The prop stays for callers.
  void variant
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
        <span className="bg-[#0b0c0f] px-3 text-[13px] text-faint">{label}</span>
      </div>
    </div>
  )
}

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="-mb-1 text-[13.5px] font-medium tracking-[-0.006em] text-zinc-200"
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
  inputMode,
  autoComplete,
  maxLength,
  autoFocus,
  className,
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
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
  autoComplete?: string
  maxLength?: number
  autoFocus?: boolean
  /** Extra classes for the input itself, e.g. the wide tracking of a code. */
  className?: string
}) {
  return (
    <div>
      <div
        className={`flex h-[44px] items-center gap-2 rounded-[8px] border bg-white/[0.02] px-[14px] transition-[border-color,box-shadow,background-color] duration-150 focus-within:border-white/30 focus-within:bg-white/[0.035] focus-within:shadow-[0_0_0_3px_rgba(255,255,255,0.08)] ${
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
          inputMode={inputMode}
          autoComplete={autoComplete}
          maxLength={maxLength}
          autoFocus={autoFocus}
          className={`flex-1 bg-transparent text-[15px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:opacity-50 ${className ?? ''}`}
        />
        {trailing}
      </div>
      {error ? (
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-rose-300">
          <Icon icon="solar:shield-warning-linear" width={12} />
          {error}
        </p>
      ) : helper ? (
        <p className="mt-1.5 text-[12.5px] text-faint [text-wrap:pretty]">{helper}</p>
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
      className={`${CONTROL_BASE} mt-2 bg-white text-zinc-950 hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-white`}
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
