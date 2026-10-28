'use client'

/**
 * The console tour: a handful of spotlight stops, shown ONCE per user, that
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
 *
 * A user whose coding agent is already connected is not told to connect it:
 * the Connect stop is dropped and the tour ends on Done. The answer is the top
 * bar's (lib/hooks/useAgentConnection.ts), read as it stands when the tour
 * starts rather than asked for again.
 *
 * Motion. The spotlight and the card travel on one spring, so moving between
 * stops reads as one camera move rather than a card blinking out and back in
 * somewhere else. The spotlight closes onto the first target; each arrival is
 * marked once (corner ticks settle, one ring goes out); the card's scene
 * (TourScenes.tsx) and copy cross over in the direction of travel. It holds to
 * components/console/tokens.ts: monochrome, violet only on the focus ring, no
 * uppercase eyebrow, counts in Geist. Under reduced motion every move is
 * instant and the scenes hold still.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useRouter } from 'next/navigation'
import { AnimatePresence, motion, useIsPresent, useReducedMotion, type Variants } from 'framer-motion'
import { ArrowRight, X } from 'lucide-react'
import { placeTooltip, type Box, type Side } from '@/lib/tours/placement'
import { readAgentConnection } from '@/lib/hooks/useAgentConnection'
import { BUTTON_BASE, BUTTON_SIZES, BUTTON_VARIANTS } from '@/components/inspector/kit'
import { FLOAT, FOCUS, R_PANEL, RAISE } from '@/components/console/tokens'
import { TourScene, type SceneName } from './TourScenes'

const TOUR_ID = 'console'
const LOCAL_KEY = 'backenly_tour_console'
const START_DELAY_MS = 900
const MIN_WIDTH = 1024
const CARD_WIDTH = 360
/** About what the card measures. Places the first frame, before the real height is known. */
const CARD_HEIGHT_GUESS = 316
const PAD = 6
const GAP = 16
const EXIT_MS = 200

/** One spring for everything that travels, so the spotlight and the card arrive together. */
const GLIDE = { type: 'spring', stiffness: 300, damping: 34, mass: 0.9 } as const
/** The console's easing curve (tailwind.config.ts `ease-linear`). */
const EASE = [0.16, 1, 0.3, 1] as const
const INSTANT = { duration: 0 } as const

interface Step {
  target: string
  side: Side
  scene: SceneName
  title: string
  body: string
}

/**
 * Five stops, in the order a new user needs them. Each sentence is held to
 * what the product does: MCP keys are project-scoped and shown once; publishing
 * records a version (app/app/projects/[id]/deploy), and a publish an agent
 * requests is parked for a human (lib/mcp/domains.ts); auth, destructive and
 * irreversible changes always wait for approval (lib/autonomy/autonomy-level.ts).
 */
export const CONSOLE_TOUR: Step[] = [
  {
    target: 'connect-agent',
    side: 'bottom',
    scene: 'connect',
    title: 'Connect your coding agent',
    body: 'Your agent builds this backend over MCP. Create a project-scoped key here and copy the install command for Claude Code, Cursor, Codex or Antigravity.',
  },
  {
    target: 'nav-database',
    side: 'right',
    scene: 'database',
    title: 'Everything your agent builds lands here',
    body: 'Tables, rows and access policies appear as your agent creates them. Review the schema and edit data whenever you need to.',
  },
  {
    target: 'nav-deploy',
    side: 'right',
    scene: 'publish',
    title: 'Publish when it’s ready',
    body: 'Publishing records a version of your backend and marks it live. Your agent can ask to publish; the request waits for your approval.',
  },
  {
    target: 'nav-autonomy',
    side: 'right',
    scene: 'autopilot',
    title: 'Backenly keeps it healthy',
    body: 'Backenly checks your backend continuously and applies safe, reversible fixes within the level you set here. Anything risky waits for you.',
  },
  {
    target: 'review-inbox',
    side: 'bottom',
    scene: 'approvals',
    title: 'Changes waiting on you',
    body: 'Auth, destructive and irreversible changes are held here until you approve them. Nothing like that ships on its own.',
  },
]

