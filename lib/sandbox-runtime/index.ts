/**
 * SANDBOX RUNTIME LAYER
 * 
 * Ephemeral, isolated execution environment for testing APIs before deployment.
 * Provides instant API testing without requiring cloud deployment.
 * 
 * ARCHITECTURE:
 * - In-process Express server per project
 * - Uses BackendStateGraph snapshot for routing/auth/storage
 * - Auto-destroys after inactivity
 * - No production resource access
 * - Fast startup (<2s target)
 * 
 * CRITICAL: This is NOT production - it's a development sandbox
 */

import { BackendStateGraph } from '@/lib/orchestration/backend-state-graph'
import { prisma } from '@/lib/db'
import express, { Express, Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { createServer, Server } from 'http'

// =============================================================================
// Types
// =============================================================================

export interface SandboxConfig {
  projectId: string
  port?: number
  autoDestroyMs?: number
  memoryLimitMb?: number
}

export interface SandboxRuntime {
  projectId: string
  port: number
  server: Server
  app: Express
  graph: BackendStateGraph
  startedAt: Date
  lastActivityAt: Date
  requestCount: number
  status: 'starting' | 'running' | 'stopping' | 'stopped'
}

export interface SandboxStatus {
  projectId: string
  running: boolean
  port?: number
  uptime?: number
  requestCount?: number
  lastActivity?: Date
}

// =============================================================================
// State Management
// =============================================================================

// In-memory registry of active sandboxes
const activeSandboxes = new Map<string, SandboxRuntime>()

// Port pool for sandboxes (10000-10100 = 100 available ports)
const MIN_PORT = 10000
const MAX_PORT = 10100
const usedPorts = new Set<number>()

/**
 * Find an available port for sandbox
 */
function findAvailablePort(): number {
  for (let port = MIN_PORT; port <= MAX_PORT; port++) {
    if (!usedPorts.has(port)) {
      usedPorts.add(port)
      return port
    }
  }
  throw new Error('No available ports for sandbox runtime')
}

/**
 * Release a port back to the pool
 */
function releasePort(port: number): void {
  usedPorts.delete(port)
}

// =============================================================================
// Sandbox Lifecycle
// =============================================================================

/**
 * Start a sandbox runtime for a project
 * 
 * @param projectId - Project ID to start sandbox for
 * @param config - Optional configuration
 * @returns Port number where sandbox is running
 */
export async function startSandbox(
  projectId: string,
  config?: Partial<SandboxConfig>
): Promise<number> {
  console.log(`[Sandbox Runtime] Starting sandbox for project: ${projectId}`)

  // Check if sandbox already running
  const existing = activeSandboxes.get(projectId)
  if (existing && existing.status === 'running') {
    console.log(`[Sandbox Runtime] Sandbox already running on port ${existing.port}`)
    existing.lastActivityAt = new Date()
    return existing.port
  }
  
  // Clean up any zombie sandbox for this project
  if (existing) {
    console.log(`[Sandbox Runtime] Cleaning up existing sandbox in state: ${existing.status}`)
    await stopSandbox(projectId).catch((err) => {
      console.warn(`[Sandbox Runtime] Failed to stop existing sandbox:`, err)
    })
  }

  // Load backend state graph
  const { loadGraph } = await import('@/lib/orchestration/backend-state-graph')
  
  let graph
  try {
    graph = await loadGraph(projectId)
  } catch (error: any) {
    console.error(`[Sandbox Runtime] Failed to load graph:`, error)
    throw new Error(`Cannot start sandbox: No backend state found for project. Please generate your backend first.`)
  }

  if (!graph || Object.keys(graph.entities).length === 0) {
    throw new Error(`Cannot start sandbox: No entities found in backend state. Please generate your backend first.`)
  }

  // Allocate port
  const port = config?.port || findAvailablePort()

  // Create Express app
  const app = express()
  
  // Middleware
  app.use(cors())
  app.use(express.json({ limit: '10mb' }))
  app.use(express.urlencoded({ extended: true, limit: '10mb' }))

  // Request logging & activity tracking
  app.use((req: Request, res: Response, next: NextFunction) => {
    const sandbox = activeSandboxes.get(projectId)
    if (sandbox) {
      sandbox.lastActivityAt = new Date()
      sandbox.requestCount++
    }
    console.log(`[Sandbox ${projectId}] ${req.method} ${req.path}`)
    next()
  })

  // Generate routes from state graph
  generateRoutesFromGraph(app, graph, projectId)

  // Health endpoint
  app.get('/health', (req: Request, res: Response) => {
    const sandbox = activeSandboxes.get(projectId)
    res.json({
      status: 'healthy',
      mode: 'sandbox',
      projectId,
      uptime: sandbox ? Date.now() - sandbox.startedAt.getTime() : 0,
      requestCount: sandbox?.requestCount || 0,
      entities: Object.keys(graph.entities).length,
      apis: Object.keys(graph.apis).length,
    })
  })

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Endpoint not found',
      mode: 'sandbox',
      hint: 'Use /health to check sandbox status',
    })
  })

  // Error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error(`[Sandbox ${projectId}] Error:`, err)
    res.status(500).json({
      error: 'Internal server error',
      mode: 'sandbox',
      message: err.message,
    })
  })

  // Start server with retry logic for port conflicts
  let server: Server | undefined
  let actualPort = port
  let retries = 0
  const maxRetries = 20 // Increased retries
  
  while (retries < maxRetries) {
    try {
      server = await new Promise<Server>((resolve, reject) => {
        const srv = createServer(app)
        
        // Set timeout for server startup
        const timeout = setTimeout(() => {
          srv.close()
          reject(new Error('Server startup timeout'))
        }, 5000)
        
        srv.listen(actualPort, () => {
          clearTimeout(timeout)
          console.log(`[Sandbox Runtime] ✅ Sandbox running on port ${actualPort}`)
          resolve(srv)
        })
        
        srv.on('error', (err) => {
          clearTimeout(timeout)
          reject(err)
        })
      })
      break // Success - exit loop
    } catch (error: any) {
      if (error.code === 'EADDRINUSE' || error.message === 'Server startup timeout') {
        console.log(`[Sandbox Runtime] Port ${actualPort} unavailable (${error.code || 'timeout'}), trying next port...`)
        releasePort(actualPort)
        actualPort = findAvailablePort()
        retries++
      } else {
        throw error
      }
    }
  }
  
  if (!server) {
    throw new Error(`Failed to find available port after ${maxRetries} retries. Please restart the development server.`)
  }

  // Register sandbox
  const runtime: SandboxRuntime = {
    projectId,
    port: actualPort,
    server,
    app,
    graph,
    startedAt: new Date(),
    lastActivityAt: new Date(),
    requestCount: 0,
    status: 'running',
  }

  activeSandboxes.set(projectId, runtime)

  // Setup auto-destroy timer
  const autoDestroyMs = config?.autoDestroyMs || 30 * 60 * 1000 // 30 minutes default
  setupAutoDestroy(projectId, autoDestroyMs)

  console.log(`[Sandbox Runtime] ✅ Sandbox started for ${projectId} on port ${actualPort}`)
  return actualPort
}

