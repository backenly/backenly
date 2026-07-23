/**
 * Preflight Service
 * 
 * Builds and tests projects in containers before deployment
 * Ensures code is deployable before sending to production
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'

const execAsync = promisify(exec)

export interface PreflightResult {
  success: boolean
  buildLogs: string[]
  healthCheckPassed: boolean
  healthCheckUrl?: string
  error?: string
  containerId?: string
}

export interface PreflightOptions {
  projectId: string
  timeout?: number // in seconds, default 300 (5 minutes)
}

/**
 * Preflight Service
 * 
 * Builds project, runs in container, checks health endpoint
 */
export class PreflightService {
  /**
   * Run preflight checks for a project
   */
  static async runPreflight(options: PreflightOptions): Promise<PreflightResult> {
    const { projectId, timeout = 300 } = options
    const buildLogs: string[] = []
    let containerId: string | undefined
    const tempDir = path.join(process.cwd(), 'tmp', 'preflight', randomUUID())

    try {
      // 1. Prepare project directory
      buildLogs.push('📦 Preparing project directory...')
      const workspacePath = path.join(process.cwd(), 'workspace', projectId)
      
      // Check if project exists
      try {
        await fs.access(workspacePath)
      } catch {
        throw new Error(`Project directory not found: ${workspacePath}`)
      }

      // Check for package.json
      const packageJsonPath = path.join(workspacePath, 'package.json')
      try {
        await fs.access(packageJsonPath)
      } catch {
        throw new Error('package.json not found. Project must have package.json with build and start scripts.')
      }

      // Copy to temp directory for container build
      buildLogs.push('📋 Copying project files...')
      await this.copyDirectory(workspacePath, tempDir)

      // 2. Build Docker image
      buildLogs.push('🔨 Building Docker image...')
      const imageName = `preflight-${projectId}-${Date.now()}`
      const buildResult = await this.buildDockerImage(tempDir, imageName, buildLogs)
      
      if (!buildResult.success) {
        return {
          success: false,
          buildLogs,
          healthCheckPassed: false,
          error: `Build failed: ${buildResult.error}`,
        }
      }

      // 3. Run container
      buildLogs.push('🚀 Starting container...')
      containerId = await this.runContainer(imageName, buildLogs)
      
      if (!containerId) {
        return {
          success: false,
          buildLogs,
          healthCheckPassed: false,
          error: 'Failed to start container',
        }
      }

      // 4. Wait for server to start
      buildLogs.push('⏳ Waiting for server to start...')
      await this.waitForServer(containerId, 30) // Wait up to 30 seconds

      // 5. Health check
      buildLogs.push('🏥 Running health check...')
      const healthResult = await this.checkHealth(containerId)
      
      // Cleanup
      await this.cleanup(containerId, imageName, tempDir)

      return {
        success: healthResult.passed,
        buildLogs,
        healthCheckPassed: healthResult.passed,
        healthCheckUrl: healthResult.url,
        error: healthResult.passed ? undefined : healthResult.error,
        containerId,
      }
    } catch (error: any) {
      // Cleanup on error
      if (containerId) {
        await this.cleanup(containerId, '', tempDir).catch(() => {})
      }
      
      return {
        success: false,
        buildLogs,
        healthCheckPassed: false,
        error: error.message || 'Preflight check failed',
      }
    }
  }

