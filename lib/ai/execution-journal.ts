import { writeFileSync, readFileSync, existsSync, unlinkSync, renameSync, copyFileSync } from 'fs'
import { join } from 'path'
import { prisma } from '@/lib/db'

/**
 * PRODUCTION SAFETY LAYER: Execution Journal & Rollback
 * 
 * This is what separates production AI from demos.
 * 
 * Features:
 * 1. Records every action before execution
 * 2. Stores rollback instructions
 * 3. Enables full or partial undo
 * 4. Audit trail for compliance
 * 5. Automatic recovery on failure
 */

export interface JournalEntry {
  id: string
  executionId: string
  projectId: string
  step: number
  action: string
  description: string
  status: 'pending' | 'executing' | 'success' | 'failed' | 'rolled_back'
  startTime: Date
  endTime?: Date
  duration?: number
  
  // What was done
  changes: {
    type: 'file_created' | 'file_modified' | 'file_deleted' | 'command_run' | 'db_mutation'
    target: string
    before?: string // Original state
    after?: string  // New state
  }[]
  
  // How to undo
  rollback: {
    action: string
    instructions: string
    automated: boolean // Can we auto-rollback?
  }
  
  // Results
  output?: string
  error?: string
}

export interface ExecutionJournal {
  id: string
  projectId: string
  userId: string
  conversationId: string
  planDescription: string
  totalSteps: number
  currentStep: number
  status: 'in_progress' | 'completed' | 'failed' | 'rolled_back'
  startTime: Date
  endTime?: Date
  entries: JournalEntry[]
}

// In-memory journal store (write-through cache — DB is source of truth)
const journals = new Map<string, ExecutionJournal>()

/**
 * Persist journal snapshot to AuditLog DB table (upsert via delete+create).
 * Called automatically on create and close — fire-and-forget.
 */
async function persistJournalSnapshot(journal: ExecutionJournal): Promise<void> {
  try {
    // Upsert: delete existing + create fresh (AuditLog has no unique constraint on details)
    await prisma.auditLog.deleteMany({
      where: { projectId: journal.projectId, type: 'ai_journal', action: `AI_EXEC_${journal.id}` },
    })
    await prisma.auditLog.create({
      data: {
        projectId: journal.projectId,
        userId: journal.userId,
        action: `AI_EXEC_${journal.id}`,
        type: 'ai_journal',
        details: JSON.stringify(journal),
        metadata: { journalId: journal.id, status: journal.status },
        timestamp: journal.startTime,
      },
    })
  } catch (err) {
    console.error('[ExecutionJournal] Failed to persist journal snapshot:', err)
  }
}

/**
 * Create new execution journal and immediately write it to DB.
 */
export function createExecutionJournal(
  projectId: string,
  userId: string,
  conversationId: string,
  planDescription: string,
  totalSteps: number
): ExecutionJournal {
  const journal: ExecutionJournal = {
    id: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    projectId,
    userId,
    conversationId,
    planDescription,
    totalSteps,
    currentStep: 0,
    status: 'in_progress',
    startTime: new Date(),
    entries: [],
  }

  journals.set(journal.id, journal)
  // Write to DB immediately (fire-and-forget) so data survives restarts
  persistJournalSnapshot(journal).catch((err) => console.error('[ExecutionJournal] create persist failed:', err))
  console.log(`📔 Created execution journal: ${journal.id}`)

  return journal
}

/**
 * Record action before execution (THIS IS CRITICAL)
 */
