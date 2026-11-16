'use client'

/**
 * Small pieces the import flow's steps share: the step trail (words, not
 * numbered circles), the label-left form row the New case and New project
 * forms use, a field's error line, and a masked input for credentials.
 */

import { forwardRef, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { AlertTriangle, Check, Eye, EyeOff } from 'lucide-react'
import { KitInput } from '@/components/inspector/kit'
import { RULE } from '@/components/console/tokens'

// ─── Trail ───────────────────────────────────────────────────────────────────

export type TrailStep = 'connect' | 'review' | 'move' | 'done'

const TRAIL: { id: TrailStep; label: string }[] = [
  { id: 'connect', label: 'Connect' },
  { id: 'review', label: 'Review' },
  { id: 'move', label: 'Move' },
  { id: 'done', label: 'Done' },
]

/** Where the flow is, in four words: the ones behind carry a check, the current one is white. */
export function Trail({ current }: { current: TrailStep }) {
  const at = TRAIL.findIndex((s) => s.id === current)
  return (
    <ol aria-label="Steps" className="-mt-[6px] mb-[24px] flex flex-wrap items-center gap-x-[20px] gap-y-1 text-[12.5px] leading-[18px]">
      {TRAIL.map((step, i) => {
        const done = i < at
        const now = i === at
        return (
          <li
            key={step.id}
            aria-current={now ? 'step' : undefined}
            className={`inline-flex items-center gap-1.5 ${now ? 'font-medium text-zinc-100' : done ? 'text-zinc-400' : 'text-faint'}`}
          >
            {done && <Check aria-hidden className="h-3 w-3" strokeWidth={2.5} />}
            {step.label}
            {done && <span className="sr-only">, done</span>}
          </li>
        )
      })}
    </ol>
  )
}

// ─── Form rows ───────────────────────────────────────────────────────────────

/** One row of a form: what it is on the left, the control on the right (stacked on a phone). */
export function FormRow({
  label,
  hint,
  hintId,
  htmlFor,
  labelId,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  hintId?: string
  htmlFor?: string
  /** For a row whose control is a group: the label's id, and the group names itself. */
  labelId?: string
  children: ReactNode
}) {
  return (
    <div className="grid gap-[8px] px-[16px] py-[16px] sm:grid-cols-[176px_minmax(0,1fr)] sm:gap-[24px] sm:px-[20px]">
      <div className="min-w-0 sm:pt-[6px]">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-[13px] font-medium leading-[20px] text-zinc-100">
            {label}
          </label>
        ) : (
          <p id={labelId} className="text-[13px] font-medium leading-[20px] text-zinc-100">
            {label}
          </p>
        )}
        {hint && (
          <p id={hintId} className="mt-[2px] text-[12px] leading-[17px] text-faint [text-wrap:pretty]">
            {hint}
          </p>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** A field's error, in the server's or the source's own words. */
export function FieldError({ id, error }: { id: string; error?: string | null }) {
  if (!error) return null
  return (
    <p id={id} className="mt-[8px] flex items-start gap-[6px] text-[12.5px] leading-[18px] text-rose-300 [overflow-wrap:anywhere]">
      <AlertTriangle aria-hidden className="mt-[2px] h-3.5 w-3.5 flex-shrink-0" strokeWidth={2} />
      {error}
    </p>
  )
}

/** The bottom of a form panel: a refusal (or one quiet line) on the left, above the buttons on a phone. */
export function FormFooter({ error, aside, children }: { error?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <div
      className={`flex flex-col gap-[12px] rounded-b-[10px] border-t ${RULE} bg-white/[0.015] px-[16px] py-[14px] sm:flex-row sm:items-center sm:justify-end sm:px-[20px]`}
    >
      {error ? (
        <p role="alert" className="min-w-0 text-[12.5px] leading-[18px] text-rose-300 [overflow-wrap:anywhere] sm:mr-auto">
          {error}
        </p>
      ) : aside ? (
        <p className="min-w-0 text-[12.5px] leading-[18px] text-faint sm:mr-auto">{aside}</p>
      ) : null}
      <div className="flex items-center justify-end gap-[8px]">{children}</div>
    </div>
  )
}

// ─── Secrets ─────────────────────────────────────────────────────────────────

/**
 * A credential: masked, never spell-checked or filled in, with a button that
 * shows it while you check what you pasted (a Supabase string arrives with
 * [YOUR-PASSWORD] in it, which has to be replaced).
 */
export const SecretInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
    /** What it is, for the show/hide button's name: "connection string". */
    what: string
  }
>(function SecretInput({ what, className = '', ...rest }, ref) {
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <KitInput
        ref={ref}
        {...rest}
        type={shown ? 'text' : 'password'}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        data-form-type="other"
        className={`pr-[40px] font-mono ${className}`}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? `Hide the ${what}` : `Show the ${what}`}
        aria-pressed={shown}
        title={shown ? 'Hide' : 'Show'}
        className="absolute right-[4px] top-1/2 flex h-[28px] w-[28px] -translate-y-1/2 items-center justify-center rounded-[5px] text-zinc-500 transition-colors duration-150 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        {shown ? <EyeOff aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.75} /> : <Eye aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.75} />}
      </button>
    </div>
  )
})
