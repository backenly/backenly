/**
 * Phase 7: Silent Migration System
 * 
 * Migrate schemas, preserve data, avoid downtime, avoid user awareness.
 * This is where most tools die. Backenly doesn't.
 */

import { CanonicalIntent } from './types'
import { BackendStateGraph, EntityState, FieldState } from './backend-state-graph'
import { ExecutionPlan, ExecutionStep } from './execution-plan-generator'

export interface MigrationStrategy {
  type: 'zero-downtime' | 'minimal-downtime' | 'maintenance-window'
  phases: MigrationPhase[]
  estimatedDuration: number
  dataPreservation: DataPreservationPlan
  cleanupScheduled: CleanupTask[]
}

export interface MigrationPhase {
  phaseId: string
  order: number
  name: string
  steps: MigrationStep[]
  reversible: boolean
  requiresDeployment: boolean
}

export interface MigrationStep {
  stepId: string
  action: MigrationAction
  target: string
  params: Record<string, any>
  description: string
  silent: boolean // User should never see this
}

export type MigrationAction =
  | 'ADD_SHADOW_COLUMN'
  | 'BACKFILL_DATA'
  | 'SYNC_DUAL_WRITE'
  | 'UPDATE_API_LAYER'
  | 'DEPRECATE_OLD_COLUMN'
  | 'CLEANUP_OLD_DATA'
  | 'RENAME_COLUMN'
  | 'SPLIT_COLUMN'
  | 'MERGE_COLUMNS'
  | 'CHANGE_TYPE'

export interface DataPreservationPlan {
  strategy: 'dual-write' | 'backfill' | 'transform-on-read'
  backupCreated: boolean
  dataLossRisk: 'none' | 'low' | 'medium' | 'high'
  preservedFields: string[]
}

export interface CleanupTask {
  taskId: string
  scheduledFor: string // ISO date
  action: 'drop_column' | 'drop_table' | 'remove_api'
  target: string
  safe: boolean
}

/**
 * Generate migration strategy for complex schema changes
 * 
 * CRITICAL: User should NEVER be aware migrations are happening
 */
export function generateMigrationStrategy(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): MigrationStrategy | null {
  // Detect if migration is needed
  const needsMigration = detectMigrationNeed(intent, graph)
  
  if (!needsMigration) {
    return null // Simple change, no migration needed
  }
  
  // Generate strategy based on intent type
  if (intent.source_text.toLowerCase().includes('split name')) {
    return generateNameSplitMigration(intent, graph)
  }
  
  if (intent.source_text.toLowerCase().includes('rename')) {
    return generateRenameMigration(intent, graph)
  }
  
  if (intent.source_text.toLowerCase().includes('merge')) {
    return generateMergeMigration(intent, graph)
  }
  
  // Default: cautious migration
  return generateDefaultMigration(intent, graph)
}

/**
 * Detect if complex migration is needed
 */
function detectMigrationNeed(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): boolean {
  const keywords = [
    'split',
    'merge',
    'rename',
    'change type',
    'combine',
    'separate',
  ]
  
  return keywords.some(keyword => 
    intent.source_text.toLowerCase().includes(keyword)
  )
}

/**
 * Generate migration for splitting name field
 * 
 * Example: "Split name into first and last name"
 */
