// Client-side API helpers for Database operations

export type DatabaseType = 'postgresql' | 'mongodb'

export interface TableInfo {
  schema?: string
  name: string
  rows?: number
  documents?: number
  size: string
  description?: string
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  primary?: boolean
  foreign?: boolean
  default?: string
  unique?: boolean
  indexed?: boolean
  description?: string
}

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
  type: string
}

export interface RelationshipInfo {
  name: string
  type: 'foreign_key' | 'reference'
  from: { table: string; column: string }
  to: { table: string; column: string }
}

export interface PaginatedResponse<T> {
  data: T[]
  pagination: {
    total: number
    page: number
    limit: number
    totalPages: number
  }
}

// Schemas
export async function getSchemas(options?: {
  projectId?: string
  view?: 'platform' | 'workspace' | 'all'
}): Promise<string[]> {
  const params = new URLSearchParams()
  if (options?.projectId) params.append('projectId', options.projectId)
  if (options?.view) params.append('view', options.view)
  
  try {
    const url = `/api/database/schemas?${params.toString()}`
    console.log(`[🔍 Database API] Fetching schemas: ${url}`)
    
    const response = await fetch(url, {
      credentials: 'include', // Include cookies for auth
    })
    
    // Production-grade error handling - NEVER GUESS!
    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[❌ Database API] Schemas request failed:`, {
        status: response.status,
        statusText: response.statusText,
        url,
        error: errorText,
      })
      
      // Parse error response to get structured error code
      let errorData: any = null;
      try {
        errorData = JSON.parse(errorText);
      } catch (e) {
        // Not JSON, treat as unknown error
        throw new Error(`UNKNOWN_ERROR: ${errorText}`);
      }
      
      // 🚫 CRITICAL: Use error codes from backend, never guess!
      const errorCode = errorData?.code;
      const errorMessage = errorData?.error || errorData?.message || 'Unknown error';
      
      switch (errorCode) {
        case 'PROJECT_NOT_FOUND':
          throw new Error('PROJECT_NOT_FOUND');
          
        case 'PROJECT_FORBIDDEN':
          throw new Error('PROJECT_FORBIDDEN');
          
        case 'UNAUTHORIZED':
          throw new Error('UNAUTHORIZED');
          
        default:
          // Unknown error - include details for debugging
          throw new Error(`UNKNOWN_DATABASE_ERROR: ${errorMessage}`);
      }
    }
    
    const data = await response.json()
    
    if (!data.success) {
      console.error('[❌ Database API] Schemas request returned error:', data)
      throw new Error(data.error || data.message || 'Failed to fetch schemas')
    }
    
    console.log(`[✅ Database API] Schemas loaded successfully:`, {
      count: data.data?.length || 0,
      schemas: data.data,
    })
    
    return data.data || []
  } catch (error: any) {
    console.error('[🔥 Database API] getSchemas error:', error)
    throw error
  }
}

/**
 * 🚫 CRITICAL: Validate project access BEFORE calling database APIs
 * This prevents unauthorized access and provides better UX
 */
export async function validateProjectAccess(projectId: string): Promise<{
  valid: boolean
  error?: 'NOT_FOUND' | 'FORBIDDEN' | 'UNAUTHORIZED'
  message?: string
}> {
  try {
    console.log('[validateProjectAccess] Starting validation for project:', projectId);
    
    // Quick validation: fetch current user profile (includes projects)
    // ⚡ OPTIMIZED: /api/auth/me is faster than /api/projects because it returns only what we need
    const response = await fetch('/api/auth/me', {
      credentials: 'include', // CRITICAL: Include cookies for auth
    });
    
    console.log('[validateProjectAccess] /api/auth/me response status:', response.status);
    
    if (!response.ok) {
      console.error('[validateProjectAccess] Failed to fetch user profile:', response.status);
      return {
        valid: false,
        error: 'UNAUTHORIZED',
        message: 'Please log in to continue',
      };
    }
    
    const data = await response.json();
    const projects = data.projects || [];
    
    console.log('[validateProjectAccess] User has', projects.length, 'projects');
    
    // Check if project exists in user's projects
    const projectExists = projects.some((p: any) => p.id === projectId);
    
    console.log('[validateProjectAccess] Project exists:', projectExists);
    
    if (!projectExists) {
      return {
        valid: false,
        error: 'NOT_FOUND',
        message: 'Project not found or you do not have access',
      };
    }
    
    console.log('[validateProjectAccess] ✅ Validation successful for project:', projectId);
    return { valid: true };
  } catch (error: any) {
    console.error('[❌ validateProjectAccess error:]', error);
    return {
      valid: false,
      error: 'UNAUTHORIZED',
      message: 'Failed to validate project access',
    };
  }
}

// Tables/Collections
export async function getTables(
  type: DatabaseType,
  schema?: string,
  options?: {
    projectId?: string
    view?: 'platform' | 'workspace' | 'all'
  }
): Promise<TableInfo[]> {
  const params = new URLSearchParams({ type })
  if (schema) params.append('schema', schema)
  if (options?.projectId) params.append('projectId', options.projectId)
  if (options?.view) params.append('view', options.view)
  
  try {
    const url = `/api/database/tables?${params.toString()}`
    console.log(`[🔍 Database API] Fetching tables: ${url}`)
    
    const response = await fetch(url, {
      credentials: 'include', // Include cookies for auth
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[❌ Database API] Tables request failed:`, {
        status: response.status,
        url,
        error: errorText,
      })
      
      if (response.status === 404) {
        // Check if it's a project not found error vs route not found
        try {
          const errorData = JSON.parse(errorText)
          if (errorData.error === 'Project not found') {
            throw new Error(`Project with ID ${options?.projectId} not found in database.`)
          }
        } catch {
          // If JSON parsing fails, it might be a different 404
        }
        
        throw new Error('Tables API route not found. Please refresh the page.')
      }
      
      throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
    
    const data = await response.json()
    if (!data.success) {
      console.error('[❌ Database API] Tables request error:', data)
      throw new Error(data.error || 'Failed to fetch tables')
    }
    
    console.log(`[✅ Database API] Tables loaded:`, {
      count: data.data?.length || 0,
      schema,
      type,
    })
    
    return data.data || []
  } catch (error: any) {
    console.error('[🔥 Database API] getTables error:', error)
    throw error
  }
}