/** The card arrives from its target's side: from above when it sits below the target, and so on. */
const ARRIVE_FROM: Record<Side, { x: number; y: number }> = {
  bottom: { x: 0, y: -6 },
  top: { x: 0, y: 6 },
  right: { x: -6, y: 0 },
  left: { x: 6, y: 0 },
}

/** The card's scene and copy cross over in the direction of travel. */
function crossover(still: boolean): Variants {
  if (still) return { enter: { opacity: 0 }, shown: { opacity: 1 }, leave: { opacity: 0 } }
  return {
    enter: (dir: number) => ({ opacity: 0, x: 12 * dir }),
    shown: { opacity: 1, x: 0, transition: { duration: 0.32, ease: EASE } },
    leave: (dir: number) => ({ opacity: 0, x: -12 * dir, transition: { duration: 0.18, ease: EASE } }),
  }
}

const targetEl = (name: string) => document.querySelector<HTMLElement>(`[data-tour="${name}"]`)

const grow = (box: Box, by: number): Box => ({
  top: box.top - by,
  left: box.left - by,
  width: box.width + by * 2,
  height: box.height + by * 2,
})

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
  const still = !!useReducedMotion()
  const [steps, setSteps] = useState<Step[] | null>(null)
  // False from the moment the tour is dismissed. The layer is then hidden from
  // assistive technology and lets clicks through, fades, and unmounts.
  const [open, setOpen] = useState(false)
  const [agentConnected, setAgentConnected] = useState(false)
  const [index, setIndex] = useState(0)
  // Which way the last move went, so the card's contents slide with it.
  const [direction, setDirection] = useState<1 | -1>(1)
  // Set by the first move. The arriving step is announced from then on; the
  // first one is announced by focus landing on the dialog.
  const [moved, setMoved] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [cardHeight, setCardHeight] = useState(0)
  const [copyHeight, setCopyHeight] = useState<number | 'auto'>('auto')
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const cardRef = useRef<HTMLDivElement>(null)
  const finished = useRef(false)
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
          // Still unknown here means the top bar has not heard back: keep the
          // Connect stop, since a new user is who it is for.
          const connected = !!projectId && readAgentConnection(projectId).status === 'connected'
          const present = CONSOLE_TOUR.filter(
            (s) => targetEl(s.target) && !(connected && s.target === 'connect-agent'),
          )
          if (present.length > 0) {
            setAgentConnected(connected)
            setSteps(present)
            setOpen(true)
          }
        }, START_DELAY_MS)
      })
      .catch(() => {
        /* unsure means do not show */
      })
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [projectId])

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
  // Once: the button that closed the tour keeps focus while the card fades,
  // and a second Enter on it must not post again.
  const finish = useCallback(() => {
    if (finished.current) return
    finished.current = true
    markSeenLocally()
    setOpen(false)
    fetch('/api/tours', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tourId: TOUR_ID }),
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (open || !steps) return
    const timer = setTimeout(() => setSteps(null), still ? 0 : EXIT_MS)
    return () => clearTimeout(timer)
  }, [open, steps, still])

  const last = !!steps && index === steps.length - 1
  const next = useCallback(() => {
    if (!steps) return
    if (index < steps.length - 1) {
      setDirection(1)
      setMoved(true)
      setIndex(index + 1)
    } else finish()
  }, [steps, index, finish])
  const back = useCallback(() => {
    if (index === 0) return
    setDirection(-1)
    setMoved(true)
    setIndex(index - 1)
  }, [index])
  const connect = useCallback(() => {
    finish()
    router.push(`/app/projects/${projectId}/connect`)
  }, [finish, router, projectId])

  // ── Keyboard + focus ───────────────────────────────────────────────────
  useEffect(() => {
    if (!step || !open) return
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
  }, [step, open, next, back, finish])

  if (!steps || !step || !rect || typeof document === 'undefined') return null

  const spot: Box = {
    top: rect.top - PAD,
    left: rect.left - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  }
  const place = placeTooltip(
    spot,
    { width: CARD_WIDTH, height: cardHeight || CARD_HEIGHT_GUESS },
    viewport,
    step.side,
    GAP,
  )
  const variants = crossover(still)
  const button = `${BUTTON_BASE} ${BUTTON_SIZES.sm}`

  return createPortal(
    <motion.div
      className={`fixed inset-0 z-[70] ${open ? '' : 'pointer-events-none'}`}
      aria-live="off"
      aria-hidden={open ? undefined : true}
      initial={false}
      animate={{ opacity: open ? 1 : 0 }}
      transition={still ? INSTANT : { duration: EXIT_MS / 1000, ease: EASE }}
    >
      {/* Clicks outside the card do nothing: the tour is short, and a stray
          click should not end it before the user has read it. */}
      <div className="absolute inset-0" aria-hidden />

      <Spotlight spot={spot} target={step.target} still={still} />

      {/* Placement rides on transforms so the glide stays off layout. */}
      <motion.div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        className="absolute left-0 top-0 focus:outline-none"
        style={{ width: CARD_WIDTH }}
        initial={{ x: place.left, y: place.top }}
        animate={{ x: place.left, y: place.top }}
        transition={still ? INSTANT : GLIDE}
      >
        <motion.div
          className={`overflow-hidden ${R_PANEL} ${RAISE} ${FLOAT}`}
          initial={still ? false : { opacity: 0, scale: 0.97, ...ARRIVE_FROM[place.side] }}
          animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
          transition={still ? INSTANT : { duration: 0.34, delay: 0.12, ease: EASE }}
        >
          {/* ── Scene ── */}
          <div className="relative h-[132px] border-b border-white/[0.06] bg-[#0a0b0d]">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.07)_1px,transparent_1px)] [background-size:12px_12px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_78%)]"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-[20%] top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.28),transparent)]"
            />
            <AnimatePresence custom={direction}>
              <motion.div
                key={step.scene}
                className="absolute inset-0"
                custom={direction}
                variants={variants}
                initial="enter"
                animate="shown"
                exit="leave"
              >
                <TourScene name={step.scene} still={still} projectId={projectId} />
              </motion.div>
            </AnimatePresence>
          </div>

          {/* ── Copy ── the box eases to each step's height rather than snapping.
              Close sits on the copy, not the scene, so no picture runs under it. */}
          <div className="relative">
            <motion.div
              className="overflow-hidden"
              initial={false}
              animate={{ height: copyHeight }}
              transition={still ? INSTANT : { duration: 0.32, ease: EASE }}
            >
              <div className="grid">
                <AnimatePresence custom={direction}>
                  <motion.div
                    key={step.target}
                    className="col-start-1 row-start-1"
                    custom={direction}
                    variants={variants}
                    initial="enter"
                    animate="shown"
                    exit="leave"
                  >
                    <StepCopy step={step} titleId={titleId} bodyId={bodyId} onHeight={setCopyHeight} />
                  </motion.div>
                </AnimatePresence>
              </div>
            </motion.div>
            <button
              type="button"
              onClick={finish}
              aria-label="Close the tour"
              className={`absolute right-3 top-3 inline-flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 ${FOCUS}`}
            >
              <X className="h-[14px] w-[14px]" aria-hidden />
            </button>
          </div>
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {moved ? `${step.title}. ${step.body}` : ''}
          </p>

          {/* ── Footer ── */}
          <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-4 py-3">
            <div className="flex items-center gap-2.5">
              <Progress count={steps.length} index={index} still={still} />
              <span className="whitespace-nowrap text-[12px] tabular-nums text-faint">
                {index + 1} of {steps.length}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {index === 0 ? (
                <button type="button" onClick={finish} className={`${button} ${BUTTON_VARIANTS.ghost}`}>
                  Skip tour
                </button>
              ) : (
                <button type="button" onClick={back} className={`${button} ${BUTTON_VARIANTS.ghost}`}>
                  Back
                </button>
              )}
              {last && projectId && !agentConnected ? (
                <button type="button" onClick={connect} className={`group ${button} ${BUTTON_VARIANTS.primary}`}>
                  Connect your agent
                  <ArrowRight className="h-[13px] w-[13px] transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
                </button>
              ) : (
                <button type="button" onClick={next} className={`group ${button} ${BUTTON_VARIANTS.primary}`}>
                  {last ? 'Done' : 'Next'}
                  {!last && (
                    <ArrowRight className="h-[13px] w-[13px] transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
                  )}
                </button>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </motion.div>,
    document.body,
  )
}

