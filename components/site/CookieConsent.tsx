'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { Cookie, X } from 'lucide-react'
import {
  CONSENT_EVENT,
  globalPrivacyControl,
  PREFERENCES_EVENT,
  readConsent,
  saveConsent,
} from '@/lib/consent'

/* ─────────────────────────────────────────────────────────────
   Cookie consent (founders, 2026-11-15: "add a cookie preference ... pop up,
   not AI generated, a real professional one").

   A small card at the bottom left until a choice is made, and a preferences
   dialog that the card's "Customize" and the footer's "Cookie preferences"
   open. It is real: lib/consent.ts stores the choice, and ConsentGate keeps
   Amplitude from loading until analytics are allowed. Reject is as easy as
   accept (the same button, side by side). A browser that sends Global Privacy
   Control is treated as a no, and no card is shown to it.

   The words say only what is true: essential cookies keep you signed in;
   analytics is Amplitude, described the way the Privacy Policy's Analytics
   section describes it. There are no advertising cookies, so there is no such
   category.
───────────────────────────────────────────────────────────── */

type Choice = 'server' | 'unset' | 'yes' | 'no'

function subscribe(onChange: () => void) {
  window.addEventListener(CONSENT_EVENT, onChange)
  return () => window.removeEventListener(CONSENT_EVENT, onChange)
}

function snapshot(): Choice {
  const consent = readConsent()
  return consent ? (consent.analytics ? 'yes' : 'no') : 'unset'
}

const BUTTON =
  'inline-flex h-[36px] items-center justify-center rounded-[6px] px-[14px] text-[13.5px] font-medium tracking-[-0.006em] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c0f]'
const QUIET = `${BUTTON} border border-white/[0.14] bg-white/[0.04] text-zinc-100 hover:border-white/[0.24] hover:bg-white/[0.08]`
const SOLID = `${BUTTON} bg-white text-black hover:bg-zinc-200`
const TEXT_LINK =
  'rounded-[3px] text-zinc-200 underline decoration-white/30 underline-offset-[3px] transition-colors hover:text-white hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70'

