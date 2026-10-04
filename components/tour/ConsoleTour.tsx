'use client'

/**
 * The console tour: a handful of spotlight tooltips, shown ONCE per user, that
 * point at the few controls a new Backenly user has to understand. Not a
 * checklist and not a panel. It runs over the real console and then gets out of
 * the way for good.
 *
 * Once means once: finishing and skipping both write a row to
 * user_tours_seen (app/api/tours), so it does not return on the next login or
 * another device. localStorage mirrors it so a slow network cannot flash it
 * again in the same browser. If the server cannot say (table missing, request
 * failed), the tour does not run: an unsure answer is treated as "seen".
 *
 * Desktop only. The project console is a fixed-sidebar desktop layout, and a
 * tooltip pointing at a sidebar that is not there would teach nothing.
 *
 * Targets are marked in the shell with data-tour="…". A step whose target is
 * not on the page is dropped rather than pointed at empty space.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useRouter } from 'next/navigation'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, X } from 'lucide-react'
import { placeTooltip, type Placement, type Side } from '@/lib/tours/placement'

const TOUR_ID = 'console'
const LOCAL_KEY = 'backenly_tour_console'
const START_DELAY_MS = 900
const MIN_WIDTH = 1024
const CARD_WIDTH = 348
const PAD = 6

interface Step {
  target: string
  side: Side
  eyebrow: string
  title: string
  body: string
}

/**
 * Five stops, in the order a new user needs them. Each sentence is held to
 * what the product does: MCP keys are project-scoped and shown once; publishing
 * requested by an agent is parked for a human (lib/mcp/domains.ts); auth,
 * destructive and irreversible changes always wait for approval
 * (lib/autonomy/autonomy-level.ts).
 */
export const CONSOLE_TOUR: Step[] = [
  {
    target: 'connect-agent',
    side: 'bottom',
    eyebrow: 'Start here',
    title: 'Connect your coding agent',
    body: 'Backenly is built through your coding agent over MCP. Generate a scoped key here and paste one prompt into Claude Code, Cursor, Codex or Cline.',
  },
  {
    target: 'nav-database',
    side: 'right',
    eyebrow: 'Your backend',
    title: 'Everything your agent builds lands here',
    body: 'Tables, rows and access policies appear as your agent creates them. Review the schema and edit data whenever you need to.',
  },
  {
    target: 'nav-deploy',
    side: 'right',
    eyebrow: 'Go live',
    title: 'Publish when it’s ready',
    body: 'Publishing gives your app a stable, versioned endpoint. Your agent can ask to publish; the request waits for your approval.',
  },
  {
    target: 'nav-autonomy',
    side: 'right',
    eyebrow: 'After you publish',
    title: 'Backenly keeps it healthy',
    body: 'Backenly checks your backend continuously and applies safe, reversible fixes within the level you set here. Anything risky waits for you.',
  },
  {
    target: 'review-inbox',
    side: 'bottom',
    eyebrow: 'Your approvals',
    title: 'Changes waiting on you',
    body: 'Auth, destructive and irreversible changes are held here until you approve them. Nothing like that ships on its own.',
  },
]

const targetEl = (name: string) => document.querySelector<HTMLElement>(`[data-tour="${name}"]`)

function markSeenLocally() {
  try {
    localStorage.setItem(LOCAL_KEY, 'seen')
  } catch {
    /* storage blocked: the server row still holds */
  }
}

function seenLocally(): boolean {
  try {
    return localStorage.getItem(LOCAL_KEY) === 'seen'
  } catch {
    return false
  }
}

