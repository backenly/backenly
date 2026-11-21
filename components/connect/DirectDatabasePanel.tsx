'use client'

/**
 * Connect → Postgres: real logins to this project's data, and backups.
 *
 *   Logins
 *   Read-only                                                                 ⋯
 *   Session (port 5432): migrations, psql, pg_dump
 *   [postgresql://bkn_ro_edc2…:•••@ap-south-1.db.backenly.com:5432/p_…   ◉ Copy]
 *   Transaction (port 6543): application traffic, serverless
 *   [postgresql://bkn_ro_edc2…:•••@ap-south-1.db.backenly.com:6543/p_…   ◉ Copy]
 *   bkn_ro_edc2173ce55c   Created Nov 11       Copy psql command  Copy pg_dump command
 *   Read-write                                                    [Create login]
 *   Reads and writes rows. Schema changes are refused unless you allow them.
 *   Each login reaches only this project's schema, over TLS, with up to 2
 *   connections at once. …
 *   Port 5432 is session pooling … Prisma: … (the pooler's guidance)
 *
 *   A project with a database of its own is reached through its region's
 *   connection pooler (lib/services/direct-access.ts): two strings per login,
 *   session and transaction. Its read-write login's password is shown once,
 *   right after the login is made or rotated, with a line saying to copy it
 *   now; after that the strings carry [YOUR-PASSWORD] and the row says the
 *   password was shown once and that rotating gives a new one. A project on a
 *   database its operator gives a host for (a self-hosted deployment) keeps
 *   one string per login.
 *
 *   Where nothing outside Backenly can reach the project's database
 *   (status.available false), the server's sentence says why, no login is
 *   offered, and the logins that exist are listed by name with Revoke.
 *
 *   Backups
 *   [Full backup (.sql)]  Schema only  Data only
 *   Standard pg_dump. Restores on any Postgres.
 *
 *   ⚠ Other projects can see your table definitions    (Cloud, shared database)
 *
 * Read-only is a SELECT-only role. Read-write writes rows; schema changes over
 * it are refused until an admin allows them (they skip approvals and
 * History), and where they cannot be allowed at all the row says why instead
 * of offering the switch.
 *
 * Every verb of database-access is ADMIN (the status carries passwords), and
 * so is a full backup (export/database). Everyone else gets one sentence, and
 * the shared-database note, which is about what they write.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Eye, EyeOff } from 'lucide-react'
import Link from 'next/link'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { CopyButton, KitButton, KitConfirmDialog, KitNote, OverflowMenu } from '@/components/inspector/kit'
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
  /** Null where it is not shown: see passwordShown. */
  password: string | null
  /** always: on every read. once: only right after the login is made or rotated. rotate: not until it is rotated. */
  passwordShown?: 'always' | 'once' | 'rotate'
  host: string
  port: number
  database: string
  /** Through the pooler: the session string (5432). Elsewhere the one string. */
  connectionString: string
  /** Through the pooler only: the transaction string (6543). */
  transactionConnectionString?: string
  transactionPort?: number
  psqlCommand: string
  pgDumpCommand: string
  createdAt: string
  rotatedAt: string | null
  /** READ_WRITE only. */
  schemaChanges?: 'allowed' | 'refused'
  /** READ_WRITE only, where schema changes cannot be allowed: why. */
  schemaChangesUnavailable?: 'shared_database' | 'pooler_not_offered' | 'helpers_outdated'
}

interface Status {
  schema: string
  /** False where nothing outside Backenly can reach this project's database. */
  available?: boolean
  unavailable?: string
  /** Where the project's data is: its region's shared database, or one of its own. */
  tenancy?: 'shared' | 'dedicated'
  /** Where connections go through the connection pooler. */
  pooler?: { host: string; sessionPort: number; transactionPort: number; guidance: string[] }
  credentials: Credential[]
  /** Where connections cannot be made: the logins that exist, by name, for revoking. */
  logins?: Array<{ mode: Mode; roleName: string; createdAt: string; rotatedAt: string | null }>
  /** Connections each login may hold at once, by the plan. */
  connectionLimit?: number | null
  pendingDriftEvents: number
}

