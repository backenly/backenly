'use client'

/**
 * Connect → API: the allowed origins and what browsers sent in the last day.
 *
 *   Allowed origins  1
 *   [https://your-app.vercel.app                                   ] [Add]
 *   https://movienight.app       Added Nov 9                                 ⋯
 *   Browsers on other sites are blocked. Servers and mobile apps are not affected.
 *   (With only development addresses listed: Any website can still call the
 *   API … Add your app's real address to block browsers on other sites.)
 *
 *   Browser requests                                            Last 24 hours
 *   ● movienight.app       214 requests   Last 3 min ago
 *   ✕ shop.example         23 failed   Last 2 min ago            [Copy fix prompt]
 *   23 requests without an Origin header failed the API key check, the last 47 min ago.
 *
 * Origins (the connected-apps registry, connected-apps/route.ts): developers
 * and above add one (:58), only admins remove one (:99). The server asks for
 * a typed confirmation when a change needs one (202); that now happens in a
 * dialog instead of a box that grew inside the card.
 *
 * Browser requests (connection-health, polled every 15 s so a fix pasted into
 * the agent shows up here): an origin row per site, a failure row with the
 * agent's fix prompt. A mobile app or a server sends no Origin, so it never
 * appears here, and the page says so instead of "No requests from an app yet"
 * beside an iOS app with 18,685 requests a day.
 */

