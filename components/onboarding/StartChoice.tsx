'use client'

/**
 * The two ways to start, as one radio group: bring a backend you already run
 * (Supabase, Firebase or any Postgres, picked inside that option) or start
 * from scratch. The first-run question ("How do you want to start?") shows it
 * large; New project shows it compact.
 *
 * The founder's rules for this choice (design round of 2026-11-14): no icon
 * tiles around the options or the marks; the sources sit inside the chosen
 * option; white radios, never violet. Native radio inputs underneath, so Tab
 * reaches each group and the arrow keys move inside it.
 */

import { useId } from 'react'
import type { ImportSourceId } from '@/lib/import/contract'
import { IMPORT_SOURCES } from '@/lib/import/client'
import { SOURCES, SourceMark } from '@/components/migrate/sources'
import { EDGE, RULE } from '@/components/console/tokens'

export type StartKind = 'import' | 'scratch'

export interface StartOption {
  kind: StartKind
  title: string
  body?: string
}

const SIZE = {
  large: {
    row: 'gap-[14px] px-[20px] py-[18px]',
    radio: 'mt-[3px]',
    title: 'text-[15px] leading-[22px]',
    body: 'mt-[2px] text-[13.5px] leading-[21px]',
    inner: 'pb-[20px] pl-[50px] pr-[20px]',
  },
  compact: {
    row: 'gap-[12px] px-[16px] py-[13px]',
    radio: 'mt-[2px]',
    title: 'text-[13.5px] leading-[20px]',
    body: 'mt-[1px] text-[13px] leading-[19px]',
    inner: 'pb-[16px] pl-[44px] pr-[16px]',
  },
} as const

/**
 * A white radio: the console's, as in New project's regions and New case's
 * severities. Placed right after its (hidden) input, it carries the keyboard
 * focus ring itself, so a dialog that opens with focus on its first option
 * does not frame the whole option.
 */
export function Radio({ on, className = '' }: { on: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={`flex h-[16px] w-[16px] flex-shrink-0 items-center justify-center rounded-full border transition-[border-color,box-shadow] duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-white/70 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[#141518] ${
        on ? 'border-white' : 'border-white/30'
      } ${className}`}
    >
      {on && <span className="h-[8px] w-[8px] rounded-full bg-white" />}
    </span>
  )
}

export function StartChoice({
  legend,
  options,
  choice,
  onChoice,
  source,
  onSource,
  size = 'large',
}: {
  /** The question, for screen readers (the dialog's title says it on screen). */
  legend: string
  options: StartOption[]
  choice: StartKind
  onChoice: (kind: StartKind) => void
  source: ImportSourceId
  onSource: (source: ImportSourceId) => void
  size?: keyof typeof SIZE
}) {
  const name = useId()
  const s = SIZE[size]
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <div className={`overflow-hidden rounded-[10px] border ${EDGE}`}>
        {options.map((option, i) => {
          const on = option.kind === choice
          return (
            <div
              key={option.kind}
              className={`transition-colors duration-150 ${i > 0 ? `border-t ${RULE}` : ''} ${on ? 'bg-white/[0.035]' : ''}`}
            >
              <label
                className={`flex cursor-pointer items-start ${s.row} transition-colors duration-150 ${on ? '' : 'hover:bg-white/[0.02]'}`}
              >
                <input
                  type="radio"
                  name={name}
                  value={option.kind}
                  checked={on}
                  onChange={() => onChoice(option.kind)}
                  className="peer sr-only"
                />
                <Radio on={on} className={s.radio} />
                <span className="min-w-0">
                  <span className={`block font-medium tracking-[-0.01em] text-zinc-50 ${s.title}`}>{option.title}</span>
                  {option.body && <span className={`block text-zinc-400 [text-wrap:pretty] ${s.body}`}>{option.body}</span>}
                </span>
              </label>
              {option.kind === 'import' && on && (
                <div className={s.inner}>
                  <SourcePicker legend="Where is it now?" value={source} onChange={onSource} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </fieldset>
  )
}

/**
 * Supabase, Firebase or Postgres, each with its own mark (no tile around it),
 * as a row of radio buttons. The chosen one is lit white.
 */
export function SourcePicker({
  legend,
  value,
  onChange,
  disabled = false,
}: {
  legend: string
  value: ImportSourceId
  onChange: (source: ImportSourceId) => void
  disabled?: boolean
}) {
  const name = useId()
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="sr-only">{legend}</legend>
      <div className="flex flex-wrap gap-[8px]">
        {IMPORT_SOURCES.map((id) => {
          const on = id === value
          return (
            <label
              key={id}
              className={`inline-flex h-[34px] cursor-pointer items-center gap-[8px] rounded-[7px] border px-[12px] text-[13px] transition-[background-color,border-color,color] duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-white/70 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 ${
                on
                  ? 'border-white/[0.24] bg-white/[0.08] font-medium text-white'
                  : 'border-white/[0.08] bg-white/[0.02] text-zinc-400 hover:border-white/[0.14] hover:text-zinc-200'
              }`}
            >
              <input
                type="radio"
                name={name}
                value={id}
                checked={on}
                onChange={() => onChange(id)}
                className="sr-only"
              />
              <SourceMark id={id} className="h-[14px] w-[14px]" />
              {SOURCES[id].name}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
