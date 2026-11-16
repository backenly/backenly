'use client'

/**
 * KitCheckbox and KitRadio: the console's choice controls, white like every
 * other control (violet marks only what Backenly does, never a form).
 *
 * Native inputs underneath, so Space toggles, arrow keys move through a radio
 * group, a form submits them, and screen readers announce checked, mixed and
 * disabled on their own. The input itself is the 28px hit target; a 16px box
 * is drawn over it, so it lines up with text like a 16px control while a
 * thumb still finds it. Re-exported from components/inspector/kit.
 *
 *   <KitCheckbox checked={on} onChange={setOn} label="Nullable" description="Rows may leave it empty." />
 *   <KitCheckbox checked={all} indeterminate={some} onChange={selectAll} aria-label="Select all rows" />
 *   <KitRadio name="visibility" value="private" checked={v === 'private'} onChange={setV} label="Private" />
 */

import { useEffect, useRef, type ReactNode } from 'react'

/** The 16px box, the white focus ring, and the disabled look, shared by both controls. */
const BOX_FOCUS =
  'peer-focus-visible:ring-2 peer-focus-visible:ring-white/70 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[#0c0d0f]'

interface ChoiceBase {
  /** The words beside the control. Clicking them toggles it too. */
  label?: ReactNode
  /** One faint line under the label. */
  description?: ReactNode
  /** The accessible name when there is no visible label (a row's selection box). */
  'aria-label'?: string
  disabled?: boolean
  id?: string
  name?: string
  className?: string
}

export interface KitCheckboxProps extends ChoiceBase {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Some, not all: drawn as a dash and announced as "mixed". */
  indeterminate?: boolean
  value?: string
}

export function KitCheckbox({
  checked,
  onChange,
  indeterminate = false,
  label,
  description,
  'aria-label': ariaLabel,
  disabled = false,
  id,
  name,
  value,
  className = '',
}: KitCheckboxProps) {
  const ref = useRef<HTMLInputElement>(null)
  // `indeterminate` is a property, not an attribute: it can only be set from script.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  const on = checked || indeterminate
  const box = (
    <span className="relative -m-[6px] flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center">
      <input
        ref={ref}
        type="checkbox"
        id={id}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        aria-label={label ? undefined : ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
        className="peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none rounded-[7px] disabled:cursor-not-allowed"
      />
      <span
        aria-hidden
        className={`pointer-events-none flex h-[16px] w-[16px] items-center justify-center rounded-[4px] border transition-[background-color,border-color] duration-150 ${BOX_FOCUS} ${
          on ? 'border-white bg-white' : 'border-white/30 bg-transparent peer-hover:border-white/50'
        } ${disabled ? 'opacity-40' : ''}`}
      >
        {indeterminate ? (
          <span className="h-[2px] w-[8px] rounded-full bg-[#0c0d0f]" />
        ) : checked ? (
          <svg viewBox="0 0 12 12" className="h-[11px] w-[11px]" fill="none">
            <path d="M2.5 6.3 4.9 8.6 9.5 3.6" stroke="#0c0d0f" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>
    </span>
  )
  if (!label) return <span className={`inline-flex ${className}`}>{box}</span>
  return (
    <label className={`flex w-fit max-w-full items-start gap-[10px] ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'} ${className}`}>
      <span className="mt-[2px] flex">{box}</span>
      <Words label={label} description={description} disabled={disabled} />
    </label>
  )
}

export interface KitRadioProps extends ChoiceBase {
  /** This option's value; `onChange` receives it when the option is picked. */
  value: string
  checked: boolean
  onChange: (value: string) => void
  /** Groups the options: the same name on every radio of one question. */
  name: string
}

/**
 * One option of a radio group. Wrap the options in an element with
 * role="radiogroup" and an accessible name (or a <fieldset> with a <legend>).
 */
export function KitRadio({
  value,
  checked,
  onChange,
  name,
  label,
  description,
  'aria-label': ariaLabel,
  disabled = false,
  id,
  className = '',
}: KitRadioProps) {
  const box = (
    <span className="relative -m-[6px] flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center">
      <input
        type="radio"
        id={id}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        aria-label={label ? undefined : ariaLabel}
        onChange={() => onChange(value)}
        className="peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed"
      />
      <span
        aria-hidden
        className={`pointer-events-none flex h-[16px] w-[16px] items-center justify-center rounded-full border transition-colors duration-150 ${BOX_FOCUS} ${
          checked ? 'border-white' : 'border-white/30 peer-hover:border-white/50'
        } ${disabled ? 'opacity-40' : ''}`}
      >
        {checked && <span className="h-[8px] w-[8px] rounded-full bg-white" />}
      </span>
    </span>
  )
  if (!label) return <span className={`inline-flex ${className}`}>{box}</span>
  return (
    <label className={`flex w-fit max-w-full items-start gap-[10px] ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'} ${className}`}>
      <span className="mt-[2px] flex">{box}</span>
      <Words label={label} description={description} disabled={disabled} />
    </label>
  )
}

function Words({ label, description, disabled }: { label: ReactNode; description?: ReactNode; disabled: boolean }) {
  return (
    <span className="min-w-0">
      <span className={`block text-[13px] leading-[20px] ${disabled ? 'text-zinc-500' : 'text-zinc-100'}`}>{label}</span>
      {description && <span className="block text-[12.5px] leading-[18px] text-faint">{description}</span>}
    </span>
  )
}