// Structure
export async function getStructure(
  type: DatabaseType,
  table: string,
  schema?: string,
  options?: {
    projectId?: string
    view?: 'platform' | 'workspace' | 'all'
  }
): Promise<ColumnInfo[]> {
  const params = new URLSearchParams({ type, table })
  if (schema) params.append('schema', schema)
  if (options?.projectId) params.append('projectId', options.projectId)
  if (options?.view) params.append('view', options.view)
  
  const url = `/api/database/structure?${params.toString()}`
  
  try {
    const response = await fetch(url, {
      credentials: 'include', // Include cookies for auth
    })
    
    // Get response text first (can only be read once)
    const responseText = await response.text()
    const contentType = response.headers.get('content-type')
    
    // Check if response is ok
    if (!response.ok) {
      let errorData: any = null
      let errorText = responseText || response.statusText || 'Unknown error'
      
      // Try to parse as JSON if content type indicates JSON
      if (contentType?.includes('application/json') && responseText) {
        try {
          errorData = JSON.parse(responseText)
        } catch (parseError) {
          // If JSON parsing fails, use text as-is
          errorText = responseText
        }
      }
      
      const errorMessage = errorData?.message || errorData?.error || errorText || `HTTP ${response.status}: Failed to fetch structure`
      const errorDetails = errorData?.details ? ` Details: ${JSON.stringify(errorData.details)}` : ''
      
      console.error(`[getStructure] Server error for ${type}.${schema || 'default'}.${table}:`, {
        url,
        status: response.status,
        statusText: response.statusText,
        contentType,
        error: errorMessage,
        details: errorData?.details,
        errorData,
        errorText: responseText.substring(0, 500), // First 500 chars for debugging
        request: { type, table, schema, projectId: options?.projectId, view: options?.view },
      })
      
      throw new Error(`${errorMessage}${errorDetails}`)
    }
    
    // Parse JSON response - handle empty or invalid JSON
    let data: any
    try {
      if (!responseText || responseText.trim() === '') {
        throw new Error('Empty response from server')
      }
      data = JSON.parse(responseText)
    } catch (parseError: any) {
      console.error(`[getStructure] JSON parsing error for ${type}.${schema || 'default'}.${table}:`, {
        url,
        status: response.status,
        statusText: response.statusText,
        contentType,
        parseError: parseError.message,
        responseText: responseText.substring(0, 500), // First 500 chars for debugging
        request: { type, table, schema, projectId: options?.projectId, view: options?.view },
      })
      throw new Error(`Failed to parse server response: ${parseError.message}`)
    }
    
    if (!data.success) {
      const errorMessage = data.message || data.error || 'Failed to fetch structure'
      const errorDetails = data.details ? ` Details: ${JSON.stringify(data.details)}` : ''
      console.error(`[getStructure] Server returned error for ${type}.${schema || 'default'}.${table}:`, {
        url,
        status: response.status,
        error: errorMessage,
        details: data.details,
        fullResponse: data,
        request: { type, table, schema, projectId: options?.projectId, view: options?.view },
      })
      throw new Error(`${errorMessage}${errorDetails}`)
    }
    
    return data.data
  } catch (error: any) {
    // Re-throw if it's already our formatted error
    if (error.message && (error.message.includes('Failed to fetch structure') || error.message.includes('Failed to parse'))) {
      throw error
    }
    
    console.error(`[getStructure] Network or parsing error for ${type}.${schema || 'default'}.${table}:`, {
      url,
      error: error.message,
      name: error.name,
      stack: error.stack,
      request: { type, table, schema, projectId: options?.projectId, view: options?.view },
    })
    throw new Error(`Failed to fetch structure: ${error.message || 'Unknown error'}`)
  }
}

