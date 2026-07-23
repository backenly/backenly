/**
 * AGENT MEMORY SYSTEM (Persistent)
 * ==================================
 * Saves successful execution patterns to the database.
 * Recalled on next execution to skip re-planning for known patterns.
 *
 * Replaces the previous in-memory Map<fingerprint, strategy> which was
 * lost on every server restart and not shared across instances.
 *
 * Schema: agent_memories table
 *   fingerprint  — normalized input token hash
 *   strategy     — which executor succeeded
 *   successRate  — running success rate (0.0–1.0)
 *   usageCount   — how many times this pattern has been matched
 */

import { prisma } from '@/lib/db/prisma'
import type { ExecutionStrategy } from './autonomous-agent'

/** Normalize a message into a stable fingerprint for pattern matching. */
export function fingerprintMessage(message: string): string {
  const tokens = message
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(t => t.length > 2)  // drop stop words / noise
    .sort()
    .slice(0, 6)
  return tokens.join(':')
}

/**
 * Save a successful execution pattern.
 * Creates or updates the record for this fingerprint.
 */
export async function saveSuccessPattern(
  fingerprint: string,
  strategy: ExecutionStrategy,
  sampleGoal: string
): Promise<void> {
  try {
    const existing = await prisma.agentMemory.findUnique({ where: { fingerprint } })

    if (existing) {
      // Smooth the success rate upward
      const newRate = Math.min(1.0, existing.successRate + 0.05)
      await prisma.agentMemory.update({
        where: { fingerprint },
        data: {
          successRate: newRate,
          usageCount: { increment: 1 },
          lastUsed: new Date(),
        },
      })
    } else {
      await prisma.agentMemory.create({
        data: { fingerprint, strategy, successRate: 0.9, sampleGoal, usageCount: 1 },
      })
    }
  } catch {
    // Non-fatal — memory is a best-effort optimization
  }
}

/**
 * Record a failure for a pattern.
 * Reduces success rate; if rate drops below threshold, pattern is de-ranked.
 */
export async function recordFailurePattern(fingerprint: string): Promise<void> {
  try {
    await prisma.agentMemory.updateMany({
      where: { fingerprint },
      data: { successRate: { decrement: 0.15 } },
    })
  } catch {
    // Non-fatal
  }
}

/**
 * Recall the best strategy for a fingerprint if success rate is high enough.
 * Returns null if unknown or low-confidence.
 */
export async function recallStrategy(fingerprint: string): Promise<ExecutionStrategy | null> {
  try {
    const entry = await prisma.agentMemory.findUnique({ where: { fingerprint } })
    if (entry && entry.successRate >= 0.7) {
      // Update lastUsed
      await prisma.agentMemory.update({
        where: { fingerprint },
        data: { lastUsed: new Date() },
      })
      return entry.strategy as ExecutionStrategy
    }
  } catch {
    // Non-fatal
  }
  return null
}

/**
 * List the top N most-used patterns (for debugging/admin).
 */
export async function listTopPatterns(limit = 20): Promise<Array<{
  fingerprint: string
  strategy: string
  successRate: number
  usageCount: number
  sampleGoal: string
}>> {
  try {
    const rows = await prisma.agentMemory.findMany({
      orderBy: { usageCount: 'desc' },
      take: limit,
      select: { fingerprint: true, strategy: true, successRate: true, usageCount: true, sampleGoal: true },
    })
    return rows
  } catch {
    return []
  }
}
