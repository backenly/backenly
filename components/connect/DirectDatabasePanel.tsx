'use client'

/**
 * Connect → Postgres: real logins to this project's schema, and backups.
 *
 *   Logins
 *   Read-only                                                                 ⋯
 *   [postgresql://bkn_ro_edc2…:•••@<DIRECT_DB_HOST>:5432/backenly…     ◉ Copy]
 *   bkn_ro_edc2173ce55c   Created Nov 11       Copy psql command  Copy pg_dump command
 *   Read-write                                                    [Create login]
 *   Reads and writes rows. Schema changes are refused unless you allow them.
 *   Each login reaches only this project's schema, over TLS. …
 *
 *   Where the region has no developer-facing host (status.available false),
 *   one sentence says direct connections aren't available there, no login is
 *   offered, and the logins that exist are listed by name with Revoke.
 *
 *   Allowed addresses                                    (where the region's
 *   The database endpoint is shared by the projects in   endpoint admits only
 *   this region and admits only the addresses they allow. allowed addresses)
 *   [203.0.113.7 or 203.0.113.0/24        ] [Allow]
 *   203.0.113.7/32        Added Nov 17                ⋯
 *   1 of 2 on the Free plan.
 *
 *   Until one is allowed, the section comes first and says so ("Allow an
 *   address first"), with "Allow my address", the address the request came
 *   from as the load balancer saw it. The endpoint holds every project's
 *   addresses in the region, so nothing here claims an address is the only
 *   way in: the login's password is what reaches this project. An address
 *   past the plan's number (after a restore, or a move to a smaller plan) is
 *   listed as not admitted.
 *
 *   Backups
 *   [Full backup (.sql)]  Schema only  Data only
 *   Standard pg_dump. Restores on any Postgres.
 *
 *   ⚠ Other projects can see your table definitions          (Cloud only)
 *
 * Read-only is a SELECT-only role. Read-write writes rows; schema changes over
 * it are refused until an admin allows them (they skip approvals and
 * History), and on a database shared with other projects they cannot be
 * allowed at all, which the row says instead of offering the switch.
 *
 * Every verb of database-access is ADMIN (the status carries decrypted
 * passwords), and so is a full backup (export/database). Everyone else gets
 * one sentence, and the shared-database note, which is about what they write.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Eye, EyeOff } from 'lucide-react'
import Link from 'next/link'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import {
  CopyButton,
  KitButton,
  KitConfirmDialog,
  KitInput,
  KitNote,
  OverflowMenu,
} from '@/components/inspector/kit'
import { Fact, Facts, Panel, Row, RowList, RowSkeleton, ROW_TEXT, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { ErrorRow, RefusedLine } from '@/components/console/states'
import { EDGE, FOCUS, R_CONTROL, WELL } from '@/components/console/tokens'
import { formatTime } from '@/components/console/format'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { findRegion, HOME_REGION } from '@/lib/regions'
import { addressInRange } from '@/lib/security/allowed-address'
import { planDisplayName } from '@/lib/entitlements/plan-names'

type Mode = 'READ_ONLY' | 'READ_WRITE'

interface Credential {
  mode: Mode
  roleName: string
  password: string
  host: string
  port: number
  database: string
  connectionString: string
  psqlCommand: string
  pgDumpCommand: string
  createdAt: string
  rotatedAt: string | null
  /** READ_WRITE only. */
  schemaChanges?: 'allowed' | 'refused'
  /** READ_WRITE only, where schema changes cannot be allowed: why. */
  schemaChangesUnavailable?: 'shared_database' | 'helpers_outdated'
}

/** The addresses this project lets connect (lib/services/direct-access-addresses.ts). */
interface Allowlist {
  /** The region's endpoint admits only the addresses its projects allow. */
  enforced: boolean
  /** Earliest first; one past the plan's number is not admitted. */
  addresses: Array<{ cidr: string; createdAt: string; admitted?: boolean }>
  limit: number
  planCode: string
  planName: string
  /** Beside an address that is not admitted: what to do. */
  notAdmitted?: string
}

/** The address this request came from, and whether "Allow my address" can allow it. */
interface CallerAddress {
  address: string
  allowable: boolean
  reason?: string
}

interface Status {
  schema: string
  /** False where nothing outside Backenly can reach this project's database. */
  available?: boolean
  unavailable?: string
  credentials: Credential[]
  /** Where connections cannot be made: the logins that exist, by name, for revoking. */
  logins?: Array<{ mode: Mode; roleName: string; createdAt: string; rotatedAt: string | null }>
  allowlist?: Allowlist
  you?: CallerAddress | null
  pendingDriftEvents: number
}