import { useCallback, useEffect, useState } from 'react'
import { CopyButton, KitButton, KitConfirmDialog, KitInput, OverflowMenu } from '@/components/inspector/kit'
import { EmptyLine, Fact, Facts, Panel, Row, RowList, RowSkeleton, ROW_TEXT, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { ErrorRow, RefusedLine } from '@/components/console/states'
import { Time } from '@/components/console/Time'
import { formatTime } from '@/components/console/format'
import { sharedRead } from '@/lib/client/shared-read'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import type { ConnectionHealth } from '@/lib/hooks/useConnectionHealth'
import { allowsAnyOrigin } from '@/lib/security/development-origin'

/** An origin bound to this backend on purpose (versioned, audit-logged). */
interface ConnectedApp {
  id: string
  origin: string
  isActive: boolean
  connectedAt: string
}

/** What the server wants typed before it makes a change. */
interface Pending {
  kind: 'add' | 'remove'
  origin: string
  message: string
}

/** The server's message, without its own "Type CONNECT to confirm." line: the dialog asks for that. */
function withoutTypePrompt(message: string): string {
  return message
    .split('\n')
    .filter((l) => !/^\s*Type (CONNECT|DISCONNECT) to confirm\.?\s*$/i.test(l))
    .join('\n')
    .trim()
}

// ── Allowed origins ───────────────────────────────────────────────────────────

function AllowedOrigins({ projectId }: { projectId: string }) {
  const role = useProjectRole(projectId)
  const [apps, setApps] = useState<ConnectedApp[]>([])
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retrying, setRetrying] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/connected-apps`, { credentials: 'include' })
      if (!res.ok) throw new Error('no apps')
      const data = await res.json()
      setApps(Array.isArray(data.apps) ? data.apps : [])
      setLoad('ready')
    } catch {
      setLoad((prev) => (prev === 'ready' ? 'ready' : 'error'))
    } finally {
      setRetrying(false)
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The server binds an origin, or answers 202 when it wants it confirmed by name.
  async function add(force: boolean) {
    const origin = pending?.kind === 'add' ? pending.origin : url.trim()
    if (!origin) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/connected-apps`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: force ? pending?.origin ?? origin : origin, force }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 202 && data.requiresConfirmation) {
        setPending({ kind: 'add', origin: data.origin ?? origin, message: data.message ?? '' })
        return
      }
      if (!res.ok || !data.success) throw new Error(data.message || data.error || 'Could not add the origin.')
      setPending(null)
      setUrl('')
      await refresh()
    } catch (e) {
      setPending(null)
      setError(e instanceof Error ? e.message : 'Could not add the origin.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(origin: string, force: boolean) {
    setBusy(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ url: origin, force: String(force) })
      const res = await fetch(`/api/projects/${projectId}/connected-apps?${qs}`, { method: 'DELETE', credentials: 'include' })
      const data = await res.json().catch(() => ({}))
      if (res.status === 202 && data.requiresConfirmation) {
        setPending({ kind: 'remove', origin, message: data.message ?? '' })
        return
      }
      if (!res.ok || data.success === false) throw new Error(data.message || data.error || 'Could not remove the origin.')
      setPending(null)
      await refresh()
    } catch (e) {
      setPending(null)
      setError(e instanceof Error ? e.message : 'Could not remove the origin.')
    } finally {
      setBusy(false)
    }
  }

  const active = apps.filter((a) => a.isActive)
  // The rule the API itself applies (middleware.ts): development origins never
  // make the list exclusive, so with only those on it every site is admitted.
  // The page said "Browsers on other sites are blocked" for any list at all,
  // while a call from another site was answered (production QA, 2026-11-27).
  const anySiteMayCall = allowsAnyOrigin(active.map((a) => a.origin))
  const canAdd = role.canWrite
  const canRemove = role.canAdminister

  return (
    <Section id="allowed-origins" title="Allowed origins" count={load === 'ready' ? active.length : null}>
      <Panel clip={false}>
        {canAdd && (
          <form
            className="flex gap-[8px] border-b border-white/[0.06] px-[20px] py-[14px]"
            onSubmit={(e) => {
              e.preventDefault()
              void add(false)
            }}
          >
            <KitInput
              type="url"
              inputMode="url"
              name="frontend-origin"
              autoComplete="off"
              spellCheck={false}
              aria-label="Website address to allow"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-app.vercel.app"
              disabled={busy}
              className="min-w-0 flex-1"
            />
            <KitButton type="submit" loading={busy && !pending} disabled={!url.trim() || busy}>
              Add
            </KitButton>
          </form>
        )}
        {error && (
          <div className="border-b border-white/[0.06] px-[20px] py-[10px]">
            <RefusedLine className="whitespace-pre-line">{error}</RefusedLine>
          </div>
        )}
        {load === 'loading' ? (
          <RowSkeleton rows={1} lead="none" />
        ) : load === 'error' ? (
          <ErrorRow
            things="allowed origins"
            onRetry={() => {
              setRetrying(true)
              void refresh()
            }}
            retrying={retrying}
          />
        ) : active.length === 0 ? (
          <EmptyLine>Until you add one, any website can call the API.</EmptyLine>
        ) : (
          <RowList>
            {active.map((app) => (
              <Row
                key={app.id}
                lead="none"
                title={<p className={`font-mono !text-[12.5px] ${ROW_TITLE}`}>{app.origin}</p>}
                actions={
                  canRemove ? (
                    <OverflowMenu
                      label={`Actions for ${app.origin}`}
                      disabled={busy}
                      items={[{ label: 'Remove', danger: true, onClick: () => void remove(app.origin, false) }]}
                    />
                  ) : undefined
                }
              >
                <Facts className="!mt-[4px]">
                  <Fact>Added {formatTime(app.connectedAt, 'date')}</Fact>
                </Facts>
              </Row>
            ))}
          </RowList>
        )}
      </Panel>
      {active.length > 0 && (
        <p className="mt-[10px] text-[12.5px] leading-[18px] text-faint">
          {anySiteMayCall
            ? 'Any website can still call the API: only development addresses are listed, and those never limit it. Add your app’s real address to block browsers on other sites.'
            : 'Browsers on other sites are blocked. Servers and mobile apps are not affected.'}
        </p>
      )}

      <KitConfirmDialog
        open={!!pending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return
          if (pending.kind === 'add') void add(true)
          else void remove(pending.origin, true)
        }}
        busy={busy}
        danger={pending?.kind === 'remove'}
        title={pending?.kind === 'remove' ? `Remove ${pending.origin}?` : `Allow ${pending?.origin ?? 'this origin'}?`}
        requireText={pending?.kind === 'remove' ? 'DISCONNECT' : 'CONNECT'}
        confirmLabel={pending?.kind === 'remove' ? 'Remove origin' : 'Allow origin'}
      >
        {pending && <p className="whitespace-pre-line text-[13px] leading-[20px] text-zinc-400">{withoutTypePrompt(pending.message)}</p>}
      </KitConfirmDialog>
    </Section>
  )
}

