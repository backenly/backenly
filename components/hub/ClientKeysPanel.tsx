'use client'

/**
 * API keys: every key for this project (apps, scripts, agents), rendered under
 * Settings → API keys. The page owns the header; this panel is the table, the
 * create dialog and the one-time reveal.
 *
 * The server returns the full plaintext key exactly once, at creation. Every
 * later read is masked by design, so a listed key shows its prefix and "Shown
 * once, at creation" rather than handing out a broken masked string to copy.
 */

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Toast } from '@/components/ui/Toast'
import { KeyRound, Trash2, Plus, Check, Eye, EyeOff, AlertTriangle, Shield } from 'lucide-react'
import {
  CopyButton,
  EmptyState,
  IconButton,
  KitButton,
  KitConfirmDialog,
  KitInput,
  KitModal,
  KitNote,
  Skeleton,
  Tag,
} from '@/components/inspector/kit'
import { PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'

interface ApiKey {
  id: string
  name: string
  key?: string
  keyPrefix: string
  keyType?: 'dashboard' | 'public'
  role: 'admin' | 'read-only' | 'write' | 'ai-only' | 'client' | 'service'
  permissions: string[]
  capabilities?: string[]
  serviceRole?: boolean
  /** Set for a preview key: it reaches that branch and nothing else. */
  branch?: { id: string; name: string; status: string } | null
  projectId?: string | null
  lastUsed?: string | null
  createdAt: string
  expiresAt?: string | null
  rateLimit?: number
  rateLimitWindow?: number
  requestCount?: number
  resetAt?: string | null
}

type NewRole = 'admin' | 'read-only' | 'write' | 'client'

// Elevated keys get the accent so they stand out in the list; the rest stay
// neutral, so the table does not read as one accent wash.
const ROLE_TAG: Record<string, 'violet' | 'good' | 'neutral'> = {
  admin: 'violet',
  write: 'good',
  'read-only': 'neutral',
  client: 'neutral',
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin',
  write: 'Write',
  'read-only': 'Read only',
  client: 'Client',
  'ai-only': 'AI only',
  service: 'Service',
}

const ROLE_OPTIONS: Array<{ value: NewRole; label: string; body: string }> = [
  { value: 'admin', label: 'Admin', body: 'Full access. Server-side only, never in a browser.' },
  { value: 'write', label: 'Write', body: 'Read and write data, no administration.' },
  { value: 'read-only', label: 'Read only', body: 'Reads data, changes nothing.' },
  { value: 'client', label: 'Client', body: 'Safe to embed in a frontend app.' },
]

export function ClientKeysPanel() {
  const params = useParams()
  const projectId = (params.id ?? params.projectId) as string

  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyRole, setNewKeyRole] = useState<NewRole>('admin')
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' | 'warning' } | null>(null)

  useEffect(() => {
    if (projectId) loadApiKeys()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const loadApiKeys = async () => {
    try {
      setLoading(true)
      const response = await fetch(`/api/api-keys?projectId=${projectId}`, { credentials: 'include' })
      if (!response.ok) throw new Error('Failed to fetch API keys')
      const data = await response.json()
      setApiKeys(data.apiKeys || [])
    } catch (error: any) {
      setToast({ message: error.message || 'Failed to load API keys', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const resetCreate = () => {
    setShowCreateModal(false)
    setNewKeyName('')
    setNewKeyRole('admin')
  }

  const handleCreateApiKey = async () => {
    if (!newKeyName.trim()) {
      setToast({ message: 'Name the key so you can recognise it later.', type: 'warning' })
      return
    }
    try {
      setCreating(true)
      const response = await fetch(`/api/api-keys?projectId=${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: newKeyName,
          keyType: 'public',
          role: newKeyRole,
          capabilities: ['database', 'auth', 'storage', 'functions', 'ai'],
          serviceRole: false,
          projectId,
        }),
      })
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to create API key')
      }
      const data = await response.json()
      setCreatedKey(data.apiKey.key)
      resetCreate()
      await loadApiKeys()
    } catch (error: any) {
      setToast({ message: error.message || 'Failed to create API key', type: 'error' })
    } finally {
      setCreating(false)
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      const response = await fetch(`/api/api-keys/${pendingDelete.id}?projectId=${projectId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to delete API key')
      }
      setToast({ message: `Deleted “${pendingDelete.name}”`, type: 'success' })
      setPendingDelete(null)
      await loadApiKeys()
    } catch (error: any) {
      setToast({ message: error.message || 'Failed to delete API key', type: 'error' })
    } finally {
      setDeleting(false)
    }
  }

  const toggleRevealKey = (keyId: string) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(keyId)) next.delete(keyId)
      else next.add(keyId)
      return next
    })
  }

  const formatDate = (dateString: string) =>
    new Date(dateString).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

  return (
    <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pt-6`}>
      {toast && <Toast message={toast.message} type={toast.type} isVisible onClose={() => setToast(null)} />}

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold leading-[22px] tracking-[-0.012em] text-zinc-100">API keys</h2>
          <p className="mt-1 max-w-[68ch] text-[13px] leading-[20px] text-zinc-400">
            Keys for apps, scripts and agents. Client keys are safe to embed; admin keys stay server-side.
          </p>
        </div>
        <KitButton variant="primary" icon={Plus} onClick={() => setShowCreateModal(true)} disabled={creating}>
          New key
        </KitButton>
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-[52px] w-full rounded-[10px]" />
          <Skeleton className="h-[52px] w-full rounded-[10px]" />
        </div>
      ) : apiKeys.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-white/[0.10]">
          <EmptyState
            icon={KeyRound}
            title="No API keys yet"
            description="Create a key to make authenticated requests from your app, a script or a server."
            action={
              <KitButton variant="primary" icon={Plus} onClick={() => setShowCreateModal(true)}>
                Create a key
              </KitButton>
            }
          />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[10px] border border-white/[0.08] bg-[#0f1012]">
          <table className="w-full min-w-[760px] text-left">
            <thead>
              <tr className="border-b border-white/[0.06] text-[12px] text-zinc-500">
                <th scope="col" className="h-[38px] whitespace-nowrap px-4 font-medium">Name</th>
                <th scope="col" className="h-[38px] whitespace-nowrap px-4 font-medium">Key</th>
                <th scope="col" className="h-[38px] whitespace-nowrap px-4 font-medium">Rate limit</th>
                <th scope="col" className="h-[38px] whitespace-nowrap px-4 font-medium">Created</th>
                <th scope="col" className="h-[38px] whitespace-nowrap px-4 font-medium">Last used</th>
                <th scope="col" className="h-[38px] w-[56px] px-4 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05]">
              {apiKeys.map((key) => {
                const isRevealed = revealedKeys.has(key.id)
                // A usable plaintext exists only for a key still held from its
                // creation; everything else is the masked identifier.
                const realKey =
                  key.key && !key.key.includes('…') && !key.key.includes('...') && key.key.length >= 24 ? key.key : null
                const maskedKey = key.key && !realKey ? key.key : key.keyPrefix + '••••••••'
                const displayKey = realKey ? (isRevealed ? realKey : key.keyPrefix + '••••••••') : maskedKey
                return (
                  <tr key={key.id} className="group transition-colors hover:bg-white/[0.02]">
                    <td className="px-4 py-3 align-middle">
                      <div className="flex items-center gap-2">
                        <span className="max-w-[220px] truncate text-[13px] font-medium text-zinc-100">{key.name}</span>
                        <Tag tone={ROLE_TAG[key.role] ?? 'neutral'}>{ROLE_LABEL[key.role] ?? key.role}</Tag>
                        {key.branch && (
                          // A preview key answers only on its branch, and not at
                          // all once that branch is merged or discarded.
                          <Tag tone={key.branch.status === 'active' ? 'warn' : 'neutral'} mono>
                            {key.branch.status === 'active'
                              ? `Preview: ${key.branch.name}`
                              : `Preview: ${key.branch.name} (${key.branch.status})`}
                          </Tag>
                        )}
                      </div>
                      <p className="mt-0.5 max-w-[260px] truncate text-[12px] text-zinc-500">
                        {key.capabilities && key.capabilities.length > 0 ? key.capabilities.join(', ') : 'Full access'}
                      </p>
                    </td>
                    <td className="px-4 py-3 align-middle">
                      <div className="flex items-center gap-1">
                        <code className="max-w-[240px] truncate font-mono text-[12px] text-zinc-300">{displayKey}</code>
                        {realKey ? (
                          <>
                            <IconButton
                              icon={isRevealed ? EyeOff : Eye}
                              label={isRevealed ? 'Hide key' : 'Reveal key'}
                              onClick={() => toggleRevealKey(key.id)}
                            />
                            <CopyButton value={realKey} label="Copy key" />
                          </>
                        ) : (
                          <span className="ml-1 inline-flex items-center gap-1 whitespace-nowrap text-[12px] text-zinc-600">
                            <Shield className="h-3 w-3" /> Shown once
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 align-middle text-[13px] tabular-nums text-zinc-400">
                      {(key.rateLimit ?? 1000).toLocaleString()} / {Math.max(1, Math.round((key.rateLimitWindow ?? 3600) / 3600))} h
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 align-middle text-[13px] tabular-nums text-zinc-400">
                      {formatDate(key.createdAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 align-middle text-[13px] tabular-nums">
                      {key.lastUsed ? (
                        <span className="text-zinc-300">{formatDate(key.lastUsed)}</span>
                      ) : (
                        <span className="text-zinc-600">Never</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right align-middle">
                      <IconButton
                        icon={Trash2}
                        label={`Delete ${key.name}`}
                        onClick={() => setPendingDelete({ id: key.id, name: key.name })}
                        className="hover:!bg-rose-500/10 hover:!text-rose-300 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Create ─────────────────────────────────────────────────────── */}
      <KitModal
        open={showCreateModal}
        onClose={resetCreate}
        title="New API key"
        description="The key is shown once, right after you create it."
        width="max-w-[480px]"
        footer={
          <>
            <KitButton variant="ghost" onClick={resetCreate} disabled={creating}>
              Cancel
            </KitButton>
            <KitButton variant="primary" icon={Plus} loading={creating} onClick={handleCreateApiKey} disabled={!newKeyName.trim()}>
              {creating ? 'Creating…' : 'Create key'}
            </KitButton>
          </>
        }
      >
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            if (newKeyName.trim()) handleCreateApiKey()
          }}
        >
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-medium text-zinc-300">Name</span>
            <KitInput
              name="key-name"
              autoComplete="off"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Production mobile app…"
            />
          </label>

          <fieldset>
            <legend className="mb-2 text-[12.5px] font-medium text-zinc-300">Access</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {ROLE_OPTIONS.map((opt) => {
                const on = newKeyRole === opt.value
                return (
                  <label
                    key={opt.value}
                    className={`relative flex cursor-pointer flex-col rounded-[8px] border px-3 py-2.5 transition-colors ${
                      on ? 'border-violet-300/40 bg-violet-400/[0.06]' : 'border-white/[0.08] hover:border-white/[0.14]'
                    } focus-within:ring-2 focus-within:ring-violet-300/60`}
                  >
                    <input
                      type="radio"
                      name="key-role"
                      value={opt.value}
                      checked={on}
                      onChange={() => setNewKeyRole(opt.value)}
                      className="sr-only"
                    />
                    <span className="flex items-center justify-between text-[13px] font-medium text-zinc-100">
                      {opt.label}
                      {on && <Check className="h-3.5 w-3.5 text-violet-200" strokeWidth={2.25} />}
                    </span>
                    <span className="mt-0.5 text-[12px] leading-[17px] text-zinc-500">{opt.body}</span>
                  </label>
                )
              })}
            </div>
          </fieldset>
        </form>
      </KitModal>

      {/* ── One-time reveal ────────────────────────────────────────────── */}
      <KitModal
        open={!!createdKey}
        onClose={() => setCreatedKey(null)}
        title="Key created"
        description="Copy it now. Backenly stores only a hash, so it can never be shown again."
        width="max-w-[540px]"
        footer={
          <KitButton variant="primary" onClick={() => setCreatedKey(null)}>
            I’ve saved it
          </KitButton>
        }
      >
        {createdKey && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-[8px] border border-white/[0.08] bg-[#08090a] p-3">
              <code className="min-w-0 flex-1 select-all break-all font-mono text-[12.5px] leading-[20px] text-zinc-100">
                {createdKey}
              </code>
              <CopyButton value={createdKey} label="Copy key" showLabel />
            </div>
            <KitNote tone="warn" icon={AlertTriangle}>
              This is your only chance to save this key. Store it in your secrets manager or an environment variable.
            </KitNote>
          </div>
        )}
      </KitModal>

      {/* ── Delete ─────────────────────────────────────────────────────── */}
      <KitConfirmDialog
        open={!!pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        danger
        busy={deleting}
        title={`Delete “${pendingDelete?.name ?? ''}”?`}
        description="Any app or script using this key stops working immediately. This cannot be undone."
        confirmLabel="Delete key"
      />
    </div>
  )
}
