'use client'

/**
 * The Branches section's three dialogs: create a branch, confirm a merge,
 * confirm a discard (decision 6: dialogs only create, confirm, or show a
 * secret once; the preview key's are in BranchPreview).
 */

import { useState } from 'react'
import { KitButton, KitCheckbox, KitConfirmDialog, KitField, KitInput, KitModal } from '@/components/inspector/kit'
import { RefusedLine } from '@/components/console/states'
import { EDGE, WELL } from '@/components/console/tokens'
import { BRANCH_LIMIT, refusal } from './data'

/** "New branch": a name, and rows only when asked. At the limit it says so instead of asking. */
export function NewBranchDialog({
  open,
  onClose,
  projectId,
  atLimit,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  atLimit: boolean
  onCreated: (branchId: string | null) => void
}) {
  const [name, setName] = useState('')
  const [includeData, setIncludeData] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)

  const close = () => {
    if (busy) return
    setRefused(null)
    onClose()
  }

  const create = async () => {
    const clean = name.trim().toLowerCase()
    if (!clean || busy) return
    setBusy(true)
    setRefused(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/branches`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: clean, includeData }),
      })
      let j: { success?: boolean; error?: string; branch?: { id?: string } } | null = null
      try {
        j = await res.json()
      } catch {
        j = null
      }
      if (!res.ok || !j?.success) {
        setRefused(refusal(j, 'The branch was not created.'))
        return
      }
      setName('')
      setIncludeData(false)
      onCreated(typeof j.branch?.id === 'string' ? j.branch.id : null)
    } catch {
      setRefused('The branch was not created. The server did not answer.')
    } finally {
      setBusy(false)
    }
  }

  if (atLimit) {
    return (
      <KitModal
        open={open}
        onClose={close}
        title="New branch"
        description={`${BRANCH_LIMIT} of ${BRANCH_LIMIT} branches are active. Merge or discard a branch first.`}
        footer={
          <KitButton variant="primary" onClick={close}>
            Close
          </KitButton>
        }
      />
    )
  }

  return (
    <KitModal
      open={open}
      onClose={close}
      title="New branch"
      footer={
        <>
          <KitButton variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </KitButton>
          <KitButton variant="primary" onClick={() => void create()} loading={busy} disabled={!name.trim()}>
            Create
          </KitButton>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
        className="space-y-[16px]"
      >
        <KitField label="Name" hint="Lowercase letters, numbers and dashes.">
          <KitInput
            placeholder="add-payments"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            className="font-mono"
            name="branch-name"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </KitField>
        <KitCheckbox
          checked={includeData}
          onChange={setIncludeData}
          disabled={busy}
          label="Copy production rows"
          description="Anyone with this branch's key can read them."
        />
        {refused && <RefusedLine>{refused}</RefusedLine>}
      </form>
    </KitModal>
  )
}

/**
 * Merging applies the branch's statements to production. The confirm lists
 * them exactly, in order, because they are what the person is agreeing to.
 */
export function MergeDialog({
  branchName,
  migrations,
  busy,
  onCancel,
  onConfirm,
}: {
  /** Null while closed. */
  branchName: string | null
  migrations: readonly string[]
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const none = migrations.length === 0
  return (
    <KitConfirmDialog
      open={branchName !== null}
      busy={busy}
      title={branchName ? `Merge ${branchName} into production?` : 'Merge branch'}
      description={
        none
          ? 'This branch has no schema changes. Merging closes it and drops its copy; production does not change.'
          : 'These statements are applied to production, in order. The branch then closes and its keys stop working.'
      }
      undoable={none ? undefined : true}
      confirmLabel="Merge into production"
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {!none && (
        <ol className={`max-h-[240px] space-y-[6px] overflow-auto rounded-[7px] border ${EDGE} ${WELL} px-[14px] py-[10px]`}>
          {migrations.map((m, i) => (
            <li key={i} className="flex gap-[10px] font-mono text-[12px] leading-[18px]">
              <span className="flex-shrink-0 tabular-nums text-faint">{i + 1}</span>
              <span className="min-w-0 text-zinc-300 [overflow-wrap:anywhere]">{m}</span>
            </li>
          ))}
        </ol>
      )}
    </KitConfirmDialog>
  )
}

/** Discarding drops the branch's copy for good: History cannot bring it back. */
export function DiscardDialog({
  branchName,
  busy,
  onCancel,
  onConfirm,
}: {
  branchName: string | null
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <KitConfirmDialog
      open={branchName !== null}
      danger
      busy={busy}
      title={branchName ? `Discard ${branchName}?` : 'Discard branch'}
      description="Production is not touched."
      undoable={false}
      lost="The branch's copy of the schema and every row in it are dropped, and its keys stop working."
      confirmLabel="Discard branch"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