// ── Browser requests ──────────────────────────────────────────────────────────

/** How often the browser traffic is read again, so a pasted fix shows up. */
const HEALTH_POLL_MS = 15_000

function BrowserRequests({ projectId }: { projectId: string }) {
  const [health, setHealth] = useState<ConnectionHealth | null>(null)
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retrying, setRetrying] = useState(false)

  const read = useCallback(async (fresh = false) => {
    try {
      // The Overview reads and polls the same thing (lib/client/shared-read.ts).
      const res = await sharedRead<ConnectionHealth>(`/api/projects/${projectId}/connection-health`, { fresh })
      if (!res.ok || !res.data?.totals) throw new Error('no health')
      setHealth(res.data)
      setLoad('ready')
    } catch {
      setLoad((prev) => (prev === 'ready' ? 'ready' : 'error'))
    } finally {
      setRetrying(false)
    }
  }, [projectId])

  useEffect(() => {
    void read()
    const t = setInterval(() => {
      if (!document.hidden) void read()
    }, HEALTH_POLL_MS)
    return () => clearInterval(t)
  }, [read])

  const failures = health?.failures ?? []
  const successes = health?.successes ?? []
  const probes = health?.probes?.count ?? 0

  let body
  if (load === 'loading') body = <RowSkeleton rows={1} lead="glyph" />
  else if (load === 'error')
    body = (
      <ErrorRow
        things="browser requests"
        onRetry={() => {
          setRetrying(true)
          void read(true)
        }}
        retrying={retrying}
      />
    )
  else if (failures.length === 0 && successes.length === 0)
    body = <EmptyLine>No browser requests in the last 24 hours. Mobile apps and servers don’t appear here.</EmptyLine>
  else
    body = (
      <RowList>
        {failures.map((f) => (
          <Row
            key={`fail-${f.origin}`}
            lead="glyph"
            glyph="failed"
            glyphLabel="Failing"
            title={<p className={`font-mono !text-[12.5px] ${ROW_TITLE}`}>{f.origin}</p>}
            actions={<CopyButton value={f.fixPrompt} label="Copy fix prompt" showLabel />}
          >
            <p className={`!mt-[4px] ${ROW_TEXT}`}>{f.hint}</p>
            <Facts className="!mt-[6px]">
              <Fact>
                <span className="font-medium text-zinc-50">{f.count.toLocaleString('en-US')} failed</span>
              </Fact>
              <Fact>
                <Time iso={f.lastSeen} prefix="Last" />
              </Fact>
            </Facts>
          </Row>
        ))}
        {successes.map((s) => (
          <Row
            key={`ok-${s.origin}`}
            lead="glyph"
            glyph="live"
            glyphLabel="Working"
            title={<p className={`font-mono !text-[12.5px] ${ROW_TITLE}`}>{s.origin}</p>}
          >
            <Facts className="!mt-[4px]">
              <Fact>
                {s.count.toLocaleString('en-US')} {s.count === 1 ? 'request' : 'requests'}
              </Fact>
              <Fact>
                <Time iso={s.lastSeen} prefix="Last" />
              </Fact>
            </Facts>
          </Row>
        ))}
      </RowList>
    )

  return (
    <Section id="browser-requests" title="Browser requests" aside={<span className="text-[12.5px] text-faint">Last 24 hours</span>}>
      <Panel>{body}</Panel>
      {/* Refused for the key, not for the missing Origin: a request without one and with a valid key is served. */}
      {probes > 0 && (
        <p className="mt-[10px] text-[12.5px] leading-[18px] text-faint">
          {probes.toLocaleString('en-US')} {probes === 1 ? 'request' : 'requests'} without an Origin header failed the API key check
          {health?.probes?.lastSeen ? `, the last ${formatTime(health.probes.lastSeen, 'ago')}` : ''}. Usually bots, curl or a server
          script missing its key.
        </p>
      )}
    </Section>
  )
}

/** Both sections, in the API tab's order. */
export function FrontendRuntimeCards({ projectId }: { projectId: string }) {
  return (
    <>
      <AllowedOrigins projectId={projectId} />
      <BrowserRequests projectId={projectId} />
    </>
  )
}