export function CookieConsent() {
  const choice = useSyncExternalStore<Choice>(subscribe, snapshot, () => 'server')
  const [open, setOpen] = useState(false)
  // The switch inside the dialog; set from the stored choice each time the dialog opens.
  const [analyticsOn, setAnalyticsOn] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const analyticsId = useId()

  const openPreferences = () => {
    setAnalyticsOn(readConsent()?.analytics === true)
    setOpen(true)
  }

  // The footer's "Cookie preferences" (and anything else) asks through an event.
  useEffect(() => {
    const onAsk = () => {
      setAnalyticsOn(readConsent()?.analytics === true)
      setOpen(true)
    }
    window.addEventListener(PREFERENCES_EVENT, onAsk)
    return () => window.removeEventListener(PREFERENCES_EVENT, onAsk)
  }, [])

  // The native modal dialog keeps focus inside, makes the page behind it inert,
  // closes on Escape, and hands focus back to whatever opened it.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  const decide = (analytics: boolean) => {
    saveConsent(analytics)
    setOpen(false)
  }

  const showCard = choice === 'unset' && !globalPrivacyControl() && !open
  const cardRef = useRef<HTMLElement>(null)

  // While the card is up, nothing on the page stays hidden under it (WCAG 2.4.11; review of 2026-11-27): the page
  // gets the card's height as room at its end, so even the footer's last row can scroll clear, and a control that
  // takes keyboard focus behind the card is scrolled above it, for someone who tabs past the card without choosing.
  useEffect(() => {
    if (!showCard) return
    const root = document.documentElement
    const card = cardRef.current
    const room = () => {
      if (card) root.style.paddingBottom = `${card.offsetHeight + 24}px`
    }
    room()
    window.addEventListener('resize', room)
    const onFocus = (event: FocusEvent) => {
      const el = event.target
      if (!card || !(el instanceof Element) || card.contains(el)) return
      requestAnimationFrame(() => {
        const c = card.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        if (r.right > c.left && r.left < c.right && r.bottom > c.top - 8) window.scrollBy(0, r.bottom - c.top + 16)
      })
    }
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('focusin', onFocus)
      window.removeEventListener('resize', room)
      root.style.paddingBottom = ''
    }
  }, [showCard])

  return (
    <>
      {showCard && (
        <section
          ref={cardRef}
          aria-label="Cookie consent"
          className="cookie-card fixed inset-x-3 bottom-3 z-[35] rounded-[10px] border border-white/[0.12] bg-[#0b0c0f]/95 p-[14px] shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-md sm:inset-x-auto sm:bottom-6 sm:left-6 sm:w-[380px] sm:p-[20px]"
        >
          {/* A phone gets the short form, so the hero's Start free stays in view (review of 2026-11-27). */}
          <div className="hidden items-center gap-[10px] sm:flex">
            <Cookie aria-hidden className="h-[16px] w-[16px] text-zinc-300" strokeWidth={1.75} />
            <h2 className="text-[15px] font-medium tracking-[-0.01em] text-white">Cookies on Backenly</h2>
          </div>
          <p className="text-[13px] leading-[1.5] text-zinc-400 sm:mt-[10px] sm:text-[13.5px] sm:leading-[1.6]">
            <span className="sm:hidden">Cookies keep you signed in. Analytics only if you agree. </span>
            <span className="hidden sm:inline">We use cookies to keep you signed in and, with your permission, to understand how the site is used. </span>
            <Link href="/privacy#analytics" className={`whitespace-nowrap ${TEXT_LINK}`}>
              Privacy Policy
            </Link>
          </p>
          <div className="mt-[10px] flex flex-wrap items-center gap-[8px] sm:mt-[16px]">
            <button type="button" className={QUIET} onClick={() => decide(false)}>
              Reject all
            </button>
            <button type="button" className={QUIET} onClick={() => decide(true)}>
              Accept all
            </button>
            <button
              type="button"
              onClick={openPreferences}
              className="ml-auto rounded-[3px] px-[2px] text-[13.5px] font-medium text-zinc-300 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              Customize
            </button>
          </div>
        </section>
      )}

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onClose={() => setOpen(false)}
        className="m-auto w-[calc(100%-24px)] max-w-[520px] rounded-[10px] border border-white/[0.12] bg-[#0b0c0f] p-0 text-white shadow-[0_40px_120px_-30px_rgba(0,0,0,0.95)] backdrop:bg-black/70 backdrop:backdrop-blur-[2px]"
      >
        {open && (
          <div className="flex flex-col">
            <div className="flex items-start justify-between gap-4 px-[24px] pb-[4px] pt-[24px] sm:px-[28px] sm:pt-[28px]">
              <div>
                <h2 id={titleId} className="text-[20px] font-normal tracking-[-0.02em] text-white">
                  Cookie preferences
                </h2>
                <p className="mt-[8px] text-[14px] leading-[1.6] text-zinc-400">
                  Choose what Backenly may keep in your browser. You can change this any time from Cookie preferences at the foot of
                  every page.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="-mr-[6px] -mt-[2px] flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[6px] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <X aria-hidden className="h-[16px] w-[16px]" />
              </button>
            </div>

            <ul className="mx-[24px] mt-[20px] divide-y divide-white/[0.08] rounded-[8px] border border-white/[0.10] sm:mx-[28px]">
              <li className="p-[16px] sm:p-[18px]">
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-[14.5px] font-medium text-white">Essential</h3>
                  <span className="rounded-[6px] border border-white/[0.10] bg-white/[0.04] px-[8px] py-[3px] text-[12.5px] text-zinc-300">
                    Always on
                  </span>
                </div>
                <p className="mt-[6px] text-[13.5px] leading-[1.6] text-zinc-400">
                  Your sign-in session, security checks, and this choice. Backenly cannot work without them.
                </p>
              </li>
              <li className="p-[16px] sm:p-[18px]">
                <div className="flex items-center justify-between gap-4">
                  <h3 id={analyticsId} className="text-[14.5px] font-medium text-white">
                    Analytics
                  </h3>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={analyticsOn}
                    aria-labelledby={analyticsId}
                    onClick={() => setAnalyticsOn((on) => !on)}
                    className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c0f] ${
                      analyticsOn ? 'border-white bg-white' : 'border-white/[0.18] bg-white/[0.06]'
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`inline-block h-[16px] w-[16px] rounded-full transition-transform duration-150 motion-reduce:transition-none ${
                        analyticsOn ? 'translate-x-[18px] bg-black' : 'translate-x-[2px] bg-zinc-300'
                      }`}
                    />
                  </button>
                </div>
                <p className="mt-[6px] text-[13.5px] leading-[1.6] text-zinc-400">
                  Amplitude records page views and sessions, and clicks on the public website, tied to a browser identifier rather
                  than to your account. It receives the page that linked you here and your IP address, which it uses to estimate
                  your country and city. It never records what you type or your screen.
                </p>
              </li>
            </ul>

            <p className="mx-[24px] mt-[14px] text-[13px] leading-[1.6] text-faint sm:mx-[28px]">
              Backenly sets no advertising cookies.{' '}
              {globalPrivacyControl() && 'Your browser sends Global Privacy Control, so analytics stay off unless you turn them on here. '}
              <Link href="/privacy#analytics" className={TEXT_LINK}>
                Read the Privacy Policy
              </Link>
            </p>

            <div className="mt-[22px] flex flex-col-reverse gap-[8px] border-t border-white/[0.08] px-[24px] py-[18px] sm:flex-row sm:items-center sm:justify-end sm:px-[28px]">
              <button type="button" className={QUIET} onClick={() => decide(false)}>
                Reject all
              </button>
              <button type="button" className={QUIET} onClick={() => decide(true)}>
                Accept all
              </button>
              <button type="button" className={SOLID} onClick={() => decide(analyticsOn)}>
                Save choices
              </button>
            </div>
          </div>
        )}
      </dialog>
    </>
  )
}
