'use client'

import { useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { useOnScreen } from '@/components/landing-v7/shared'
import { PlayPause } from '@/components/landing-v7/scene-ui'

/* ─────────────────────────────────────────────────────────────
   "How a move works" on /migrate (founders, 2026-11-15: "more professional,
   more animated"): the three steps beside the product's own screen for each,
   the way the first-run flow shows them (components/migrate/Welcome.tsx).

   It walks through the steps by itself while on screen, a thin line filling
   under the current one, and holds still while the pointer or focus is on it
   or after Pause, so nothing moves under someone reading. Each step is a tab:
   click it or use the arrow keys. Reduced motion shows the first step and
   never advances. The trail is words, as in the product, not numbered circles.
───────────────────────────────────────────────────────────── */

const STEP_MS = 7000

export function MoveSteps({ steps, screens }: { steps: { title: string; body: string }[]; screens: ReactNode[] }) {
  const quiet = useSettledReducedMotion()
  const [ref, onScreen] = useOnScreen<HTMLDivElement>('0px')
  const [active, setActive] = useState(0)
  // Bumped on every choice, so choosing the current step again restarts its line.
  const [cycle, setCycle] = useState(0)
  const [paused, setPaused] = useState(false)
  const [holding, setHolding] = useState(false)
  const running = onScreen && !paused && !holding && !quiet
  const base = useId()
  const tabs = useRef<(HTMLButtonElement | null)[]>([])

  const choose = (i: number) => {
    setActive(i)
    setCycle((c) => c + 1)
  }

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = steps.length - 1
    const to =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? i === last
          ? 0
          : i + 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? i === 0
            ? last
            : i - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null
    if (to === null) return
    e.preventDefault()
    choose(to)
    tabs.current[to]?.focus()
  }

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHolding(false)
  }

  return (
    <div
      ref={ref}
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHolding(true)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && setHolding(false)}
      onFocus={() => setHolding(true)}
      onBlur={onBlur}
      className="grid gap-[28px] lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)] lg:items-start lg:gap-[48px]"
    >
      <style>{'@keyframes mg-fill{from{transform:scaleX(0)}to{transform:scaleX(1)}}@keyframes mg-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}'}</style>

      <div>
        <div role="tablist" aria-label="How a move works" aria-orientation="vertical" className="grid gap-[6px]">
          {steps.map((step, i) => {
            const on = i === active
            const done = i < active
            return (
              <button
                key={step.title}
                ref={(el) => {
                  tabs.current[i] = el
                }}
                type="button"
                role="tab"
                id={`${base}-tab-${i}`}
                aria-selected={on}
                aria-controls={`${base}-panel-${i}`}
                tabIndex={on ? 0 : -1}
                onClick={() => choose(i)}
                onKeyDown={(e) => onKey(e, i)}
                className={`group relative w-full rounded-[8px] border px-[18px] pb-[16px] pt-[15px] text-left transition-[background-color,border-color] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
                  on ? 'border-white/[0.10] bg-white/[0.035]' : 'border-transparent hover:bg-white/[0.02]'
                }`}
              >
                <span className="flex items-center gap-[8px]">
                  <span className={`text-[17px] font-medium tracking-[-0.012em] ${on ? 'text-white' : 'text-zinc-300'}`}>{step.title}</span>
                  {done && <Check aria-hidden className="h-[14px] w-[14px] text-zinc-400" strokeWidth={2.25} />}
                </span>
                <span className={`mt-[6px] block text-[15px] leading-[1.6] [text-wrap:pretty] ${on ? 'text-zinc-300' : 'text-zinc-400'}`}>{step.body}</span>
                {/* The step's time on screen, filling under the current step. */}
                <span aria-hidden className="mt-[14px] block h-[2px] overflow-hidden rounded-full bg-white/[0.06]">
                  {on && !quiet && (
                    <span
                      key={cycle}
                      className="block h-full origin-left rounded-full bg-zinc-300"
                      style={{ animation: `mg-fill ${STEP_MS}ms linear forwards`, animationPlayState: running ? 'running' : 'paused' }}
                      onAnimationEnd={() => choose((i + 1) % steps.length)}
                    />
                  )}
                  {(done || (on && quiet)) && <span className="block h-full rounded-full bg-zinc-600" />}
                </span>
              </button>
            )
          })}
        </div>
        {!quiet && (
          <div className="mt-[14px] flex items-center gap-[12px] px-[4px]">
            <PlayPause what="steps" paused={paused} onToggle={() => setPaused((v) => !v)} />
            <span className="text-[12.5px] text-zinc-400">{paused ? 'Paused. Pick a step to see its screen.' : 'Plays through the steps, and holds while you read.'}</span>
          </div>
        )}
      </div>

      {/* The product's own screen for the step, under its trail. */}
      <div className="overflow-hidden rounded-[10px] border border-white/[0.10] bg-[#0b0c0f] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-white/[0.07] px-[18px] py-[12px]">
          <p className="text-[13px] font-medium text-zinc-200">Move a project</p>
          <ol aria-label="Steps" className="flex items-center gap-[18px] text-[12.5px] leading-[18px]">
            {steps.map((step, i) => (
              <li
                key={step.title}
                aria-current={i === active ? 'step' : undefined}
                className={`inline-flex items-center gap-[5px] ${i === active ? 'font-medium text-zinc-100' : i < active ? 'text-zinc-400' : 'text-faint'}`}
              >
                {i < active && <Check aria-hidden className="h-3 w-3 text-zinc-400" strokeWidth={2.5} />}
                {step.title}
              </li>
            ))}
          </ol>
        </div>
        {/* One height for every step, so nothing below moves as the steps play. A screen taller than it (the finished move) fades itself out at the edge. */}
        <div className="grid h-[470px] overflow-hidden p-[14px] sm:h-[392px] sm:p-[18px]">
          {screens.map((screen, i) => (
            <div
              key={i}
              role="tabpanel"
              id={`${base}-panel-${i}`}
              aria-labelledby={`${base}-tab-${i}`}
              className={`[grid-area:1/1] ${i === active ? 'visible' : 'invisible'}`}
              style={i === active && !quiet ? { animation: 'mg-in 320ms cubic-bezier(0.16,1,0.3,1) both' } : undefined}
            >
              {screen}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