  /**
   * Copy directory recursively
   */
  private static async copyDirectory(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true })
    const entries = await fs.readdir(src, { withFileTypes: true })

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)

      if (entry.isDirectory()) {
        // Skip node_modules and .next
        if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') {
          continue
        }
        await this.copyDirectory(srcPath, destPath)
      } else {
        await fs.copyFile(srcPath, destPath)
      }
    }
  }

  /**
   * Build Docker image
   */
  private static async buildDockerImage(
    projectDir: string,
    imageName: string,
    logs: string[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Check if Dockerfile exists, if not create one
      const dockerfilePath = path.join(projectDir, 'Dockerfile')
      let dockerfileExists = false
      
      try {
        await fs.access(dockerfilePath)
        dockerfileExists = true
      } catch {
        // Create a basic Dockerfile
        await this.createDefaultDockerfile(dockerfilePath)
      }

      // Build image
      const { stdout, stderr } = await execAsync(
        `docker build -t ${imageName} .`,
        { cwd: projectDir, timeout: 300000 } // 5 minutes timeout
      )

      logs.push(...stdout.split('\n').filter(line => line.trim()))
      if (stderr) {
        logs.push(...stderr.split('\n').filter(line => line.trim()))
      }

      return { success: true }
    } catch (error: any) {
      const errorMsg = error.stderr || error.message || 'Unknown build error'
      logs.push(`❌ Build error: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * Create default Dockerfile if none exists
   */
  private static async createDefaultDockerfile(dockerfilePath: string): Promise<void> {
    const dockerfile = `# Default Dockerfile for Next.js project
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Generate Prisma client if schema exists
RUN if [ -f prisma/schema.prisma ]; then npx prisma generate; fi

# Build
RUN npm run build

# Production image
FROM node:18-alpine AS runner

WORKDIR /app

ENV NODE_ENV production

# Copy built files
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/public ./public

# Expose port
EXPOSE 3000

# Start server
CMD ["npm", "start"]
`
    await fs.writeFile(dockerfilePath, dockerfile)
  }

  /**
   * Run container
   */
  private static async runContainer(
    imageName: string,
    logs: string[]
  ): Promise<string | undefined> {
    try {
      // Run container in detached mode
      const { stdout } = await execAsync(
        `docker run -d -p 0:3000 ${imageName}`,
        { timeout: 30000 }
      )

      const containerId = stdout.trim()
      logs.push(`✅ Container started: ${containerId.substring(0, 12)}`)
      
      // Get mapped port
      const { stdout: portOutput } = await execAsync(
        `docker port ${containerId}`,
        { timeout: 5000 }
      )
      
      const portMatch = portOutput.match(/:(\d+)/)
      if (portMatch) {
        logs.push(`🌐 Container port: ${portMatch[1]}`)
      }

      return containerId
    } catch (error: any) {
      logs.push(`❌ Failed to start container: ${error.message}`)
      return undefined
    }
  }

  /**
   * Wait for server to be ready
   */
  private static async waitForServer(
    containerId: string,
    maxWaitSeconds: number
  ): Promise<void> {
    const startTime = Date.now()
    const maxWait = maxWaitSeconds * 1000

    while (Date.now() - startTime < maxWait) {
      try {
        // Check if container is still running
        const { stdout } = await execAsync(
          `docker ps --filter id=${containerId} --format "{{.Status}}"`,
          { timeout: 5000 }
        )

        if (!stdout.trim()) {
          throw new Error('Container stopped unexpectedly')
        }

        // Try to get container logs to check for startup
        const { stdout: logs } = await execAsync(
          `docker logs --tail 10 ${containerId}`,
          { timeout: 5000 }
        )

        // Check if server is ready (look for "Ready" or "started" in logs)
        if (logs.includes('Ready') || logs.includes('started') || logs.includes('listening')) {
          return
        }

        await new Promise(resolve => setTimeout(resolve, 2000)) // Wait 2 seconds
      } catch (error) {
        // Continue waiting
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }

    throw new Error(`Server did not start within ${maxWaitSeconds} seconds`)
  }

  /**
   * Check health endpoint
   */
  private static async checkHealth(containerId: string): Promise<{
    passed: boolean
    url?: string
    error?: string
  }> {
    try {
      // Get container port
      const { stdout: portOutput } = await execAsync(
        `docker port ${containerId}`,
        { timeout: 5000 }
      )

      const portMatch = portOutput.match(/:(\d+)/)
      if (!portMatch) {
        return { passed: false, error: 'Could not determine container port' }
      }

      const port = portMatch[1]
      const healthUrl = `http://localhost:${port}/api/health`

      // Try health check
      const response = await fetch(healthUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000), // 10 second timeout
      })

      if (response.ok) {
        const data = await response.json()
        return {
          passed: true,
          url: healthUrl,
        }
      } else {
        return {
          passed: false,
          error: `Health check returned ${response.status}`,
          url: healthUrl,
        }
      }
    } catch (error: any) {
      return {
        passed: false,
        error: error.message || 'Health check failed',
      }
    }
  }

  /**
   * Cleanup container and image
   */
  private static async cleanup(
    containerId: string,
    imageName: string,
    tempDir: string
  ): Promise<void> {
    try {
      // Stop and remove container
      if (containerId) {
        await execAsync(`docker stop ${containerId}`, { timeout: 10000 }).catch(() => {})
        await execAsync(`docker rm ${containerId}`, { timeout: 10000 }).catch(() => {})
      }

      // Remove image
      if (imageName) {
        await execAsync(`docker rmi ${imageName}`, { timeout: 10000 }).catch(() => {})
      }

      // Remove temp directory
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    } catch (error) {
      // Ignore cleanup errors
      console.error('Cleanup error:', error)
    }
  }
}

