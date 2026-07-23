/**
 * UI → AI Orchestration Bridge
 * 
 * This module connects UI actions (buttons, forms) to the AI orchestration engine.
 * It ensures chat↔UI parity by converting UI actions into natural language prompts
 * that flow through the SAME orchestration pipeline as chat messages.
 * 
 * WHY: 
 * - Single source of truth for all backend changes
 * - Unified audit trail (UI and chat actions logged identically)
 * - Consistent rollback capability
 * - Same safety validations apply
 */

import { getCurrentProjectId } from './client'

export interface OrchestrationResponse {
  success: boolean
  message: string
  timeline?: {
    id: string
    timestamp: string
    title: string
    description: string
    category: string
    userVisible: boolean
  }
  changes?: any[]
  errors?: string[]
  narration?: {
    pre?: string
    post?: string
  }
}

/**
 * Execute UI action through orchestration engine
 * 
 * Converts UI action into natural language prompt and calls /api/ai/chat
 * 
 * @param action - Natural language description of what user wants to do
 * @param triggerSource - 'UI' to mark in audit logs
 * @returns Orchestration result with timeline, changes, narration
 */
export async function executeUIAction(
  action: string,
  options?: {
    projectId?: string
    triggerSource?: 'UI' | 'CHAT'
  }
): Promise<OrchestrationResponse> {
  const projectId = options?.projectId || (await getCurrentProjectId())
  
  if (!projectId) {
    return {
      success: false,
      message: 'No project selected',
      errors: ['PROJECT_ID_MISSING'],
    }
  }

  try {
    const response = await fetch(`/api/ai/chat?projectId=${projectId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        message: action,
        triggerSource: options?.triggerSource || 'UI',
        intelligent: true, // Use full orchestration engine
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      return {
        success: false,
        message: data.message || 'Action failed',
        errors: data.errors || ['EXECUTION_FAILED'],
      }
    }

    return {
      success: data.success !== false,
      message: data.message,
      timeline: data.timeline,
      changes: data.changes,
      errors: data.errors,
      narration: data.narration,
    }
  } catch (error: any) {
    console.error('[Orchestration Bridge] Error:', error)
    return {
      success: false,
      message: 'Failed to execute action',
      errors: [error.message || 'NETWORK_ERROR'],
    }
  }
}

/**
 * Pre-built action templates for common UI operations
 * These ensure consistent phrasing for intent parsing
 */
export const StorageActions = {
  uploadFile: (fileName: string, bucketName: string) =>
    `upload file ${fileName} to ${bucketName} bucket in storage`,
  
  deleteFile: (fileName: string) =>
    `delete file ${fileName} from storage`,
  
  createBucket: (bucketName: string, isPublic: boolean) =>
    isPublic
      ? `create public storage bucket named ${bucketName}`
      : `create private storage bucket named ${bucketName}`,
  
  deleteBucket: (bucketName: string) =>
    `delete storage bucket ${bucketName}`,
}

export const SecretsActions = {
  addSecret: (key: string, value: string) =>
    `add environment variable ${key} with value [REDACTED]`,
  
  deleteSecret: (key: string) =>
    `delete environment variable ${key}`,
  
  updateSecret: (key: string, value: string) =>
    `update environment variable ${key}`,
}

export const DeployActions = {
  deployToProduction: () =>
    `deploy my project to production`,
  
  deployToStaging: () =>
    `deploy my project to staging`,
  
  rollbackDeployment: () =>
    `rollback last deployment`,
}

export const DatabaseActions = {
  createTable: (tableName: string, columns: string[]) =>
    `create table ${tableName} with columns ${columns.join(', ')}`,
  
  addColumn: (tableName: string, columnName: string, columnType: string) =>
    `add column ${columnName} of type ${columnType} to table ${tableName}`,
  
  deleteTable: (tableName: string) =>
    `delete table ${tableName}`,
}

export const AuthActions = {
  enableProvider: (provider: string) =>
    `enable ${provider} authentication`,
  
  disableProvider: (provider: string) =>
    `disable ${provider} authentication`,
}

/**
 * Example usage in UI components:
 * 
 * ```tsx
 * import { executeUIAction, StorageActions } from '@/lib/api/orchestration-bridge'
 * 
 * const handleDeleteFile = async (fileName: string) => {
 *   const result = await executeUIAction(
 *     StorageActions.deleteFile(fileName)
 *   )
 *   
 *   if (result.success) {
 *     // Show success notification
 *     console.log(result.message)
 *     // Refresh data
 *     await fetchData()
 *   } else {
 *     // Show error
 *     alert(result.message)
 *   }
 * }
 * ```
 */
