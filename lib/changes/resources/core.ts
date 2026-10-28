/**
 * The shapes and helpers every resource adapter shares. The registry, and what
 * the ledger and the restore call, are in ./index.ts, which explains the whole.
 *
 * THE REST OF THE BACKEND, IN THE SAME HISTORY
 * ============================================
 *
 * A governed change records what it did to the database from the catalog
 * before and after it (lib/changes/ledger.ts). An agent's request changes more
 * than the database: one request can create a table, a bucket, a function and
 * an environment variable. So the same change also records the project's
 * configuration around the database, resource by resource, the same way:
 * captured before and after, the difference is what the change did, and
 * restoring the change puts that back. One history, one restore, whatever the
 * change touched (docs/CHANGE_RECOVERY.md, "One history").
 *
 *   auth          sign-in settings, OAuth providers, SMTP, email templates
 *   storage       buckets and their settings
 *   functions     functions and schedules (generated endpoints follow their
 *                 tables instead: lib/changes/recovery.ts generatedEndpointsFollow)
 *   webhooks      webhooks and triggers
 *   env           environment variables
 *   keys          API keys
 *   integrations  integration keys and which integrations are active
 *
 * ── What never comes back ───────────────────────────────────────────────────
 *
 * A secret's value is never kept here, only a digest of what is stored, which
 * tells that it changed and nothing more. So a restore never puts a secret back:
 * a revoked or rotated key, a replaced signing secret, an environment
 * variable's earlier value. Each adapter says so, in a sentence, for exactly
 * the item it concerns, and a restore that cannot bring something back needs a
 * person, who approves exactly that (lib/changes/impact.ts). A change that only
 * did what cannot be undone is shown as such and offers no restore. Data the
 * application wrote (files in a bucket) is never removed by a restore either.
 */

import { createHash } from 'crypto'
import type { Prisma } from '@prisma/client'
import { canonicalJson } from '../integrity'

export type ResourceId = 'auth' | 'storage' | 'functions' | 'webhooks' | 'env' | 'keys' | 'integrations'

/** The order resources are listed in, everywhere. A stored record's keys come back in jsonb's order, not this one. */
export const RESOURCE_ORDER: readonly ResourceId[] = ['auth', 'storage', 'functions', 'webhooks', 'env', 'keys', 'integrations']

export interface ResourceItem {
  /** What a person calls it: "bucket avatars". */
  label: string
  /** Its configuration. Compared as canonical JSON; never a secret's value. */
  fields: Record<string, unknown>
  /** Each secret it holds as a digest of what is stored: enough to tell it changed, never to recover it. */
  secrets?: Record<string, string>
  /** Facts kept beside it and not compared, such as how many files a bucket held. */
  meta?: Record<string, unknown>
}

export type ResourceSnapshot = Partial<Record<ResourceId, Record<string, ResourceItem>>>

/** One item a change touched: as it was before, and as the change left it. Null for absent. */
export interface ResourceOp {
  resource: ResourceId
  key: string
  before: ResourceItem | null
  after: ResourceItem | null
}

/** A platform client inside a transaction. */
export type Tx = Prisma.TransactionClient

export interface Irreversible {
  /** One sentence: what does not come back, and why. */
  reason: string
  /**
   * The rest of the item still comes back (its other settings), and only what
   * the sentence names stays as the change left it. False: nothing of it does.
   */
  partial: boolean
}

export interface ResourceAdapter {
  id: ResourceId
  capture(projectId: string): Promise<Record<string, ResourceItem>>
  /**
   * What of putting `op.before` back is not possible, from the change's own
   * ops (`op` and the rest it made, for an item that follows another). Null
   * when all of it is.
   */
  irreversible(op: ResourceOp, all: ResourceOp[]): Irreversible | null
  /** The same, from today's data: a bucket the change created that holds files now. */
  liveCheck?(projectId: string, op: ResourceOp): Promise<Irreversible | null>
  /** Put `op.before` back (or remove the item, when it was absent). Idempotent. Never called for an op wholly irreversible. */
  apply(tx: Tx, projectId: string, op: ResourceOp): Promise<void>
  /** Work outside the platform database once the restore has committed (a bucket's directory). Best-effort. */
  afterCommit?(projectId: string, op: ResourceOp): Promise<void>
}

/**
 * Which encryption of a secret is stored: the IV of one sealed by
 * lib/security/projectEnvCrypto.ts. AES-GCM needs a fresh one for every
 * encryption and it is not secret, so it tells a re-saved secret from the one
 * before without hashing anything taken from the secret.
 */
export function encryptedVersion(iv: string | null | undefined): string {
  return `iv:${iv ?? ''}`
}

/** A digest of a stored secret: its ciphertext or hash, never its value. */
export function secretDigest(...stored: Array<string | null | undefined>): string {
  return `sha256:${createHash('sha256').update(stored.map((s) => s ?? '').join('\u0000')).digest('hex').slice(0, 32)}`
}

/** Two items are the same when their fields and secrets are (meta is not compared). */
export function sameItem(a: ResourceItem | null | undefined, b: ResourceItem | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return canonicalJson({ f: a.fields, s: a.secrets ?? {} }) === canonicalJson({ f: b.fields, s: b.secrets ?? {} })
}

/** The same, ignoring secrets: for checking what a partial restore put back. */
export function sameFields(a: ResourceItem | null | undefined, b: ResourceItem | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return canonicalJson(a.fields) === canonicalJson(b.fields)
}

/** The secrets whose digest differs between two states of an item. */
export function changedSecrets(a: ResourceItem | null, b: ResourceItem | null): string[] {
  const names = new Set([...Object.keys(a?.secrets ?? {}), ...Object.keys(b?.secrets ?? {})])
  return [...names].filter((n) => (a?.secrets?.[n] ?? null) !== (b?.secrets?.[n] ?? null))
}