// Rows/Documents
export async function getRows(
  type: DatabaseType,
  table: string,
  options: {
    schema?: string
    projectId?: string
    view?: 'platform' | 'workspace' | 'all'
    page?: number
    limit?: number
    sortBy?: string
    sortOrder?: 'asc' | 'desc'
    search?: string
    filters?: Record<string, any>
  } = {}
): Promise<PaginatedResponse<any>> {
  const params = new URLSearchParams({ type, table })
  if (options.schema) params.append('schema', options.schema)
  if (options.projectId) params.append('projectId', options.projectId)
  if (options.view) params.append('view', options.view)
  if (options.page) params.append('page', options.page.toString())
  if (options.limit) params.append('limit', options.limit.toString())
  if (options.sortBy) params.append('sortBy', options.sortBy)
  if (options.sortOrder) params.append('sortOrder', options.sortOrder)
  if (options.search) params.append('search', options.search)
  
  // Add filters as query params
  if (options.filters) {
    Object.entries(options.filters).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        params.append(key, String(value))
      }
    })
  }

  const response = await fetch(`/api/database/rows?${params.toString()}`, {
    credentials: 'include', // Include cookies for auth
  })
  const data = await response.json()
  if (!data.success) throw new Error(data.error || 'Failed to fetch rows')
  return { data: data.data, pagination: data.pagination }
}

export async function insertRow(
  type: DatabaseType,
  table: string,
  data: Record<string, any>,
  schema?: string,
  projectId?: string
): Promise<any> {
  const response = await fetch('/api/database/rows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // Include cookies for auth
    body: JSON.stringify({ type, schema, table, data, projectId }),
  })
  const result = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to insert row')
  return result.data
}