const LOGIN_NAME: Record<Mode, string> = { READ_ONLY: 'Read-only', READ_WRITE: 'Read-write' }
const LOGIN_BODY: Record<Mode, string> = {
  READ_ONLY: 'Reads everything, changes nothing. For psql, TablePlus, BI tools and backups.',
  READ_WRITE: 'Reads and writes rows. Schema changes are refused unless you allow them.',
}

/** Why schema changes over the read-write login can't be allowed, where they can't. */
const SCHEMA_CHANGES_UNAVAILABLE: Record<NonNullable<Credential['schemaChangesUnavailable']>, string> = {
  shared_database:
    'They can’t be allowed here: this project’s database is shared with other projects, and a trigger, function or view made over the login would run with access to all of them.',
  pooler_not_offered: 'They can’t be allowed here until the connection pooler is offered in this project’s region.',
  helpers_outdated: 'This database needs its direct-access helpers updated before that can change.',
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

function masked(value: string, password: string | null): string {
  return password ? value.replace(`:${password}@`, ':••••••••@') : value
}

/** A connection string, its password masked until shown; Copy always copies the real one. */
function ConnectionString({
  value,
  password,
  copyLabel = 'Copy connection string',
}: {
  value: string
  password: string | null
  copyLabel?: string
}) {
  const [shown, setShown] = useState(false)
  return (
    <div className={`mt-[6px] flex h-[34px] min-w-0 items-center gap-[4px] ${WELL} border ${EDGE} ${R_CONTROL} pl-[12px] pr-[4px]`}>
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-300">{shown ? value : masked(value, password)}</code>
      {password && (
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
      )}
      <CopyButton value={value} label={copyLabel} />
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
  /**
   * A login just made or rotated, as that answer gave it: the one time a
   * password shown once is on the page. Kept until the page is left, or the
   * login is rotated or revoked again.
   */
  const [fresh, setFresh] = useState<Partial<Record<Mode, Credential>>>({})
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
  async function act(key: string, mode: Mode | null, run: () => Promise<Response>, done: string, keep: 'credential' | 'forget' | 'none' = 'none') {
    setBusy(key)
    setNote(null)
    try {
      const res = await run()
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'That did not work. Try again.')
      if (mode && keep === 'credential' && data.credential) setFresh((f) => ({ ...f, [mode]: data.credential as Credential }))
      if (mode && keep === 'forget') setFresh((f) => ({ ...f, [mode]: undefined }))
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
    act(
      `provision_${mode}`,
      mode,
      () => fetch(`/api/projects/${projectId}/database-access`, send('POST', { mode })),
      `${LOGIN_NAME[mode]} login created.`,
      'credential',
    )
  const rotate = (mode: Mode) =>
    act(
      `rotate_${mode}`,
      mode,
      () => fetch(`/api/projects/${projectId}/database-access/rotate`, send('POST', { mode })),
      'Password rotated. Old sessions were disconnected.',
      'credential',
    )
  const revoke = (mode: Mode) =>
    act(
      `revoke_${mode}`,
      mode,
      () => fetch(`/api/projects/${projectId}/database-access?mode=${mode}`, { method: 'DELETE', credentials: 'include' }),
      `${LOGIN_NAME[mode]} login revoked.`,
      'forget',
    )
  const setSchemaChanges = (value: 'allowed' | 'refused') =>
    act(
      'schema_changes',
      'READ_WRITE',
      () => fetch(`/api/projects/${projectId}/database-access`, send('PATCH', { schemaChanges: value })),
      value === 'allowed' ? 'Schema changes are now allowed over this login.' : 'Schema changes are now refused over this login.',
    )

  const cityName = (findRegion(region) ?? findRegion(HOME_REGION))?.city ?? 'this region'
  // About a database several projects share: a project with one of its own has
  // no such neighbours.
  const sharedNote = CLOUD_CONTROL_PLANE && status?.tenancy !== 'dedicated' && (
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

  /**
   * A login as shown: the answer that just made or rotated it, while it is
   * still the login the status lists (same role, same rotation), so its
   * password is on the page; otherwise the status's.
   */
  const byMode = (mode: Mode): Credential | null => {
    const listed = status?.credentials.find((c) => c.mode === mode) ?? null
    const made = fresh[mode]
    if (listed && made && made.roleName === listed.roleName && made.rotatedAt === listed.rotatedAt && made.password) {
      return { ...listed, password: made.password, connectionString: made.connectionString, transactionConnectionString: made.transactionConnectionString, psqlCommand: made.psqlCommand, pgDumpCommand: made.pgDumpCommand }
    }
    return listed
  }

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
    const shownOnce = c?.passwordShown === 'once'
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
            {c.transactionConnectionString && status?.pooler ? (
              <>
                <p className="mt-[10px] text-[12px] leading-[16px] text-faint">
                  Session (port {status.pooler.sessionPort}): migrations, psql, pg_dump
                </p>
                <ConnectionString value={c.connectionString} password={c.password} copyLabel="Copy the session connection string" />
                <p className="mt-[10px] text-[12px] leading-[16px] text-faint">
                  Transaction (port {status.pooler.transactionPort}): application traffic, serverless
                </p>
                <ConnectionString
                  value={c.transactionConnectionString}
                  password={c.password}
                  copyLabel="Copy the transaction connection string"
                />
              </>
            ) : (
              <div className="mt-[10px]">
                <ConnectionString value={c.connectionString} password={c.password} />
              </div>
            )}
            {shownOnce && c.password && (
              <p role="status" className="mt-[8px] text-[12.5px] leading-[18px] text-zinc-50">
                Copy the password now: it isn&apos;t shown again. Rotate the login to get a new one.
              </p>
            )}
            {shownOnce && !c.password && (
              <p className="mt-[8px] text-[12.5px] leading-[18px] text-faint">
                The password was shown once, when the login was made or last rotated, and Backenly doesn&apos;t keep it. Put yours
                in place of [YOUR-PASSWORD], or rotate the login to get a new one.
              </p>
            )}
            {c.passwordShown === 'rotate' && (
              <p className="mt-[8px] text-[12.5px] leading-[18px] text-zinc-50">
                This login was made before the project had a database of its own. Rotate its password to connect through the
                connection pooler.
              </p>
            )}
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
                {rw.schemaChangesUnavailable &&
                  rw.schemaChangesUnavailable !== 'helpers_outdated' &&
                  ' They can’t be allowed on this project’s database, so Backenly takes them away at the login’s next sync.'}
              </p>
            ) : rw?.schemaChangesUnavailable ? (
              <p className="mt-[8px] text-[12.5px] leading-[18px] text-faint">
                Schema changes over this login are refused. {SCHEMA_CHANGES_UNAVAILABLE[rw.schemaChangesUnavailable]}
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
                  {status.unavailable ?? 'Direct Postgres connections aren’t available for this project.'} Read and change data in
                  the Database section or through the REST API, and download a backup below.
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
            Each login reaches only this project&apos;s schema, over TLS
            {typeof status?.connectionLimit === 'number' &&
              `, with up to ${status.connectionLimit} ${status.connectionLimit === 1 ? 'connection' : 'connections'} at once`}
            . Every change to a login is recorded; rotate at once if a connection string leaks.
          </p>
        )}
        {status?.available !== false && status?.pooler && (
          <ul className="mt-[6px] space-y-[4px] text-[12.5px] leading-[18px] text-faint">
            {status.pooler.guidance.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
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
