'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Toast } from '@/components/ui/Toast'
import { motion, AnimatePresence } from 'framer-motion'
import {
  KeyRound, Trash2, Plus, Copy, Check, Eye, EyeOff, AlertTriangle,
  Shield, Loader2, Activity, X, ChevronDown,
} from 'lucide-react'
import { InspectorPageHeader } from '@/components/inspector/InspectorPageHeader'
import {
  KIT, KitButton, KitBadge, KitField, KitInput, EmptyState, KitNote,
} from '@/components/inspector/kit'

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
  projectId?: string | null
  lastUsed?: string | null
  createdAt: string
  expiresAt?: string | null
  rateLimit?: number
  rateLimitWindow?: number
  requestCount?: number
  resetAt?: string | null
}

// Role → semantic badge tone. Violet (beta) marks elevated/admin keys; the rest
// use neutral/semantic tones so the list doesn't read as one accent wash.
const ROLE_TONE: Record<string, 'beta' | 'operational' | 'managed' | 'neutral'> = {
  admin: 'beta',
  write: 'operational',
  'read-only': 'managed',
  client: 'neutral',
}

export function ClientKeysPanel() {
  const params = useParams()
  const projectId = (params.id ?? params.projectId) as string

  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyRole, setNewKeyRole] = useState<'admin' | 'read-only' | 'write' | 'client'>('admin')
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [createdCopied, setCreatedCopied] = useState(false)
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
      // The server only ever returns a masked key on list reads (the raw key is
      // shown exactly once, at creation). So every listed key renders as
      // "Shown once, at creation" — the honest state — and the reveal/copy
      // affordance only lights up for the just-created key held in memory.
      setApiKeys(data.apiKeys || [])
    } catch (error: any) {
      setToast({ message: error.message || 'Failed to load API keys', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const handleCreateApiKey = async () => {
    if (!newKeyName.trim()) {
      setToast({ message: 'Please enter a key name', type: 'warning' })
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
      setNewKeyName('')
      setNewKeyRole('admin')
      await loadApiKeys()
      setToast({ message: 'API key created', type: 'success' })
    } catch (error: any) {
      setToast({ message: error.message || 'Failed to create API key', type: 'error' })
    } finally {
      setCreating(false)
    }
  }

  const handleDeleteApiKey = async (keyId: string, keyName: string) => {
    if (!confirm(`Delete the API key "${keyName}"? This cannot be undone and any app using it will stop working immediately.`)) return
    try {
      const response = await fetch(`/api/api-keys/${keyId}?projectId=${projectId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to delete API key')
      }
      setToast({ message: 'API key deleted', type: 'success' })
      await loadApiKeys()
    } catch (error: any) {
      setToast({ message: error.message || 'Failed to delete API key', type: 'error' })
    }
  }

  const toggleRevealKey = (keyId: string) => {
    setRevealedKeys(prev => {
      const newSet = new Set(prev)
      if (newSet.has(keyId)) newSet.delete(keyId)
      else newSet.add(keyId)
      return newSet
    })
  }

  const handleCopyKey = (key: string, keyId: string) => {
    navigator.clipboard.writeText(key)
    setCopiedKey(keyId)
    setToast({ message: 'Copied to clipboard', type: 'success' })
    setTimeout(() => setCopiedKey(null), 2000)
  }

  const formatDate = (dateString: string) =>
    new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })

  return (
    <div className="h-full overflow-y-auto bg-[#101116]">
      {toast && <Toast message={toast.message} type={toast.type} isVisible={true} onClose={() => setToast(null)} />}

      <InspectorPageHeader
        icon={KeyRound}
        title="API Keys"
        description="Every key for this project: apps, scripts, and agents. Client keys are safe to embed; admin keys must stay server-side."
        badge={{ label: 'Managed', variant: 'managed' }}
        stat={loading ? undefined : `${apiKeys.length} ${apiKeys.length === 1 ? 'key' : 'keys'}`}
        actions={
          <KitButton variant="primary" icon={Plus} onClick={() => setShowCreateModal(true)} disabled={creating}>
            New key
          </KitButton>
        }
      />

      <div className="px-8 pb-24 pt-8">
        <div className="max-w-3xl">
          {loading ? (
            <div className="flex items-center gap-2 text-[13px] text-zinc-500 py-10 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading keys…
            </div>
          ) : apiKeys.length === 0 ? (
            <div className={`${KIT.surface} border ${KIT.border} ${KIT.radius} ${KIT.inset}`}>
              <EmptyState
                icon={KeyRound}
                title="No API keys yet"
                description="Create your first key to start making authenticated requests from your app."
                action={
                  <KitButton variant="primary" icon={Plus} onClick={() => setShowCreateModal(true)}>
                    Create key
                  </KitButton>
                }
              />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {apiKeys.map((key) => {
                const isRevealed = revealedKeys.has(key.id)
                const isCopied = copiedKey === key.id
                // The server only returns the full plaintext key ONCE, at
                // creation — every later read is masked (e.g. sk_live_ab…cd) by
                // design. So we can only reveal/copy a genuinely usable value
                // when we still hold the raw key (recovered from localStorage).
                // Otherwise we show the masked identifier honestly rather than
                // handing the user a broken "sk_live_ab…cd" string to copy.
                const realKey = key.key && !key.key.includes('…') && !key.key.includes('...') && key.key.length >= 24
                  ? key.key
                  : null
                const maskedKey = key.key && !realKey ? key.key : key.keyPrefix + '••••••••••••'
                const displayKey = realKey
                  ? (isRevealed ? realKey : key.keyPrefix + '••••••••••••')
                  : maskedKey
                return (
                  <motion.div
                    key={key.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`group relative ${KIT.surface} border ${KIT.border} ${KIT.radius} ${KIT.inset} p-5`}
                  >
                    <div className="flex items-start justify-between gap-4 mb-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2.5">
                          <h3 className="text-[14px] font-semibold text-zinc-50 truncate">{key.name}</h3>
                          <KitBadge tone={ROLE_TONE[key.role] ?? 'neutral'} className="uppercase">
                            {key.role}
                          </KitBadge>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-[12px] text-zinc-500">
                          <span>Created {formatDate(key.createdAt)}</span>
                          {key.lastUsed && (
                            <span className="text-emerald-400/80">Last used {formatDate(key.lastUsed)}</span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteApiKey(key.id, key.name)}
                        className="p-1.5 rounded-md text-zinc-500 hover:text-rose-300 hover:bg-rose-500/10 transition-colors opacity-0 group-hover:opacity-100"
                        title="Delete key"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="flex items-center gap-2 bg-[#0f1015] border border-white/[0.08] rounded-md px-3 py-2.5">
                      <code className="flex-1 min-w-0 text-[12.5px] font-mono text-zinc-200 truncate">
                        {displayKey}
                      </code>
                      {realKey ? (
                        <>
                          <button
                            onClick={() => toggleRevealKey(key.id)}
                            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06] transition-colors"
                            title={isRevealed ? 'Hide' : 'Reveal'}
                          >
                            {isRevealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            onClick={() => handleCopyKey(realKey, key.id)}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                              isCopied
                                ? 'bg-emerald-500/[0.12] border border-emerald-500/25 text-emerald-300'
                                : 'bg-white/[0.05] border border-white/[0.09] text-zinc-200 hover:bg-white/[0.09]'
                            }`}
                          >
                            {isCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                            {isCopied ? 'Copied' : 'Copy'}
                          </button>
                        </>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500 whitespace-nowrap pl-1">
                          <Shield className="w-3 h-3" />
                          Shown once, at creation
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-5 mt-3 text-[12px] text-zinc-500">
                      <span className="inline-flex items-center gap-1.5">
                        <Activity className="w-3.5 h-3.5 text-zinc-600" />
                        {key.rateLimit ?? 1000} req/{Math.max(1, Math.round((key.rateLimitWindow ?? 3600) / 3600))}h
                      </span>
                      <span className="inline-flex items-center gap-1.5 min-w-0">
                        <Shield className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />
                        <span className="truncate">
                          {key.capabilities && key.capabilities.length > 0 ? key.capabilities.join(', ') : 'Full access'}
                        </span>
                      </span>
                    </div>
                  </motion.div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Create key modal ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {showCreateModal && (
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center p-4"
            onClick={(e) => { if (e.target === e.currentTarget) { setShowCreateModal(false); setNewKeyName(''); setNewKeyRole('admin') } }}
          >
            <div className="absolute inset-0 bg-black/70" />
            <motion.div
              initial={{ opacity: 0, scale: 0.97, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 8 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              className={`relative w-full max-w-md ${KIT.surface} border ${KIT.border} ${KIT.radius} ${KIT.inset} overflow-hidden`}
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.08]">
                <div className="flex items-center gap-2.5">
                  <span className={`w-8 h-8 ${KIT.radiusSm} ${KIT.accentBg} border ${KIT.accentBorder} flex items-center justify-center`}>
                    <KeyRound className="w-4 h-4 text-violet-300" />
                  </span>
                  <h3 className="text-[15px] font-semibold text-zinc-50">New API key</h3>
                </div>
                <button
                  onClick={() => { setShowCreateModal(false); setNewKeyName(''); setNewKeyRole('admin') }}
                  className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06] transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="px-5 py-5 space-y-5">
                <KitField label="Key name" hint="A label to recognise this key later, e.g. Production mobile app.">
                  <KitInput
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && newKeyName.trim()) handleCreateApiKey() }}
                    placeholder="e.g. Production mobile app"
                    autoFocus
                  />
                </KitField>

                <KitField label="Access role" hint="Controls what this key is allowed to do.">
                  <div className="relative">
                    <select
                      value={newKeyRole}
                      onChange={(e) => setNewKeyRole(e.target.value as any)}
                      className={`w-full px-3.5 py-2.5 bg-[#0f1015] border ${KIT.border} ${KIT.radiusSm} text-[13.5px] text-zinc-50 appearance-none cursor-pointer focus:outline-none focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/15 transition-colors`}
                    >
                      <option value="admin" className="bg-[#0f1015]">Admin (full access)</option>
                      <option value="write" className="bg-[#0f1015]">Write (read + write)</option>
                      <option value="read-only" className="bg-[#0f1015]">Read only</option>
                      <option value="client" className="bg-[#0f1015]">Client (frontend apps)</option>
                    </select>
                    <ChevronDown className="w-4 h-4 text-zinc-500 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  </div>
                </KitField>
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-white/[0.08] bg-white/[0.012]">
                <KitButton variant="ghost" onClick={() => { setShowCreateModal(false); setNewKeyName(''); setNewKeyRole('admin') }} disabled={creating}>
                  Cancel
                </KitButton>
                <KitButton
                  variant="primary"
                  icon={creating ? Loader2 : Plus}
                  onClick={handleCreateApiKey}
                  disabled={creating || !newKeyName.trim()}
                  className={creating ? '[&_svg]:animate-spin' : ''}
                >
                  {creating ? 'Generating…' : 'Generate key'}
                </KitButton>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Created key reveal (one-time) ────────────────────────────────── */}
      <AnimatePresence>
        {createdKey && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/75" />
            <motion.div
              initial={{ opacity: 0, scale: 0.97, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 8 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              className={`relative w-full max-w-lg ${KIT.surface} border ${KIT.border} ${KIT.radius} ${KIT.inset} overflow-hidden`}
            >
              <div className="px-6 py-6">
                <div className="flex items-center gap-3 mb-1">
                  <span className="w-9 h-9 rounded-md bg-emerald-500/[0.10] border border-emerald-500/25 flex items-center justify-center">
                    <Check className="w-4 h-4 text-emerald-300" />
                  </span>
                  <div>
                    <h3 className="text-[15.5px] font-semibold text-zinc-50 tracking-tight">Key created</h3>
                    <p className="text-[12.5px] text-zinc-400">Copy it now. It won&apos;t be shown again.</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 bg-[#0f1015] border border-white/[0.08] rounded-md px-3 py-3 mt-5">
                  <code className="flex-1 min-w-0 text-[13px] font-mono text-zinc-100 break-all select-all">
                    {createdKey}
                  </code>
                </div>

                <KitButton
                  variant="primary"
                  icon={createdCopied ? Check : Copy}
                  onClick={() => {
                    navigator.clipboard.writeText(createdKey)
                    setCreatedCopied(true)
                    setToast({ message: 'Copied to clipboard', type: 'success' })
                    setTimeout(() => setCreatedCopied(false), 2000)
                  }}
                  className="w-full justify-center mt-3"
                >
                  {createdCopied ? 'Copied to clipboard' : 'Copy to clipboard'}
                </KitButton>

                <div className="mt-4">
                  <KitNote tone="warn" icon={AlertTriangle}>
                    This is your only chance to save this key. Backenly stores only a hash, so the raw key can never be shown again.
                  </KitNote>
                </div>
              </div>

              <div className="flex items-center justify-end px-6 py-4 border-t border-white/[0.08] bg-white/[0.012]">
                <KitButton variant="secondary" onClick={() => { setCreatedKey(null); setShowCreateModal(false) }}>
                  I&apos;ve saved it
                </KitButton>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  )
}
