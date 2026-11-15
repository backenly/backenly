'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAnimate } from 'motion/react'
import { Check } from 'lucide-react'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'

/* ─────────────────────────────────────────────────────────────
   "Your schema restructures itself", as the plan it is (founders,
   2026-11-15; three designers in review). Repair, the box before, moves on
   its own because Backenly acts on its own; this one is still until a person
   approves, because nothing here runs without one.

   At rest it already reads whole: reviews' columns, with strips showing which
   sampled rows carry each one (the engine's real evidence: flagged_at,
   flag_reason and moderated_by "are filled in on the same rows"), the new
   table drawn dashed because it is only planned, and the plan in the
   console's own sentences (lib/structural-evolution/words.ts) with Approve.

   Approve runs the plan once: its lines light as each stage runs, three
   violet lines keep the columns in step, the moderation data fills its own
   table densely in ten batches (only reviews that carry moderation data are
   copied, as the engine does), and the reason becomes the measured verdict
   30 days on: moderation changes that locked all of reviews, 5 before, 0
   after. No speed claim: until the old columns go, the move only adds work.
   If a visitor never clicks, a pointer approves once per visit, never while
   the visitor's own pointer is in the figure.
───────────────────────────────────────────────────────────── */

const KEPT = ['id', 'movie_id', 'user_id', 'rating', 'body']
const MOVED = ['flagged_at', 'flag_reason', 'moderated_by']
const TICKS = 36
/** Sampled rows that carry moderation data: the same rows in all three columns. */
const SET = new Set([2, 7, 11, 16, 22, 27, 31])
const STAGES = ['Set up review_moderation', 'Keep it in step with reviews', 'Copy the existing moderation data', 'Check that it matches reviews', 'Open it to your apps']
/** When each stage lights, in ms after approval; the copy runs in ten batches from 800. */
const AT = [0, 450, 800, 1650, 2050]
const COPY_FROM = 800
const BATCH = 80
const VERDICT = 2500
const RUN_MARKS = [...AT, ...Array.from({ length: 10 }, (_, i) => COPY_FROM + (i + 1) * BATCH), VERDICT]

type Phase = 'waiting' | 'running' | 'done' | 'dismissed'

/** A column's strip: one bar per sampled row, lit where the row carries a value. */
function Strip({ lit, tone = 'zinc', filled }: { lit: (i: number) => boolean; tone?: 'zinc' | 'white' | 'violet'; filled?: boolean }) {
  const on = tone === 'violet' ? 'bg-violet-300' : tone === 'white' ? 'bg-zinc-100' : 'bg-zinc-500'
  return (
    <span aria-hidden className="flex h-[12px] min-w-0 flex-1 items-center justify-between overflow-hidden">
      {Array.from({ length: TICKS }, (_, i) => (
        <span key={i} className={`h-full w-[2px] shrink-0 rounded-[1px] transition-colors duration-150 ${lit(i) ? on : filled === false ? 'bg-transparent' : 'bg-white/[0.07]'}`} />
      ))}
    </span>
  )
}

function Row({ name, children, dim = false }: { name: string; children: React.ReactNode; dim?: boolean }) {
  return (
    <div className="flex h-[30px] items-center gap-[12px]">
      <span className={`w-[104px] shrink-0 truncate font-mono text-[12.5px] ${dim ? 'text-faint' : 'text-zinc-300'}`}>{name}</span>
      {children}
    </div>
  )
}

function Head({ name, meta }: { name: string; meta: React.ReactNode }) {
  return (
    <div className="flex h-[28px] items-center justify-between gap-[12px] border-b border-white/[0.08]">
      <span className="font-mono text-[13px] text-white">{name}</span>
      <span className="text-[12px] text-faint">{meta}</span>
    </div>
  )
}