/**
 * Stop a sandbox runtime
 * 
 * @param projectId - Project ID to stop sandbox for
 */
export async function stopSandbox(projectId: string): Promise<boolean> {
  console.log(`[Sandbox Runtime] Stopping sandbox for project: ${projectId}`)

  const sandbox = activeSandboxes.get(projectId)
  if (!sandbox) {
    console.log(`[Sandbox Runtime] No sandbox running for project: ${projectId}`)
    return false
  }

  sandbox.status = 'stopping'

  // Close server
  await new Promise<void>((resolve) => {
    sandbox.server.close(() => {
      console.log(`[Sandbox Runtime] Server closed for project: ${projectId}`)
      resolve()
    })
  })

  // Release port
  releasePort(sandbox.port)

  // Remove from registry
  activeSandboxes.delete(projectId)

  sandbox.status = 'stopped'

  console.log(`[Sandbox Runtime] ✅ Sandbox stopped for project: ${projectId}`)
  return true
}

/**
 * Get sandbox status
 * 
 * @param projectId - Project ID to check
 * @returns Status information
 */
export function getSandboxStatus(projectId: string): SandboxStatus {
  const sandbox = activeSandboxes.get(projectId)

  if (!sandbox || sandbox.status !== 'running') {
    return {
      projectId,
      running: false,
    }
  }

  return {
    projectId,
    running: true,
    port: sandbox.port,
    uptime: Date.now() - sandbox.startedAt.getTime(),
    requestCount: sandbox.requestCount,
    lastActivity: sandbox.lastActivityAt,
  }
}

