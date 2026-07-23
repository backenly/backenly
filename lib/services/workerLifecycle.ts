/**
 * Worker Lifecycle Management Service
 * 
 * Manages isolated worker containers for each project.
 * Each project gets its own Docker container with:
 * - Isolated Node.js process
 * - Resource limits (CPU, memory)
 * - Dedicated port
 * - Project-specific environment variables
 * 
 * This solves BLOCKER #2: Runtime Isolation
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { prisma } from '@/lib/db/postgres';
import path from 'path';
import fs from 'fs/promises';

const execAsync = promisify(exec);

export interface WorkerConfig {
  projectId: string;
  port: number;
  cpuLimit?: string; // e.g., "0.5" for 50% of one CPU
  memoryLimit?: string; // e.g., "512m" for 512 MB
  timeout?: number; // Request timeout in ms
  workspaceRoot: string;
}

export interface WorkerStatus {
  running: boolean;
  containerId?: string;
  port?: number;
  uptime?: number;
  memoryUsage?: number;
  cpuUsage?: number;
}

export class WorkerLifecycleService {
  private static readonly CONTAINER_PREFIX = 'backenly-worker';
  private static readonly DEFAULT_CPU_LIMIT = '0.5'; // 50% of one CPU
  private static readonly DEFAULT_MEMORY_LIMIT = '512m'; // 512 MB
  private static readonly DEFAULT_TIMEOUT = 30000; // 30 seconds
  private static readonly PORT_RANGE_START = 6000;
  private static readonly PORT_RANGE_END = 7000;

  /**
   * Start a dedicated worker container for a project
   * PHASE 10: Enhanced with comprehensive logging and failure isolation
   */
  static async startWorker(config: WorkerConfig): Promise<string> {
    const {
      projectId,
      port,
      cpuLimit = this.DEFAULT_CPU_LIMIT,
      memoryLimit = this.DEFAULT_MEMORY_LIMIT,
      timeout = this.DEFAULT_TIMEOUT,
      workspaceRoot,
    } = config;

    const containerName = `${this.CONTAINER_PREFIX}-${projectId}`;

    try {
      console.log(`[WorkerLifecycle] 🚀 Starting worker for project ${projectId}`)
      console.log(`[WorkerLifecycle]   Port: ${port}`)
      console.log(`[WorkerLifecycle]   CPU Limit: ${cpuLimit}`)
      console.log(`[WorkerLifecycle]   Memory Limit: ${memoryLimit}`)
      
      // Check if container already exists
      const existing = await this.getContainerStatus(containerName);
      if (existing.running) {
        console.log(`[WorkerLifecycle] ✅ Container ${containerName} already running`);
        return existing.containerId!;
      }

      // Remove old container if it exists but is stopped
      if (existing.containerId) {
        console.log(`[WorkerLifecycle] 🗑️ Removing stopped container ${containerName}`)
        await this.removeContainer(containerName);
      }

      // PHASE 10: ENVIRONMENT PREP - Get workspace schema
      console.log(`[WorkerLifecycle] 🔍 Looking up workspace schema...`)
      
      const workspace = await prisma.workspace.findFirst({
        where: { projectId },
        select: { postgresSchema: true }
      });

      if (!workspace?.postgresSchema) {
        console.error(`[WorkerLifecycle] ❌ Workspace schema not found for project ${projectId}`)
        throw new Error(`Workspace schema not found for project ${projectId}`);
      }

      const workspaceSchema = workspace.postgresSchema;
      console.log(`[WorkerLifecycle] ✅ Workspace schema: ${workspaceSchema}`);

      // PHASE 10: FILE SYSTEM PREP - Ensure workspace directory exists
      const workspaceAbsPath = path.resolve(workspaceRoot, projectId);
      console.log(`[WorkerLifecycle] 📁 Creating workspace directory: ${workspaceAbsPath}`)
      
      try {
        await fs.mkdir(workspaceAbsPath, { recursive: true });
        console.log(`[WorkerLifecycle] ✅ Workspace directory ready`)
      } catch (fsError: any) {
        console.error(`[WorkerLifecycle] ❌ Failed to create workspace directory:`, fsError.message)
        throw new Error(`File system error: ${fsError.message}`)
      }

      // PHASE 10: DATABASE CONNECTION PREP - Verify database URL
      if (!process.env.DATABASE_URL) {
        console.error(`[WorkerLifecycle] ❌ DATABASE_URL environment variable not set`)
        throw new Error('DATABASE_URL environment variable is required')
      }
      console.log(`[WorkerLifecycle] ✅ Database URL configured`)

      // Escape DATABASE_URL for shell execution (Windows-safe)
      const escapedDbUrl = process.env.DATABASE_URL.replace(/"/g, '\\"');

      // PHASE 10: CONTAINER SPIN - Build Docker command
      console.log(`[WorkerLifecycle] 🐳 Building Docker command...`)
      
      const dockerCommand = [
        'docker run -d',
        `--name ${containerName}`,
        `--cpus=${cpuLimit}`,
        `--memory=${memoryLimit}`,
        `--memory-swap=${memoryLimit}`, // Disable swap
        `--restart=unless-stopped`,
        `-p ${port}:5173`, // Map host port to container's 5173
        `-v "${workspaceAbsPath}:/workspace/${projectId}:ro"`, // Mount at /workspace/{projectId} for worker discovery
        `-e NODE_ENV=production`,
        `-e WORKER_PORT=5173`,
        `-e WORKER_MODE=db`,
        `-e WORKSPACE_ROOT=/workspace`,
        `-e PROJECT_ID=${projectId}`,
        `-e WORKSPACE_SCHEMA=${workspaceSchema}`, // 🔒 WORKSPACE ISOLATION
        `-e REQUEST_TIMEOUT=${timeout}`,
        `-e "DATABASE_URL=${escapedDbUrl}"`,
        `--label backenly.project=${projectId}`,
        `--label backenly.type=worker`,
        '--health-cmd="wget --no-verbose --tries=1 --spider http://localhost:5173/health || exit 1"',
        '--health-interval=30s',
        '--health-timeout=10s',
        '--health-retries=3',
        'backenly-worker:latest', // Pre-built image
      ].join(' ');

      console.log(`[WorkerLifecycle] 🔧 Docker command built (${dockerCommand.length} chars)`)
      console.log(`[WorkerLifecycle] 🚀 Executing docker run...`)

      let containerId: string
      try {
        const { stdout } = await execAsync(dockerCommand);
        containerId = stdout.trim();
        console.log(`[WorkerLifecycle] ✅ Container created: ${containerId.substring(0, 12)}`)
      } catch (dockerError: any) {
        console.error(`[WorkerLifecycle] ❌ Docker command failed:`, dockerError.message)
        console.error(`[WorkerLifecycle] Docker stderr:`, dockerError.stderr || 'No stderr')
        
        // PHASE 10: FAILURE ISOLATION - Categorize Docker failures
        if (dockerError.message.includes('port is already allocated')) {
          throw new Error(`Port ${port} is already in use. All available ports are currently allocated.`)
        }
        if (dockerError.message.includes('No such image')) {
          throw new Error('Docker image "backenly-worker:latest" not found. Please rebuild the worker image.')
        }
        if (dockerError.message.includes('Cannot connect to the Docker daemon')) {
          throw new Error('Docker daemon is not running. Please start Docker and try again.')
        }
        if (dockerError.message.includes('permission denied')) {
          throw new Error('Docker permission denied. Please ensure your user has Docker access.')
        }
        
        throw new Error(`Docker execution failed: ${dockerError.message}`)
      }

      // PHASE 10: DATABASE RECORD UPDATE
      console.log(`[WorkerLifecycle] 💾 Updating project database record...`)
      
      try {
        await prisma.project.update({
          where: { id: projectId },
          data: {
            workerContainerId: containerId,
            workerPort: port,
          },
        });
        console.log(`[WorkerLifecycle] ✅ Database record updated`)
      } catch (error: any) {
        if (error.code === 'P2025') {
          // Project doesn't exist - this is OK for standalone testing
          console.warn(`[WorkerLifecycle] ⚠️ Project ${projectId} not found in database (OK for testing)`);
        } else {
          console.error(`[WorkerLifecycle] ❌ Failed to update database:`, error.message)
          // Don't throw - container is running, this is non-critical
        }
      }

      console.log(`[WorkerLifecycle] ✅ Worker started successfully: ${containerId.substring(0, 12)}`);
      return containerId;
      
    } catch (error: any) {
      console.error(`[WorkerLifecycle] ❌ FATAL: Failed to start worker for ${projectId}`);
      console.error(`[WorkerLifecycle] Error details:`, {
        message: error.message,
        stack: error.stack?.split('\n').slice(0, 3).join('\n')
      });
      
      // Re-throw with enhanced error message
      throw new Error(`Failed to start worker: ${error.message}`);
    }
  }

  /**
   * Stop a worker container
   */
  static async stopWorker(projectId: string): Promise<void> {
    const containerName = `${this.CONTAINER_PREFIX}-${projectId}`;

    try {
      const status = await this.getContainerStatus(containerName);
      if (!status.running) {
        console.log(`[WorkerLifecycle] Worker ${containerName} is not running`);
        return;
      }

      console.log(`[WorkerLifecycle] Stopping worker ${containerName}`);
      await execAsync(`docker stop ${containerName}`);

      // Update project record
      await prisma.project.update({
        where: { id: projectId },
        data: {
          workerContainerId: null,
          workerPort: null,
        },
      });

      console.log(`[WorkerLifecycle] Worker stopped successfully`);
    } catch (error: any) {
      console.error(`[WorkerLifecycle] Failed to stop worker:`, error.message);
      throw new Error(`Failed to stop worker: ${error.message}`);
    }
  }

  /**
   * Restart a worker container (stop + start)
   */
  static async restartWorker(projectId: string, config?: Partial<WorkerConfig>): Promise<string> {
    await this.stopWorker(projectId);
    await this.removeContainer(`${this.CONTAINER_PREFIX}-${projectId}`);
    
    // Get existing config from database
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { workerPort: true },
    });

    const port = config?.port || project?.workerPort || await this.allocatePort();
    const workspaceRoot = config?.workspaceRoot || path.resolve(process.cwd(), 'workspace');

    return await this.startWorker({
      projectId,
      port,
      workspaceRoot,
      ...config,
    });
  }

  /**
   * Remove a container (stopped or running)
   */
  private static async removeContainer(containerName: string): Promise<void> {
    try {
      await execAsync(`docker rm -f ${containerName}`);
    } catch {
      // Ignore errors if container doesn't exist
    }
  }

  /**
   * Get status of a worker container
   */
  static async getContainerStatus(containerNameOrId: string): Promise<WorkerStatus> {
    try {
      const { stdout } = await execAsync(
        `docker inspect --format='{{.State.Running}},{{.Id}},{{.State.StartedAt}}' ${containerNameOrId}`
      );

      const [running, containerId, startedAt] = stdout.trim().split(',');
      
      if (running === 'true') {
        const uptime = Date.now() - new Date(startedAt).getTime();
        
        // Get resource usage
        let memoryUsage = 0;
        let cpuUsage = 0;
        
        try {
          const { stdout: statsOut } = await execAsync(
            `docker stats ${containerNameOrId} --no-stream --format "{{.MemUsage}},{{.CPUPerc}}"`
          );
          const [memStr, cpuStr] = statsOut.trim().split(',');
          memoryUsage = parseFloat(memStr.replace(/[^0-9.]/g, ''));
          cpuUsage = parseFloat(cpuStr.replace(/[^0-9.]/g, ''));
        } catch {
          // Ignore stats errors
        }

        return {
          running: true,
          containerId,
          uptime,
          memoryUsage,
          cpuUsage,
        };
      }

      return { running: false, containerId };
    } catch {
      return { running: false };
    }
  }

  /**
   * Get worker status by project ID
   */
  static async getWorkerStatus(projectId: string): Promise<WorkerStatus> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { workerContainerId: true, workerPort: true },
    });

    if (!project?.workerContainerId) {
      return { running: false };
    }

    const status = await this.getContainerStatus(project.workerContainerId);
    return { ...status, port: project.workerPort || undefined };
  }

  /**
   * Allocate a free port for a new worker
   */
  static async allocatePort(): Promise<number> {
    // Get all ports currently in use
    const projects = await prisma.project.findMany({
      where: {
        workerPort: { not: null },
      },
      select: { workerPort: true },
    });

    const usedPorts = new Set(projects.map(p => p.workerPort).filter(Boolean) as number[]);

    // Find first available port in range
    for (let port = this.PORT_RANGE_START; port <= this.PORT_RANGE_END; port++) {
      if (!usedPorts.has(port)) {
        return port;
      }
    }

    throw new Error('No available ports in range');
  }

  /**
   * Build the worker image (run once at deployment)
   */
  static async buildWorkerImage(): Promise<void> {
    console.log('[WorkerLifecycle] Building worker Docker image...');
    
    const buildCommand = 'docker build -f docker/worker-template.Dockerfile -t backenly-worker:latest .';
    
    try {
      await execAsync(buildCommand, { cwd: process.cwd() });
      console.log('[WorkerLifecycle] Worker image built successfully');
    } catch (error: any) {
      console.error('[WorkerLifecycle] Failed to build worker image:', error.message);
      throw error;
    }
  }

  /**
   * List all running worker containers
   */
  static async listWorkers(): Promise<Array<{ projectId: string; containerId: string; port: number; status: WorkerStatus }>> {
    try {
      const { stdout } = await execAsync(
        `docker ps --filter "label=backenly.type=worker" --format "{{.Label \"backenly.project\"}},{{.ID}},{{.Names}}"`
      );

      if (!stdout.trim()) {
        return [];
      }

      const lines = stdout.trim().split('\n');
      const workers = await Promise.all(
        lines.map(async (line) => {
          const [projectId, containerId, containerName] = line.split(',');
          const status = await this.getContainerStatus(containerId);
          
          // Get port from database
          const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { workerPort: true },
          });

          return {
            projectId,
            containerId,
            port: project?.workerPort || 0,
            status,
          };
        })
      );

      return workers;
    } catch {
      return [];
    }
  }

  /**
   * Clean up orphaned containers (containers without DB records)
   */
  static async cleanupOrphanedContainers(): Promise<number> {
    const workers = await this.listWorkers();
    let cleaned = 0;

    for (const worker of workers) {
      const project = await prisma.project.findUnique({
        where: { id: worker.projectId },
      });

      if (!project) {
        console.log(`[WorkerLifecycle] Cleaning up orphaned container for deleted project ${worker.projectId}`);
        await this.removeContainer(worker.containerId);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Get worker URL for a project
   */
  static async getWorkerUrl(projectId: string): Promise<string> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { workerPort: true, workerContainerId: true },
    });

    if (!project?.workerPort || !project.workerContainerId) {
      throw new Error('Worker not running for this project');
    }

    // In production, use the container name for internal networking
    // In development, use localhost
    const host = process.env.NODE_ENV === 'production'
      ? `${this.CONTAINER_PREFIX}-${projectId}`
      : 'localhost';

    return `http://${host}:${project.workerPort}`;
  }
}
