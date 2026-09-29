'use client'

/**
 * ChangePath: the path every change takes, drawn as one line.
 *
 * Replaced ChangePlayer (a tab list beside a panel of mocked dashboard cards:
 * badges, a stat grid, Approve and Reject buttons) on the founder's call that
 * it read as generated. A collage of fake UI is the single most common tell of
 * a generated landing page. This is the opposite move: the same engineering
 * drawing language as the primitives bento (components/landing/
 * CapabilityDiagrams), one track from your agent to production, with the one
 * branch that matters: a destructive action leaves the track and waits for a
 * person, while additive work passes straight through.
 *
 * Everything on the line is a real product noun: `apply_migration` is the
 * MCP tool, the Review Queue holds destructive actions, a restore point is
 * captured before the first write, verification is real requests against the
 * runtime, and the ledger is where rollback lives.
 *
 * Motion is one light travelling the track, lighting each stage as it passes,
 * and the parked branch marching slowly because it is waiting. Both are CSS
 * keyframes in app/globals.css (`.path-pulse`, `.path-node`, `.path-wait`),
 * so there is no JS timer and reduced motion turns all of it off there.
 */

import { Check } from 'lucide-react'
import { AGENT_MARKS, AgentGlyph } from '@/components/landing/AgentMarks'

const CHIP =
  'path-node relative z-10 inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-md border border-white/[0.12] bg-[#0b0c0f] px-3 font-mono text-[12px] tracking-tight text-zinc-200'
const NOTE = 'font-mono text-[11px] tracking-tight text-zinc-500'

/**
 * Seconds into the pulse's 8s lap at which it reaches each chip. The pulse is
 * 12% of the track wide and travels from -12% to +108% of it, so its centre
 * crosses a point x% along the track at ((x + 6) / 120) * 8s. With five
 * columns and a 32px gap, chip centres sit near 6, 26.5, 47, 67.5 and 88%.
 */
const LIT_AT = [0.8, 2.17, 3.53, 4.9, 6.27]

const claude = AGENT_MARKS.find((m) => m.id === 'claude')!

type Stage = { title: string; body: string }

const STAGES: Stage[] = [
  {
    title: 'Plan',
    body: 'Your agent writes ordinary SQL. Backenly turns it into typed actions and says what each one touches.',
  },
  {
    title: 'Review',
    body: 'Additive work passes. Anything destructive leaves the line and waits for a person. The agent can ask, never approve.',
  },
  {
    title: 'Apply',
    body: 'A restore point is captured before the first write, then the plan commits atomically. All of it or none of it.',
  },
  {
    title: 'Verify',
    body: 'Real requests hit the running backend as a stranger and as a user. Done means it behaves, not that it ran.',
  },
  {
    title: 'Record',
    body: 'Every change lands in one ledger, with its actor, its diff and a one-click way back.',
  },
]

function StageChip({ index }: { index: number }) {
  const style = { animationDelay: `${LIT_AT[index]}s` }
  switch (index) {
    case 0:
      return (
        <span className={CHIP} style={style}>
          <AgentGlyph mark={claude} className="h-3.5 w-3.5 text-[#d97757]" />
          apply_migration
        </span>
      )
    case 1:
      return (
        <span className={CHIP} style={style}>
          review
        </span>
      )
    case 2:
      return (
        <span className={CHIP} style={style}>
          restore point
          <span className="text-zinc-600">→</span>
          commit
        </span>
      )
    case 3:
      return (
        <span className={CHIP} style={style}>
          <Check aria-hidden className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.5} />5 / 5 checks
        </span>
      )
    default:
      return (
        <span className={CHIP} style={style}>
          change 184
          <span className="rounded-[3px] border border-white/[0.10] px-1 text-[10px] text-zinc-400">undo</span>
        </span>
      )
  }
}

const NOTES = [
  'sql → 4 typed actions',
  'additive passes',
  'snapshot first',
  'as anon, as a user',
  'every actor, one history',
]

/**
 * Out of Review, down to the parked action, and back up into the track just
 * before Apply once a person has decided. Dashed, because nothing on it moves
 * until then. Positioned inside the Review column: its width runs to the end
 * of the column plus the 32px gap, less 16px, so it rejoins the line just
 * short of the Apply chip at every width.
 */
