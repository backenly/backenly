'use client'

/**
 * ChangePlayer: one real change, walked through the path every change takes.
 *
 * This is the landing page's centrepiece because it is the product's thesis.
 * Backenly does not just generate resources, it manages backend change: an
 * agent's request is planned, anything destructive waits for a human, the
 * apply snapshots first, the result is verified against the running backend,
 * and the whole thing lands in a ledger you can roll back from. Each stage
 * below shows the artifact that stage really produces, in the product's own
 * vocabulary:
 *
 *   - Plan: `apply_migration` is the real MCP tool (lib/mcp/catalog.ts), and
 *     the typed actions it translates into are the executor's vocabulary
 *     (CREATE_TABLE, GENERATE_API, SET_PERMISSION; see AGENTS.md).
 *   - Review: destructive actions park in the Review Queue; an agent key can
 *     request and poll (`check_approval`), never approve.
 *   - Apply: every applied change captures a restore point first.
 *   - Verify: real requests against the runtime, as the anonymous caller and
 *     as a signed-in user, before a change counts as done.
 *   - Record: the change ledger, with the autonomy loop writing to the same one.
 *
 * Names, ids and timings in the panels are illustrative, and the caption under
 * the frame says so. The shapes are not: do not add a stage, a status or a
 * button the product does not have.
 *
 * TIMING. Advancing is driven by the progress bar's own CSS animation
 * (`onAnimationEnd`), not by a JS timer. Pausing the animation therefore
 * pauses the story with no bookkeeping: hover or keyboard focus inside the
 * player, or the frame leaving the viewport, sets `animation-play-state` to
 * paused, and it resumes from the same point. Reduced motion never
 * auto-advances; the tabs still work.
 */

import { useCallback, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AnimatePresence, motion, useInView } from 'framer-motion'
import { Check, CornerDownRight, RotateCcw, ShieldAlert, X } from 'lucide-react'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'

const EASE_OUT = [0.16, 1, 0.3, 1] as const
const STAGE_MS = 7000

type Stage = {
  id: string
  title: string
  body: string
  panel: () => JSX.Element
}

const STAGES: Stage[] = [
  {
    id: 'plan',
    title: 'Plan',
    body: 'Your agent writes ordinary SQL. Backenly turns it into typed, reviewable actions and says what each one touches.',
    panel: PlanPanel,
  },
  {
    id: 'review',
    title: 'Review',
    body: 'Anything destructive stops here with its blast radius spelled out. The agent can ask. Only a person can approve.',
    panel: ReviewPanel,
  },
  {
    id: 'apply',
    title: 'Apply',
    body: 'A restore point is captured before the first write, then the plan lands atomically. All of it, or none of it.',
    panel: ApplyPanel,
  },
  {
    id: 'verify',
    title: 'Verify',
    body: 'Real requests hit the running backend as a stranger and as a user. A change is not done until it behaves.',
    panel: VerifyPanel,
  },
  {
    id: 'record',
    title: 'Record',
    body: 'Every change lands in one ledger with its actor, its diff, and a one-click way back.',
    panel: RecordPanel,
  },
]