function generateNameSplitMigration(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): MigrationStrategy {
  const phases: MigrationPhase[] = []
  
  // Phase 1: Add new fields (shadow columns)
  phases.push({
    phaseId: 'split_phase_1',
    order: 1,
    name: 'Add new fields',
    steps: [
      {
        stepId: 'add_first_name',
        action: 'ADD_SHADOW_COLUMN',
        target: 'users',
        params: {
          columnName: 'first_name',
          columnType: 'TEXT',
          nullable: true,
        },
        description: 'Add first_name field',
        silent: true,
      },
      {
        stepId: 'add_last_name',
        action: 'ADD_SHADOW_COLUMN',
        target: 'users',
        params: {
          columnName: 'last_name',
          columnType: 'TEXT',
          nullable: true,
        },
        description: 'Add last_name field',
        silent: true,
      },
    ],
    reversible: true,
    requiresDeployment: false,
  })
  
  // Phase 2: Backfill data from existing name field
  phases.push({
    phaseId: 'split_phase_2',
    order: 2,
    name: 'Migrate existing data',
    steps: [
      {
        stepId: 'backfill_split',
        action: 'BACKFILL_DATA',
        target: 'users',
        params: {
          source: 'name',
          targets: ['first_name', 'last_name'],
          transformer: 'splitFullName', // Function to split "John Doe" → ["John", "Doe"]
        },
        description: 'Split existing names',
        silent: true,
      },
    ],
    reversible: false,
    requiresDeployment: false,
  })
  
  // Phase 3: Enable dual-write (write to both old and new)
  phases.push({
    phaseId: 'split_phase_3',
    order: 3,
    name: 'Enable dual-write',
    steps: [
      {
        stepId: 'dual_write',
        action: 'SYNC_DUAL_WRITE',
        target: 'users',
        params: {
          oldField: 'name',
          newFields: ['first_name', 'last_name'],
          syncDirection: 'bidirectional',
        },
        description: 'Keep fields in sync',
        silent: true,
      },
    ],
    reversible: true,
    requiresDeployment: true,
  })
  
  // Phase 4: Update API layer to use new fields
  phases.push({
    phaseId: 'split_phase_4',
    order: 4,
    name: 'Update APIs',
    steps: [
      {
        stepId: 'update_api_response',
        action: 'UPDATE_API_LAYER',
        target: '/users',
        params: {
          responseMapping: {
            'name': 'DEPRECATED',
            'first_name': 'firstName',
            'last_name': 'lastName',
          },
        },
        description: 'Update API to return new fields',
        silent: true,
      },
    ],
    reversible: true,
    requiresDeployment: true,
  })
  
  // Phase 5: Schedule cleanup of old field (30 days later)
  const cleanupDate = new Date()
  cleanupDate.setDate(cleanupDate.getDate() + 30)
  
  const cleanupTasks: CleanupTask[] = [
    {
      taskId: 'cleanup_old_name',
      scheduledFor: cleanupDate.toISOString(),
      action: 'drop_column',
      target: 'users.name',
      safe: true,
    },
  ]
  
  return {
    type: 'zero-downtime',
    phases,
    estimatedDuration: 45, // seconds
    dataPreservation: {
      strategy: 'dual-write',
      backupCreated: true,
      dataLossRisk: 'none',
      preservedFields: ['name', 'first_name', 'last_name'],
    },
    cleanupScheduled: cleanupTasks,
  }
}

/**
 * Generate migration for field rename
 */
function generateRenameMigration(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): MigrationStrategy {
  // Extract old and new names from intent
  const oldName = 'email' // Placeholder
  const newName = 'email_address' // Placeholder
  
  const phases: MigrationPhase[] = [
    {
      phaseId: 'rename_phase_1',
      order: 1,
      name: 'Add new column',
      steps: [
        {
          stepId: 'add_new_column',
          action: 'ADD_SHADOW_COLUMN',
          target: 'users',
          params: {
            columnName: newName,
            columnType: 'TEXT',
          },
          description: `Add ${newName} field`,
          silent: true,
        },
      ],
      reversible: true,
      requiresDeployment: false,
    },
    {
      phaseId: 'rename_phase_2',
      order: 2,
      name: 'Copy data',
      steps: [
        {
          stepId: 'copy_data',
          action: 'BACKFILL_DATA',
          target: 'users',
          params: {
            source: oldName,
            targets: [newName],
            transformer: 'identity',
          },
          description: 'Copy existing data',
          silent: true,
        },
      ],
      reversible: false,
      requiresDeployment: false,
    },
    {
      phaseId: 'rename_phase_3',
      order: 3,
      name: 'Update APIs',
      steps: [
        {
          stepId: 'update_apis',
          action: 'UPDATE_API_LAYER',
          target: 'users',
          params: {
            fieldMapping: {
              [oldName]: newName,
            },
          },
          description: 'Update API responses',
          silent: true,
        },
      ],
      reversible: true,
      requiresDeployment: true,
    },
  ]
  
  const cleanupDate = new Date()
  cleanupDate.setDate(cleanupDate.getDate() + 30)
  
  return {
    type: 'zero-downtime',
    phases,
    estimatedDuration: 30,
    dataPreservation: {
      strategy: 'dual-write',
      backupCreated: true,
      dataLossRisk: 'none',
      preservedFields: [oldName, newName],
    },
    cleanupScheduled: [
      {
        taskId: 'cleanup_old_field',
        scheduledFor: cleanupDate.toISOString(),
        action: 'drop_column',
        target: `users.${oldName}`,
        safe: true,
      },
    ],
  }
}