function ReviewBranch() {
  return (
    <>
      <svg
        className="absolute left-[36px] top-[36px] h-[92px] w-[calc(100%-20px)] overflow-visible"
        viewBox="0 0 100 92"
        preserveAspectRatio="none"
        fill="none"
      >
        <path
          d="M0 0 V74 H100 V-18"
          className="path-wait stroke-amber-200/40"
          strokeDasharray="3 5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="absolute left-[14px] top-[92px] z-10 flex flex-col items-start gap-2.5">
        <span className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-md border border-amber-200/25 bg-[#0e0d0a] px-3 font-mono text-[12px] tracking-tight text-amber-100">
          <span className="relative flex h-1.5 w-1.5">
            <span className="path-wait-dot absolute inset-0 rounded-full bg-amber-300" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-amber-300" />
          </span>
          drop legacy_slug
        </span>
        <span className={`${NOTE} whitespace-nowrap`}>waits for you</span>
      </div>
    </>
  )
}

export function ChangePath() {
  return (
    <figure>
      {/* ── Desktop: the drawing ─────────────────────────────────────── */}
      <div aria-hidden className="relative mb-10 hidden h-[164px] select-none lg:block">
        {/* The track, fading in from your agent and out into production. */}
        <div className="absolute inset-x-0 top-[18px] h-px bg-[linear-gradient(to_right,transparent,rgba(255,255,255,0.22)_4%,rgba(255,255,255,0.22)_94%,transparent)]" />
        <div className="absolute inset-x-0 top-[18px] h-px overflow-hidden">
          <span className="path-pulse absolute inset-y-0 left-0 w-[12%] bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.9),#fff,transparent)]" />
        </div>

        {/* The five stages sit on the track at their column's left edge,
            the same edge their captions start from below. */}
        {/* Same columns and gap as the captions below, so every chip sits
            exactly over the start of its caption. */}
        <div className="absolute inset-x-0 top-0 grid grid-cols-5 gap-x-8">
          {STAGES.map((stage, i) => (
            <div key={stage.title} className="relative flex flex-col items-start">
              <StageChip index={i} />
              <span className={`${NOTE} mt-2.5 ${i === 1 ? 'ml-[64px]' : ''}`}>{NOTES[i]}</span>
              {i === 1 && <ReviewBranch />}
            </div>
          ))}
        </div>
      </div>

      <figcaption className="grid gap-x-8 gap-y-8 max-lg:hidden lg:grid-cols-5">
        {STAGES.map((stage) => (
          <div key={stage.title} className="border-t border-white/[0.08] pt-5">
            <h3 className="text-[17px] font-semibold tracking-[-0.018em] text-white">{stage.title}</h3>
            <p className="mt-2 max-w-[30ch] text-[14.5px] leading-[1.65] tracking-[-0.004em] text-zinc-400">
              {stage.body}
            </p>
          </div>
        ))}
      </figcaption>

      {/* ── Phone and tablet: the same line, stood upright ─────────────── */}
      <ol className="relative lg:hidden">
        <span aria-hidden className="absolute bottom-3 left-[5px] top-3 w-px bg-white/[0.14]" />
        {STAGES.map((stage, i) => (
          <li key={stage.title} className="relative pb-9 pl-8 last:pb-0">
            <span
              aria-hidden
              className="absolute left-0 top-[7px] h-[11px] w-[11px] rounded-full border border-white/30 bg-[#08090a]"
            />
            <h3 className="text-[17px] font-semibold tracking-[-0.018em] text-white">{stage.title}</h3>
            <p className="mt-1.5 max-w-[52ch] text-[15px] leading-[1.65] text-zinc-400">{stage.body}</p>
            <div aria-hidden className="mt-3.5 flex flex-wrap items-center gap-2">
              <StageChip index={i} />
              {i === 1 && (
                <span className="inline-flex h-9 items-center gap-2 rounded-md border border-amber-200/25 bg-[#0e0d0a] px-3 font-mono text-[12px] tracking-tight text-amber-100">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
                  drop column waits for you
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </figure>
  )
}
