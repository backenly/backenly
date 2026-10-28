/**
 * THE REST OF THE BACKEND, IN THE SAME HISTORY: the registry, and what the
 * ledger (lib/changes/ledger.ts) and the restore (lib/changes/recovery.ts) call.
 * The model, and what never comes back, are described in ./core.ts.
 */

import { canonicalJson } from '../integrity'
import { authAdapter } from './auth'
import { changedSecrets, RESOURCE_ORDER, sameFields, sameItem, type ResourceAdapter, type ResourceId, type ResourceOp, type ResourceSnapshot, type Tx } from './core'
import { envAdapter } from './env'
import { functionsAdapter } from './functions'
import { integrationsAdapter } from './integrations'
import { keysAdapter } from './keys'
import { storageAdapter } from './storage'
import { webhooksAdapter } from './webhooks'

export * from './core'

// ── The adapters ─────────────────────────────────────────────────────────────

/** Read at call time, so the adapters' modules have finished loading. */
function adapters(): ResourceAdapter[] {
  return [authAdapter, storageAdapter, functionsAdapter, webhooksAdapter, envAdapter, keysAdapter, integrationsAdapter]
}

export function adapterFor(id: ResourceId): ResourceAdapter {
  const found = adapters().find((a) => a.id === id)
  if (!found) throw new Error(`No resource adapter for ${id}`)
  return found
}

/**
 * Every resource's state now. A resource that could not be read is left out
 * and logged: its changes are then not recorded for this change, which is said
 * on the change (`unread`), rather than the change being refused.
 */
export async function captureResources(projectId: string): Promise<{ snapshot: ResourceSnapshot; unread: ResourceId[] }> {
  const snapshot: ResourceSnapshot = {}
  const unread: ResourceId[] = []
  // Read together, kept in the registry's order, so a record lists its
  // resources the same way every time.
  const read = await Promise.all(adapters().map(async (a) => {
    try {
      return { id: a.id, items: await a.capture(projectId) }
    } catch (err) {
      console.error(`[ChangeResources] project=${projectId}: could not read ${a.id}:`, err instanceof Error ? err.message : err)
      return { id: a.id, items: null }
    }
  }))
  for (const r of read) {
    if (r.items) snapshot[r.id] = r.items
    else unread.push(r.id)
  }
  return { snapshot, unread }
}

/** What differs between two states, item by item. Only resources read on both sides. */
export function diffResources(before: ResourceSnapshot, after: ResourceSnapshot): ResourceOp[] {
  const ops: ResourceOp[] = []
  for (const resource of Object.keys(before) as ResourceId[]) {
    const b = before[resource]
    const a = after[resource]
    if (!b || !a) continue
    for (const key of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
      if (!sameItem(b[key], a[key])) ops.push({ resource, key, before: b[key] ?? null, after: a[key] ?? null })
    }
  }
  return ops
}

/** The parts of a snapshot the ops name, for storing with the change. */
export function pickItems(ops: ResourceOp[], side: 'before' | 'after'): ResourceSnapshot {
  const out: ResourceSnapshot = {}
  for (const op of ops) {
    const item = op[side]
    if (!item) continue
    ;(out[op.resource] ??= {})[op.key] = item
  }
  return out
}

/** The ops a stored change describes: its checkpoint's items before, its result's after. */
export function opsOf(checkpoint: ResourceSnapshot | undefined, result: ResourceSnapshot | undefined): ResourceOp[] {
  const ops: ResourceOp[] = []
  const present = new Set([...Object.keys(checkpoint ?? {}), ...Object.keys(result ?? {})])
  for (const resource of RESOURCE_ORDER.filter((r) => present.has(r))) {
    const b = checkpoint?.[resource] ?? {}
    const a = result?.[resource] ?? {}
    for (const key of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
      ops.push({ resource, key, before: b[key] ?? null, after: a[key] ?? null })
    }
  }
  return ops
}

// ── Saying what a change did ─────────────────────────────────────────────────

export function describeOp(op: ResourceOp): string {
  const label = (op.after ?? op.before)!.label
  if (!op.before) return `Created ${label}`
  if (!op.after) return `Removed ${label}`
  const fields = [...new Set([...Object.keys(op.before.fields), ...Object.keys(op.after.fields)])]
    .filter((f) => canonicalJson(op.before!.fields[f] ?? null) !== canonicalJson(op.after!.fields[f] ?? null))
  const secrets = changedSecrets(op.before, op.after)
  const what = [...fields.map(humanField), ...secrets.map((s) => `${humanField(s)} (replaced)`)]
  return `Changed ${label}${what.length ? `: ${what.slice(0, 3).join(', ')}${what.length > 3 ? ` and ${what.length - 3} more` : ''}` : ''}`
}