/**
 * The step's title and sentence. While a step leaves it keeps its words on
 * screen for the crossover but gives up the dialog's name and description, so
 * the dialog is always named after the step arriving.
 */
function StepCopy({
  step,
  titleId,
  bodyId,
  onHeight,
}: {
  step: Step
  titleId: string
  bodyId: string
  onHeight: (height: number) => void
}) {
  const isPresent = useIsPresent()
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !isPresent) return
    const report = () => {
      if (el.offsetHeight > 0) onHeight(el.offsetHeight)
    }
    report()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [isPresent, onHeight])

  // The padding is measured with the words: the box around them animates to this height.
  return (
    <div ref={ref} aria-hidden={isPresent ? undefined : true} className="px-4 pb-4 pt-[14px]">
      <h2
        id={isPresent ? titleId : undefined}
        className="pr-8 text-[15px] font-semibold leading-[22px] tracking-[-0.012em] text-zinc-50"
      >
        {step.title}
      </h2>
      <p id={isPresent ? bodyId : undefined} className="mt-1.5 text-[13px] leading-[20px] text-zinc-400">
        {step.body}
      </p>
    </div>
  )
}

/**
 * The page dims everywhere except the thing being explained. The hole closes
 * onto the first target from a wider ring and then glides from stop to stop.
 */