const LOGIN_NAME: Record<Mode, string> = { READ_ONLY: 'Read-only', READ_WRITE: 'Read-write' }
const LOGIN_BODY: Record<Mode, string> = {
  READ_ONLY: 'Reads everything, changes nothing. For psql, TablePlus, BI tools and backups.',
  READ_WRITE: 'Reads and writes rows. Schema changes are refused unless you allow them.',
}

type BackupMode = 'full' | 'schema' | 'data'

/** The file name a response's Content-Disposition gives, if it gives one. */
function savedName(disposition: string | null): string | null {
  const m = /filename="?([^";]+)"?/i.exec(disposition ?? '')
  return m ? m[1] : null
}

/** Hand the browser a file to save, the way a download link does. */
function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // After the click has been handled: revoking at once can cancel the save.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function masked(c: Credential): string {
  return c.connectionString.replace(`:${c.password}@`, ':••••••••@')
}

/** The connection string, masked until shown; Copy always copies the real one. */
function ConnectionString({ c }: { c: Credential }) {
  const [shown, setShown] = useState(false)
  return (
    <div className={`mt-[10px] flex h-[34px] min-w-0 items-center gap-[4px] ${WELL} border ${EDGE} ${R_CONTROL} pl-[12px] pr-[4px]`}>
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-300">{shown ? c.connectionString : masked(c)}</code>
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
        title={shown ? 'Hide password' : 'Show password'}
        className={`inline-flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center ${R_CONTROL} text-zinc-500 transition-colors duration-150 hover:bg-white/[0.06] hover:text-zinc-100 ${FOCUS}`}
      >
        {shown ? <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} /> : <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />}
      </button>
      <CopyButton value={c.connectionString} label="Copy connection string" />
    </div>
  )
}

/** A quiet button that copies a command and says so. */
function CopyCommand({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <KitButton
      size="sm"
      variant="ghost"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          },
          () => {},
        )
      }}
    >
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </KitButton>
  )
}

/**
 * Where the region's endpoint admits only allowed addresses: the addresses this
 * project lets connect, a field to allow one, and "Allow my address". Each add
 * and remove is a change in History (lib/changes/resources/addresses.ts).
 */
