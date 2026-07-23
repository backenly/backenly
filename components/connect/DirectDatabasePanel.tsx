'use client'

/**
 * Direct database access — the open-loop panel (Connect → Direct).
 *
 * Real PostgreSQL connection strings for the project's workspace schema:
 *   • Read-only  — SELECT-only role. psql, TablePlus, EXPLAIN, BI tools,
 *                  self-serve pg_dump. Structurally cannot mutate.
 *   • Read-write — DML + in-schema DDL. External DDL is captured by the
 *                  drift watch and adopted/flagged by autonomy —
 *                  reconciliation, not lockout.
 *
 * Plus the portability guarantee made concrete: one-click pg_dump exports
 * (full / schema / data) that restore on any PostgreSQL.
 *
 * Copy rules: plain language first (audience includes non-dev founders), the
 * exact commands for developers, and honest notes about the shared tier.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Database, Copy, Check, Eye, EyeOff, RefreshCw, Trash2, Loader2,
  Download, ShieldCheck, PencilRuler, Terminal, GitBranch,
} from 'lucide-react'
import { Toast } from '@/components/ui/Toast'
import {
  KIT, KitButton, KitBadge, KitCard, KitCardHeader, KitCardBody, KitNote, KitConfirmDialog, SectionLabel,
} from '@/components/inspector/kit'

interface Credential {
  mode: 'READ_ONLY' | 'READ_WRITE'
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
}

interface Status {
  schema: string
  credentials: Credential[]
  pendingDriftEvents: number
}

function maskConnectionString(c: Credential): string {
  return c.connectionString.replace(`:${c.password}@`, ':••••••••@')
}

export function DirectDatabasePanel({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null) // 'provision_RO' | 'rotate_RW' | …
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState<string | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' | 'warning' } | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<Credential['mode'] | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/database-access`, { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to load database access status')
      setStatus(await res.json())
    } catch {
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { if (projectId) load() }, [projectId, load])

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(key)
      setTimeout(() => setCopied(c => (c === key ? null : c)), 1600)
    } catch {
      setToast({ message: 'Could not copy. The browser blocked clipboard access', type: 'warning' })
    }
  }

  const provision = async (mode: Credential['mode']) => {
    setBusy(`provision_${mode}`)
    try {
      const res = await fetch(`/api/projects/${projectId}/database-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Provisioning failed')
      setToast({ message: mode === 'READ_ONLY' ? 'Read-only credentials created' : 'Read-write credentials created', type: 'success' })
      await load()
    } catch (err: any) {
      setToast({ message: err.message, type: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const rotate = async (mode: Credential['mode']) => {
    setBusy(`rotate_${mode}`)
    try {
      const res = await fetch(`/api/projects/${projectId}/database-access/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Rotation failed')
      setToast({ message: 'Password rotated. Old sessions were disconnected', type: 'success' })
      await load()
    } catch (err: any) {
      setToast({ message: err.message, type: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const revoke = async (mode: Credential['mode']) => {
    const label = mode === 'READ_ONLY' ? 'read-only' : 'read-write'
    setBusy(`revoke_${mode}`)
    try {
      const res = await fetch(`/api/projects/${projectId}/database-access?mode=${mode}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Revoke failed')
      setToast({ message: `${label[0].toUpperCase()}${label.slice(1)} credentials revoked`, type: 'success' })
      await load()
    } catch (err: any) {
      setToast({ message: err.message, type: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const has = (mode: Credential['mode']) => status?.credentials.some(c => c.mode === mode) ?? false

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 justify-center text-zinc-500 text-[12px]">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading database access…
      </div>
    )
  }

  return (
    <div className="mt-10 space-y-4">
      <div>
        <SectionLabel>Your database, direct</SectionLabel>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-zinc-500 max-w-2xl">
          Standard PostgreSQL, and it&apos;s yours: real connection strings for psql, TablePlus, or any BI tool,
          plus full <span className="font-mono text-[11.5px]">pg_dump</span> exports. No lock-in.
        </p>
      </div>

      {/* ── Credential cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Read-only */}
        <KitCard>
          <KitCardHeader
            title={<span className="inline-flex items-center gap-2"><ShieldCheck className="w-3.5 h-3.5 text-zinc-400" />Read-only access</span>}
            actions={has('READ_ONLY') ? <KitBadge tone="operational">active</KitBadge> : undefined}
          />
          <KitCardBody className="space-y-3">
            <p className="text-[12px] leading-relaxed text-zinc-500">
              SELECT-only role scoped to this project&apos;s schema: inspect, run{' '}
              <span className="font-mono text-[11px]">EXPLAIN</span>, take backups. It structurally cannot write.
            </p>
            {has('READ_ONLY') ? (
              <CredentialDetails
                credential={status!.credentials.find(c => c.mode === 'READ_ONLY')!}
                revealed={revealed} setRevealed={setRevealed}
                copied={copied} onCopy={copy}
                busy={busy} onRotate={() => rotate('READ_ONLY')} onRevoke={() => setRevokeTarget('READ_ONLY')}
              />
            ) : (
              <KitButton
                variant="primary" size="sm" icon={Terminal}
                disabled={busy !== null}
                onClick={() => provision('READ_ONLY')}
              >
                {busy === 'provision_READ_ONLY' ? 'Creating…' : 'Create read-only credentials'}
              </KitButton>
            )}
          </KitCardBody>
        </KitCard>

        {/* Read-write */}
        <KitCard>
          <KitCardHeader
            title={<span className="inline-flex items-center gap-2"><PencilRuler className="w-3.5 h-3.5 text-zinc-400" />Read-write access</span>}
            actions={has('READ_WRITE') ? <KitBadge tone="beta">active</KitBadge> : undefined}
          />
          <KitCardBody className="space-y-3">
            <p className="text-[12px] leading-relaxed text-zinc-500">
              Full DML + in-schema DDL from your own tools. Schema changes are{' '}
              <span className="text-zinc-300">observed, not blocked</span>. Autonomy adopts them into your APIs,
              or asks you first.
            </p>
            {has('READ_WRITE') ? (
              <>
                {status!.pendingDriftEvents > 0 && (
                  <div className="flex items-center gap-2 text-[11.5px] text-amber-400/90">
                    <GitBranch className="w-3.5 h-3.5" />
                    {status!.pendingDriftEvents} external schema change{status!.pendingDriftEvents === 1 ? '' : 's'} awaiting adoption · see Autonomy
                  </div>
                )}
                <CredentialDetails
                  credential={status!.credentials.find(c => c.mode === 'READ_WRITE')!}
                  revealed={revealed} setRevealed={setRevealed}
                  copied={copied} onCopy={copy}
                  busy={busy} onRotate={() => rotate('READ_WRITE')} onRevoke={() => setRevokeTarget('READ_WRITE')}
                />
              </>
            ) : (
              <KitButton
                variant="secondary" size="sm" icon={Terminal}
                disabled={busy !== null}
                onClick={() => provision('READ_WRITE')}
              >
                {busy === 'provision_READ_WRITE' ? 'Creating…' : 'Create read-write credentials'}
              </KitButton>
            )}
          </KitCardBody>
        </KitCard>
      </div>

      {/* ── Export ───────────────────────────────────────────────────────────── */}
      <KitCard>
        <KitCardHeader
          title={<span className="inline-flex items-center gap-2"><Download className="w-3.5 h-3.5 text-zinc-400" />Export your backend</span>}
          description="Standard pg_dump. Restores on any PostgreSQL."
        />
        <KitCardBody>
          <div className="flex flex-wrap items-center gap-2">
            <a href={`/api/projects/${projectId}/export/database?mode=full`} download>
              <KitButton variant="secondary" size="sm" icon={Database}>Full backup (.sql)</KitButton>
            </a>
            <a href={`/api/projects/${projectId}/export/database?mode=schema`} download>
              <KitButton variant="ghost" size="sm">Schema only</KitButton>
            </a>
            <a href={`/api/projects/${projectId}/export/database?mode=data`} download>
              <KitButton variant="ghost" size="sm">Data only</KitButton>
            </a>
          </div>
        </KitCardBody>
      </KitCard>

      {/* ── Honest notes ─────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <KitNote>
          TLS required (<span className="font-mono text-[10.5px]">sslmode=require</span>), scoped to this project&apos;s
          schema. Shared tier: catalogs can list other projects&apos; schema <em>names</em>, never their data.
        </KitNote>
        <KitNote>
          Connections hit the live database your APIs serve. Every credential action is audit-logged.
          Rotate immediately if a string leaks.
        </KitNote>
      </div>

      {toast && <Toast message={toast.message} type={toast.type} isVisible onClose={() => setToast(null)} />}

      <KitConfirmDialog
        open={!!revokeTarget}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (revokeTarget) revoke(revokeTarget)
          setRevokeTarget(null)
        }}
        title={`Revoke ${revokeTarget === 'READ_ONLY' ? 'read-only' : 'read-write'} credentials?`}
        description="Anything connected with them is disconnected immediately."
        confirmLabel="Revoke"
        danger
      />
    </div>
  )
}

// ── Credential detail block ─────────────────────────────────────────────────

function CredentialDetails({
  credential: c, revealed, setRevealed, copied, onCopy, busy, onRotate, onRevoke,
}: {
  credential: Credential
  revealed: Set<string>
  setRevealed: (s: Set<string>) => void
  copied: string | null
  onCopy: (key: string, value: string) => void
  busy: string | null
  onRotate: () => void
  onRevoke: () => void
}) {
  const isRevealed = revealed.has(c.mode)
  const shown = isRevealed ? c.connectionString : maskConnectionString(c)
  const copyKey = `conn_${c.mode}`

  return (
    <div className="space-y-2.5">
      <div className={`flex items-center gap-1.5 rounded-md border ${KIT.hairline} ${KIT.surfaceSoft} pl-3 pr-1.5 py-1.5`}>
        <code className="flex-1 truncate font-mono text-[11px] text-zinc-300">{shown}</code>
        <button
          onClick={() => {
            const next = new Set(revealed)
            if (isRevealed) next.delete(c.mode); else next.add(c.mode)
            setRevealed(next)
          }}
          className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 transition-colors"
          title={isRevealed ? 'Hide password' : 'Reveal password'}
        >
          {isRevealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
        <button
          onClick={() => onCopy(copyKey, c.connectionString)}
          className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 transition-colors"
          title="Copy connection string"
        >
          {copied === copyKey ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono text-zinc-600">
        <span>{c.roleName}</span>
        <span>{c.host}:{c.port}/{c.database}</span>
        {c.rotatedAt && <span>rotated {new Date(c.rotatedAt).toLocaleDateString()}</span>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <KitButton variant="ghost" size="sm" icon={Terminal} onClick={() => onCopy(`psql_${c.mode}`, c.psqlCommand)}>
          {copied === `psql_${c.mode}` ? 'Copied' : 'Copy psql command'}
        </KitButton>
        <KitButton variant="ghost" size="sm" icon={Download} onClick={() => onCopy(`dump_${c.mode}`, c.pgDumpCommand)}>
          {copied === `dump_${c.mode}` ? 'Copied' : 'Copy pg_dump command'}
        </KitButton>
        <div className="ml-auto flex items-center gap-1.5">
          <KitButton variant="ghost" size="sm" icon={RefreshCw} disabled={busy !== null} onClick={onRotate}>
            {busy === `rotate_${c.mode}` ? 'Rotating…' : 'Rotate'}
          </KitButton>
          <KitButton variant="danger" size="sm" icon={Trash2} disabled={busy !== null} onClick={onRevoke}>
            {busy === `revoke_${c.mode}` ? 'Revoking…' : 'Revoke'}
          </KitButton>
        </div>
      </div>
    </div>
  )
}