export function RestructurePlan() {
  const quiet = useSettledReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const approveRef = useRef<HTMLButtonElement>(null)
  const [phase, setPhase] = useState<Phase>('waiting')
  const [t, setT] = useState(-1)
  const [pointer, setPointer] = useState(false)
  const [cursor, setCursor] = useState(false)
  const timers = useRef<number[]>([])

  const approve = useCallback(() => {
    setCursor(false)
    if (quiet) {
      setT(Infinity)
      setPhase('done')
      return
    }
    setPhase('running')
    setT(0)
    timers.current.forEach((id) => window.clearTimeout(id))
    timers.current = RUN_MARKS.map((m) => window.setTimeout(() => setT(m), m))
    timers.current.push(window.setTimeout(() => setPhase('done'), VERDICT + 40))
  }, [quiet])

  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), [])

  const pressByPointer = useCallback(() => {
    try {
      sessionStorage.setItem('bk-plan-approved', '1')
    } catch {}
    approve()
  }, [approve])

  // Nobody clicked: a pointer approves, once per visit, after the figure has sat whole on screen for 1.2 s with no pointer in it.
  useEffect(() => {
    const el = ref.current
    if (!el || quiet || phase !== 'waiting' || pointer) return
    let seen = false
    try {
      seen = sessionStorage.getItem('bk-plan-approved') === '1'
    } catch {}
    if (seen) return
    let wait = 0
    const io = new IntersectionObserver(
      ([e]) => {
        window.clearTimeout(wait)
        if (e.intersectionRatio >= 0.85) wait = window.setTimeout(() => setCursor(true), 1200)
      },
      { threshold: [0, 0.85, 1] },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      window.clearTimeout(wait)
    }
  }, [quiet, phase, pointer])

  const ran = (i: number) => phase === 'done' || (phase === 'running' && t >= AT[i])
  const built = ran(0)
  const inStep = ran(1)
  const copied = phase === 'done' ? 10 : phase === 'running' ? Math.max(0, Math.min(10, Math.floor((t - COPY_FROM) / BATCH))) : 0
  const matches = ran(3)
  const open = ran(4)
  const verdict = phase === 'done' || (phase === 'running' && t >= VERDICT)

  const status =
    phase === 'waiting' ? 'Waiting on you' : phase === 'dismissed' ? 'Dismissed. Nothing ran.' : phase === 'running' ? 'Approved by you. Carrying out the plan.' : 'Approved by you. Done.'

  return (
    <figure
      ref={ref}
      onPointerEnter={() => setPointer(true)}
      onPointerLeave={() => setPointer(false)}
      className="relative overflow-hidden rounded-[8px] border border-white/[0.07] bg-[#0a0a0d] p-[20px] sm:p-[28px]"
    >
      <div className="grid gap-[28px] lg:grid-cols-[minmax(0,1fr)_minmax(0,0.86fr)_minmax(0,1.05fr)] lg:gap-[40px]">
        {/* reviews, and which rows carry each column. */}
        <div className="min-w-0">
          <Head name="reviews" meta="9,431 rows" />
          {KEPT.map((c) => (
            <Row key={c} name={c}>
              <Strip lit={() => true} />
            </Row>
          ))}
          <div className="relative mt-[14px]">
            {/* The second job, bracketed: the same rows, in all three. */}
            <span aria-hidden className="absolute -left-[12px] bottom-[4px] top-[4px] w-px bg-white/25" />
            {MOVED.map((c) => (
              <Row key={c} name={c}>
                <Strip lit={(i) => SET.has(i)} tone="white" />
              </Row>
            ))}
          </div>
          <p className="mt-[8px] text-[12.5px] leading-[1.5] text-zinc-400">Each mark is a sample row. These three are filled in together.</p>
        </div>

        {/* review_moderation: dashed while planned, then built, kept in step and filled. */}
        <div className="relative min-w-0 lg:mt-[134px]">
          <div className="relative">
            <span aria-hidden className="pointer-events-none absolute -inset-x-[10px] -inset-y-[8px] rounded-[6px] border border-dashed border-white/25 transition-opacity duration-500" style={{ opacity: built ? 0 : 1 }} />
            <span aria-hidden className="pointer-events-none absolute -inset-x-[10px] -inset-y-[8px] rounded-[6px] border border-white/[0.12] transition-opacity duration-500" style={{ opacity: built ? 1 : 0 }} />
            <Head name="review_moderation" meta={open ? 'open to your apps' : matches ? 'matches reviews' : inStep ? 'kept in step' : built ? 'set up' : 'planned'} />
            <Row name="review_id" dim={!built}>
              <Strip lit={(i) => i < copied * (TICKS / 10)} tone="zinc" filled={built} />
            </Row>
            {MOVED.map((c, k) => (
              <div key={c} className="relative">
                {/* Kept in step: one line per column, from its home in reviews (wide screens). */}
                <span
                  aria-hidden
                  className="absolute right-[calc(100%+10px)] top-1/2 hidden h-px w-[30px] origin-left bg-violet-400 transition-transform duration-[380ms] ease-[cubic-bezier(0.65,0,0.35,1)] lg:block"
                  style={{ transform: inStep ? 'scaleX(1)' : 'scaleX(0)', transitionDelay: inStep && phase === 'running' ? `${k * 60}ms` : '0ms' }}
                />
                <Row name={c} dim={!built}>
                  <Strip lit={(i) => i < copied * (TICKS / 10)} tone="violet" filled={built} />
                </Row>
              </div>
            ))}
          </div>
          <p className="mt-[16px] text-[12.5px] text-zinc-400 transition-opacity duration-300" style={{ opacity: open ? 1 : 0 }}>
            Your apps read and write it now. The reviews table keeps working too.
          </p>
        </div>

        {/* The plan, in the console's words. */}
        <div className="min-w-0 lg:border-l lg:border-white/[0.08] lg:pl-[32px]">
          <p aria-live="polite" className={`text-[12.5px] ${phase === 'waiting' ? 'text-zinc-400' : 'text-white'}`}>
            {status}
          </p>
          <p className="mt-[10px] text-[15.5px] font-medium leading-[1.4] tracking-[-0.01em] text-white [text-wrap:balance]">Move moderation data out of reviews into its own table</p>
          <div className="relative mt-[8px] grid [&>*]:[grid-area:1/1]">
            <p className="text-[13.5px] leading-[1.55] text-zinc-400 transition-opacity duration-300" style={{ opacity: verdict ? 0 : 1 }}>
              Changes to these three columns locked all of reviews 5 times in the last 30 days.
            </p>
            <p className="text-[13.5px] leading-[1.55] text-zinc-200 transition-opacity duration-500" style={{ opacity: verdict ? 1 : 0 }}>
              30 days on: changes to these columns locked reviews 0 times, down from 5. It helped.
            </p>
          </div>
          <ol className="mt-[16px] grid gap-[7px] text-[13px]">
            <li className="flex items-center gap-[9px] text-zinc-300">
              <Check aria-hidden className="h-[13px] w-[13px] shrink-0 text-zinc-300" strokeWidth={2.2} />
              Rehearsed on a copy of reviews, then rolled back
            </li>
            {STAGES.map((s, i) => (
              <li key={s} className={`flex items-center gap-[9px] transition-colors duration-200 ${ran(i) ? 'text-white' : 'text-faint'}`}>
                <span aria-hidden className="grid h-[13px] w-[13px] shrink-0 place-items-center">
                  {ran(i) ? <Check className="h-[13px] w-[13px] text-violet-300" strokeWidth={2.2} /> : <span className="h-[5px] w-[5px] rounded-full border border-zinc-600" />}
                </span>
                {s}
              </li>
            ))}
          </ol>

          {/* The buttons, the dismissed note and the cost share one cell, so approving never shifts the cards below. */}
          <div className="grid [&>*]:[grid-area:1/1]">
            <div className={phase === 'waiting' ? '' : 'invisible'} aria-hidden={phase !== 'waiting'}>
              <p className="mt-[16px] text-[12.5px] text-faint">Agents can read this plan. Only a person can approve it.</p>
              <div className="mt-[14px] flex gap-[10px]">
                <button
                  type="button"
                  tabIndex={phase === 'waiting' ? 0 : -1}
                  onClick={() => setPhase('dismissed')}
                  className="h-[34px] rounded-[6px] border border-white/[0.14] px-[14px] text-[13.5px] font-medium text-zinc-200 transition-colors hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  Dismiss
                </button>
                <button
                  ref={approveRef}
                  type="button"
                  tabIndex={phase === 'waiting' ? 0 : -1}
                  onClick={approve}
                  className="h-[34px] rounded-[6px] bg-white px-[14px] text-[13.5px] font-medium text-black transition-[background-color,transform] duration-150 hover:bg-zinc-200 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0d]"
                >
                  Approve
                  <span className="sr-only"> the example plan</span>
                </button>
              </div>
            </div>
            {phase === 'dismissed' && (
              <div>
                <button type="button" onClick={() => setPhase('waiting')} className="mt-[16px] text-[13px] font-medium text-zinc-200 underline decoration-white/30 underline-offset-[3px] hover:decoration-white">
                  Show the plan again
                </button>
              </div>
            )}
            {(phase === 'running' || phase === 'done') && (
              <div className="mt-[16px] grid content-start gap-[4px] transition-opacity duration-500" style={{ opacity: verdict ? 1 : 0 }}>
                <p className="text-[12.5px] text-faint">Cost: a second row for each moderation write.</p>
                <p className="text-[12.5px] text-faint">Removing the old columns stays your call.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {cursor && phase === 'waiting' && !pointer && <ApprovingPointer target={approveRef} onPress={pressByPointer} />}
    </figure>
  )
}

/** A person's pointer: it glides to Approve, presses it, and moves away. */
function ApprovingPointer({ target, onPress }: { target: React.RefObject<HTMLButtonElement | null>; onPress: () => void }) {
  const [scope, animate] = useAnimate<HTMLDivElement>()
  useEffect(() => {
    const el = scope.current
    const root = el?.parentElement
    const btn = target.current
    if (!el || !root || !btn) return
    const rr = root.getBoundingClientRect()
    const br = btn.getBoundingClientRect()
    const tx = br.left - rr.left + br.width * 0.55
    const ty = br.top - rr.top + br.height * 0.6
    let pressed = false
    const press = window.setTimeout(() => {
      pressed = true
      onPress()
    }, 1400 * 0.56)
    const c = animate(
      el,
      { x: [tx + 140, tx, tx, tx, tx + 28], y: [ty + 80, ty, ty, ty, ty + 24], opacity: [0, 1, 1, 1, 0], scale: [1, 1, 0.86, 1, 1] },
      { duration: 1.4, times: [0, 0.48, 0.56, 0.64, 1], ease: [0.45, 0, 0.25, 1] },
    )
    return () => {
      c.stop()
      if (!pressed) window.clearTimeout(press)
    }
  }, [animate, scope, target, onPress])
  return (
    <div ref={scope} aria-hidden className="pointer-events-none absolute left-0 top-0 z-10 opacity-0" style={{ transformOrigin: '2px 2px' }}>
      <svg width="22" height="22" viewBox="0 0 22 22" className="drop-shadow-[0_3px_6px_rgba(0,0,0,0.55)]">
        <path d="M3 2.2v15.4l3.9-3.7 2.6 6 2.6-1.1-2.6-5.9h5.6L3 2.2Z" fill="#fff" stroke="#0a0a0d" strokeWidth={1.3} strokeLinejoin="round" />
      </svg>
      {/* A person's cursor, named the way shared editors name one, so nobody takes it for their own. */}
      <span className="absolute left-[15px] top-[19px] whitespace-nowrap rounded-[4px] bg-white px-[5px] py-[1px] text-[11px] font-medium leading-[15px] text-black shadow-[0_2px_6px_rgba(0,0,0,0.45)]">You</span>
    </div>
  )
}
