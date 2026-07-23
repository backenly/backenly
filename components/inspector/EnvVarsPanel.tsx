'use client'

import { useEffect, useState, useCallback } from 'react'
import { KeyRound, Plus, Trash2, Loader2, X, Check, AlertCircle, Eye, EyeOff } from 'lucide-react'
import { KIT, KitButton, KitInput, KitConfirmDialog } from '@/components/inspector/kit'

interface EnvVarSummary {
  id: string
  key: string
  preview: string
  description: string | null
  createdAt: string
  updatedAt: string
}

interface EnvVarsPanelProps {
  projectId: string
}

const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

export function EnvVarsPanel({ projectId }: EnvVarsPanelProps) {
  const [vars, setVars] = useState<EnvVarSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [deletingKey, setDeletingKey] = useState<string | null>(null)
  const [varToDelete, setVarToDelete] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [keyInput, setKeyInput] = useState('')
  const [valueInput, setValueInput] = useState('')
  const [descInput, setDescInput] = useState('')
  const [showValue, setShowValue] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/env-vars`, { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setVars(data.vars || [])
      }
    } catch {
      // best-effort
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const resetForm = () => {
    setKeyInput('')
    setValueInput('')
    setDescInput('')
    setShowValue(false)
    setError(null)
  }

  const handleAdd = async () => {
    if (!KEY_PATTERN.test(keyInput)) {
      setError('Key must be UPPER_SNAKE_CASE (e.g. STRIPE_WEBHOOK_SECRET)')
      return
    }
    if (!valueInput) {
      setError('Value is required')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/env-vars`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: keyInput,
          value: valueInput,
          description: descInput || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.error || 'Failed to save')
        return
      }
      resetForm()
      setAdding(false)
      await refresh()
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (key: string) => {
    setDeletingKey(key)
    try {
      const res = await fetch(`/api/projects/${projectId}/env-vars?key=${encodeURIComponent(key)}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (res.ok) await refresh()
    } finally {
      setDeletingKey(null)
    }
  }

  return (
    <div className={`${KIT.surface} border ${KIT.border} ${KIT.radius} overflow-hidden ${KIT.inset}`}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="w-3 h-3 text-zinc-500" />
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
            Project env vars
          </p>
          {vars.length > 0 && (
            <span className="font-mono text-[10.5px] text-zinc-500 tabular-nums">{vars.length}</span>
          )}
        </div>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 px-2 py-1 text-[11.5px] font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04] rounded-md transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
        )}
      </div>

      {/* Add form */}
      {adding && (
        <div className="px-4 py-4 border-b border-white/[0.06] space-y-3">
          <div>
            <label className="block text-[10px] font-semibold text-zinc-600 uppercase tracking-[0.12em] mb-1.5">Key</label>
            <KitInput
              type="text"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
              placeholder="STRIPE_WEBHOOK_SECRET"
              autoCapitalize="characters"
              className="font-mono"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-zinc-600 uppercase tracking-[0.12em] mb-1.5">Value</label>
            <div className="relative">
              <KitInput
                type={showValue ? 'text' : 'password'}
                value={valueInput}
                onChange={(e) => setValueInput(e.target.value)}
                placeholder="whsec_…"
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowValue((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-600 hover:text-zinc-300"
              >
                {showValue ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-zinc-600 uppercase tracking-[0.12em] mb-1.5">Description (optional)</label>
            <KitInput
              type="text"
              value={descInput}
              onChange={(e) => setDescInput(e.target.value)}
              placeholder="Stripe webhook signing secret"
            />
          </div>
          {error && (
            <div className="flex items-start gap-2 px-2.5 py-2 bg-rose-500/[0.05] border border-rose-500/15 rounded-lg">
              <AlertCircle className="w-3.5 h-3.5 text-rose-300 flex-shrink-0 mt-0.5" />
              <p className="text-[11.5px] text-rose-300/90 leading-relaxed">{error}</p>
            </div>
          )}
          <div className="flex gap-2">
            <KitButton variant="primary" onClick={handleAdd} disabled={submitting}>
              {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Save
            </KitButton>
            <KitButton variant="ghost" icon={X} onClick={() => { resetForm(); setAdding(false) }}>
              Cancel
            </KitButton>
          </div>
        </div>
      )}

      {/* List */}
      <div className="px-1 py-1">
        {loading ? (
          <p className="px-3 py-3 text-[11.5px] text-zinc-600">Loading…</p>
        ) : vars.length === 0 ? (
          <div className="px-3 py-3.5 text-[12px] text-zinc-500 leading-5">
            None yet. Save secrets like Stripe webhook signing keys or third-party API tokens here. They&apos;re encrypted at rest and available inside AI functions as <code className="font-mono text-violet-300">ctx.env.KEY</code>.
          </div>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {vars.map((v) => (
              <li
                key={v.id}
                className="flex items-center justify-between px-3 py-[9px] rounded-md transition-colors hover:bg-white/[0.025]"
              >
                <div className="min-w-0 flex-1 mr-3">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[12px] font-mono text-zinc-200 truncate">{v.key}</span>
                    <span className="font-mono text-[10.5px] text-zinc-600 flex-shrink-0">{v.preview}</span>
                  </div>
                  {v.description && (
                    <p className="text-[11px] text-zinc-500 mt-0.5 truncate">{v.description}</p>
                  )}
                </div>
                <button
                  onClick={() => setVarToDelete(v.key)}
                  disabled={deletingKey === v.key}
                  className="flex items-center gap-1 p-1.5 text-zinc-600 hover:text-rose-300 hover:bg-rose-500/[0.08] rounded-md transition-colors"
                >
                  {deletingKey === v.key ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <KitConfirmDialog
        open={!!varToDelete}
        onCancel={() => setVarToDelete(null)}
        onConfirm={() => {
          if (varToDelete) handleDelete(varToDelete)
          setVarToDelete(null)
        }}
        title={`Delete ${varToDelete ?? 'env var'}?`}
        description={varToDelete ? `AI functions reading ctx.env.${varToDelete} will get undefined.` : undefined}
        confirmLabel="Delete"
        danger
      />
    </div>
  )
}
