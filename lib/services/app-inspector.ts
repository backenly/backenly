/**
 * App Inspector — Analyzes app behavior without importing code
 * 
 * Inspects:
 * - Network requests (what APIs are being called)
 * - DOM structure (what data is displayed)
 * - User interactions (what actions are possible)
 * - Technology detection (React, Vue, Next.js, etc.)
 * 
 * Does NOT:
 * - Import or read source code
 * - Access private repositories
 * - Modify the app
 */

export interface AppInspectionResult {
  success: boolean
  error?: string
  data?: {
    appName: string
    appUrl: string
    technologies: string[]
    detectedAPIs: DetectedAPI[]
    detectedDataModels: DetectedDataModel[]
    detectedAuth: DetectedAuth | null
    detectedStorage: DetectedStorage | null
  }
}

export interface DetectedAPI {
  endpoint: string
  method: string
  sampleRequest?: any
  sampleResponse?: any
  frequency: number // How many times it was called
}

export interface DetectedDataModel {
  name: string // "posts", "users", "comments"
  fields: DetectedField[]
  relationships: string[] // ["user has many posts"]
}

export interface DetectedField {
  name: string
  type: string // "string", "number", "boolean", "date"
  required: boolean
}

export interface DetectedAuth {
  method: string // "jwt", "oauth", "session"
  provider?: string // "google", "github"
}

export interface DetectedStorage {
  hasFileUpload: boolean
  fileTypes: string[]
}

