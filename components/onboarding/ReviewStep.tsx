'use client'

/**
 * Review: what will move, read from the source without changing it
 * (ImportPreview), beside the new project it moves into.
 *
 *   Tables           each with its rows, and its new name when it changes
 *   Users and files  how many, how they will sign in, which buckets
 *   Access rules     each waits for approval; until then only the server key reads the tables
 *   Before you move  what does not move or changes shape, in plain words
 *
 * The new project's name (the source's own, to start with) and region sit
 * with the one button that starts the move, kept in view on a laptop. A
 * source over a v1 limit is refused here, in the server's words, and the
 * button is not offered.
 */

import { useId, useState, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { ImportPreview, ImportPreviewRule } from '@/lib/import/contract'
import { KitButton, KitInput, KitNote, KitSelect, KitSwitch } from '@/components/inspector/kit'
import { EDGE, PLATE, RULE, R_PANEL } from '@/components/console/tokens'
import { Fact, Facts, Panel, Section } from '@/components/autonomy/rows'
import type { CloudRegion, CloudRegionId } from '@/lib/regions'
import { SOURCES } from '@/components/migrate/sources'
import { count, num, size } from './format'
import { FieldError } from './parts'

export interface ReviewErrors {
  name?: string
  region?: string
  form?: ReactNode
}

const RULES_SHOWN = 4

export function ReviewStep({
  preview,
  orgName,
  name,
  onName,
  region,
  onRegion,
  regions,
  include,
  onInclude,
  errors,
  busy,
  onBack,
  onStart,
}: {
  preview: ImportPreview
  orgName: string | null
  name: string
  onName: (name: string) => void
  region: CloudRegionId
  onRegion: (region: CloudRegionId) => void
  /** The regions open to this person (GET /api/regions). */
  regions: readonly CloudRegion[]
  include: { users: boolean; files: boolean }
  onInclude: (include: { users: boolean; files: boolean }) => void
  errors: ReviewErrors
  busy: boolean
  onBack: () => void
  onStart: () => void
}) {
  const from = SOURCES[preview.source].name
  const refused = !!preview.refusal

  return (
    <div className="grid items-start gap-x-[32px] gap-y-[28px] lg:grid-cols-[minmax(0,1fr)_304px]">
      <div className="min-w-0 space-y-[28px]">
        {refused && (
          <KitNote icon={AlertTriangle} tone="danger" title="This can’t be imported yet">
            {preview.refusal}
          </KitNote>
        )}
        <TablesSection preview={preview} />
        <PeopleAndFiles preview={preview} include={include} onInclude={onInclude} disabled={busy} />
        {preview.rules.length > 0 && <RulesSection rules={preview.rules} firebase={preview.source === 'firebase'} />}
        {preview.warnings.length > 0 && (
          <Section id="import-before" title="Before you move">
            <Panel>
              <ul className="divide-y divide-white/[0.06]">
                {preview.warnings.map((warning) => (
                  <li key={warning} className="px-5 py-[11px] text-[13px] leading-[20px] text-zinc-300 [overflow-wrap:anywhere]">
                    {warning}
                  </li>
                ))}
              </ul>
            </Panel>
          </Section>
        )}
      </div>

      <aside className="min-w-0 lg:sticky lg:top-[calc(var(--console-bar)+24px)]">
        <NewProjectPanel
          from={from}
          orgName={orgName}
          name={name}
          onName={onName}
          region={region}
          onRegion={onRegion}
          regions={regions}
          errors={errors}
          busy={busy}
          refused={refused}
          onBack={onBack}
          onStart={onStart}
        />
      </aside>
    </div>
  )
}

// ─── What moves ──────────────────────────────────────────────────────────────

function TablesSection({ preview }: { preview: ImportPreview }) {
  return (
    <Section id="import-tables" title="Tables" count={preview.tables.length}>
      <Panel>
        {preview.tables.length === 0 ? (
          <p className="px-5 py-4 text-[13px] leading-[20px] text-zinc-400">
            No tables found. Check that the user can read them
            {preview.source === 'postgres' ? ', and the schemas you named.' : '.'}
          </p>
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {preview.tables.map((table) => (
              <li key={table.sourceName} className="flex items-start justify-between gap-x-[16px] px-5 py-[11px]">
                <div className="min-w-0">
                  <p className="flex min-w-0 flex-wrap items-baseline gap-x-[10px] gap-y-0.5">
                    <code className="font-mono text-[12.5px] leading-[20px] text-zinc-100 [overflow-wrap:anywhere]">{table.name}</code>
                    {table.sourceName !== table.name && (
                      <span className="text-[12px] leading-[18px] text-faint [overflow-wrap:anywhere]">
                        from <code className="font-mono text-[11.5px]">{table.sourceName}</code>
                      </span>
                    )}
                  </p>
                  {table.notes.length > 0 && (
                    <ul className="mt-[2px] space-y-[2px] text-[12px] leading-[17px] text-faint">
                      {table.notes.map((note) => (
                        <li key={note} className="[overflow-wrap:anywhere]">
                          {note}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <p className="flex-shrink-0 whitespace-nowrap text-right text-[13px] leading-[20px] tabular-nums text-zinc-300">
                  {num(table.rows)} <span className="text-faint">{table.rows === 1 ? 'row' : 'rows'}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Section>
  )
}

function PeopleAndFiles({
  preview,
  include,
  onInclude,
  disabled,
}: {
  preview: ImportPreview
  include: { users: boolean; files: boolean }
  onInclude: (include: { users: boolean; files: boolean }) => void
  disabled: boolean
}) {
  const from = SOURCES[preview.source].name
  const users = preview.users
  const buckets = preview.buckets
  const files = buckets?.reduce((sum, b) => sum + b.files, 0) ?? 0
  const bytes = buckets?.reduce((sum, b) => sum + b.bytes, 0) ?? 0
  // Supabase moves Storage only with the project URL and service_role key.
  const storageLeft = preview.source === 'supabase' && buckets === null
  if (!users && !buckets?.length && !storageLeft) return null

  return (
    <Section id="import-people" title="Users and files">
      <Panel>
        <ul className="divide-y divide-white/[0.06]">
          {users && (
            <MoveRow
              title={count(users.total, 'user', 'users')}
              on={include.users}
              onChange={(users) => onInclude({ ...include, users })}
              what="users"
              from={from}
              disabled={disabled}
            >
              <Facts>
                {users.withPassword > 0 && <Fact>{num(users.withPassword)} sign in with a password</Fact>}
                {users.providerOnly > 0 && <Fact>{num(users.providerOnly)} with Google, GitHub or another provider only</Fact>}
                {users.skipped > 0 && <Fact>{num(users.skipped)} with a phone number only, not moved</Fact>}
              </Facts>
            </MoveRow>
          )}
          {buckets && buckets.length > 0 && (
            <MoveRow
              title={
                <>
                  {count(files, 'file', 'files')} <span className="font-normal text-faint">{size(bytes)}</span>
                </>
              }
              on={include.files}
              onChange={(files) => onInclude({ ...include, files })}
              what="files"
              from={from}
              disabled={disabled}
            >
              <Facts>
                {buckets.map((b) => (
                  <Fact key={b.sourceName}>
                    <code className="font-mono text-[11.5px] text-zinc-300">{b.name}</code>
                    {b.public ? 'Public' : 'Private'}
                    {b.name !== b.sourceName && <span>from {b.sourceName}</span>}
                  </Fact>
                ))}
              </Facts>
            </MoveRow>
          )}
          {storageLeft && (
            <li className="px-5 py-[12px] text-[13px] leading-[20px] text-zinc-400">
              Storage files stay in Supabase. To move them too, go back and add the project URL and{' '}
              <code className="font-mono text-[12px] text-zinc-300">service_role</code> key.
            </li>
          )}
        </ul>
      </Panel>
    </Section>
  )
}

/** Users or files: what moves, with a switch to leave them where they are. */
function MoveRow({
  title,
  on,
  onChange,
  what,
  from,
  disabled,
  children,
}: {
  title: ReactNode
  on: boolean
  onChange: (on: boolean) => void
  what: string
  from: string
  disabled: boolean
  children: ReactNode
}) {
  return (
    <li className="flex items-start justify-between gap-x-[16px] px-5 py-[12px]">
      <div className={`min-w-0 transition-opacity duration-150 ${on ? '' : 'opacity-60'}`}>
        <p className="text-[13.5px] font-medium leading-[21px] text-zinc-50">{title}</p>
        {on ? children : <p className="mt-1 text-[12px] leading-[16px] text-faint">They stay in {from}.</p>}
      </div>
      <span className="flex flex-shrink-0 items-center gap-[10px] pt-[1px]">
        <span aria-hidden className="text-[12.5px] leading-[18px] text-faint">
          Move
        </span>
        <KitSwitch checked={on} onChange={onChange} label={`Move ${what}`} disabled={disabled} />
      </span>
    </li>
  )
}

function RulesSection({ rules, firebase = false }: { rules: ImportPreviewRule[]; firebase?: boolean }) {
  const [all, setAll] = useState(false)
  const shown = all ? rules : rules.slice(0, RULES_SHOWN)
  return (
    <Section
      id="import-rules"
      title="Access rules"
      count={rules.length}
      description={
        firebase
          ? "Firestore security rules don't carry over. Until your agent adds access rules, only your server key can read or write these tables."
          : 'Each waits for your approval. Until then, only your server key can read or write the moved tables.'
      }
    >
      <Panel>
        <ul className="divide-y divide-white/[0.06]">
          {shown.map((rule, i) => (
            <li key={`${rule.table}-${i}`} className="px-5 py-[11px]">
              <p className="text-[13px] leading-[20px] text-zinc-200 [overflow-wrap:anywhere]">{rule.summary}</p>
              <div className="mt-[3px] flex min-w-0 flex-wrap items-baseline gap-x-[14px] gap-y-0.5 text-[12px] leading-[17px] text-faint">
                <code className="font-mono text-[11.5px] text-zinc-400">{rule.table}</code>
                {rule.definition && (
                  <code title={rule.definition} className="min-w-0 max-w-full truncate font-mono text-[11.5px]">
                    {rule.definition}
                  </code>
                )}
              </div>
            </li>
          ))}
        </ul>
        {rules.length > RULES_SHOWN && (
          <div className={`border-t ${RULE} px-5 py-[9px]`}>
            <button
              type="button"
              onClick={() => setAll((a) => !a)}
              aria-expanded={all}
              className="rounded-[4px] text-[12.5px] font-medium leading-[18px] text-zinc-400 transition-colors hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              {all ? 'Show fewer' : `Show all ${num(rules.length)}`}
            </button>
          </div>
        )}
      </Panel>
    </Section>
  )
}

// ─── Where it goes ───────────────────────────────────────────────────────────

function NewProjectPanel({
  from,
  orgName,
  name,
  onName,
  region,
  onRegion,
  regions,
  errors,
  busy,
  refused,
  onBack,
  onStart,
}: {
  from: string
  orgName: string | null
  name: string
  onName: (name: string) => void
  region: CloudRegionId
  onRegion: (region: CloudRegionId) => void
  regions: readonly CloudRegion[]
  errors: ReviewErrors
  busy: boolean
  refused: boolean
  onBack: () => void
  onStart: () => void
}) {
  const id = useId()
  const open = regions.filter((r) => r.open)
  return (
    <form
      noValidate
      aria-labelledby={`${id}-title`}
      className={`${PLATE} border ${EDGE} ${R_PANEL}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (!busy && !refused) onStart()
      }}
    >
      <div className="px-[20px] pb-[2px] pt-[16px]">
        <h2 id={`${id}-title`} className="text-[14px] font-medium leading-[20px] tracking-[-0.006em] text-zinc-50">
          New project
        </h2>
        {orgName && <p className="text-[12.5px] leading-[18px] text-faint">In {orgName}</p>}
      </div>
      <div className="space-y-[16px] px-[20px] pb-[18px] pt-[14px]">
        <div>
          <label htmlFor={`${id}-name`} className="mb-[6px] block text-[12.5px] font-medium leading-[18px] text-zinc-300">
            Name
          </label>
          <KitInput
            id={`${id}-name`}
            value={name}
            onChange={(e) => onName(e.target.value)}
            maxLength={100}
            autoComplete="off"
            disabled={busy || refused}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${id}-name-error` : `${id}-name-hint`}
          />
          {errors.name ? (
            <FieldError id={`${id}-name-error`} error={errors.name} />
          ) : (
            <p id={`${id}-name-hint`} className="mt-[6px] text-[12px] leading-[17px] text-faint">
              You can rename it later.
            </p>
          )}
        </div>
        <div>
          <label htmlFor={`${id}-region`} className="mb-[6px] block text-[12.5px] font-medium leading-[18px] text-zinc-300">
            Region
          </label>
          <KitSelect
            id={`${id}-region`}
            value={region}
            onChange={(e) => onRegion(e.target.value as CloudRegionId)}
            disabled={busy || refused}
            aria-invalid={errors.region ? true : undefined}
            aria-describedby={errors.region ? `${id}-region-error` : `${id}-region-hint`}
          >
            {open.map((r) => (
              <option key={r.id} value={r.id}>
                {r.city} ({r.id})
              </option>
            ))}
          </KitSelect>
          {errors.region ? (
            <FieldError id={`${id}-region-error`} error={errors.region} />
          ) : (
            <p id={`${id}-region-hint`} className="mt-[6px] text-[12px] leading-[17px] text-faint">
              Where its database and API run.
            </p>
          )}
        </div>
      </div>
      <div className={`rounded-b-[10px] border-t ${RULE} bg-white/[0.015] px-[20px] py-[14px]`}>
        {errors.form ? (
          <p role="alert" className="text-[12.5px] leading-[18px] text-rose-300 [overflow-wrap:anywhere]">
            {errors.form}
          </p>
        ) : (
          <p className="text-[12.5px] leading-[18px] text-faint">Backenly only reads {from}. Nothing there changes.</p>
        )}
        <div className="mt-[12px] flex items-center justify-end gap-[8px]">
          <KitButton variant="ghost" onClick={onBack} disabled={busy}>
            Back
          </KitButton>
          {!refused && (
            <KitButton type="submit" variant="primary" loading={busy}>
              {busy ? 'Starting…' : 'Move to Backenly'}
            </KitButton>
          )}
        </div>
      </div>
    </form>
  )
}