function AllowedAddresses({
  projectId,
  allowlist,
  you,
  onChanged,
}: {
  projectId: string
  allowlist: Allowlist
  you: CallerAddress | null | undefined
  onChanged: () => Promise<void>
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; refused: boolean } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const url = `/api/projects/${projectId}/database-access/allowed-addresses`
  const count = allowlist.addresses.length
  const mineListed = !!you?.allowable && allowlist.addresses.some((a) => addressInRange(you.address, a.cidr))

  async function allow(body: { address: string } | { mine: true }, key: string) {
    setBusy(key)
    setNote(null)
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'That did not work. Try again.')
      const cidr: string = data.address?.cidr ?? ''
      setValue('')
      setNote({
        text: !data.added
          ? `${cidr} was already allowed.`
          : data.applied === false
            ? `${cidr} is allowed. The database endpoint takes it within five minutes.`
            : `${cidr} is allowed.`,
        refused: false,
      })
      await onChanged()
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : 'That did not work. Try again.', refused: true })
    } finally {
      setBusy(null)
    }
  }

  async function remove(cidr: string) {
    setBusy(`remove:${cidr}`)
    setNote(null)
    try {
      const res = await fetch(`${url}?address=${encodeURIComponent(cidr)}`, { method: 'DELETE', credentials: 'include' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'That did not work. Try again.')
      setNote({ text: `${cidr} removed.`, refused: false })
      await onChanged()
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : 'That did not work. Try again.', refused: true })
    } finally {
      setBusy(null)
    }
  }

  const mine =
    you?.allowable && !mineListed ? (
      <KitButton
        size="sm"
        variant={count === 0 ? 'secondary' : 'ghost'}
        loading={busy === 'mine'}
        disabled={busy !== null}
        onClick={() => void allow({ mine: true }, 'mine')}
      >
        Allow my address ({you.address})
      </KitButton>
    ) : null

  return (
    <Section
      id="postgres-addresses"
      title="Allowed addresses"
      count={count}
      description="The database endpoint is shared by the projects in this region and admits only the addresses they allow. Allow the ones you connect from; a login's password is what lets a connection into this project."
    >
      <Panel clip={false}>
        {count === 0 && (
          <div className="border-b border-white/[0.06] px-[20px] py-[14px]">
            <p className={ROW_TITLE}>Allow an address first</p>
            <p className={ROW_TEXT}>
              The endpoint refuses an address no project in this region allows. Allow the one you connect from.
            </p>
            {mine ? (
              <div className="mt-[10px]">{mine}</div>
            ) : you && !you.allowable && you.reason ? (
              <p className="mt-[8px] text-[12.5px] leading-[18px] text-faint">{you.reason}</p>
            ) : null}
          </div>
        )}
        <form
          className="flex flex-wrap gap-[8px] px-[20px] py-[14px]"
          onSubmit={(e) => {
            e.preventDefault()
            if (value.trim()) void allow({ address: value.trim() }, 'add')
          }}
        >
          <KitInput
            name="postgres-address"
            autoComplete="off"
            spellCheck={false}
            inputMode="decimal"
            aria-label="Address or range to allow"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="203.0.113.7 or 203.0.113.0/24"
            disabled={busy !== null}
            className="min-w-0 flex-[1_1_220px]"
          />
          <KitButton type="submit" loading={busy === 'add'} disabled={!value.trim() || busy !== null}>
            Allow
          </KitButton>
          {count > 0 && mine}
        </form>
        {note && (
          <div className="border-t border-white/[0.06] px-[20px] py-[10px]">
            {note.refused ? (
              <RefusedLine>{note.text}</RefusedLine>
            ) : (
              <p role="status" className="text-[12.5px] leading-[18px] text-zinc-300">
                {note.text}
              </p>
            )}
          </div>
        )}
        {count > 0 && (
          <div className="border-t border-white/[0.06]">
            <RowList>
              {allowlist.addresses.map((a) => (
                <Row
                  key={a.cidr}
                  lead="none"
                  title={<p className={`font-mono !text-[12.5px] ${ROW_TITLE}`}>{a.cidr}</p>}
                  actions={
                    <OverflowMenu
                      label={`Actions for ${a.cidr}`}
                      disabled={busy !== null}
                      items={[{ label: 'Remove', danger: true, onClick: () => setRemoving(a.cidr) }]}
                    />
                  }
                >
                  <Facts className="!mt-[4px]">
                    <Fact>Added {formatTime(a.createdAt, 'date')}</Fact>
                    {you?.allowable && addressInRange(you.address, a.cidr) && <Fact>Your address</Fact>}
                    {a.admitted === false && <Fact strong>{allowlist.notAdmitted ?? `Not admitted on the ${planDisplayName(allowlist.planCode)} plan.`}</Fact>}
                  </Facts>
                </Row>
              ))}
            </RowList>
          </div>
        )}
      </Panel>
      <p className="mt-[10px] text-[12.5px] leading-[18px] text-faint">
        {count} of {allowlist.limit} on the {planDisplayName(allowlist.planCode)} plan.
      </p>

      <KitConfirmDialog
        open={removing !== null}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const cidr = removing
          setRemoving(null)
          if (cidr) void remove(cidr)
        }}
        danger
        title={`Remove ${removing ?? 'this address'}?`}
        description="New connections from it are refused, unless another project in this region allows it too. Connections already open stay open: rotate a login's password to end them."
        undoable
        confirmLabel="Remove address"
      />
    </Section>
  )
}

type Confirm = { kind: 'revoke' | 'rotate'; mode: Mode } | { kind: 'allow' } | null

