'use client'

/**
 * New project: a name and, on Backenly Cloud, where it runs. That is the
 * whole dialog: Backenly first (the founder's call, 2026-11-16). Moving an
 * existing backend in is one quiet line in the footer, beside the buttons,
 * where the import API answers (Backenly Cloud): "Import from Supabase,
 * Firebase or Postgres" opens the import flow (/app/org/[orgId]/import),
 * which creates its own new project. A plan with no room is said before the
 * dialog, by the page.
 *
 * Label and hint on the left, the control on the right, rows on hairlines; on
 * a phone the rows stack. The organization it lands in is said once, under
 * the title.
 *
 * Region lists the Backenly Cloud regions from lib/regions.ts as this
 * deployment serves them (GET /api/regions): the open ones as choices, the
 * rest once, below, as "Not open yet", so nobody picks a place their project
 * would not actually run. The server refuses a region that is not open as well.
 */

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { KitButton, KitInput, KitModal, KitNote } from '@/components/inspector/kit'
import { EDGE, FOCUS, RULE, R_CONTROL, WELL } from '@/components/console/tokens'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { CLOUD_REGIONS, HOME_REGION, type CloudRegion, type CloudRegionId } from '@/lib/regions'
import { SourceMark } from '@/components/migrate/sources'

export function NewProjectDialog({
  open,
  creating,
  error,
  orgName,
  onClose,
  onCreate,
  importHref,
}: {
  open: boolean
  creating: boolean
  error?: string | null
  /** The organization it will be created in, when there is one. */
  orgName?: string | null
  onClose: () => void
  onCreate: (input: { name: string; region: CloudRegionId | null }) => void
  /** Where the import flow starts; set only where importing is offered. */
  importHref?: string | null
}) {
  const [name, setName] = useState('')
  const [region, setRegion] = useState<CloudRegionId>(HOME_REGION)
  const nameRef = useRef<HTMLInputElement>(null)
  const nameId = useId()
  const nameHintId = useId()
  const regionLabelId = useId()
  const regionHintId = useId()
  // A fresh dialog each time it opens, reset while rendering rather than after.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setName('')
      setRegion(HOME_REGION)
    }
  }

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed && !creating) onCreate({ name: trimmed, region: CLOUD_CONTROL_PLANE ? region : null })
  }

  return (
    <KitModal
      open={open}
      onClose={onClose}
      width="max-w-[640px]"
      title="New project"
      description={orgName ? <span className="text-faint">In {orgName}</span> : undefined}
      footer={
        <>
          {importHref && (
            <span className="flex items-center gap-[8px] pt-[2px] sm:mr-auto sm:pt-0">
              <span className="flex items-center gap-[6px] text-zinc-500" aria-hidden>
                <SourceMark id="supabase" className="h-[12px] w-[12px]" />
                <SourceMark id="firebase" className="h-[12px] w-[12px]" />
                <SourceMark id="postgres" className="h-[12px] w-[12px]" />
              </span>
              <Link
                href={importHref}
                className={`rounded-[4px] text-[12.5px] leading-[18px] text-zinc-400 underline decoration-white/20 underline-offset-[3px] transition-colors hover:text-zinc-100 hover:decoration-white/60 ${FOCUS}`}
              >
                Import from Supabase, Firebase or Postgres
              </Link>
            </span>
          )}
          <KitButton variant="ghost" onClick={onClose} disabled={creating}>
            Cancel
          </KitButton>
          <KitButton variant="primary" onClick={submit} disabled={!name.trim()} loading={creating}>
            Create
          </KitButton>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="-mt-2 divide-y divide-white/[0.06]">
          <FormRow label="Project name" hint="You can rename it later." htmlFor={nameId} hintId={nameHintId}>
            <KitInput
              ref={nameRef}
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-app"
              maxLength={100}
              disabled={creating}
              autoComplete="off"
              aria-describedby={nameHintId}
            />
          </FormRow>

          {CLOUD_CONTROL_PLANE && (
            <FormRow label="Region" hint="Where its database and API run." labelId={regionLabelId} hintId={regionHintId}>
              <RegionPicker
                value={region}
                onChange={setRegion}
                disabled={creating}
                labelledBy={regionLabelId}
                describedBy={regionHintId}
              />
            </FormRow>
          )}
        </div>

        {/* A hidden submit keeps Enter in the name field submitting the form. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />

        {error && (
          <div className="mt-4">
            <KitNote icon={AlertTriangle} tone="danger">
              {error}
            </KitNote>
          </div>
        )}
      </form>
    </KitModal>
  )
}

/** One row of the form: what it is on the left, the control on the right. */
function FormRow({
  label,
  hint,
  htmlFor,
  labelId,
  hintId,
  children,
}: {
  label: string
  hint: string
  htmlFor?: string
  labelId?: string
  hintId: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-[10px] py-4 sm:grid-cols-[148px_minmax(0,1fr)] sm:gap-6">
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
        <p id={hintId} className="mt-0.5 text-[12px] leading-[17px] text-faint [text-wrap:pretty]">
          {hint}
        </p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/**
 * The regions with what this deployment serves as open (GET /api/regions), so
 * a region opened on the running deployment can be chosen without a new build.
 * Until the answer arrives, or if it never does, the build's own list stands.
 * The answer can only open a region this build lists; creating the project is
 * checked again on the server either way.
 */
export function useRegionsAsServed(): readonly CloudRegion[] {
  const [regions, setRegions] = useState<readonly CloudRegion[]>(CLOUD_REGIONS)
  useEffect(() => {
    let cancelled = false
    fetch('/api/regions')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { regions?: { id?: unknown; open?: unknown }[] } | null) => {
        if (cancelled || !Array.isArray(body?.regions)) return
        const open = new Set(body.regions.filter((r) => r?.open === true).map((r) => r.id))
        setRegions(CLOUD_REGIONS.map((r) => ({ ...r, open: r.open || open.has(r.id) })))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return regions
}

/** City, area and id in fixed columns, so the list reads down as well as across. */
const REGION_LINE = 'grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3 sm:grid-cols-[16px_minmax(0,1fr)_96px_104px]'

/**
 * The open regions as one radio list. Native radio inputs underneath: Tab
 * reaches the group and the arrow keys move between regions. The regions not
 * open yet follow once, as plain text: nothing to choose, nothing to skip.
 */
export function RegionPicker({
  value,
  onChange,
  disabled,
  labelledBy,
  describedBy,
}: {
  value: CloudRegionId
  onChange: (region: CloudRegionId) => void
  disabled?: boolean
  labelledBy: string
  describedBy: string
}) {
  const regions = useRegionsAsServed()
  const open = regions.filter((r) => r.open)
  const closed = regions.filter((r) => !r.open)
  return (
    <div className={`overflow-hidden ${R_CONTROL} border ${EDGE} ${WELL}`}>
      <div role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy} className="divide-y divide-white/[0.06]">
        {open.map((r) => {
          const selected = r.id === value
          return (
            <label
              key={r.id}
              className={`${REGION_LINE} min-h-[40px] cursor-pointer px-3 py-2 transition-colors duration-150 hover:bg-white/[0.03] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-white/70 ${
                selected ? 'bg-white/[0.04]' : ''
              }`}
            >
              <input
                type="radio"
                name="project-region"
                value={r.id}
                checked={selected}
                disabled={disabled}
                onChange={() => onChange(r.id)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={`flex h-[16px] w-[16px] items-center justify-center rounded-full border transition-colors duration-150 ${
                  selected ? 'border-white' : 'border-white/25'
                }`}
              >
                {selected && <span className="h-[8px] w-[8px] rounded-full bg-white" />}
              </span>
              <span className="truncate text-[13px] font-medium leading-[20px] text-zinc-100">{r.city}</span>
              <span className="hidden truncate text-[12px] leading-[16px] text-faint sm:block">{r.area}</span>
              <code className="truncate text-right font-mono text-[11.5px] leading-[16px] text-faint">{r.id}</code>
            </label>
          )
        })}
      </div>
      {closed.length > 0 && (
        <div className={`border-t ${RULE} px-3 pb-2 pt-[10px]`}>
          <p className="text-[12px] leading-[16px] text-faint">Not open yet</p>
          <ul className="mt-1">
            {closed.map((r) => (
              <li key={r.id} className={`${REGION_LINE} min-h-[30px]`}>
                <span aria-hidden />
                <span className="truncate text-[13px] leading-[20px] text-zinc-400">{r.city}</span>
                <span className="hidden truncate text-[12px] leading-[16px] text-faint sm:block">{r.area}</span>
                <code className="truncate text-right font-mono text-[11.5px] leading-[16px] text-faint">{r.id}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