export class AppInspector {
  /**
   * Inspect app behavior by URL
   */
  static async inspect(url: string): Promise<AppInspectionResult> {
    try {
      console.log('[AppInspector] Inspecting:', url)

      // Step 1: Fetch the app HTML
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Backenly-Inspector/1.0 (Backend-as-a-Service)',
        },
      })

      if (!response.ok) {
        return {
          success: false,
          error: 'Couldn\'t access that app. It might be private or offline.',
        }
      }

      const html = await response.text()

      // Step 2: Detect technologies from HTML
      const technologies = this.detectTechnologies(html)

      // Step 3: Extract app name
      const appName = this.extractAppName(html, url)

      // Step 4: Analyze network requests (client-side behavior simulation)
      // In production, this would use a headless browser (Playwright/Puppeteer)
      // For now, we'll extract API endpoints from HTML/scripts
      const detectedAPIs = this.extractAPIEndpoints(html)

      // Step 5: Infer data models from API responses
      const detectedDataModels = this.inferDataModels(detectedAPIs)

      // Step 6: Detect auth patterns
      const detectedAuth = this.detectAuth(html, detectedAPIs)

      // Step 7: Detect storage/file upload
      const detectedStorage = this.detectStorage(html)

      return {
        success: true,
        data: {
          appName,
          appUrl: url,
          technologies,
          detectedAPIs,
          detectedDataModels,
          detectedAuth,
          detectedStorage,
        },
      }
    } catch (error) {
      console.error('[AppInspector] Failed:', error)
      return {
        success: false,
        error: 'Something went wrong while inspecting the app.',
      }
    }
  }

  /**
   * Detect technologies from HTML
   */
  private static detectTechnologies(html: string): string[] {
    const technologies: string[] = []

    // React detection
    if (html.includes('react') || html.includes('__REACT') || html.includes('_react')) {
      technologies.push('React')
    }

    // Vue detection
    if (html.includes('vue') || html.includes('__VUE__')) {
      technologies.push('Vue')
    }

    // Next.js detection
    if (html.includes('__NEXT') || html.includes('_next/')) {
      technologies.push('Next.js')
    }

    // Vite detection
    if (html.includes('/@vite') || html.includes('vite')) {
      technologies.push('Vite')
    }

    // Tailwind detection
    if (html.includes('tailwind') || html.match(/class="[^"]*\b(flex|grid|p-|m-|bg-|text-)/)) {
      technologies.push('Tailwind CSS')
    }

    // TypeScript detection
    if (html.includes('.ts') || html.includes('typescript')) {
      technologies.push('TypeScript')
    }

    return technologies
  }

  /**
   * Extract app name from HTML
   */
  private static extractAppName(html: string, url: string): string {
    // Try to extract from <title> tag
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1].trim()
    }

    // Fallback to URL hostname
    try {
      const parsedUrl = new URL(url)
      return parsedUrl.hostname.split('.')[0]
    } catch {
      return 'App'
    }
  }

  /**
   * Extract API endpoints from HTML/scripts
   */
  private static extractAPIEndpoints(html: string): DetectedAPI[] {
    const apis: DetectedAPI[] = []
    const seenEndpoints = new Set<string>()

    // Extract fetch calls using exec() to avoid downlevelIteration
    const fetchRegex = /fetch\s*\(\s*['"]{1}([^'"]+)['"]{1}/g
    let match
    while ((match = fetchRegex.exec(html)) !== null) {
      const endpoint = match[1]
      if (!seenEndpoints.has(endpoint) && (endpoint.startsWith('/api') || endpoint.startsWith('http'))) {
        seenEndpoints.add(endpoint)
        apis.push({
          endpoint,
          method: 'GET',
          frequency: 1,
        })
      }
    }

    // Extract axios calls
    const axiosRegex = /axios\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"]{1}([^'"]+)['"]{1}/gi
    while ((match = axiosRegex.exec(html)) !== null) {
      const method = match[1].toUpperCase()
      const endpoint = match[2]
      if (!seenEndpoints.has(endpoint)) {
        seenEndpoints.add(endpoint)
        apis.push({
          endpoint,
          method,
          frequency: 1,
        })
      }
    }

    return apis
  }

  /**
   * Infer data models from API endpoints
   */
  private static inferDataModels(apis: DetectedAPI[]): DetectedDataModel[] {
    const models: Map<string, DetectedDataModel> = new Map()

    for (const api of apis) {
      // Extract resource name from endpoint
      // Example: /api/posts -> "posts", /api/users/123 -> "users"
      const resourceMatch = api.endpoint.match(/\/api\/([a-z]+)/i)
      if (!resourceMatch) continue

      const resourceName = resourceMatch[1]

      if (!models.has(resourceName)) {
        models.set(resourceName, {
          name: resourceName,
          fields: [],
          relationships: [],
        })
      }
    }

    return Array.from(models.values())
  }

  /**
   * Detect authentication patterns
   */
  private static detectAuth(html: string, apis: DetectedAPI[]): DetectedAuth | null {
    // Check for auth-related keywords
    const hasLogin = html.toLowerCase().includes('login') || html.toLowerCase().includes('sign in')
    const hasSignup = html.toLowerCase().includes('sign up') || html.toLowerCase().includes('register')
    const hasAuthHeader = html.includes('Authorization:') || html.includes('Bearer ')

    if (!hasLogin && !hasSignup && !hasAuthHeader) {
      return null
    }

    // Detect OAuth providers
    if (html.toLowerCase().includes('google') && html.toLowerCase().includes('oauth')) {
      return { method: 'oauth', provider: 'google' }
    }
    if (html.toLowerCase().includes('github') && html.toLowerCase().includes('oauth')) {
      return { method: 'oauth', provider: 'github' }
    }

    // Default to JWT
    return { method: 'jwt' }
  }

  /**
   * Detect storage/file upload functionality
   */
  private static detectStorage(html: string): DetectedStorage | null {
    const hasFileInput = html.includes('type="file"') || html.includes('type=file')
    const hasUpload = html.toLowerCase().includes('upload')

    if (!hasFileInput && !hasUpload) {
      return null
    }

    // Try to detect accepted file types
    const fileTypes: string[] = []
    const acceptMatch = html.match(/accept\s*=\s*['"]([^'"]+)['"]/i)
    if (acceptMatch) {
      fileTypes.push(...acceptMatch[1].split(',').map(t => t.trim()))
    }

    return {
      hasFileUpload: true,
      fileTypes: fileTypes.length > 0 ? fileTypes : ['*/*'],
    }
  }
}
