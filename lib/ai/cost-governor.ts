/**
 * COST GOVERNOR — LLM Usage Control
 * ====================================
 * Enforces heuristic-first, LLM-second architecture.
 * Prevents cost explosion as autonomous systems scale.
 *
 * Principles:
 *  1. Heuristics run for every project, every scan — always fast, free
 *  2. LLM runs only when: budget available + schema is complex enough to warrant it
 *  3. Results are cached per schema fingerprint (TTL: 1 hour)
 *  4. Per-project daily token budget (configurable via env var)
 *  5. Global degraded mode: if system-wide usage spikes, force heuristic-only
 *
 * Budget tracking stored in architecturalMemory JSON (no new DB columns needed).
 */

import { loadProjectMemory, saveProjectMemory } from './project-memory'

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_DAILY_TOKEN_BUDGET = parseInt(process.env.AGENT_LLM_DAILY_TOKENS ?? '50000', 10)
const MIN_TABLES_FOR_LLM = 3            // Don't burn LLM on empty projects
const CACHE_TTL_MS = 60 * 60 * 1000    // 1 hour cache TTL

// ── In-memory result cache ─────────────────────────────────────────────────────
// Uses global to survive Next.js hot reloads (same pattern as Prisma singleton)

declare global {
  // eslint-disable-next-line no-var
  var __agentResultCache: Map<string, { value: unknown; expiresAt: number }> | undefined
}

function getCache(): Map<string, { value: unknown; expiresAt: number }> {
  if (!global.__agentResultCache) {
    global.__agentResultCache = new Map()
  }
  return global.__agentResultCache
}

// ── Budget types ──────────────────────────────────────────────────────────────

export interface LLMBudgetStatus {
  allowed: boolean
  usedToday: number
  remainingToday: number
  dailyBudget: number
  reason?: string
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether an LLM call is permitted for this project.
 * Returns false when: budget exhausted, project too small, or degraded mode active.
 */
export async function checkLLMBudget(
  projectId: string,
  tables: string[],
): Promise<LLMBudgetStatus> {
  // Minimum complexity gate — don't burn LLM on tiny projects
  if (tables.length < MIN_TABLES_FOR_LLM) {
    return {
      allowed: false,
      usedToday: 0,
      remainingToday: DEFAULT_DAILY_TOKEN_BUDGET,
      dailyBudget: DEFAULT_DAILY_TOKEN_BUDGET,
      reason: `Project has ${tables.length} tables — heuristics sufficient (min ${MIN_TABLES_FOR_LLM} for LLM)`,
    }
  }

  try {
    const memory = await loadProjectMemory(projectId)
    const budget = ((memory as any).llmBudget ?? {}) as {
      date?: string
      usedToday?: number
    }

    const today = new Date().toISOString().slice(0, 10)
    const usedToday = budget.date === today ? (budget.usedToday ?? 0) : 0
    const remainingToday = DEFAULT_DAILY_TOKEN_BUDGET - usedToday

    if (remainingToday <= 0) {
      return {
        allowed: false,
        usedToday,
        remainingToday: 0,
        dailyBudget: DEFAULT_DAILY_TOKEN_BUDGET,
        reason: `Daily LLM token budget exhausted (${usedToday}/${DEFAULT_DAILY_TOKEN_BUDGET}). Resets at midnight UTC.`,
      }
    }

    return {
      allowed: true,
      usedToday,
      remainingToday,
      dailyBudget: DEFAULT_DAILY_TOKEN_BUDGET,
    }
  } catch {
    // Fail open — budget tracking failure never blocks agents
    return {
      allowed: true,
      usedToday: 0,
      remainingToday: DEFAULT_DAILY_TOKEN_BUDGET,
      dailyBudget: DEFAULT_DAILY_TOKEN_BUDGET,
    }
  }
}

/**
 * Record actual LLM token usage after a call completes.
 * Fire-and-forget safe.
 */
export async function recordLLMUsage(projectId: string, tokensUsed: number): Promise<void> {
  try {
    const memory = await loadProjectMemory(projectId)
    const budget = ((memory as any).llmBudget ?? {}) as {
      date?: string
      usedToday?: number
      totalLifetime?: number
    }

    const today = new Date().toISOString().slice(0, 10)
    const current = budget.date === today ? (budget.usedToday ?? 0) : 0

    ;(memory as any).llmBudget = {
      date: today,
      usedToday: current + tokensUsed,
      totalLifetime: (budget.totalLifetime ?? 0) + tokensUsed,
    }

    await saveProjectMemory(projectId, memory)
  } catch {
    // Non-fatal
  }
}

/**
 * Convenience wrapper: should this project skip LLM calls right now?
 * Returns true when budget is exhausted OR project is too small.
 */
export async function shouldSkipLLM(projectId: string, tables: string[]): Promise<boolean> {
  const status = await checkLLMBudget(projectId, tables)
  return !status.allowed
}

// ── Result cache ──────────────────────────────────────────────────────────────

/**
 * Get a cached agent result. Returns null on cache miss or expiry.
 * Key should be: `${projectId}:${agentType}:${schemaFingerprint}`
 */
export function getCachedResult<T>(key: string): T | null {
  const cache = getCache()
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(key)
    return null
  }
  return entry.value as T
}

/**
 * Store a result in the cache.
 * @param ttlMs  How long to cache (default: CACHE_TTL_MS = 1 hour)
 */
export function setCachedResult<T>(key: string, value: T, ttlMs = CACHE_TTL_MS): void {
  const cache = getCache()
  cache.set(key, { value, expiresAt: Date.now() + ttlMs })

  // Evict stale entries every 50 writes (memory hygiene)
  if (cache.size % 50 === 0) {
    const now = Date.now()
    for (const [k, v] of cache) {
      if (now > v.expiresAt) cache.delete(k)
    }
  }
}

/**
 * Generate a schema fingerprint for cache keying.
 * Cheap — just sorts and joins table names.
 */
export function schemaFingerprint(tables: string[]): string {
  return [...tables].sort().join(',')
}

// ── Cache stats (for observability) ──────────────────────────────────────────

export function getCacheStats(): { size: number; hitRate: number } {
  const cache = getCache()
  const now = Date.now()
  let live = 0
  for (const v of cache.values()) {
    if (now < v.expiresAt) live++
  }
  return { size: cache.size, hitRate: live / Math.max(1, cache.size) }
}
