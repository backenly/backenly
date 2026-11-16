'use client'

/**
 * API keys, on Connect → API beside the URL they are used with (project
 * console decision 4, 2026-11-16: a credential lives where the thing that uses
 * it is set up). Moved from Settings, which now holds no credentials;
 * Settings' old `?tab=keys` lands here.
 *
 *   API keys  2                                                       [New key]
 *   Catalog import (server)   Admin                                           ⋯
 *   svc_live_••••••••   Bypasses row security   1,000 / 1 h   Last used 3 d ago   Never expires
 *
 * The server returns a key's plaintext exactly once, when it is made, so a new
 * key is shown once in a dialog (SecretOnceDialog) and a listed key shows its
 * prefix only. New keys default to Client, the one safe in a browser; Admin is
 * listed last. The radios are white, like every form control.
 *
 * Agent keys and browser sign-ins are on Connect → Agents (the list route
 * leaves scope 'mcp' out). Creating and deleting keys is ADMIN; everyone else
 * reads the list and one sentence.
 */

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  KitButton,
  KitConfirmDialog,
  KitField,
  KitInput,
  KitModal,
  KitRadio,
  OverflowMenu,
  Tag,
} from '@/components/inspector/kit'
import { EmptyLine, Fact, Facts, Panel, Row, RowList, RowSkeleton, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { ErrorRow, RefusedLine } from '@/components/console/states'
import { SecretOnceDialog } from '@/components/console/SecretOnceDialog'
import { Time, useNow } from '@/components/console/Time'
import { formatTime } from '@/components/console/format'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { isSharedKey, sharedKeyWindow, shortWindow } from '@/lib/security/shared-key'

interface ApiKey {
  id: string
  name: string
  key?: string
  keyPrefix: string
  keyType?: 'dashboard' | 'public'
  role: 'admin' | 'read-only' | 'write' | 'ai-only' | 'client' | 'service' | 'custom'
  permissions: string[]
  capabilities?: string[]
  serviceRole?: boolean
  /** Set for a preview key: it reaches that branch and nothing else. */
  branch?: { id: string; name: string; status: string } | null
  lastUsed?: string | null
  createdAt: string
  expiresAt?: string | null
  rateLimit?: number
  rateLimitWindow?: number
}

type NewRole = 'admin' | 'read-only' | 'write' | 'client'

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin',
  write: 'Write',
  'read-only': 'Read only',
  client: 'Client',
  'ai-only': 'AI only',
  service: 'Service',
  // Agent-created publishable keys carry role 'custom'; the raw word read as an unknown kind.
  custom: 'Publishable',
}

/** Safest first: Client is the default, Admin is last. */
const ROLE_OPTIONS: Array<{ value: NewRole; label: string; body: string }> = [
  { value: 'client', label: 'Client', body: 'Safe to put in a web or mobile app. Row security applies.' },
  { value: 'read-only', label: 'Read only', body: 'Reads data, changes nothing.' },
  { value: 'write', label: 'Write', body: 'Reads and writes data, no administration.' },
  // The runtime's elevation switch is serviceRole: Admin mints a svc_live_ key it refuses from a browser.
  { value: 'admin', label: 'Admin', body: 'Bypasses row security. Refused from a browser, so servers only.' },
]

/** Under 30 days to go, an expiry is worth noticing. */
const SOON_MS = 30 * 24 * 60 * 60 * 1000