export function ConsoleTour() {
  const router = useRouter()
  const params = useParams()
  const projectId = params?.id as string | undefined
  const reduceMotion = useReducedMotion()
  const [steps, setSteps] = useState<Step[] | null>(null)
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [cardHeight, setCardHeight] = useState(0)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const cardRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const bodyId = useId()

  // ── Decide once whether to run ─────────────────────────────────────────
  useEffect(() => {
    if (seenLocally() || window.innerWidth < MIN_WIDTH) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    fetch('/api/tours', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { available?: boolean; seen?: string[] } | null) => {
        if (cancelled || !data?.available) return
        if (data.seen?.includes(TOUR_ID)) {
          markSeenLocally()
          return
        }
        // Let the page settle so the first spotlight lands on a painted target.
        timer = setTimeout(() => {
          if (cancelled || window.innerWidth < MIN_WIDTH) return
          const present = CONSOLE_TOUR.filter((s) => targetEl(s.target))
          if (present.length > 0) setSteps(present)
        }, START_DELAY_MS)
      })
      .catch(() => {
        /* unsure means do not show */
      })
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const step = steps?.[index] ?? null

  // ── Follow the target ──────────────────────────────────────────────────
  const measure = useCallback(() => {
    if (!step) return
    const el = targetEl(step.target)
    setViewport({ width: window.innerWidth, height: window.innerHeight })
    setRect(el ? el.getBoundingClientRect() : null)
  }, [step])

  useLayoutEffect(() => {
    if (!step) return
    targetEl(step.target)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    // Next frame: after the scroll above has moved the target into place.
    const frame = requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [step, measure])

  // The card's height decides whether it fits above or below its target, and
  // copy lengths differ per step, so it is observed rather than assumed.
  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setCardHeight(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [step, rect])

  // ── Finish, from any exit ──────────────────────────────────────────────
  const finish = useCallback(() => {
    markSeenLocally()
    setSteps(null)
    fetch('/api/tours', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tourId: TOUR_ID }),
    }).catch(() => {})
  }, [])

  const last = !!steps && index === steps.length - 1
  const next = useCallback(() => {
    if (!steps) return
    if (index < steps.length - 1) setIndex(index + 1)
    else finish()
  }, [steps, index, finish])
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), [])

  // ── Keyboard + focus ───────────────────────────────────────────────────
  useEffect(() => {
    if (!step) return
    cardRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        next()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        back()
      } else if (e.key === 'Tab' && cardRef.current) {
        const items = Array.from(cardRef.current.querySelectorAll<HTMLElement>('button:not([disabled])'))
        if (items.length === 0) return
        const first = items[0]
        const lastItem = items[items.length - 1]
        if (e.shiftKey && (document.activeElement === first || document.activeElement === cardRef.current)) {
          e.preventDefault()
          lastItem.focus()
        } else if (!e.shiftKey && document.activeElement === lastItem) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [step, next, back, finish])

  if (!steps || !step || !rect || typeof document === 'undefined') return null

  const spot = {
    top: rect.top - PAD,
    left: rect.left - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  }
  const place: Placement = placeTooltip(spot, { width: CARD_WIDTH, height: cardHeight || 180 }, viewport, step.side)
  const ease = reduceMotion ? { duration: 0 } : { type: 'spring' as const, stiffness: 380, damping: 34 }
  const fade = reduceMotion ? { duration: 0 } : { duration: 0.18, ease: [0.16, 1, 0.3, 1] as const }

  return createPortal(
    <div className="fixed inset-0 z-[70]" aria-live="off">
      {/* Clicks outside the card do nothing: the tour is short, and a stray
          click should not end it before the user has read it. */}
      <div className="absolute inset-0" aria-hidden />

      {/* Spotlight: the page dims everywhere except the thing being explained. */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute rounded-lg ring-1 ring-violet-300/80"
        style={{ boxShadow: '0 0 0 9999px rgba(8, 9, 12, 0.62), 0 0 0 4px rgba(196, 181, 253, 0.16), 0 0 24px 2px rgba(196, 181, 253, 0.18)' }}
        initial={false}
        animate={spot}
        transition={ease}
      />

      {/* Keyed per step: the new card fades in where the spotlight lands. No
          exit animation, so moving on never waits for the old card to leave. */}
      <motion.div
        key={step.target}
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        initial={{ opacity: 0, y: place.side === 'bottom' ? -4 : place.side === 'top' ? 4 : 0, x: place.side === 'right' ? -4 : place.side === 'left' ? 4 : 0 }}
        animate={{ opacity: 1, x: 0, y: 0 }}
        transition={fade}
        className="absolute rounded-xl border border-white/[0.10] bg-[#1c1d23] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85),0_24px_64px_-24px_rgba(0,0,0,0.6)] focus:outline-none"
        style={{ top: place.top, left: place.left, width: CARD_WIDTH }}
      >
        <Arrow side={place.side} offset={place.arrow} />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-xl bg-gradient-to-r from-transparent via-violet-300/50 to-transparent"
        />

        <div className="px-4 pb-3 pt-3.5">
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-300/85">
              <span className="h-[5px] w-[5px] rounded-full bg-violet-300" aria-hidden />
              {step.eyebrow}
            </p>
            <button
              type="button"
              onClick={finish}
              aria-label="Close the tour"
              className="-mr-1.5 rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
          <h2 id={titleId} className="mt-2 text-[14px] font-semibold leading-snug tracking-[-0.01em] text-white">
            {step.title}
          </h2>
          <p id={bodyId} className="mt-1.5 text-[12.5px] leading-[1.6] text-zinc-400">
            {step.body}
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <span className="flex items-center gap-1" aria-hidden>
              {steps.map((s, i) => (
                <span
                  key={s.target}
                  className={`h-1 rounded-full transition-all duration-300 ${
                    i === index ? 'w-4 bg-violet-300' : i < index ? 'w-1.5 bg-violet-300/40' : 'w-1.5 bg-white/[0.12]'
                  }`}
                />
              ))}
            </span>
            <span className="whitespace-nowrap font-mono text-[10.5px] tabular-nums text-zinc-500">
              {index + 1} of {steps.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {index === 0 ? (
              <button
                type="button"
                onClick={finish}
                className="h-7 whitespace-nowrap rounded-md px-2.5 text-[11.5px] font-medium text-zinc-500 transition-colors hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40"
              >
                Skip tour
              </button>
            ) : (
              <button
                type="button"
                onClick={back}
                className="h-7 whitespace-nowrap rounded-md px-2.5 text-[11.5px] font-medium text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40"
              >
                Back
              </button>
            )}
            {last && projectId ? (
              <button
                type="button"
                onClick={() => {
                  finish()
                  router.push(`/app/projects/${projectId}/connect`)
                }}
                className="group inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md bg-white px-3 text-[11.5px] font-semibold text-black transition-colors hover:bg-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/50"
              >
                Connect your agent
                <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                onClick={next}
                className="group inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md bg-white px-3 text-[11.5px] font-semibold text-black transition-colors hover:bg-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/50"
              >
                {last ? 'Done' : 'Next'}
                {!last && <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden />}
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </div>,
    document.body,
  )
}

/** A square rotated into a pointer, drawn with the card's own border so it reads as one shape. */
function Arrow({ side, offset }: { side: Side; offset: number }) {
  const base = 'absolute h-2.5 w-2.5 rotate-45 border-white/[0.10] bg-[#1c1d23]'
  const pos: Record<Side, { cls: string; style: React.CSSProperties }> = {
    bottom: { cls: 'border-l border-t -top-[5.5px]', style: { left: offset - 5 } },
    top: { cls: 'border-b border-r -bottom-[5.5px]', style: { left: offset - 5 } },
    right: { cls: 'border-b border-l -left-[5.5px]', style: { top: offset - 5 } },
    left: { cls: 'border-r border-t -right-[5.5px]', style: { top: offset - 5 } },
  }
  return <span aria-hidden className={`${base} ${pos[side].cls}`} style={pos[side].style} />
}