export function recordAction(
  journalId: string,
  step: number,
  action: string,
  description: string,
  target: string
): JournalEntry {
  const journal = journals.get(journalId)
  if (!journal) throw new Error(`Journal ${journalId} not found`)
  
  const entry: JournalEntry = {
    id: `entry-${Date.now()}-${step}`,
    executionId: journalId,
    projectId: journal.projectId,
    step,
    action,
    description,
    status: 'pending',
    startTime: new Date(),
    changes: [],
    rollback: {
      action: 'ROLLBACK_' + action,
      instructions: '',
      automated: false,
    },
  }
  
  // Backup file if it exists (for rollback)
  if (action === 'CREATE_PRISMA_MODEL' || action === 'CREATE_API_ROUTE') {
    const workspacePath = join(process.cwd(), 'workspace', journal.projectId)
    const filePath = getFilePath(action, target, workspacePath)
    
    if (existsSync(filePath)) {
      const backup = readFileSync(filePath, 'utf-8')
      entry.changes.push({
        type: 'file_modified',
        target: filePath,
        before: backup,
      })
      entry.rollback.automated = true
      entry.rollback.instructions = `Restore file: ${filePath}`
    } else {
      entry.changes.push({
        type: 'file_created',
        target: filePath,
      })
      entry.rollback.automated = true
      entry.rollback.instructions = `Delete file: ${filePath}`
    }
  }
  
  journal.entries.push(entry)
  journal.currentStep = step
  
  console.log(`📝 Recorded action [${step}/${journal.totalSteps}]: ${action}`)
  
  return entry
}

/**
 * Mark action as successful
 */
export function markSuccess(
  journalId: string,
  entryId: string,
  output: string,
  changes: JournalEntry['changes']
) {
  const journal = journals.get(journalId)
  if (!journal) return
  
  const entry = journal.entries.find(e => e.id === entryId)
  if (!entry) return
  
  entry.status = 'success'
  entry.endTime = new Date()
  entry.duration = entry.endTime.getTime() - entry.startTime.getTime()
  entry.output = output
  entry.changes = changes
  
  console.log(`✅ Action succeeded in ${entry.duration}ms: ${entry.action}`)
}

/**
 * Mark action as failed
 */
export function markFailure(
  journalId: string,
  entryId: string,
  error: string
) {
  const journal = journals.get(journalId)
  if (!journal) return
  
  const entry = journal.entries.find(e => e.id === entryId)
  if (!entry) return
  
  entry.status = 'failed'
  entry.endTime = new Date()
  entry.duration = entry.endTime.getTime() - entry.startTime.getTime()
  entry.error = error
  
  journal.status = 'failed'
  
  console.error(`❌ Action failed after ${entry.duration}ms: ${error}`)
}

/**
 * CRITICAL: Rollback execution
 */
export async function rollbackExecution(journalId: string): Promise<{
  success: boolean
  message: string
  rolledBack: number
  failed: number
}> {
  const journal = journals.get(journalId)
  if (!journal) {
    return { success: false, message: 'Journal not found', rolledBack: 0, failed: 0 }
  }
  
  console.log(`🔄 STARTING ROLLBACK for execution: ${journalId}`)
  console.log(`📋 Total steps to rollback: ${journal.entries.length}`)
  
  let rolledBack = 0
  let failed = 0
  
  // Rollback in REVERSE order (undo step 3, then 2, then 1)
  const successfulEntries = journal.entries.filter(e => e.status === 'success').reverse()
  
  for (const entry of successfulEntries) {
    try {
      if (!entry.rollback.automated) {
        console.log(`⚠️ Manual rollback required for: ${entry.action}`)
        failed++
        continue
      }
      
      console.log(`↩️ Rolling back step ${entry.step}: ${entry.action}`)
      
      // Execute rollback based on change type
      for (const change of entry.changes) {
        switch (change.type) {
          case 'file_created':
            // Delete the created file
            if (existsSync(change.target)) {
              unlinkSync(change.target)
              console.log(`  🗑️ Deleted: ${change.target}`)
            }
            break
            
          case 'file_modified':
            // Restore original content
            if (change.before) {
              writeFileSync(change.target, change.before, 'utf-8')
              console.log(`  📝 Restored: ${change.target}`)
            }
            break
            
          case 'file_deleted':
            // Restore deleted file
            if (change.before) {
              writeFileSync(change.target, change.before, 'utf-8')
              console.log(`  📄 Recreated: ${change.target}`)
            }
            break
            
          case 'db_mutation':
            // Database rollback requires migration undo
            console.log(`  ⚠️ DB rollback requires manual migration: ${change.target}`)
            failed++
            break
        }
      }
      
      entry.status = 'rolled_back'
      rolledBack++
      
    } catch (error: any) {
      console.error(`  ❌ Rollback failed for step ${entry.step}:`, error.message)
      failed++
    }
  }
  
  journal.status = 'rolled_back'
  journal.endTime = new Date()
  
  console.log(`✅ Rollback complete: ${rolledBack} successful, ${failed} failed`)
  
  // Store rollback record in database
  await prisma.auditLog.create({
    data: {
      projectId: journal.projectId,
      userId: journal.userId,
      action: 'AI_EXECUTION_ROLLBACK',
      type: 'ai_rollback',
      details: JSON.stringify({
        executionId: journalId,
        rolledBack,
        failed,
        originalPlan: journal.planDescription,
      }),
      timestamp: new Date(),
    },
  })
  
  return {
    success: rolledBack > 0,
    message: `Rolled back ${rolledBack} steps, ${failed} failed`,
    rolledBack,
    failed,
  }
}

