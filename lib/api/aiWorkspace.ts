import type {
  BackendChangePlan,
  ChangeItem,
  DiffPreview,
} from '@/lib/services/aiWorkspace'

export interface GeneratePlanRequest {
  prompt: string
  projectId?: string
}

export interface GeneratePlanResponse {
  plan: BackendChangePlan
}

export interface PreviewDiffRequest {
  plan: BackendChangePlan
  projectId?: string
}

export interface PreviewDiffResponse {
  diffs: DiffPreview[]
}

export interface ApplyChangesRequest {
  plan: BackendChangePlan
  selectedChanges: string[]
  projectId?: string
}

export interface ApplyChangesResponse {
  result: {
    success: boolean
    applied: string[]
    errors: Array<{ change: string; error: string }>
  }
}

// Generate a backend change plan
export async function generatePlan(
  request: GeneratePlanRequest
): Promise<BackendChangePlan> {
  console.log('[Frontend] generatePlan called with prompt:', request.prompt.substring(0, 100))
  
  const authToken = localStorage.getItem('auth-token')
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  }
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
  }

  console.log('[Frontend] Sending POST to /api/ai-workspace/generate-plan...')
  
  try {
    const response = await fetch('/api/ai-workspace/generate-plan', {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    })

    console.log('[Frontend] Response status:', response.status, response.statusText)

    if (!response.ok) {
      const error = await response.json()
      console.error('[Frontend] API error response:', error)
      throw new Error(error.error || 'Failed to generate plan')
    }

    const data: GeneratePlanResponse = await response.json()
    console.log('[Frontend] Successfully received plan with', data.plan.changes.length, 'changes')
    return data.plan
  } catch (err) {
    console.error('[Frontend] generatePlan fetch error:', err)
    throw err
  }
}

// Preview diffs for a plan
export async function previewDiff(
  request: PreviewDiffRequest
): Promise<DiffPreview[]> {
  const response = await fetch('/api/ai-workspace/preview-diff', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to preview diff')
  }

  const data: PreviewDiffResponse = await response.json()
  return data.diffs
}

// Apply changes from a plan
export async function applyChanges(
  request: ApplyChangesRequest
): Promise<ApplyChangesResponse['result']> {
  const authToken = localStorage.getItem('auth-token')
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  }
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
  }

  const response = await fetch('/api/ai-workspace/apply-changes', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      plan: request.plan,
      selectedChanges: request.selectedChanges,
      projectId: request.projectId,
    }),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to apply changes')
  }

  const data: ApplyChangesResponse = await response.json()
  return data.result
}

// Re-export types for convenience
export type { BackendChangePlan, ChangeItem, DiffPreview }