export function DirectDatabasePanel({ projectId, region }: { projectId: string; region?: string | null }) {
  const role = useProjectRole(projectId)
  const [status, setStatus] = useState<Status | null>(null)
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retrying, setRetrying] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [note, setNote] = useState<{ mode: Mode | null; text: string; refused: boolean } | null>(null)
  const [exporting, setExporting] = useState<BackupMode | null>(null)
  const [backupNote, setBackupNote] = useState<{ text: string; refused: boolean } | null>(null)
  const canSee = role.canAdminister

  const read = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/database-access`, { credentials: 'include' })
      if (!res.ok) throw new Error('Could not load the logins')
      setStatus(await res.json())
      setLoad('ready')
    } catch {
      setLoad((prev) => (prev === 'ready' ? 'ready' : 'error'))
    } finally {
      setRetrying(false)
    }
  }, [projectId])

  useEffect(() => {
    if (canSee) void read()
  }, [canSee, read])

  /** One call to database-access, its outcome said on the login's row. */
  async function act(key: string, mode: Mode | null, run: () => Promise<Response>, done: string) {
    setBusy(key)
    setNote(null)
    try {
      const res = await run()
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'That did not work. Try again.')
      setNote({ mode, text: done, refused: false })
      await read()
    } catch (err) {
      setNote({ mode, text: err instanceof Error ? err.message : 'That did not work. Try again.', refused: true })
    } finally {
      setBusy(null)
    }
  }

  const send = (method: 'POST' | 'PATCH', body: unknown): RequestInit => ({
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const provision = (mode: Mode) =>
    act(`provision_${mode}`, mode, () => fetch(`/api/projects/${projectId}/database-access`, send('POST', { mode })), `${LOGIN_NAME[mode]} login created.`)
  const rotate = (mode: Mode) =>
    act(
      `rotate_${mode}`,
      mode,
      () => fetch(`/api/projects/${projectId}/database-access/rotate`, send('POST', { mode })),
      'Password rotated. Old sessions were disconnected.',
    )
  const revoke = (mode: Mode) =>
    act(
      `revoke_${mode}`,
      mode,
      () => fetch(`/api/projects/${projectId}/database-access?mode=${mode}`, { method: 'DELETE', credentials: 'include' }),
      `${LOGIN_NAME[mode]} login revoked.`,
    )
  const setSchemaChanges = (value: 'allowed' | 'refused') =>
    act(
      'schema_changes',
      'READ_WRITE',
      () => fetch(`/api/projects/${projectId}/database-access`, send('PATCH', { schemaChanges: value })),
      value === 'allowed' ? 'Schema changes are now allowed over this login.' : 'Schema changes are now refused over this login.',
    )

  const cityName = (findRegion(region) ?? findRegion(HOME_REGION))?.city ?? 'this region'
  const sharedNote = CLOUD_CONTROL_PLANE && (
    // PostgreSQL lets every login in a database read its catalogs, and nothing on a shared database can narrow that.
    <KitNote tone="warn" icon={AlertTriangle} title="Other projects can see your table definitions">
      Every project in {cityName}, from every account, shares one Postgres database, and any project&apos;s login can read its
      catalogs. They show
      every project&apos;s ID, the names and definitions of its tables, columns, constraints, policies, views and functions, and its
      row counts, yours included. They show no row data. Keep secrets out of names, comments, defaults, policies, views and
      function code.
    </KitNote>
  )

  if (!canSee) {
    return (
      <div className="space-y-[36px]">
        <Section id="postgres-logins" title="Logins">
          <Panel>
            {role.loading ? (
              <RowSkeleton rows={2} lead="none" />
            ) : (
              <p className="px-[20px] py-[14px] text-[13px] leading-[20px] text-zinc-400">
                Only owners and admins can see database logins and download backups.
              </p>
            )}
          </Panel>
        </Section>
        {sharedNote}
      </div>
    )
  }

  const byMode = (mode: Mode) => status?.credentials.find((c) => c.mode === mode) ?? null

  /**
   * A login nothing outside Backenly can connect with: its name, and Revoke.
   * No connection string, password or command is shown for it (production QA
   * re-test, 2026-11-16, N4: they named backenly.com:5432, where nothing
   * listens).
   */
  const unreachableLoginRow = (login: NonNullable<Status['logins']>[number]) => (
    <Row
      key={login.mode}
      lead="none"
      title={<p className={ROW_TITLE}>{LOGIN_NAME[login.mode]}</p>}
      actions={
        <KitButton size="sm" variant="ghost" loading={busy === `revoke_${login.mode}`} disabled={busy !== null} onClick={() => setConfirm({ kind: 'revoke', mode: login.mode })}>
          Revoke
        </KitButton>
      }
    >
      <span className="!mt-[4px] flex flex-wrap items-center gap-x-[16px] gap-y-[4px] text-[12px] leading-[16px] text-faint">
        <code className="font-mono text-[11.5px] text-zinc-400">{login.roleName}</code>
        <span>{login.rotatedAt ? `Rotated ${formatTime(login.rotatedAt, 'date')}` : `Created ${formatTime(login.createdAt, 'date')}`}</span>
      </span>
      {note && note.mode === login.mode && note.refused && <RefusedLine className="mt-[8px]">{note.text}</RefusedLine>}
    </Row>
  )

  const loginRow = (mode: Mode) => {
    const c = byMode(mode)
    const rw = mode === 'READ_WRITE' ? c : null
    const schemaItems = rw
      ? rw.schemaChanges === 'allowed'
        ? [{ label: 'Refuse schema changes', onClick: () => void setSchemaChanges('refused') }]
        : rw.schemaChangesUnavailable
          ? []
          : [{ label: 'Allow schema changes', onClick: () => setConfirm({ kind: 'allow' }) }]
      : []
    return (
      <Row
        key={mode}
        lead="none"
        title={<p className={ROW_TITLE}>{LOGIN_NAME[mode]}</p>}
        actions={
          c ? (
            <OverflowMenu
              label={`Actions for the ${LOGIN_NAME[mode].toLowerCase()} login`}
              width="w-[220px]"
              disabled={busy !== null}
              items={[
                { label: 'Rotate password', onClick: () => setConfirm({ kind: 'rotate', mode }) },
                ...schemaItems,
                { separator: true as const },
                { label: 'Revoke', danger: true, onClick: () => setConfirm({ kind: 'revoke', mode }) },
              ]}
            />
          ) : (
            <KitButton size="sm" loading={busy === `provision_${mode}`} disabled={busy !== null} onClick={() => void provision(mode)}>
              Create login
            </KitButton>
          )
        }
      >
        {!c ? (
          <p className={`!mt-[4px] ${ROW_TEXT}`}>{LOGIN_BODY[mode]}</p>
        ) : (
          <>
            <ConnectionString c={c} />
            <div className="mt-[8px] flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[6px]">
              <span className="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] text-[12px] leading-[16px] text-faint">
                <code className="font-mono text-[11.5px] text-zinc-400">{c.roleName}</code>
                <span>{c.rotatedAt ? `Rotated ${formatTime(c.rotatedAt, 'date')}` : `Created ${formatTime(c.createdAt, 'date')}`}</span>
              </span>
              <span className="-mr-[8px] flex flex-wrap items-center gap-[2px]">
                <CopyCommand value={c.psqlCommand} label="Copy psql command" />
                <CopyCommand value={c.pgDumpCommand} label="Copy pg_dump command" />
              </span>
            </div>
            {rw?.schemaChanges === 'allowed' ? (
              <p className="mt-[8px] text-[12.5px] leading-[18px] text-zinc-50">
                Schema changes are allowed over this login. They skip approvals and History.
                {rw.schemaChangesUnavailable === 'shared_database' &&
                  ' This project’s database is shared with other projects, so Backenly takes them away at the login’s next sync.'}
              </p>
            ) : rw?.schemaChangesUnavailable ? (
              <p className="mt-[8px] text-[12.5px] leading-[18px] text-faint">
                Schema changes over this login are refused.{' '}
                {rw.schemaChangesUnavailable === 'shared_database'
                  ? 'They can’t be allowed here: this project’s database is shared with other projects, and a trigger, function or view made over the login would run with access to all of them.'
                  : 'This database needs its direct-access helpers updated before that can change.'}
              </p>
            ) : rw ? (
              <p className="mt-[8px] text-[12.5px] leading-[18px] text-faint">Schema changes over this login are refused.</p>
            ) : null}
            {rw && (status?.pendingDriftEvents ?? 0) > 0 && (
              <p className="mt-[6px] text-[12.5px] leading-[18px] text-zinc-50">
                {status!.pendingDriftEvents} schema {status!.pendingDriftEvents === 1 ? 'change' : 'changes'} made over this login
                {status!.pendingDriftEvents === 1 ? ' waits' : ' wait'} in{' '}
                <Link href={`/app/projects/${projectId}/autonomy`} className={`rounded-[3px] underline decoration-zinc-50/40 underline-offset-2 ${FOCUS}`}>
                  Autonomy
                </Link>
                .
              </p>
            )}
          </>
        )}
        {note && note.mode === mode && (
          note.refused ? (
            <RefusedLine className="mt-[8px]">{note.text}</RefusedLine>
          ) : (
            <p role="status" className="mt-[8px] text-[12.5px] leading-[18px] text-zinc-300">
              {note.text}
            </p>
          )
        )}
      </Row>
    )
  }

  /**
   * Fetch the backup and save it only when the server finished it. A link with
   * `download` saved whatever came back, so a failed export arrived as a file
   * named database.json holding the error, and the page said nothing
   * (production QA re-test, 2026-11-16, N5).
   */
  async function backup(mode: BackupMode) {
    setExporting(mode)
    setBackupNote(null)
    try {
      let res: Response
      try {
        res = await fetch(`/api/projects/${projectId}/export/database?mode=${mode}`, { credentials: 'include' })
      } catch {
        throw new Error('The backup could not reach Backenly. Nothing was downloaded. Try again.')
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(
          typeof data?.error === 'string' && data.error
            ? data.error
            : `The backup did not finish (HTTP ${res.status}). Nothing was downloaded. Try again.`,
        )
      }
      const name = savedName(res.headers.get('Content-Disposition')) ?? `backup-${mode}.sql`
      saveFile(await res.blob(), name)
      setBackupNote({ text: `Downloaded ${name}.`, refused: false })
    } catch (err) {
      setBackupNote({ text: err instanceof Error ? err.message : 'The backup did not finish. Nothing was downloaded. Try again.', refused: true })
    } finally {
      setExporting(null)
    }
  }

  const download = (mode: BackupMode, label: string, variant: 'secondary' | 'ghost') => (
    <KitButton size="sm" variant={variant} onClick={() => void backup(mode)} loading={exporting === mode} disabled={exporting !== null}>
      {label}
    </KitButton>
  )

  const allowlist = status?.available !== false && status?.allowlist?.enforced ? status.allowlist : null

  return (
    <div className="space-y-[36px]">
      {allowlist && <AllowedAddresses projectId={projectId} allowlist={allowlist} you={status?.you} onChanged={read} />}

      <Section id="postgres-logins" title="Logins">
        <Panel clip={false}>
          {load === 'loading' ? (
            <RowSkeleton rows={2} lead="none" />
          ) : load === 'error' ? (
            <ErrorRow
              things="database logins"
              onRetry={() => {
                setRetrying(true)
                void read()
              }}
              retrying={retrying}
            />
          ) : status?.available === false ? (
            <RowList>
              <li className="px-[20px] py-[14px]">
                <p className="text-[13px] leading-[20px] text-zinc-400">
                  Direct Postgres connections aren&apos;t available in this project&apos;s region yet: nothing outside Backenly can
                  reach its database. Read and change data in the Database section or through the REST API, and download a backup
                  below.
                </p>
              </li>
              {(status.logins ?? []).map(unreachableLoginRow)}
            </RowList>
          ) : (
            <RowList>{(['READ_ONLY', 'READ_WRITE'] as const).map(loginRow)}</RowList>
          )}
        </Panel>
        {status?.available !== false && (
          <p className="mt-[10px] text-[12.5px] leading-[18px] text-faint">
            Each login reaches only this project&apos;s schema, over TLS. Every change to a login is recorded; rotate at once if a
            connection string leaks.
          </p>
        )}
      </Section>

      <Section id="postgres-backups" title="Backups">
        <Panel>
          <div className="px-[20px] py-[14px]">
            <div className="flex flex-wrap items-center gap-[8px]">
              {download('full', 'Full backup (.sql)', 'secondary')}
              {download('schema', 'Schema only', 'ghost')}
              {download('data', 'Data only', 'ghost')}
            </div>
            {backupNote &&
              (backupNote.refused ? (
                <RefusedLine className="mt-[8px]">{backupNote.text}</RefusedLine>
              ) : (
                <p role="status" className="mt-[8px] text-[12.5px] leading-[18px] text-zinc-300">
                  {backupNote.text}
                </p>
              ))}
            <p className="mt-[10px] text-[12.5px] leading-[18px] text-faint">Standard pg_dump. Restores on any Postgres.</p>
          </div>
        </Panel>
      </Section>

      {sharedNote}

      <KitConfirmDialog
        open={confirm?.kind === 'revoke'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm?.kind === 'revoke') void revoke(confirm.mode)
          setConfirm(null)
        }}
        danger
        title={`Revoke the ${confirm && confirm.kind === 'revoke' ? LOGIN_NAME[confirm.mode].toLowerCase() : ''} login?`}
        description="Anything connected with it is disconnected immediately."
        undoable={false}
        confirmLabel="Revoke login"
      />
      <KitConfirmDialog
        open={confirm?.kind === 'rotate'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm?.kind === 'rotate') void rotate(confirm.mode)
          setConfirm(null)
        }}
        title="Rotate the password?"
        description="Tools using the old password are disconnected and need the new connection string."
        confirmLabel="Rotate password"
      />
      <KitConfirmDialog
        open={confirm?.kind === 'allow'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null)
          void setSchemaChanges('allowed')
        }}
        danger
        title="Allow schema changes over this login?"
        description="A table changed or dropped over it skips approvals and History, so Backenly can’t undo it. Autonomy asks you before it adopts the change into your APIs."
        confirmLabel="Allow schema changes"
      />
    </div>
  )
}