/**
 * Proxy a request to the sandbox runtime
 * 
 * @param projectId - Project ID
 * @param request - Request details
 * @returns Response from sandbox
 */
export async function proxyRequest(
  projectId: string,
  request: {
    method: string
    path: string
    headers?: Record<string, string>
    body?: any
  }
): Promise<{
  status: number
  statusText: string
  headers: Record<string, string>
  data: any
  time: number
}> {
  const sandbox = activeSandboxes.get(projectId)

  if (!sandbox || sandbox.status !== 'running') {
    throw new Error('Sandbox is not running. Please start the sandbox first.')
  }

  const url = `http://localhost:${sandbox.port}${request.path}`
  const startTime = Date.now()

  try {
    const response = await fetch(url, {
      method: request.method,
      headers: {
        'Content-Type': 'application/json',
        ...request.headers,
      },
      body: request.body ? JSON.stringify(request.body) : undefined,
    })

    const responseTime = Date.now() - startTime

    // Get response headers
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    // Parse response body
    let responseData
    const contentType = response.headers.get('content-type')
    if (contentType?.includes('application/json')) {
      responseData = await response.json()
    } else {
      responseData = await response.text()
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      data: responseData,
      time: responseTime,
    }
  } catch (error: any) {
    const responseTime = Date.now() - startTime
    throw {
      status: 0,
      statusText: 'Network Error',
      headers: {},
      data: { error: error.message || 'Request failed' },
      time: responseTime,
    }
  }
}

// =============================================================================
// Route Generation from State Graph
// =============================================================================

/**
 * Generate Express routes from BackendStateGraph
 */
