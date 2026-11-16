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
  BUTTON_BASE,
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  CopyButton,
  KitButton,
  KitConfirmDialog,
  KitNote,
  OverflowMenu,
} from '@/components/inspector/kit'
import { Panel, Row, RowList, RowSkeleton, ROW_TEXT, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { ErrorRow, RefusedLine } from '@/components/console/states'
import { EDGE, FOCUS, R_CONTROL, WELL } from '@/components/console/tokens'
import { formatTime } from '@/components/console/format'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { findRegion, HOME_REGION } from '@/lib/regions'

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

interface Status {
  schema: string
  /** False where nothing outside Backenly can reach this project's database. */
  available?: boolean
  unavailable?: string
  credentials: Credential[]
  /** Where connections cannot be made: the logins that exist, by name, for revoking. */
  logins?: Array<{ mode: Mode; roleName: string; createdAt: string; rotatedAt: string | null }>
  pendingDriftEvents: number
}

const LOGIN_NAME: Record<Mode, string> = { READ_ONLY: 'Read-only', READ_WRITE: 'Read-write' }
const LOGIN_BODY: Record<Mode, string> = {
  READ_ONLY: 'Reads everything, changes nothing. For psql, TablePlus, BI tools and backups.',
  READ_WRITE: 'Reads and writes rows. Schema changes are refused unless you allow them.',
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

type Confirm = { kind: 'revoke' | 'rotate'; mode: Mode } | { kind: 'allow' } | null

export function DirectDatabasePanel({ projectId, region }: { projectId: string; region?: string | null }) {
  const role = useProjectRole(projectId)
  const [status, setStatus] = useState<Status | null>(null)
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retrying, setRetrying] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [note, setNote] = useState<{ mode: Mode | null; text: string; refused: boolean } | null>(null)
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

  const download = (mode: 'full' | 'schema' | 'data', label: string, variant: 'secondary' | 'ghost') => (
    // Links styled as buttons: a button inside a link is two focus stops and invalid HTML.
    <a href={`/api/projects/${projectId}/export/database?mode=${mode}`} download className={`${BUTTON_BASE} ${BUTTON_SIZES.sm} ${BUTTON_VARIANTS[variant]}`}>
      {label}
    </a>
  )

  return (
    <div className="space-y-[36px]">
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
