/**
 * EXECUTION CACHE — Speed Optimization
 * ======================================
 * Caches expensive, frequently-repeated operations.
 *
 * Operations cached:
 *   - Schema introspection (30s TTL) — most expensive repeated call
 *   - Project settings/integrations (60s TTL)
 *   - Intent classification results (no TTL — deterministic)
 *
 * This removes multiple round-trips to DB per request and cuts
 * average response time significantly on repeated calls.
 *
 * Implementation: In-process LRU with TTL.
 * Trade-off: Cache is per-server-instance.
 * Acceptable because: schema changes are infrequent, 30s staleness is fine.
 */

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

// ─── Generic TTL Cache ────────────────────────────────────────────────────────

class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>()
  private maxSize: number

  constructor(maxSize = 500) {
    this.maxSize = maxSize
  }

  get(key: string): T | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return null
    }
    return entry.value
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.store.size >= this.maxSize) {
      // Evict oldest entry
      const firstKey = this.store.keys().next().value
      if (firstKey) this.store.delete(firstKey)
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs })
  }

  delete(key: string): void {
    this.store.delete(key)
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key)
    }
  }

  size(): number {
    return this.store.size
  }
}

// ─── Shared Cache Instances ───────────────────────────────────────────────────

const schemaCache = new TtlCache<string>(200)
const projectCache = new TtlCache<Record<string, any>>(200)
const intentCache = new TtlCache<string>(1000) // deterministic — no TTL decay

const SCHEMA_TTL_MS  = 30_000   // 30 seconds
const PROJECT_TTL_MS = 60_000   // 60 seconds
const INTENT_TTL_MS  = 300_000  // 5 minutes (classification is deterministic)

// ─── Schema Cache ─────────────────────────────────────────────────────────────

/**
 * Get cached schema introspection, or run fresh introspection if stale.
 */
export async function getCachedSchema(projectId: string): Promise<string> {
  const key = `schema:${projectId}`
  const cached = schemaCache.get(key)
  if (cached !== null) return cached

  const { introspectSchema } = await import('./minimal-executor')
  const schema = await introspectSchema(projectId)
  schemaCache.set(key, schema, SCHEMA_TTL_MS)
  return schema
}

/**
 * Invalidate schema cache for a project (call after any schema mutation).
 */
export function invalidateSchemaCache(projectId: string): void {
  schemaCache.delete(`schema:${projectId}`)
}

// ─── Project Settings Cache ───────────────────────────────────────────────────

/**
 * Get cached project integrations/settings.
 */
export async function getCachedProjectSettings(projectId: string): Promise<{
  activeIntegrations: Record<string, any>
  hasAuth: boolean
  isFrontendConnected: boolean
  isDeployed: boolean
}> {
  const key = `project:${projectId}`
  const cached = projectCache.get(key)
  if (cached !== null) return cached as any

  const { prisma } = await import('@/lib/db/prisma')
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      activeIntegrations: true,
      authManifest: true,
      isFrontendConnected: true,
      isDeployed: true,
    },
  })

  const result = {
    activeIntegrations: (project?.activeIntegrations as Record<string, any>) ?? {},
    hasAuth: !!(project?.authManifest as any)?.enabled,
    isFrontendConnected: project?.isFrontendConnected ?? false,
    isDeployed: project?.isDeployed ?? false,
  }

  projectCache.set(key, result, PROJECT_TTL_MS)
  return result
}

/**
 * Invalidate project settings cache (call after any project update).
 */
export function invalidateProjectCache(projectId: string): void {
  projectCache.delete(`project:${projectId}`)
}

// ─── Intent Classification Cache ─────────────────────────────────────────────

/**
 * Cache the intent classification result for a message.
 * Intent classification is deterministic so cache is safe.
 */
export function getCachedIntent(message: string): string | null {
  const key = `intent:${message.slice(0, 100)}`
  return intentCache.get(key)
}

export function setCachedIntent(message: string, intent: string): void {
  const key = `intent:${message.slice(0, 100)}`
  intentCache.set(key, intent, INTENT_TTL_MS)
}

// ─── Cache Stats (for observability) ─────────────────────────────────────────

export function getCacheStats(): { schemaEntries: number; projectEntries: number; intentEntries: number } {
  return {
    schemaEntries: schemaCache.size(),
    projectEntries: projectCache.size(),
    intentEntries: intentCache.size(),
  }
}
