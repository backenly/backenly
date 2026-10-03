'use client'

/**
 * A preview branch's endpoint: where to point an app or a coding agent so it
 * tests against the branch instead of production.
 *
 * There is no preview host to show. The branch answers at the project's own
 * base URL to a key bound to it, and every data response names the environment
 * that served it. So this card is those three things (URL, key, header), the
 * snippets that put them together, the branch's OpenAPI spec and the requests
 * the branch has served. There is deliberately no request builder here: the
 * coding agent, curl or the SDK do the testing.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, KeyRound, RefreshCw, Shield, X } from 'lucide-react'
import {
  CopyButton,
  IconButton,
  KitButton,
  KitCard,
  KitCardBody,
  KitCardHeader,
  KitNote,
  SectionLabel,
  Segmented,
  Tag,
} from '@/components/inspector/kit'

export interface BranchPreview {
  baseUrl: string
  dataUrl: string
  v2Url: string
  environmentHeader: { name: string; value: string }
  openapiUrl: string
  curl: string
  sdk: string
  instructions: string
}

interface RequestRow {
  id: string
  method: string
  path: string
  status: number
  latency: number
  timestamp: string
}

type Snippet = 'curl' | 'sdk' | 'agent'

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${Math.max(s, 0)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function Row({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
      <span className="w-[150px] flex-shrink-0 text-[12.5px] text-zinc-500">{label}</span>
      <div className="flex min-w-0 items-center gap-1">
        <code className={`min-w-0 truncate text-[12.5px] text-zinc-200 ${mono ? 'font-mono' : ''}`}>{value}</code>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  )
}

export function BranchPreviewCard({
  projectId,
  branch,
  onClose,
}: {
  projectId: string
  branch: { id: string; name: string; schemaName?: string; preview: BranchPreview }
  onClose: () => void
}) {
  const { preview } = branch
  const [snippet, setSnippet] = useState<Snippet>('curl')
  const [issued, setIssued] = useState<{ key: string; serviceRole: boolean } | null>(null)
  const [issuing, setIssuing] = useState<'client' | 'service' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requests, setRequests] = useState<RequestRow[] | null>(null)

  const fetchRequests = useCallback(async (): Promise<RequestRow[]> => {
    try {
      const res = await fetch(
        `/api/monitoring/request-logs?projectId=${projectId}&branchId=${branch.id}&limit=20`,
        { credentials: 'include' },
      )
      const j = await res.json()
      return j.success ? j.requestLogs : []
    } catch {
      return []
    }
  }, [projectId, branch.id])

  useEffect(() => {
    let cancelled = false
    fetchRequests().then((rows) => { if (!cancelled) setRequests(rows) })
    return () => { cancelled = true }
  }, [fetchRequests])

  const loadRequests = () => { fetchRequests().then(setRequests) }

  const issue = async (serviceRole: boolean) => {
    setIssuing(serviceRole ? 'service' : 'client')
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/branches/${branch.id}/keys`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceRole }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) { setError(j.error || 'Could not issue a key.'); return }
      setIssued({ key: j.key, serviceRole: j.serviceRole })
    } catch {
      setError('Network error issuing a key.')
    } finally {
      setIssuing(null)
    }
  }

  const snippetText = snippet === 'curl' ? preview.curl : snippet === 'sdk' ? preview.sdk : preview.instructions
  const header = `${preview.environmentHeader.name}: ${preview.environmentHeader.value}`

  return (
    <KitCard className="overflow-hidden">
      <KitCardHeader
        title={
          <span>
            Preview endpoint for <span className="font-mono">{branch.name}</span>
          </span>
        }
        actions={<IconButton icon={X} label="Close the preview endpoint" onClick={onClose} />}
      />
      <KitCardBody>
        <div className="space-y-5">
          <p className="max-w-[72ch] text-[12.5px] leading-[19px] text-zinc-500">
            Same URL as production. A key bound to this branch is what makes a request reach it, and every data
            response says which environment answered. Only the data API is branch-scoped: auth, functions, storage
            and realtime refuse a branch key rather than answer from production.
          </p>

          <div className="space-y-2.5">
            <Row label="Base URL" value={preview.baseUrl} />
            <Row label="Data API" value={preview.dataUrl} />
            <Row label="Response header" value={header} />
            {branch.schemaName && <Row label="Schema" value={branch.schemaName} />}
          </div>

          <div>
            <SectionLabel>Key</SectionLabel>
            {issued ? (
              <KitNote
                tone="warn"
                icon={Shield}
                title={issued.serviceRole ? 'Server-side preview key, shown once' : 'Preview key, shown once'}
                actions={<IconButton icon={X} label="Hide the key" onClick={() => setIssued(null)} />}
              >
                <div className="mt-1 flex min-w-0 items-center gap-1">
                  <code className="min-w-0 truncate font-mono text-[12.5px] text-zinc-100">{issued.key}</code>
                  <CopyButton value={issued.key} label="Copy key" />
                </div>
                <p className="mt-1.5 text-[12px] text-zinc-400">
                  Copy it now; it cannot be shown again. Put it in the app or test environment as
                  BACKENLY_PREVIEW_KEY. {issued.serviceRole
                    ? 'It bypasses row-level security on this branch, so keep it server-side.'
                    : 'It is bound by row-level security, like the production client key.'}
                </p>
              </KitNote>
            ) : (
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <KitButton size="sm" variant="primary" icon={KeyRound} loading={issuing === 'client'} onClick={() => issue(false)}>
                  Create preview key
                </KitButton>
                <KitButton size="sm" variant="ghost" loading={issuing === 'service'} onClick={() => issue(true)}>
                  Server-side key
                </KitButton>
                <span className="text-[12px] text-zinc-500">Keys start with proj_preview_ and stop working when the branch is merged or discarded.</span>
              </div>
            )}
            {error && (
              <KitNote tone="danger" icon={AlertTriangle}>
                {error}
              </KitNote>
            )}
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented<Snippet>
                label="Snippet"
                size="sm"
                value={snippet}
                onChange={setSnippet}
                options={[
                  { value: 'curl', label: 'curl' },
                  { value: 'sdk', label: 'SDK' },
                  { value: 'agent', label: 'Instructions for your agent' },
                ]}
              />
              <div className="flex items-center gap-2">
                <a
                  href={preview.openapiUrl}
                  download={`openapi-${branch.name}.json`}
                  className="text-[12.5px] text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
                >
                  OpenAPI spec
                </a>
                <CopyButton value={snippetText} label="Copy snippet" showLabel />
              </div>
            </div>
            <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-white/[0.07] bg-black/30 px-3.5 py-3 font-mono text-[12px] leading-[18px] text-zinc-300">
              {snippetText}
            </pre>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <SectionLabel>Requests this branch served</SectionLabel>
              <IconButton icon={RefreshCw} label="Refresh requests" onClick={loadRequests} />
            </div>
            {requests === null ? (
              <p className="mt-1.5 text-[12.5px] text-zinc-500">Loading…</p>
            ) : requests.length === 0 ? (
              <p className="mt-1.5 text-[12.5px] text-zinc-500">
                None yet. Requests made with this branch&apos;s keys appear here, and never in production monitoring.
              </p>
            ) : (
              <ul className="mt-1.5 divide-y divide-white/[0.05]">
                {requests.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 py-1.5 text-[12.5px]">
                    <span className="w-[56px] flex-shrink-0 font-mono text-zinc-400">{r.method}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-zinc-200">{r.path}</span>
                    <Tag tone={r.status >= 500 ? 'bad' : r.status >= 400 ? 'warn' : 'good'} mono>{r.status}</Tag>
                    <span className="w-[56px] flex-shrink-0 text-right tabular-nums text-zinc-500">{r.latency}ms</span>
                    <span className="hidden w-[64px] flex-shrink-0 text-right text-zinc-600 sm:inline">{timeAgo(r.timestamp)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </KitCardBody>
    </KitCard>
  )
}