export function ClientKeysPanel({ projectId: given }: { projectId?: string } = {}) {
  const params = useParams()
  const projectId = given ?? ((params?.id ?? params?.projectId) as string)
  const role = useProjectRole(projectId)
  const now = useNow()

  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retrying, setRetrying] = useState(false)
  const [creatingOpen, setCreatingOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyRole, setNewKeyRole] = useState<NewRole>('client')
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ApiKey | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [refusal, setRefusal] = useState<{ id: string; message: string } | null>(null)

  const loadApiKeys = useCallback(async () => {
    try {
      const response = await fetch(`/api/api-keys?projectId=${projectId}`, { credentials: 'include' })
      if (!response.ok) throw new Error('Failed to fetch API keys')
      const data = await response.json()
      setApiKeys(Array.isArray(data.apiKeys) ? data.apiKeys : [])
      setLoad('ready')
    } catch {
      setLoad((prev) => (prev === 'ready' ? 'ready' : 'error'))
    } finally {
      setRetrying(false)
    }
  }, [projectId])

  useEffect(() => {
    if (projectId) void loadApiKeys()
  }, [projectId, loadApiKeys])

  const resetCreate = () => {
    setCreatingOpen(false)
    setNewKeyName('')
    setNewKeyRole('client')
    setCreateError(null)
  }

  const handleCreateApiKey = async () => {
    const name = newKeyName.trim()
    if (!name || creating) return
    setCreating(true)
    setCreateError(null)
    try {
      const response = await fetch(`/api/api-keys?projectId=${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name,
          keyType: 'public',
          role: newKeyRole,
          capabilities: ['database', 'auth', 'storage', 'functions', 'ai'],
          // The runtime's elevation switch is serviceRole, not the role string.
          // The Admin option used to send serviceRole:false, which minted a
          // publishable proj_live_ key: not full access, and served from
          // browsers, the exact opposite of this option's copy.
          serviceRole: newKeyRole === 'admin',
          projectId,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.apiKey?.key) throw new Error(data?.error || 'Could not create the key. Try again.')
      resetCreate()
      setCreated({ name, key: data.apiKey.key })
      await loadApiKeys()
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not create the key. Try again.')
    } finally {
      setCreating(false)
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    const target = pendingDelete
    setDeleting(true)
    setRefusal(null)
    try {
      const response = await fetch(`/api/api-keys/${target.id}?projectId=${projectId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(error.error || 'Could not delete the key. Try again.')
      }
      setPendingDelete(null)
      await loadApiKeys()
    } catch (error) {
      setPendingDelete(null)
      setRefusal({ id: target.id, message: error instanceof Error ? error.message : 'Could not delete the key. Try again.' })
    } finally {
      setDeleting(false)
    }
  }

  const canChange = role.canAdminister
  let body
  if (load === 'loading') {
    body = <RowSkeleton rows={2} lead="none" />
  } else if (load === 'error') {
    body = (
      <ErrorRow
        things="API keys"
        onRetry={() => {
          setRetrying(true)
          void loadApiKeys()
        }}
        retrying={retrying}
      />
    )
  } else if (apiKeys.length === 0) {
    body = <EmptyLine>No API keys yet. An app, a script or a server uses one to call the API.</EmptyLine>
  } else {
    body = (
      <RowList>
        {apiKeys.map((key) => {
          const ended = key.branch && key.branch.status !== 'active'
          const soon = now !== null && !!key.expiresAt && new Date(key.expiresAt).getTime() - now < SOON_MS
          return (
            <Row
              key={key.id}
              lead="none"
              title={
                <p className={`flex min-w-0 flex-wrap items-center gap-x-[8px] gap-y-[4px] ${ROW_TITLE}`}>
                  <span className="min-w-0 [overflow-wrap:anywhere]">{key.name}</span>
                  <Tag>{ROLE_LABEL[key.role] ?? key.role}</Tag>
                  {key.branch && (
                    // A preview key answers only on its branch, and not at all once that branch is merged or discarded.
                    <Tag tone={key.branch.status === 'active' ? 'warn' : 'neutral'} mono>
                      Preview: {key.branch.name}
                    </Tag>
                  )}
                </p>
              }
              actions={
                canChange ? (
                  <OverflowMenu
                    label={`Actions for ${key.name}`}
                    items={[{ label: 'Delete key', danger: true, onClick: () => setPendingDelete(key) }]}
                  />
                ) : undefined
              }
            >
              <Facts>
                <Fact>
                  <code className="font-mono text-[11.5px] text-zinc-400">{key.keyPrefix}••••••••</code>
                </Fact>
                {key.serviceRole && <Fact strong>Service role: bypasses row security, servers only</Fact>}
                <Fact>
                  {/* Every user of an app sends a shared key, so its limit is each address's (lib/security/shared-key.ts). */}
                  {isSharedKey(key)
                    ? `${shortWindow(sharedKeyWindow(key))} per address`
                    : shortWindow({ limit: key.rateLimit ?? 1000, windowSeconds: key.rateLimitWindow ?? 3600 })}
                </Fact>
                <Fact>{key.lastUsed ? <Time iso={key.lastUsed} prefix="Last used" /> : 'Never used'}</Fact>
                <Fact>Created {formatTime(key.createdAt, 'date')}</Fact>
                {ended ? (
                  // Its branch was merged or discarded, and the key with it: no date to wait for.
                  <Fact>Ended with branch</Fact>
                ) : key.expiresAt ? (
                  // The runtime refuses the key past this date; white once it is under 30 days out.
                  <Fact>
                    <span className={soon ? 'font-medium text-zinc-50' : ''}>Expires {formatTime(key.expiresAt, 'date')}</span>
                  </Fact>
                ) : (
                  <Fact>Never expires</Fact>
                )}
              </Facts>
              {refusal?.id === key.id && <RefusedLine className="mt-[8px]">{refusal.message}</RefusedLine>}
            </Row>
          )
        })}
      </RowList>
    )
  }

  return (
    <Section
      id="api-keys"
      title="API keys"
      count={load === 'ready' ? apiKeys.length : null}
      aside={
        canChange ? (
          <KitButton size="sm" onClick={() => setCreatingOpen(true)}>
            New key
          </KitButton>
        ) : undefined
      }
    >
      <Panel>{body}</Panel>
      {!canChange && !role.loading && (
        <p className="mt-[10px] text-[12.5px] leading-[18px] text-faint">Only owners and admins can add or revoke keys.</p>
      )}

      <KitModal
        open={creatingOpen}
        onClose={() => {
          if (!creating) resetCreate()
        }}
        title="New API key"
        description="The key is shown once, right after you create it."
        width="max-w-[480px]"
        footer={
          <>
            <KitButton variant="ghost" onClick={resetCreate} disabled={creating}>
              Cancel
            </KitButton>
            <KitButton variant="primary" loading={creating} onClick={handleCreateApiKey} disabled={!newKeyName.trim()}>
              Create key
            </KitButton>
          </>
        }
      >
        <form
          className="space-y-[18px]"
          onSubmit={(e) => {
            e.preventDefault()
            void handleCreateApiKey()
          }}
        >
          <KitField label="Name">
            <KitInput
              name="key-name"
              autoComplete="off"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Production mobile app…"
            />
          </KitField>
          <fieldset>
            <legend className="mb-[8px] text-[12.5px] font-medium leading-[18px] text-zinc-300">Access</legend>
            <div className="space-y-[10px]">
              {ROLE_OPTIONS.map((opt) => (
                <KitRadio
                  key={opt.value}
                  name="key-role"
                  value={opt.value}
                  checked={newKeyRole === opt.value}
                  onChange={(v) => setNewKeyRole(v as NewRole)}
                  label={opt.label}
                  description={opt.body}
                />
              ))}
            </div>
          </fieldset>
          {createError && <RefusedLine>{createError}</RefusedLine>}
        </form>
      </KitModal>

      <SecretOnceDialog
        open={!!created}
        onClose={() => setCreated(null)}
        title={created ? `API key for ${created.name}` : 'API key'}
        value={created?.key ?? ''}
        copyLabel="Copy key"
        description="Copy it now. Backenly keeps only a hash, so it can’t be shown again."
      >
        Keep it in your secrets manager or an environment variable.
      </SecretOnceDialog>

      <KitConfirmDialog
        open={!!pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
        danger
        busy={deleting}
        title={`Delete ${pendingDelete?.name ?? 'key'}?`}
        description="Any app or script using it stops working immediately."
        undoable={false}
        confirmLabel="Delete key"
      />
    </Section>
  )
}