function Spotlight({ spot, target, still }: { spot: Box; target: string; still: boolean }) {
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute rounded-[10px]"
      style={{ boxShadow: '0 0 0 1px rgba(255,255,255,0.14), 0 0 0 9999px rgba(5, 6, 8, 0.7)' }}
      initial={still ? false : { ...grow(spot, 32), opacity: 0 }}
      animate={{ ...spot, opacity: 1 }}
      transition={still ? INSTANT : { ...GLIDE, opacity: { duration: 0.35, ease: EASE } }}
    >
      <Arrival key={target} still={still} />
    </motion.div>
  )
}

const CORNERS = [
  { at: '-left-[5px] -top-[5px] rounded-tl-[5px] border-l border-t', from: { x: -5, y: -5 } },
  { at: '-right-[5px] -top-[5px] rounded-tr-[5px] border-r border-t', from: { x: 5, y: -5 } },
  { at: '-bottom-[5px] -left-[5px] rounded-bl-[5px] border-b border-l', from: { x: -5, y: 5 } },
  { at: '-bottom-[5px] -right-[5px] rounded-br-[5px] border-b border-r', from: { x: 5, y: 5 } },
] as const

/**
 * Marks an arrival, once per stop: four corner ticks settle onto the spotlight
 * as it lands and a single ring goes out. It says "here" without a beacon that
 * keeps pulsing while the user reads.
 */
function Arrival({ still }: { still: boolean }) {
  return (
    <>
      {CORNERS.map((corner) => (
        <motion.span
          key={corner.at}
          className={`absolute h-[9px] w-[9px] border-white/[0.55] ${corner.at}`}
          initial={still ? false : { opacity: 0, ...corner.from }}
          animate={{ opacity: 1, x: 0, y: 0 }}
          transition={still ? INSTANT : { delay: 0.22, duration: 0.42, ease: EASE }}
        />
      ))}
      {!still && (
        <motion.span
          className="absolute inset-0 rounded-[10px]"
          initial={{ boxShadow: '0 0 0 0px rgba(255,255,255,0.28)' }}
          animate={{ boxShadow: '0 0 0 14px rgba(255,255,255,0)' }}
          transition={{ delay: 0.3, duration: 1.1, ease: EASE }}
        />
      )}
    </>
  )
}

/** One segment per stop: done ones dim, the current one fills as it arrives. */
function Progress({ count, index, still }: { count: number; index: number; still: boolean }) {
  return (
    <span className="flex items-center gap-[3px]" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="relative h-[3px] w-[12px] overflow-hidden rounded-full bg-white/[0.10]">
          <motion.span
            className="absolute inset-0 origin-left rounded-full bg-white"
            initial={still ? false : { scaleX: 0 }}
            animate={{ scaleX: i <= index ? 1 : 0, opacity: i < index ? 0.4 : 1 }}
            transition={still ? INSTANT : { duration: 0.5, ease: EASE }}
          />
        </span>
      ))}
    </span>
  )
}