/**
 * Get execution journal — in-memory cache first, then DB fallback.
 */
export async function getJournal(journalId: string): Promise<ExecutionJournal | undefined> {
  if (journals.has(journalId)) return journals.get(journalId)
  // Fallback: load from DB (e.g. after a server restart)
  try {
    const record = await prisma.auditLog.findFirst({
      where: { action: `AI_EXEC_${journalId}`, type: 'ai_journal' },
    })
    if (record?.details) {
      const journal: ExecutionJournal = JSON.parse(record.details)
      journals.set(journalId, journal) // hydrate cache
      return journal
    }
  } catch (err) {
    console.error('[ExecutionJournal] DB fallback load failed:', err)
  }
  return undefined
}

/**
 * Get all journals for a project — in-memory first, then DB for any gap.
 */
export async function getProjectJournals(projectId: string): Promise<ExecutionJournal[]> {
  const inMemory = Array.from(journals.values()).filter(j => j.projectId === projectId)
  if (inMemory.length > 0) return inMemory
  // Fallback: load from DB
  try {
    const records = await prisma.auditLog.findMany({
      where: { projectId, type: 'ai_journal' },
      orderBy: { timestamp: 'desc' },
      take: 20,
    })
    return records.map(r => {
      try { return JSON.parse(r.details || '{}') as ExecutionJournal } catch { return null }
    }).filter((j): j is ExecutionJournal => j !== null)
  } catch (err) {
    console.error('[ExecutionJournal] DB project journals load failed:', err)
    return []
  }
}

/**
 * Close journal (mark as complete) and persist final state to DB.
 */
export function closeJournal(journalId: string, status: 'completed' | 'failed') {
  const journal = journals.get(journalId)
  if (!journal) return

  journal.status = status
  journal.endTime = new Date()

  // Persist final state to DB (fire-and-forget)
  persistJournalSnapshot(journal).catch((err) => console.error('[ExecutionJournal] close persist failed:', err))

  console.log(`📕 Closed journal ${journalId}: ${status}`)
}

/**
 * Helper: Get file path for action
 */
function getFilePath(action: string, target: string, workspacePath: string): string {
  switch (action) {
    case 'CREATE_PRISMA_MODEL':
      return join(workspacePath, 'prisma', 'schema.prisma')
    case 'CREATE_API_ROUTE':
      return join(workspacePath, 'api', target, 'route.ts')
    default:
      return join(workspacePath, target)
  }
}

/**
 * Persist journal to database — kept for backward compatibility.
 * Prefer the automatic persistence via createExecutionJournal / closeJournal.
 */
export async function persistJournal(journalId: string) {
  const journal = journals.get(journalId)
  if (!journal) return
  await persistJournalSnapshot(journal)
  console.log(`💾 Persisted journal ${journalId} to database`)
}

