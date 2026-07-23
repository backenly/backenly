/**
 * Client-side API helpers for Database Brain
 */

export interface DatabaseIssue {
  id: string
  projectId?: string
  title: string
  description: string
  severity: 'high' | 'medium' | 'low' | 'info'
  database: 'postgresql' | 'mongodb' | 'hybrid'
  category: 'missing_index' | 'slow_query' | 'schema_drift' | 'relationship' | 'other'
  impact?: string
  suggestedFix: string
  rawQuery?: string
  affectedTables: string[]
  estimatedImpact?: string
  detailedAnalysis?: string
  whyItHappened?: string
  sqlFix?: string
  migrationSteps?: string
  status: 'open' | 'resolved' | 'ignored'
  resolvedAt?: string
  createdAt: string
  updatedAt: string
}

export interface AnalysisResult {
  issuesFound: number
  issues: DatabaseIssue[]
  mode?: 'safe' | 'deep'
  projectId?: string
}

/**
 * Run database analysis
 */
export async function runAnalysis(mode: 'safe' | 'deep' = 'safe'): Promise<AnalysisResult> {
  console.log(`🚀 [API] Calling runAnalysis with mode: ${mode}`)
  
  const response = await fetch('/api/database-brain/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mode }),
  })

  console.log(`📡 [API] Analysis response status: ${response.status} ${response.statusText}`)
  
  const data = await response.json()
  console.log('📊 [API] Analysis response data:', data)
  
  if (!data.success) {
    const errorMsg = data.error || 'Failed to run analysis'
    console.error(`❌ [API] Analysis failed: ${errorMsg}`, data)
    throw new Error(errorMsg)
  }

  return data.data
}

/**
 * Get all issues
 */
export async function getIssues(options?: {
  projectId?: string
  severity?: 'high' | 'medium' | 'low' | 'info'
  database?: string
  status?: 'open' | 'resolved' | 'ignored'
}): Promise<DatabaseIssue[]> {
  const params = new URLSearchParams()
  if (options?.projectId) params.append('projectId', options.projectId)
  if (options?.severity) params.append('severity', options.severity)
  if (options?.database) params.append('database', options.database)
  if (options?.status) params.append('status', options.status)

  const url = `/api/database-brain/issues?${params.toString()}`
  console.log(`🚀 [API] Fetching issues from: ${url}`)

  const response = await fetch(url)
  console.log(`📡 [API] Issues response status: ${response.status} ${response.statusText}`)
  
  const data = await response.json()
  console.log(`📊 [API] Issues response data:`, { success: data.success, count: data.count, projectId: data.projectId })
  
  if (!data.success) {
    const errorMsg = data.error || 'Failed to fetch issues'
    console.error(`❌ [API] Failed to fetch issues: ${errorMsg}`, data)
    throw new Error(errorMsg)
  }

  return data.data
}

/**
 * Get issue by ID
 */
export async function getIssue(id: string): Promise<DatabaseIssue> {
  console.log(`🚀 [API] Fetching issue: ${id}`)
  
  const response = await fetch(`/api/database-brain/issues/${id}`)
  console.log(`📡 [API] Issue response status: ${response.status} ${response.statusText}`)
  
  const data = await response.json()
  
  if (!data.success) {
    const errorMsg = data.error || 'Failed to fetch issue'
    console.error(`❌ [API] Failed to fetch issue ${id}: ${errorMsg}`, data)
    throw new Error(errorMsg)
  }

  return data.data
}

/**
 * Update issue
 */
export async function updateIssue(
  id: string,
  updates: {
    status?: 'open' | 'resolved' | 'ignored'
    sqlFix?: string
    migrationSteps?: string
  }
): Promise<DatabaseIssue> {
  console.log(`🚀 [API] Updating issue ${id}:`, updates)
  
  const response = await fetch(`/api/database-brain/issues/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  })

  console.log(`📡 [API] Update response status: ${response.status} ${response.statusText}`)
  
  const data = await response.json()
  
  if (!data.success) {
    const errorMsg = data.error || 'Failed to update issue'
    console.error(`❌ [API] Failed to update issue ${id}: ${errorMsg}`, data)
    throw new Error(errorMsg)
  }

  return data.data
}

/**
 * Generate SQL fix using OpenAI
 */
export async function generateFix(id: string): Promise<{
  issue: DatabaseIssue
  generated: {
    sqlFix?: string
    migrationSteps?: string
    warnings?: string
  }
}> {
  console.log(`🚀 [API] Generating fix for issue: ${id}`)
  
  const response = await fetch(`/api/database-brain/issues/${id}/generate-fix`, {
    method: 'POST',
  })

  console.log(`📡 [API] Generate fix response status: ${response.status} ${response.statusText}`)
  
  const data = await response.json()
  
  if (!data.success) {
    const errorMsg = data.error || 'Failed to generate fix'
    console.error(`❌ [API] Failed to generate fix for ${id}: ${errorMsg}`, data)
    throw new Error(errorMsg)
  }

  return data.data
}

/**
 * Auto-apply fix (ONE-CLICK FIX)
 * Executes the SQL migration automatically and marks issue as resolved
 */
export async function applyFix(id: string): Promise<{
  success: boolean
  issue: DatabaseIssue
  executionResult: {
    executed: boolean
    rowsAffected?: number
    duration?: number
    error?: string
  }
}> {
  console.log(`🚀 [API] Auto-applying fix for issue: ${id}`)
  
  const response = await fetch(`/api/database-brain/issues/${id}/apply-fix`, {
    method: 'POST',
  })

  console.log(`📡 [API] Apply fix response status: ${response.status} ${response.statusText}`)
  
  const data = await response.json()
  
  if (!data.success) {
    const errorMsg = data.error || 'Failed to apply fix'
    console.error(`❌ [API] Failed to apply fix for ${id}: ${errorMsg}`, data)
    throw new Error(errorMsg)
  }

  console.log(`✅ [API] Fix applied successfully:`, {
    executed: data.data.executionResult.executed,
    duration: data.data.executionResult.duration,
  })

  return data.data
}