export async function updateRow(
  type: DatabaseType,
  table: string,
  id: any,
  data: Record<string, any>,
  schema?: string,
  projectId?: string
): Promise<any> {
  const params = new URLSearchParams({ type, table })
  if (schema) params.append('schema', schema)
  // projectId is required for the route's ownership check (withProjectAccess).
  if (projectId) params.append('projectId', projectId)
  const response = await fetch(`/api/database/rows/${encodeURIComponent(String(id))}?${params.toString()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // Include cookies for auth
    body: JSON.stringify({ data }),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.success) throw new Error(result.error || result.message || 'Failed to update row')
  return result.data
}

export async function deleteRow(
  type: DatabaseType,
  table: string,
  id: any,
  schema?: string,
  projectId?: string
): Promise<void> {
  const params = new URLSearchParams({ type, table })
  if (schema) params.append('schema', schema)
  // projectId is required for the route's ownership check (withProjectAccess).
  if (projectId) params.append('projectId', projectId)
  const response = await fetch(`/api/database/rows/${encodeURIComponent(String(id))}?${params.toString()}`, {
    method: 'DELETE',
    credentials: 'include', // Include cookies for auth
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.success) throw new Error(result.error || result.message || 'Failed to delete row')
}

// Indexes (PostgreSQL only)
export async function getIndexes(
  schema: string,
  table: string,
  options?: {
    projectId?: string
    view?: 'platform' | 'workspace' | 'all'
  }
): Promise<IndexInfo[]> {
  const params = new URLSearchParams({ schema, table })
  if (options?.projectId) params.append('projectId', options.projectId)
  const response = await fetch(`/api/database/indexes?${params.toString()}`, {
    credentials: 'include', // Include cookies for auth
  })
  const data = await response.json()
  if (!data.success) throw new Error(data.error || 'Failed to fetch indexes')
  return data.data
}

// Column-level schema mutations — all funnel through the canonical
// `lib/services/tableLifecycle` runtime (same path the AI uses).
export async function addColumn(
  projectId: string,
  tableName: string,
  column: { name: string; type: string; nullable?: boolean; default?: string },
): Promise<void> {
  const response = await fetch(`/api/database/schema/columns?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ tableName, column }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.success) throw new Error(data.error || 'Failed to add column')
}

export async function renameColumn(
  projectId: string,
  tableName: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const response = await fetch(`/api/database/schema/columns?projectId=${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ tableName, oldName, newName }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.success) throw new Error(data.error || 'Failed to rename column')
}

export async function dropColumn(
  projectId: string,
  tableName: string,
  columnName: string,
): Promise<void> {
  const response = await fetch(`/api/database/schema/columns?projectId=${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ tableName, columnName }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.success) throw new Error(data.error || 'Failed to drop column')
}

export async function addConstraint(
  projectId: string,
  tableName: string,
  columnName: string,
  constraintType: 'not_null' | 'unique' | 'check' | 'foreign_key',
  expression?: string,
): Promise<void> {
  const response = await fetch(`/api/database/schema/constraints?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ tableName, columnName, constraintType, expression }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.success) throw new Error(data.error || 'Failed to add constraint')
}

// Relationships (PostgreSQL only)
export async function getRelationships(
  schema: string,
  table: string,
  options?: {
    projectId?: string
    view?: 'platform' | 'workspace' | 'all'
  }
): Promise<RelationshipInfo[]> {
  const params = new URLSearchParams({ schema, table })
  if (options?.projectId) params.append('projectId', options.projectId)
  const response = await fetch(`/api/database/relationships?${params.toString()}`, {
    credentials: 'include', // Include cookies for auth
  })
  const data = await response.json()
  if (!data.success) throw new Error(data.error || 'Failed to fetch relationships')
  return data.data
}

