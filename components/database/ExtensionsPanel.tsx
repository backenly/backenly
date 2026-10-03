'use client'

/**
 * POSTGRESQL EXTENSIONS
 *
 * The platform already detected two of these — `pg_stat_statements` and
 * `pgstattuple` — and told the operator to go and run `CREATE EXTENSION` by
 * hand. This is the surface that was missing.
 *
 * ── It shows what the SERVER says, not what the code hopes ──────────────────
 *
 * Installed, available, version and trusted all come from `pg_extension` and
 * `pg_available_extensions` on every load. Nothing here is cached, because a
 * dashboard reporting an extension that an operator removed at a psql prompt is
 * the exact drift the derived register exists to stop.
 *
 * ── An Install button only where installing can work ────────────────────────
 *
 * PostgreSQL 13+ lets a non-superuser install TRUSTED extensions. Everything
 * else needs superuser, and Backenly's application role is deliberately
 * NOSUPERUSER. So non-trusted extensions get the exact command and the reason
 * instead of a button whose only possible outcome is a permissions error.
 *
 * ── No uninstall ────────────────────────────────────────────────────────────
 *
 * `DROP EXTENSION` cascades into columns and indexes that depend on it and this
 * surface cannot show what that would take with it. Stated in the footer rather
 * than left as a puzzling absence.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download } from 'lucide-react'
import { KitButton, KitNote, Skeleton, StatusDot } from '@/components/inspector/kit'
import { EDGE, RULE, R_PANEL } from '@/components/console/tokens'

interface ExtensionRow {
  name: string
  purpose: string
  caveat?: string
  available: boolean
  installed: boolean
  installedVersion: string | null
  defaultVersion: string | null
  schema: string | null
  trusted: boolean | null
  installable: boolean
  blockedReason: string | null
}

export function ExtensionsPanel({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<ExtensionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'danger' | 'success' | 'warn'; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/database/extensions`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Extensions could not be loaded.')
      setRows(data.extensions ?? [])
    } catch (err) {
      // Reported, not swallowed. An empty list over a failed request reads as
      // "this server has no extensions", which is a different claim.
      setLoadError(err instanceof Error ? err.message : 'Extensions could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  async function install(name: string) {
    setBusy(name)
    setMessage(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/database/extensions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await res.json()
      if (!res.ok) {
        // PostgreSQL's own words where it refused. "Install failed" would tell
        // an operator nothing they can act on.
        setMessage({ tone: 'danger', text: data.error ?? 'The extension could not be installed.' })
        return
      }
      setRows(data.extensions ?? rows)
      setMessage({
        tone: 'success',
        text: data.alreadyInstalled
          ? `${name} was already installed.`
          : `${name} ${data.version ?? ''} installed.`.trim(),
      })
    } catch (err) {
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : 'The extension could not be installed.' })
    } finally {
      setBusy(null)
    }
  }

  const installedCount = rows.filter((r) => r.installed).length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`flex h-[44px] flex-shrink-0 items-center gap-2.5 border-b ${RULE} px-4 sm:px-5`}>
        <h2 className="text-[13px] font-medium text-zinc-100">Extensions</h2>
        {!loading && rows.length > 0 && (
          <span className="text-[12px] tabular-nums text-zinc-500">
            {installedCount} of {rows.length} installed
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full max-w-[860px] space-y-4 px-4 py-5 sm:px-5">
          <p className="max-w-[72ch] text-[13px] leading-[20px] text-zinc-400 [text-wrap:pretty]">
            Backenly installs from a fixed list. An extension runs its own install script with the privileges of
            whoever installs it, so the list is a code change rather than a text box. Extensions are database-wide,
            not per project.
          </p>

          {loadError && (
            <KitNote icon={AlertTriangle} tone="danger">
              {loadError}
            </KitNote>
          )}
          {message && (
            <KitNote icon={message.tone === 'success' ? CheckCircle2 : AlertTriangle} tone={message.tone}>
              {message.text}
            </KitNote>
          )}

          {loading ? (
            <div className={`overflow-hidden border ${EDGE} ${R_PANEL}`} aria-hidden>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className={`space-y-2 px-4 py-3.5 ${i > 0 ? `border-t ${RULE}` : ''}`}>
                  <Skeleton className="h-[12px] w-36" />
                  <Skeleton className="h-[11px] w-2/3" />
                </div>
              ))}
            </div>
          ) : (
            <ul className={`overflow-hidden border ${EDGE} ${R_PANEL}`}>
              {rows.map((ext, i) => (
                <li
                  key={ext.name}
                  className={`flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start ${i > 0 ? `border-t ${RULE}` : ''}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-mono text-[12.5px] font-medium text-zinc-100">{ext.name}</span>
                      {ext.installed && (
                        <span className="text-[12px] tabular-nums text-zinc-500">
                          {ext.installedVersion}
                          {ext.schema ? ` · ${ext.schema}` : ''}
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-[13px] leading-[19px] text-zinc-400">{ext.purpose}</p>

                    {/* Why it cannot be installed, where that is the case. An
                        unexplained disabled button is worse than no button. */}
                    {!ext.installed && ext.blockedReason && (
                      <p className="mt-1.5 text-[12.5px] leading-[18px] text-amber-200/80">{ext.blockedReason}</p>
                    )}
                  </div>

                  <div className="flex flex-shrink-0 items-center gap-2 sm:pt-0.5">
                    {ext.installed ? (
                      <StatusDot tone="operational" label="Installed" />
                    ) : ext.installable ? (
                      <KitButton
                        size="sm"
                        icon={Download}
                        loading={busy === ext.name}
                        disabled={busy !== null && busy !== ext.name}
                        onClick={() => install(ext.name)}
                      >
                        Install
                      </KitButton>
                    ) : (
                      <StatusDot
                        tone={ext.available ? 'attention' : 'neutral'}
                        label={ext.available ? 'Needs superuser' : 'Not available'}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <p className="max-w-[72ch] text-[12.5px] leading-[19px] text-zinc-500">
            There is no uninstall here. <span className="font-mono text-zinc-400">DROP EXTENSION</span> cascades into the
            columns and indexes that depend on it, and this page cannot show what that would take with it. Removing one
            is a deliberate act at a psql prompt.
          </p>
        </div>
      </div>
    </div>
  )
}