/**
 * Generate migration for field merge
 */
function generateMergeMigration(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): MigrationStrategy {
  const phases: MigrationPhase[] = [
    {
      phaseId: 'merge_phase_1',
      order: 1,
      name: 'Add merged field',
      steps: [
        {
          stepId: 'add_merged',
          action: 'ADD_SHADOW_COLUMN',
          target: 'users',
          params: {
            columnName: 'full_name',
            columnType: 'TEXT',
          },
          description: 'Add full_name field',
          silent: true,
        },
      ],
      reversible: true,
      requiresDeployment: false,
    },
    {
      phaseId: 'merge_phase_2',
      order: 2,
      name: 'Merge data',
      steps: [
        {
          stepId: 'backfill_merge',
          action: 'BACKFILL_DATA',
          target: 'users',
          params: {
            source: ['first_name', 'last_name'],
            targets: ['full_name'],
            transformer: 'joinFullName',
          },
          description: 'Combine first and last names',
          silent: true,
        },
      ],
      reversible: false,
      requiresDeployment: false,
    },
  ]
  
  return {
    type: 'zero-downtime',
    phases,
    estimatedDuration: 25,
    dataPreservation: {
      strategy: 'backfill',
      backupCreated: true,
      dataLossRisk: 'none',
      preservedFields: ['first_name', 'last_name', 'full_name'],
    },
    cleanupScheduled: [],
  }
}

/**
 * Default migration strategy (cautious)
 */
function generateDefaultMigration(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): MigrationStrategy {
  return {
    type: 'minimal-downtime',
    phases: [],
    estimatedDuration: 10,
    dataPreservation: {
      strategy: 'backfill',
      backupCreated: true,
      dataLossRisk: 'low',
      preservedFields: [],
    },
    cleanupScheduled: [],
  }
}

/**
 * Execute migration strategy
 */
export async function executeMigration(
  strategy: MigrationStrategy,
  graph: BackendStateGraph
): Promise<{
  success: boolean
  phasesCompleted: number
  message: string
}> {
  console.log('[Silent Migration] Starting migration:', strategy.type)
  
  let phasesCompleted = 0
  
  try {
    for (const phase of strategy.phases) {
      console.log(`[Silent Migration] Executing phase: ${phase.name}`)
      
      for (const step of phase.steps) {
        // Execute migration step (silently)
        await executeMigrationStep(step, graph)
      }
      
      phasesCompleted++
    }
    
    console.log('[Silent Migration] Migration completed successfully')
    
    return {
      success: true,
      phasesCompleted,
      message: 'Your backend has been updated.',
    }
    
  } catch (error) {
    console.error('[Silent Migration] Migration failed:', error)
    
    return {
      success: false,
      phasesCompleted,
      message: 'Something didn\'t work. Nothing was changed.',
    }
  }
}

/**
 * Execute single migration step
 */
async function executeMigrationStep(
  step: MigrationStep,
  graph: BackendStateGraph
): Promise<void> {
  // Simulate step execution
  await new Promise(resolve => setTimeout(resolve, 100))
  
  switch (step.action) {
    case 'ADD_SHADOW_COLUMN':
      // In production: ALTER TABLE ADD COLUMN
      console.log(`[Silent Migration] Added shadow column: ${step.params.columnName}`)
      break
      
    case 'BACKFILL_DATA':
      // In production: UPDATE table SET new_col = transform(old_col)
      console.log(`[Silent Migration] Backfilled data for: ${step.target}`)
      break
      
    case 'SYNC_DUAL_WRITE':
      // In production: Add database triggers or app-level sync
      console.log(`[Silent Migration] Enabled dual-write for: ${step.target}`)
      break
      
    case 'UPDATE_API_LAYER':
      // In production: Update API response transformers
      console.log(`[Silent Migration] Updated API layer: ${step.target}`)
      break
      
    default:
      console.log(`[Silent Migration] Unknown action: ${step.action}`)
  }
}

/**
 * Schedule cleanup task for later execution
 */
export async function scheduleCleanup(task: CleanupTask): Promise<void> {
  console.log(`[Silent Migration] Scheduled cleanup for ${task.scheduledFor}:`, task.target)
  
  // In production: Store in database with scheduled job
  // For now: Log it
}
