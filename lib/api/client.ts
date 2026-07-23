/**
 * API Client Utilities
 * 
 * Provides helpers for making authenticated API requests with tenant isolation
 */

// Memory cache for project ID to avoid redundant API calls
let cachedProjectIdResult: string | null = null
let lastFetchTime = 0
const CACHE_TTL = 30000 // 30 seconds
let currentFetchPromise: Promise<string | null> | null = null

/**
 * Get the current project ID from localStorage or fetch from API
 * ⚡ OPTIMIZED: Uses memory caching and singleton promise to prevent redundant network calls
 */
export async function getCurrentProjectId(): Promise<string | null> {
  // ⚡ FAST PATH 1: Check URL first (instant for project-scoped routes)
  if (typeof window !== 'undefined') {
    const match = window.location.pathname.match(/\/projects\/([a-f0-9-]+)/)
    if (match) {
      const urlProjectId = match[1]
      // Cache it for other helpers but return immediately
      localStorage.setItem('current-project-id', urlProjectId)
      cachedProjectIdResult = urlProjectId
      lastFetchTime = Date.now()
      return urlProjectId
    }
  }

  // ⚡ FAST PATH 2: Check memory cache (fast for same-session navigation)
  const now = Date.now()
  if (cachedProjectIdResult && (now - lastFetchTime < CACHE_TTL)) {
    return cachedProjectIdResult
  }

  // 2. If already fetching, return the existing promise (prevents race conditions/duplicate calls)
  if (currentFetchPromise) {
    return currentFetchPromise
  }

  // 3. Start a new fetch operation
  currentFetchPromise = (async () => {
    try {
      // Try to get from localStorage first (preferred by user)
      const storedProjectId = localStorage.getItem('current-project-id')
      
      // We still verify with /api/auth/me to ensure session is valid and project belongs to user
      // /api/auth/me is optimized to return user + projects in ONE call
      const response = await fetch('/api/auth/me', {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      })

      if (!response.ok) {
        localStorage.removeItem('current-project-id')
        return null
      }

      const userData = await response.json()
      const projects = userData.projects || []
      
      if (projects.length === 0) {
        localStorage.removeItem('current-project-id')
        return null
      }

      // If we had a stored ID, check if it's still valid
      if (storedProjectId) {
        const isValid = projects.some((p: any) => p.id === storedProjectId)
        if (isValid) {
          cachedProjectIdResult = storedProjectId
          lastFetchTime = Date.now()
          return storedProjectId
        }
      }

      // Otherwise, use the most recent project (or first one)
      const firstProjectId = projects[0].id
      localStorage.setItem('current-project-id', firstProjectId)
      cachedProjectIdResult = firstProjectId
      lastFetchTime = Date.now()
      return firstProjectId
    } catch (error) {
      console.error('Failed to fetch current project:', error)
      return null
    } finally {
      currentFetchPromise = null
    }
  })()

  return currentFetchPromise
}

/**
 * Make an authenticated API request with tenant isolation
 */
export async function apiRequest<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const projectId = await getCurrentProjectId()

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  }

  // Add projectId to headers for tenant isolation
  if (projectId) {
    (headers as Record<string, string>)['X-Project-Id'] = projectId
  }

  // Also add auth token if available
  const authToken = localStorage.getItem('auth-token')
  if (authToken) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${authToken}`
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'include', // Required to send cookies for authentication
  })

  if (!response.ok) {
    // Handle 403 Forbidden - might be missing project
    if (response.status === 403) {
      const error = await response.json().catch(() => ({ error: 'Forbidden' }))
      if (error.error?.includes('Project ID') || error.error?.includes('project')) {
        throw new Error('No project found. Please create a project first.')
      }
    }
    
    const error = await response.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(error.error || `Request failed with status ${response.status}`)
  }

  return response.json()
}

/**
 * Clear cached project ID (call this when switching projects)
 */
export function clearProjectCache(): void {
  localStorage.removeItem('current-project-id')
}

/**
 * Set the current project ID (call this when user selects a project)
 */
export function setCurrentProjectId(projectId: string): void {
  localStorage.setItem('current-project-id', projectId)
}

