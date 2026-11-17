/**
 * Writing how a function's last run went, without switching it back on.
 *
 * `status: 'active' | 'error'` records how the last run went
 * (lib/services/ai-functions/status.ts); 'inactive' is a person's decision. A
 * run that started before someone switched the function off finishes after
 * it, and each finished run used to write its status outright, so the switch
 * was undone the moment the next run ended. With four runs of a burst going at
 * once that was within a second: the drain matched the function again, queued
 * more of the burst and kept running and counting it (production QA re-test,
 * 2026-11-16, N7). The same held for a repair written after a failed run.
 *
 * So the run's own record (count, time, last error, repaired code) is written
 * whatever the switch says, and its status only while the function is on.
 */
import { prisma } from '@/lib/db'
import { RUNNABLE_FUNCTION_STATUS_FILTER } from './status'

export interface RunRecord {
  runCount?: { increment: number }
  lastRun?: Date
  lastError?: string | null
  generatedCode?: string
}

type Db = Pick<typeof prisma, 'aiFunction'>

/** Record a run (or its repair) and, only if the function is still on, how it went. */
export async function recordRunState(functionId: string, record: RunRecord, status: 'active' | 'error', db: Db = prisma): Promise<void> {
  // history: how the last run went, not configuration (lib/changes/resources/functions.ts). Repaired
  // code is written only inside its caller's governed change (selfHealSave, the fix actions).
  if (Object.keys(record).length > 0) await db.aiFunction.update({ where: { id: functionId }, data: record })
  // history: how the last run went, and never the Power switch: only while the function is on.
  await db.aiFunction.updateMany({ where: { id: functionId, status: RUNNABLE_FUNCTION_STATUS_FILTER }, data: { status } })
}
