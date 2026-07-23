/**
 * PROJECT ENV VARS — canonical engine.
 *
 * Single source of truth for per-project env vars. Brain tools, REST routes,
 * and the AI-functions worker all funnel through here.
 *
 * Values are encrypted at rest (AES-256-GCM, see lib/security/projectEnvCrypto.ts).
 * The decrypted map is exposed to AI Functions as `ctx.env`.
 */

import { prisma } from '@/lib/db/prisma'
import { encryptValue, decryptValue, previewValue } from '@/lib/security/projectEnvCrypto'

const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const MAX_VALUE_BYTES = 8 * 1024 // 8 KB hard cap — env vars should be secrets, not blobs.

export interface SetEnvVarOptions {
  projectId: string
  key: string
  value: string
  userId: string
  description?: string
}

export interface EnvVarSummary {
  id: string
  key: string
  preview: string
  description: string | null
  createdAt: Date
  updatedAt: Date
}

export class EnvVarValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvVarValidationError'
  }
}

function validateKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new EnvVarValidationError(
      `Invalid env var key "${key}". Must be UPPER_SNAKE_CASE, start with a letter, max 64 chars.`,
    )
  }
}

function validateValue(value: string): void {
  if (typeof value !== 'string') {
    throw new EnvVarValidationError('Env var value must be a string.')
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw new EnvVarValidationError(`Env var value exceeds ${MAX_VALUE_BYTES} byte limit.`)
  }
}

// ─── Writes ────────────────────────────────────────────────────────────────

export async function setEnvVar(opts: SetEnvVarOptions): Promise<EnvVarSummary> {
  validateKey(opts.key)
  validateValue(opts.value)

  const enc = encryptValue(opts.value)

  const row = await prisma.projectEnvVar.upsert({
    where: { projectId_key: { projectId: opts.projectId, key: opts.key } },
    update: {
      valueCipher: enc.valueCipher,
      valueIv: enc.valueIv,
      valueTag: enc.valueTag,
      description: opts.description ?? null,
      // createdBy intentionally NOT updated — preserve original setter
    },
    create: {
      projectId: opts.projectId,
      key: opts.key,
      valueCipher: enc.valueCipher,
      valueIv: enc.valueIv,
      valueTag: enc.valueTag,
      description: opts.description ?? null,
      createdBy: opts.userId,
    },
  })

  await prisma.auditLog.create({
    data: {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      projectId: opts.projectId,
      userId: opts.userId,
      action: 'SET_ENV_VAR',
      type: 'env_var',
      details: JSON.stringify({ key: opts.key, resourceId: row.id, hasDescription: !!opts.description }),
      timestamp: new Date(),
    },
  })

  return toSummary(row, opts.value)
}

export async function deleteEnvVar(projectId: string, key: string, userId: string): Promise<boolean> {
  validateKey(key)
  const existing = await prisma.projectEnvVar.findUnique({
    where: { projectId_key: { projectId, key } },
  })
  if (!existing) return false

  await prisma.projectEnvVar.delete({
    where: { projectId_key: { projectId, key } },
  })

  await prisma.auditLog.create({
    data: {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      projectId,
      userId,
      action: 'DELETE_ENV_VAR',
      type: 'env_var',
      details: JSON.stringify({ key, resourceId: existing.id }),
      timestamp: new Date(),
    },
  })
  return true
}

// ─── Reads ─────────────────────────────────────────────────────────────────

/**
 * Surface-safe list for UI/chat — never includes decrypted values.
 */
export async function listEnvVars(projectId: string): Promise<EnvVarSummary[]> {
  const rows = await prisma.projectEnvVar.findMany({
    where: { projectId },
    orderBy: { key: 'asc' },
  })
  return rows.map((r) => {
    let preview = '••••'
    try {
      preview = previewValue(decryptValue(r))
    } catch {
      // corrupted row or wrong key — show ellipsis rather than crash
      preview = '⚠ unreadable'
    }
    return {
      id: r.id,
      key: r.key,
      preview,
      description: r.description,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }
  })
}

/**
 * RUNTIME PATH. Decrypted key→value map, injected as `ctx.env` into AI
 * functions. Never expose this map to the brain or to the REST layer.
 */
export async function getDecryptedEnvMap(projectId: string): Promise<Record<string, string>> {
  const rows = await prisma.projectEnvVar.findMany({
    where: { projectId },
    select: { key: true, valueCipher: true, valueIv: true, valueTag: true },
  })
  const out: Record<string, string> = {}
  for (const r of rows) {
    try {
      out[r.key] = decryptValue(r)
    } catch {
      // Skip — corrupted row shouldn't break the whole function run.
    }
  }
  return out
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function toSummary(row: { id: string; key: string; description: string | null; createdAt: Date; updatedAt: Date }, plaintext: string): EnvVarSummary {
  return {
    id: row.id,
    key: row.key,
    preview: previewValue(plaintext),
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