/** One sentence for a change that touched resources. */
export function describeOps(ops: ResourceOp[]): string {
  if (ops.length === 0) return ''
  if (ops.length === 1) return describeOp(ops[0])
  const created = ops.filter((o) => !o.before).map((o) => o.after!.label)
  const removed = ops.filter((o) => !o.after).map((o) => o.before!.label)
  const changed = ops.filter((o) => o.before && o.after).map((o) => o.after!.label)
  const parts = [
    created.length ? `created ${list(created)}` : '',
    changed.length ? `changed ${list(changed)}` : '',
    removed.length ? `removed ${list(removed)}` : '',
  ].filter(Boolean)
  const s = parts.join(', ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function list(items: string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items[0]}, ${items[1]} and ${items.length - 2} more`
}

function humanField(f: string): string {
  return f.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}

/** The resources a set of ops touched, for the change's `resources`. */
export function resourcesTouched(ops: ResourceOp[]): ResourceId[] {
  return [...new Set(ops.map((o) => o.resource))]
}

// ── Restoring ────────────────────────────────────────────────────────────────

export interface ResourceAssessment {
  /** Items changed since the change: restoring them would undo that too. */
  conflicts: Array<{ table: string; reason: string }>
  /** What does not come back, item by item: each needs a person who approves exactly that. */
  irreversible: Array<{ op: ResourceOp; reason: string; partial: boolean }>
  /** What the restore puts back: every op not wholly irreversible. */
  apply: ResourceOp[]
  /** One sentence per op it puts back, for View details. */
  steps: string[]
}

/**
 * What restoring a change would do to the rest of the backend, from today's
 * state, under the change lock. The same rule as the database: an item is put
 * back only if it is still exactly as the change left it.
 */
export async function assessResources(projectId: string, ops: ResourceOp[]): Promise<ResourceAssessment> {
  const out: ResourceAssessment = { conflicts: [], irreversible: [], apply: [], steps: [] }
  if (ops.length === 0) return out
  const { snapshot: live } = await captureResources(projectId)
  for (const op of ops) {
    const label = (op.after ?? op.before)!.label
    const now = live[op.resource]
    if (!now) {
      out.conflicts.push({ table: label, reason: `${label} could not be read, so it cannot be checked` })
      continue
    }
    const current = now[op.key] ?? null
    if (!sameItem(current, op.after)) {
      out.conflicts.push({
        table: label,
        reason: op.after && !current ? `${label} no longer exists` : !op.after ? `${label} was created again after this change` : `${label} has changed since this change`,
      })
      continue
    }
    const adapter = adapterFor(op.resource)
    const ir = adapter.irreversible(op, ops) ?? (adapter.liveCheck ? await adapter.liveCheck(projectId, op) : null)
    if (ir) out.irreversible.push({ op, ...ir })
    if (!ir || ir.partial) {
      out.apply.push(op)
      out.steps.push(!op.before ? `Remove ${label}.` : !op.after ? `Bring back ${label}.` : `Put ${label} back as it was.`)
    }
  }
  return out
}

/** Put back what `ops` name, in the caller's transaction. */
export async function applyResources(tx: Tx, projectId: string, ops: ResourceOp[]): Promise<void> {
  for (const op of ops) await adapterFor(op.resource).apply(tx, projectId, op)
}

/** Undo `applyResources`: each item back to how the change had left it. */
export async function compensateResources(tx: Tx, projectId: string, ops: ResourceOp[]): Promise<void> {
  for (const op of [...ops].reverse()) {
    await adapterFor(op.resource).apply(tx, projectId, { ...op, before: op.after, after: op.before })
  }
}

/** The work each adapter does outside the platform database once the restore has committed. */
export async function afterCommitResources(projectId: string, ops: ResourceOp[]): Promise<void> {
  for (const op of ops) {
    const adapter = adapterFor(op.resource)
    if (adapter.afterCommit) await adapter.afterCommit(projectId, op).catch(() => {})
  }
  // Which row events the database captures is derived from the webhooks and
  // row-event functions (lib/webhooks/capture.ts): a restore that brought one
  // back or took one away changes it, once for all of them.
  if (ops.some((o) => o.resource === 'webhooks' || o.resource === 'functions')) {
    const { syncWebhookCapture } = await import('@/lib/webhooks/capture')
    await syncWebhookCapture(projectId).catch((err) => console.warn(`[ChangeResources] capture sync after restore failed for ${projectId}:`, err?.message ?? err))
  }
}

/**
 * The independent check, as the database's: read back, compared with how each
 * item was before the change. A partly restorable item is compared on its
 * settings, since what the adapter named (a secret) was left as it is.
 */
export async function verifyResources(
  projectId: string,
  applied: ResourceOp[],
  partial: Set<string>,
): Promise<Array<{ id: string; label: string; ok: boolean; detail: string }>> {
  if (applied.length === 0) return []
  const { snapshot: live } = await captureResources(projectId)
  return applied.map((op, i) => {
    const label = (op.before ?? op.after)!.label
    const now = live[op.resource]?.[op.key] ?? null
    const ok = partial.has(`${op.resource}:${op.key}`) ? sameFields(now, op.before) : sameItem(now, op.before)
    return {
      id: `resource_${i}`,
      label,
      ok,
      detail: ok
        ? (!op.before ? 'removed, as before the change' : 'matches how it was before the change')
        : (!op.before ? 'should be gone and is still there' : !now ? 'should be back and is not' : 'differs from how it was before the change'),
    }
  })
}

/** Every key an op touches, for finding later changes to the same items. */
export function opKeys(ops: ResourceOp[]): string[] {
  return ops.map((o) => `${o.resource}:${o.key}`)
}