function generateRoutesFromGraph(
  app: Express,
  graph: BackendStateGraph,
  projectId: string
): void {
  console.log(`[Sandbox Runtime] Generating routes for ${Object.keys(graph.entities).length} entities`)

  // Generate CRUD routes for each entity
  for (const [entityName, entity] of Object.entries(graph.entities)) {
    const basePath = `/api/${entityName.toLowerCase()}`

    // In-memory storage for sandbox (not persistent)
    const storage = new Map<string, any>()
    let nextId = 1

    // LIST endpoint
    app.get(basePath, (req: Request, res: Response) => {
      const records = Array.from(storage.values())
      res.json({
        success: true,
        data: records,
        count: records.length,
        mode: 'sandbox',
      })
    })

    // GET by ID endpoint
    app.get(`${basePath}/:id`, (req: Request, res: Response) => {
      const record = storage.get(req.params.id)
      if (!record) {
        return res.status(404).json({
          success: false,
          error: 'Record not found',
          mode: 'sandbox',
        })
      }
      res.json({
        success: true,
        data: record,
        mode: 'sandbox',
      })
    })

    // CREATE endpoint
    app.post(basePath, (req: Request, res: Response) => {
      const id = String(nextId++)
      const now = new Date().toISOString()
      const record = {
        id,
        ...req.body,
        createdAt: now,
        updatedAt: now,
      }
      storage.set(id, record)
      res.status(201).json({
        success: true,
        data: record,
        mode: 'sandbox',
      })
    })

    // UPDATE endpoint
    app.put(`${basePath}/:id`, (req: Request, res: Response) => {
      const existing = storage.get(req.params.id)
      if (!existing) {
        return res.status(404).json({
          success: false,
          error: 'Record not found',
          mode: 'sandbox',
        })
      }
      const updated = {
        ...existing,
        ...req.body,
        id: req.params.id,
        updatedAt: new Date().toISOString(),
      }
      storage.set(req.params.id, updated)
      res.json({
        success: true,
        data: updated,
        mode: 'sandbox',
      })
    })

    // DELETE endpoint
    app.delete(`${basePath}/:id`, (req: Request, res: Response) => {
      const deleted = storage.delete(req.params.id)
      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: 'Record not found',
          mode: 'sandbox',
        })
      }
      res.json({
        success: true,
        message: 'Record deleted',
        mode: 'sandbox',
      })
    })

    console.log(`[Sandbox Runtime] Generated routes for entity: ${entityName}`)
  }

  // Generate auth routes if enabled
  const authProviders = Object.keys(graph.auth?.providers || {}).filter(
    (p) => graph.auth.providers[p as keyof typeof graph.auth.providers]?.enabled
  )
  if (authProviders.length > 0) {
    app.post('/api/auth/register', (req: Request, res: Response) => {
      res.json({
        success: true,
        message: 'Registration successful (sandbox mode)',
        mode: 'sandbox',
        user: { id: '1', email: req.body.email },
        token: 'sandbox_token_' + Date.now(),
      })
    })

    app.post('/api/auth/login', (req: Request, res: Response) => {
      res.json({
        success: true,
        message: 'Login successful (sandbox mode)',
        mode: 'sandbox',
        user: { id: '1', email: req.body.email },
        token: 'sandbox_token_' + Date.now(),
      })
    })

    console.log('[Sandbox Runtime] Generated auth routes')
  }

  // Generate storage routes if enabled
  if (Object.keys(graph.storage?.buckets || {}).length > 0) {
    app.post('/api/storage/upload', (req: Request, res: Response) => {
      res.json({
        success: true,
        message: 'File uploaded (sandbox mode)',
        mode: 'sandbox',
        url: `http://localhost/sandbox-storage/${Date.now()}.dat`,
      })
    })

    console.log('[Sandbox Runtime] Generated storage routes')
  }
}

// =============================================================================
// Auto-Destroy Logic
// =============================================================================

/**
 * Setup auto-destroy timer for inactive sandboxes
 */
function setupAutoDestroy(projectId: string, inactivityMs: number): void {
  const checkInterval = 60 * 1000 // Check every minute

  const intervalId = setInterval(() => {
    const sandbox = activeSandboxes.get(projectId)

    if (!sandbox) {
      clearInterval(intervalId)
      return
    }

    const inactiveFor = Date.now() - sandbox.lastActivityAt.getTime()

    if (inactiveFor > inactivityMs) {
      console.log(
        `[Sandbox Runtime] Auto-destroying sandbox for ${projectId} (inactive for ${Math.round(inactiveFor / 1000)}s)`
      )
      stopSandbox(projectId)
      clearInterval(intervalId)
    }
  }, checkInterval)
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get all active sandboxes
 */
export function getActiveSandboxes(): SandboxStatus[] {
  const statuses: SandboxStatus[] = []
  for (const [projectId, sandbox] of Array.from(activeSandboxes.entries())) {
    statuses.push(getSandboxStatus(projectId))
  }
  return statuses
}

/**
 * Stop all sandboxes (for shutdown)
 */
export async function stopAllSandboxes(): Promise<void> {
  console.log('[Sandbox Runtime] Stopping all sandboxes...')
  const projectIds = Array.from(activeSandboxes.keys())
  await Promise.all(projectIds.map((id) => stopSandbox(id)))
  console.log('[Sandbox Runtime] All sandboxes stopped')
}