export function ChangePlayer() {
  const reduced = useSettledReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const inView = useInView(rootRef, { amount: 0.35 })
  const [active, setActive] = useState(0)
  const [held, setHeld] = useState(false)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const baseId = useId()

  const running = !reduced && inView && !held

  const select = useCallback((index: number, focus = false) => {
    const next = (index + STAGES.length) % STAGES.length
    setActive(next)
    if (focus) tabRefs.current[next]?.focus()
  }, [])

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const keys: Record<string, number> = {
      ArrowDown: active + 1,
      ArrowRight: active + 1,
      ArrowUp: active - 1,
      ArrowLeft: active - 1,
      Home: 0,
      End: STAGES.length - 1,
    }
    if (!(event.key in keys)) return
    event.preventDefault()
    select(keys[event.key], true)
  }

  const Panel = STAGES[active].panel

  return (
    <div
      ref={rootRef}
      className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocusCapture={() => setHeld(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false)
      }}
    >
      <div
        role="tablist"
        aria-label="How a change moves through Backenly"
        aria-orientation="vertical"
        className="grid grid-cols-5 gap-1.5 lg:flex lg:flex-col lg:gap-0"
      >
        {STAGES.map((stage, index) => {
          const selected = index === active
          return (
            <button
              key={stage.id}
              ref={(node) => {
                tabRefs.current[index] = node
              }}
              id={`${baseId}-tab-${stage.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(index)}
              onKeyDown={onTabKey}
              className={`group relative shrink-0 text-left outline-none transition-colors duration-300 focus-visible:ring-2 focus-visible:ring-violet-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a] max-lg:rounded-md max-lg:border max-lg:px-1 max-lg:py-2.5 max-lg:text-center lg:border-t lg:py-5 lg:pr-6 ${
                selected
                  ? 'max-lg:border-white/20 max-lg:bg-white/[0.06] lg:border-white/[0.14]'
                  : 'max-lg:border-white/[0.08] lg:border-white/[0.07]'
              }`}
            >
              {/* Progress rail. Its animation IS the timer; see file comment. */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 -top-px hidden h-px overflow-hidden lg:block"
              >
                {selected && (
                  <span
                    key={`${stage.id}-${active}`}
                    onAnimationEnd={() => select(active + 1)}
                    className="change-progress absolute inset-0 origin-left bg-gradient-to-r from-violet-500 via-violet-300 to-white"
                    style={{
                      animationDuration: `${STAGE_MS}ms`,
                      animationPlayState: running ? 'running' : 'paused',
                      // Reduced motion: a full, static rail marks the selection.
                      ...(reduced ? { animation: 'none', transform: 'none' } : null),
                    }}
                  />
                )}
              </span>

              <span className="flex items-baseline gap-4">
                <span
                  className={`hidden font-mono text-[12px] tabular-nums transition-colors duration-300 lg:inline ${
                    selected ? 'text-violet-300' : 'text-zinc-600 group-hover:text-zinc-400'
                  }`}
                >
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block text-[13px] font-semibold tracking-[-0.012em] sm:text-[15px] transition-colors duration-300 lg:text-[19px] ${
                      selected ? 'text-white' : 'text-zinc-500 group-hover:text-zinc-300'
                    }`}
                  >
                    {stage.title}
                  </span>
                  {/* Only the selected stage shows its sentence. Exactly one
                      is open at a time, so the list's total height barely
                      moves as the story advances. The 0fr to 1fr grid row
                      animates the height without measuring anything. */}
                  <span
                    className={`hidden transition-[grid-template-rows,opacity] duration-500 ease-out lg:grid ${
                      selected ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                    }`}
                  >
                    <span className="overflow-hidden">
                      <span className="block max-w-[44ch] pt-2 text-[15px] leading-[1.65] tracking-[-0.004em] text-zinc-400">
                        {stage.body}
                      </span>
                    </span>
                  </span>
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="min-w-0">
        {/* Phone and tablet get the stage's sentence above the frame, since
            the tab row has no room for it. */}
        <p className="mb-5 max-w-[60ch] text-[15px] leading-[1.65] text-zinc-400 lg:hidden">
          {STAGES[active].body}
        </p>

        <div
          id={`${baseId}-panel`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${STAGES[active].id}`}
          className="relative overflow-hidden rounded-2xl border border-white/[0.09] bg-[#0b0c0f] shadow-[0_1px_0_0_rgba(255,255,255,0.05)_inset,0_40px_120px_-40px_rgba(0,0,0,0.9),0_24px_80px_-48px_rgba(139,92,246,0.35)]"
        >
          <FrameBar stage={active} />
          <div className="relative min-h-[430px] sm:min-h-[400px]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={STAGES[active].id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: reduced ? 0 : 0.32, ease: EASE_OUT }}
                className="min-w-0 p-4 sm:p-7"
              >
                <Panel />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        <p className="mt-4 text-[13px] leading-[1.6] text-zinc-600">
          One change, drawn from the real flow. Names, ids and timings are illustrative.
        </p>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   Frame chrome
───────────────────────────────────────────────────────────── */

function FrameBar({ stage }: { stage: number }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/[0.07] bg-white/[0.015] px-5 py-3 sm:px-7">
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate text-[13px] font-medium tracking-[-0.006em] text-zinc-200">
          Add comments to posts
        </span>
        <span className="hidden font-mono text-[11px] text-zinc-600 sm:inline">change 184</span>
      </div>
      {/* The five stages as a compact meter, so the frame reads as one change
          moving forward rather than five unrelated screens. */}
      <div aria-hidden className="flex shrink-0 items-center gap-1.5">
        {STAGES.map((s, i) => (
          <span
            key={s.id}
            className={`h-1 rounded-full transition-all duration-500 ${
              i < stage ? 'w-3 bg-violet-400/70' : i === stage ? 'w-6 bg-white' : 'w-3 bg-white/[0.12]'
            }`}
          />
        ))}
      </div>
    </div>
  )
}

const MONO = 'font-mono text-[12.5px] leading-[1.75] [font-variant-ligatures:none]'

function Label({ children }: { children: ReactNode }) {
  return <p className="text-[12px] font-medium tracking-[-0.004em] text-zinc-500">{children}</p>
}

/* ─────────────────────────────────────────────────────────────
   1 · Plan
───────────────────────────────────────────────────────────── */

const K = 'text-[#c4b5fd]' // SQL keyword: the brand violet, lightened
const T = 'text-zinc-200'
const D = 'text-zinc-500'

function PlanPanel() {
  const actions = [
    { verb: 'CREATE_TABLE', what: 'comments', note: '5 columns' },
    { verb: 'ADD_RELATION', what: 'comments.post_id → posts.id', note: 'on delete cascade' },
    { verb: 'SET_PERMISSION', what: 'delete where author_id = you', note: 'row-level' },
    { verb: 'GENERATE_API', what: '/comments', note: 'GET POST PATCH DELETE' },
  ]

  return (
    <div className="grid min-w-0 gap-6 [&>*]:min-w-0">
      <div>
        <div className="flex items-center justify-between">
          <Label>From Claude Code, over MCP</Label>
          <span className="rounded border border-white/[0.08] px-1.5 py-0.5 font-mono text-[11px] text-zinc-400">
            apply_migration
          </span>
        </div>
        <pre className={`mt-3 overflow-x-auto rounded-lg border border-white/[0.06] bg-black/40 px-4 py-3 ${MONO}`}>
          <code>
            <span className={K}>create table</span> <span className={T}>comments</span> <span className={D}>(</span>
            {'\n  '}
            <span className={T}>id</span> <span className={D}>uuid primary key default gen_random_uuid(),</span>
            {'\n  '}
            <span className={T}>post_id</span> <span className={D}>uuid</span> <span className={K}>references</span>{' '}
            <span className={T}>posts</span>
            <span className={D}>(id)</span> <span className={K}>on delete cascade</span>
            <span className={D}>,</span>
            {'\n  '}
            <span className={T}>author_id</span> <span className={D}>uuid not null,</span>
            {'\n  '}
            <span className={T}>body</span> <span className={D}>text not null,</span>
            {'\n  '}
            <span className={T}>created_at</span> <span className={D}>timestamptz default now()</span>
            {'\n'}
            <span className={D}>);</span>
          </code>
        </pre>
      </div>

      <div>
        <Label>Backenly’s plan</Label>
        <ul className="mt-3 divide-y divide-white/[0.06] rounded-lg border border-white/[0.06]">
          {actions.map((a, i) => (
            <motion.li
              key={a.verb}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.12 + i * 0.08, duration: 0.4, ease: EASE_OUT }}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5"
            >
              <span className="basis-full font-mono text-[11.5px] text-violet-300 sm:w-[120px] sm:shrink-0 sm:basis-auto">{a.verb}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-200">{a.what}</span>
              <span className="text-[12px] text-zinc-500">{a.note}</span>
            </motion.li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-zinc-400">
          <Fact tone="ok">Additive</Fact>
          <Fact tone="ok">0 existing rows touched</Fact>
          <Fact tone="ok">Reversible</Fact>
        </div>
      </div>
    </div>
  )
}

function Fact({ children, tone }: { children: ReactNode; tone: 'ok' | 'warn' }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {tone === 'ok' ? (
        <Check aria-hidden className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.25} />
      ) : (
        <ShieldAlert aria-hidden className="h-3.5 w-3.5 text-amber-300" strokeWidth={2} />
      )}
      {children}
    </span>
  )
}

/* ─────────────────────────────────────────────────────────────
   2 · Review
───────────────────────────────────────────────────────────── */

function ReviewPanel() {
  return (
    <div className="grid min-w-0 gap-5 [&>*]:min-w-0">
      <div className="flex items-center justify-between">
        <Label>Review Queue</Label>
        <span className="text-[12px] text-zinc-500">1 waiting</span>
      </div>

      <div className="rounded-xl border border-amber-300/20 bg-amber-300/[0.03] p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <span className="inline-flex items-center gap-1.5 rounded border border-amber-300/25 bg-amber-300/[0.08] px-1.5 py-0.5 text-[11px] font-medium text-amber-200">
              <ShieldAlert aria-hidden className="h-3 w-3" strokeWidth={2.25} />
              Destructive
            </span>
            <p className="mt-3 text-[16px] font-semibold tracking-[-0.014em] text-white">
              Drop column <span className="font-mono text-[14.5px] font-medium">posts.legacy_slug</span>
            </p>
            <p className="mt-1 text-[13px] text-zinc-400">
              Requested alongside the comments table, by Claude Code
            </p>
          </div>
        </div>

        <dl className="mt-5 grid gap-px overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.06] sm:grid-cols-3">
          {[
            ['Live rows holding a value', '1,284'],
            ['Recoverable', 'From the snapshot'],
            ['Requested by', 'Agent key'],
          ].map(([k, v]) => (
            <div key={k} className="bg-[#0d0e11] px-4 py-3">
              <dt className="text-[11.5px] text-zinc-500">{k}</dt>
              <dd className="mt-1 text-[14px] font-medium tabular-nums text-zinc-100">{v}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <span className="inline-flex h-9 items-center gap-1.5 rounded-md bg-white px-3.5 text-[13px] font-semibold text-black">
            <Check aria-hidden className="h-3.5 w-3.5" strokeWidth={2.5} />
            Approve
          </span>
          <span className="inline-flex h-9 items-center gap-1.5 rounded-md border border-white/[0.12] px-3.5 text-[13px] font-medium text-zinc-300">
            <X aria-hidden className="h-3.5 w-3.5" strokeWidth={2.25} />
            Reject
          </span>
          <span className="text-[12.5px] text-zinc-500">Only a person can decide</span>
        </div>
      </div>

      <div className={`rounded-lg border border-white/[0.06] bg-black/40 px-4 py-3 ${MONO} text-zinc-500`}>
        <span className="text-zinc-300">check_approval</span> apr_9c2e
        {'  '}
        <CornerDownRight aria-hidden className="mx-1 inline h-3 w-3 -translate-y-px text-zinc-600" />
        <span className="text-amber-200">pending</span>
        <span className="text-zinc-600"> · the agent’s key can poll, never approve</span>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   3 · Apply
───────────────────────────────────────────────────────────── */

function ApplyPanel() {
  const lines: [string, string, string, string?][] = [
    ['14:02:11.08', 'snapshot', 'restore point sp_7f3a captured', 'violet'],
    ['14:02:11.31', 'begin', 'transaction opened'],
    ['14:02:11.47', 'apply', 'create table comments'],
    ['14:02:11.52', 'apply', 'foreign key comments.post_id → posts.id'],
    ['14:02:11.60', 'apply', 'policy comments_delete_own'],
    ['14:02:11.71', 'commit', '3 statements, all or nothing', 'ok'],
    ['14:02:11.94', 'serve', '/comments live on the REST API', 'ok'],
  ]

  return (
    <div className="grid min-w-0 gap-5 [&>*]:min-w-0">
      <div className="flex items-center justify-between">
        <Label>Apply log</Label>
        <span className="text-[12px] text-zinc-500">production</span>
      </div>
      <ol className={`rounded-lg border border-white/[0.06] bg-black/40 px-4 py-3 ${MONO}`}>
        {lines.map(([time, kind, text, tone], i) => (
          <motion.li
            key={time}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 + i * 0.16, duration: 0.3 }}
            className="grid grid-cols-[84px_64px_minmax(0,1fr)] gap-3 sm:grid-cols-[96px_72px_minmax(0,1fr)]"
          >
            <span className="tabular-nums text-zinc-600">{time}</span>
            <span
              className={
                tone === 'violet' ? 'text-violet-300' : tone === 'ok' ? 'text-emerald-400' : 'text-zinc-500'
              }
            >
              {kind}
            </span>
            <span className="truncate text-zinc-300">{text}</span>
          </motion.li>
        ))}
      </ol>
      <div className="flex items-center gap-4 rounded-lg border border-violet-400/20 bg-violet-400/[0.04] px-4 py-3">
        <RotateCcw aria-hidden className="h-4 w-4 shrink-0 text-violet-300" />
        <p className="text-[13px] leading-[1.55] text-zinc-300">
          The restore point exists before the first write. If anything below it fails, nothing
          is left half-applied.
        </p>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   4 · Verify
───────────────────────────────────────────────────────────── */

function VerifyPanel() {
  const checks = [
    ['GET', '/comments', 'anyone', 'allowed', 'allowed'],
    ['POST', '/comments', 'signed out', 'denied', 'denied'],
    ['POST', '/comments', 'signed in', 'allowed', 'allowed'],
    ['DELETE', '/comments/:id', 'another user', 'denied', 'denied'],
    ['DELETE', '/comments/:id', 'the author', 'allowed', 'allowed'],
  ]

  return (
    <div className="grid min-w-0 gap-5 [&>*]:min-w-0">
      <div className="flex items-center justify-between">
        <Label>Checks against the running backend</Label>
        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-emerald-400">
          <Check aria-hidden className="h-3.5 w-3.5" strokeWidth={2.5} />
          5 of 5 passed
        </span>
      </div>
      <div className="overflow-hidden rounded-lg border border-white/[0.06]">
        <table className="w-full text-left text-[12.5px]">
          <thead className="bg-white/[0.02] text-zinc-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Request</th>
              <th scope="col" className="hidden px-4 py-2 font-medium sm:table-cell">As</th>
              <th scope="col" className="px-4 py-2 font-medium">Expected</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Got</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {checks.map(([method, path, as, expected, got], i) => (
              <motion.tr
                key={`${method}${path}${as}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.12 + i * 0.14, duration: 0.3 }}
              >
                <td className="px-4 py-2.5 font-mono text-[12px]">
                  <span className="inline-block w-[52px] text-zinc-500">{method}</span>
                  <span className="text-zinc-200">{path}</span>
                  <span className="mt-0.5 block font-sans text-[11.5px] text-zinc-500 sm:hidden">as {as}</span>
                </td>
                <td className="hidden px-4 py-2.5 text-zinc-400 sm:table-cell">{as}</td>
                <td className="px-4 py-2.5 text-zinc-400">{expected}</td>
                <td className="px-4 py-2.5 text-right">
                  <span className="inline-flex items-center gap-1.5 text-zinc-200">
                    {got}
                    <Check aria-hidden className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.5} />
                  </span>
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[13px] leading-[1.6] text-zinc-500">
        A denied request that comes back allowed fails the change, even when every statement
        applied cleanly.
      </p>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   5 · Record
───────────────────────────────────────────────────────────── */

function RecordPanel() {
  const earlier = [
    ['183', 'Restored index on orders.customer_id', 'Autonomy loop', '03:15'],
    ['182', 'Added storage bucket avatars', 'Cursor', 'Yesterday'],
  ]

  return (
    <div className="grid min-w-0 gap-5 [&>*]:min-w-0">
      <div className="flex items-center justify-between">
        <Label>Change ledger</Label>
        <span className="text-[12px] text-zinc-500">every actor, one history</span>
      </div>

      <div className="rounded-xl border border-white/[0.10] bg-white/[0.02] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-mono text-[11.5px] text-zinc-500">184</p>
            <p className="mt-1 text-[16px] font-semibold tracking-[-0.014em] text-white">Add comments to posts</p>
            <p className="mt-1 text-[13px] text-zinc-400">Claude Code over MCP, verified 5 of 5</p>
          </div>
          <span className="inline-flex h-9 items-center gap-1.5 rounded-md border border-white/[0.12] px-3.5 text-[13px] font-medium text-zinc-200">
            <RotateCcw aria-hidden className="h-3.5 w-3.5" />
            Roll back
          </span>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {['+1 table', '+1 relation', '+1 policy', '+4 endpoints'].map((d) => (
            <span
              key={d}
              className="rounded-md border border-emerald-400/15 bg-emerald-400/[0.05] px-2 py-1 font-mono text-[11.5px] text-emerald-300"
            >
              {d}
            </span>
          ))}
          <span className="rounded-md border border-violet-400/20 bg-violet-400/[0.05] px-2 py-1 font-mono text-[11.5px] text-violet-200">
            restore point sp_7f3a
          </span>
        </div>
      </div>

      <ul className="divide-y divide-white/[0.05] rounded-lg border border-white/[0.06]">
        {earlier.map(([id, what, who, when]) => (
          <li key={id} className="flex items-center gap-4 px-4 py-3 text-[13px]">
            <span className="w-8 font-mono text-[11.5px] text-zinc-600">{id}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-300">{what}</span>
            <span className="hidden text-zinc-500 sm:inline">{who}</span>
            <span className="w-[68px] text-right tabular-nums text-zinc-600">{when}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
