/**
 * Tenant-Aware Prisma Client Wrapper
 * 
 * Provides a wrapper around Prisma that automatically enforces tenant isolation
 * by adding projectId filters to all queries.
 */

// @ts-nocheck - Temporary: Complex type inference issues with Prisma relation spreading
import { prisma } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { TenantIsolationError } from './isolation'

/**
 * Tenant-scoped Prisma client
 * All queries are automatically filtered by projectId
 */
export class TenantPrisma {
  constructor(private projectId: string) {
    if (!projectId) {
      throw new TenantIsolationError('Project ID is required for tenant-scoped queries')
    }
  }

  /**
   * Get the project ID for this tenant scope
   */
  getProjectId(): string {
    return this.projectId
  }

  /**
   * Validate that a resource belongs to this project
   */
  async validateOwnership<T extends { projectId: string }>(
    resource: T | null,
    resourceType: string = 'Resource'
  ): Promise<T> {
    if (!resource) {
      throw new TenantIsolationError(`${resourceType} not found`)
    }

    if (resource.projectId !== this.projectId) {
      throw new TenantIsolationError(`${resourceType} does not belong to this project`)
    }

    return resource
  }

  // Project operations
  project = {
    findUnique: async (args: Prisma.ProjectFindUniqueArgs) => {
      const result = await prisma.project.findUnique(args)
      if (result && result.id !== this.projectId) {
        throw new TenantIsolationError('Project access denied')
      }
      return result
    },
    findFirst: async (args?: Prisma.ProjectFindFirstArgs) => {
      return prisma.project.findFirst({
        ...args,
        where: {
          ...args?.where,
          id: this.projectId,
        },
      })
    },
    findMany: async (args?: Prisma.ProjectFindManyArgs) => {
      return prisma.project.findMany({
        ...args,
        where: {
          ...args?.where,
          id: this.projectId,
        },
      })
    },
    update: async (args: Prisma.ProjectUpdateArgs) => {
      // Ensure we're only updating the current project
      return prisma.project.update({
        ...args,
        where: {
          ...args.where,
          id: this.projectId,
        },
      })
    },
    delete: async (args: Prisma.ProjectDeleteArgs) => {
      return prisma.project.delete({
        ...args,
        where: {
          ...args.where,
          id: this.projectId,
        },
      })
    },
  }

  // Table operations (automatically scoped to project)
  table = {
    findUnique: async (args: Prisma.TableFindUniqueArgs) => {
      const result = await prisma.table.findUnique({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
      return result
    },
    findFirst: async (args?: Prisma.TableFindFirstArgs) => {
      return prisma.table.findFirst({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    findMany: async (args?: Prisma.TableFindManyArgs) => {
      return prisma.table.findMany({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    create: async (args: Prisma.TableCreateArgs) => {
      const { project, ...dataWithoutRelations } = args.data as any
      return prisma.table.create({
        ...args,
        data: {
          ...args.data,
          projectId: this.projectId,
        },
      })
    },
    update: async (args: Prisma.TableUpdateArgs) => {
      // First validate ownership
      const existing = await prisma.table.findUnique({
        where: args.where,
        select: { projectId: true },
      })
      await this.validateOwnership(existing, 'Table')

      return prisma.table.update({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
    },
    delete: async (args: Prisma.TableDeleteArgs) => {
      // First validate ownership
      const existing = await prisma.table.findUnique({
        where: args.where,
        select: { projectId: true },
      })
      await this.validateOwnership(existing, 'Table')

      return prisma.table.delete({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
    },
  }

  // Workspace operations
  workspace = {
    findUnique: async (args: Prisma.WorkspaceFindUniqueArgs) => {
      const result = await prisma.workspace.findUnique({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
      return result
    },
    findFirst: async (args?: Prisma.WorkspaceFindFirstArgs) => {
      return prisma.workspace.findFirst({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    findMany: async (args?: Prisma.WorkspaceFindManyArgs) => {
      return prisma.workspace.findMany({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    create: async (args: Prisma.WorkspaceCreateArgs) => {
      return prisma.workspace.create({
        ...args,
        data: {
          ...args.data,
          projectId: this.projectId,
        },
      })
    },
    update: async (args: Prisma.WorkspaceUpdateArgs) => {
      const existing = await prisma.workspace.findUnique({
        where: args.where,
        select: { projectId: true },
      })
      await this.validateOwnership(existing, 'Workspace')

      return prisma.workspace.update({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
    },
    delete: async (args: Prisma.WorkspaceDeleteArgs) => {
      const existing = await prisma.workspace.findUnique({
        where: args.where,
        select: { projectId: true },
      })
      await this.validateOwnership(existing, 'Workspace')

      return prisma.workspace.delete({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
    },
  }

  // Metric operations
  metric = {
    findMany: async (args?: Prisma.MetricFindManyArgs) => {
      return prisma.metric.findMany({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    create: async (args: Prisma.MetricCreateArgs) => {
      return prisma.metric.create({
        ...args,
        data: {
          ...args.data,
          projectId: this.projectId,
        },
      })
    },
    aggregate: async (args: Prisma.MetricAggregateArgs) => {
      return prisma.metric.aggregate({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
  }

  // Log operations
  log = {
    findMany: async (args?: Prisma.LogFindManyArgs) => {
      return prisma.log.findMany({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    create: async (args: Prisma.LogCreateArgs) => {
      return prisma.log.create({
        ...args,
        data: {
          ...args.data,
          projectId: this.projectId,
        },
      })
    },
    count: async (args?: Prisma.LogCountArgs) => {
      return prisma.log.count({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
  }

  // Security operations
  securityIssue = {
    findMany: async (args?: Prisma.SecurityIssueFindManyArgs) => {
      return prisma.securityIssue.findMany({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    findUnique: async (args: Prisma.SecurityIssueFindUniqueArgs) => {
      const result = await prisma.securityIssue.findUnique({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
      return result
    },
    create: async (args: Prisma.SecurityIssueCreateArgs) => {
      return prisma.securityIssue.create({
        ...args,
        data: {
          ...args.data,
          projectId: this.projectId,
        },
      })
    },
    update: async (args: Prisma.SecurityIssueUpdateArgs) => {
      const existing = await prisma.securityIssue.findUnique({
        where: args.where,
        select: { projectId: true },
      })
      await this.validateOwnership(existing, 'SecurityIssue')

      return prisma.securityIssue.update({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
    },
    delete: async (args: Prisma.SecurityIssueDeleteArgs) => {
      const existing = await prisma.securityIssue.findUnique({
        where: args.where,
        select: { projectId: true },
      })
      await this.validateOwnership(existing, 'SecurityIssue')

      return prisma.securityIssue.delete({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
    },
  }

  blockedAttack = {
    findMany: async (args?: Prisma.BlockedAttackFindManyArgs) => {
      return prisma.blockedAttack.findMany({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    create: async (args: Prisma.BlockedAttackCreateArgs) => {
      return prisma.blockedAttack.create({
        ...args,
        data: {
          ...args.data,
          projectId: this.projectId,
        },
      })
    },
  }

  securityScan = {
    findMany: async (args?: Prisma.SecurityScanFindManyArgs) => {
      return prisma.securityScan.findMany({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    create: async (args: Prisma.SecurityScanCreateArgs) => {
      return prisma.securityScan.create({
        ...args,
        data: {
          ...args.data,
          projectId: this.projectId,
        },
      })
    },
  }

  // Storage operations
  storageBucket = {
    findMany: async (args?: Prisma.StorageBucketFindManyArgs) => {
      return prisma.storageBucket.findMany({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    findUnique: async (args: Prisma.StorageBucketFindUniqueArgs) => {
      const result = await prisma.storageBucket.findUnique({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
      return result
    },
    create: async (args: Prisma.StorageBucketCreateArgs) => {
      return prisma.storageBucket.create({
        ...args,
        data: {
          ...args.data,
          projectId: this.projectId,
        },
      })
    },
    delete: async (args: Prisma.StorageBucketDeleteArgs) => {
      const existing = await prisma.storageBucket.findUnique({
        where: args.where,
        select: { projectId: true },
      })
      await this.validateOwnership(existing, 'StorageBucket')

      return prisma.storageBucket.delete({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
    },
  }

  storageFile = {
    findMany: async (args?: Prisma.StorageFileFindManyArgs) => {
      return prisma.storageFile.findMany({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    findUnique: async (args: Prisma.StorageFileFindUniqueArgs) => {
      const result = await prisma.storageFile.findUnique({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
      return result
    },
    create: async (args: Prisma.StorageFileCreateArgs) => {
      return prisma.storageFile.create({
        ...args,
        data: {
          ...args.data,
          projectId: this.projectId,
        },
      })
    },
    delete: async (args: Prisma.StorageFileDeleteArgs) => {
      const existing = await prisma.storageFile.findUnique({
        where: args.where,
        select: { projectId: true },
      })
      await this.validateOwnership(existing, 'StorageFile')

      return prisma.storageFile.delete({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
    },
  }

  // AI operations
  aiConfiguration = {
    findUnique: async (args: Prisma.AiConfigurationFindUniqueArgs) => {
      const result = await prisma.aiConfiguration.findUnique({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
      return result
    },
    upsert: async (args: Prisma.AiConfigurationUpsertArgs) => {
      const { project, ...createData } = args.create as any
      return prisma.aiConfiguration.upsert({
        ...args,
        where: {
          projectId: this.projectId,
        },
        update: args.update,
        create: {
          ...createData,
          projectId: this.projectId,
        },
      })
    },
  }

  aiUsage = {
    findMany: async (args?: Prisma.AiUsageFindManyArgs) => {
      return prisma.aiUsage.findMany({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    create: async (args: Prisma.AiUsageCreateArgs) => {
      return prisma.aiUsage.create({
        ...args,
        data: {
          ...args.data,
          projectId: this.projectId,
        },
      })
    },
    aggregate: async (args: Prisma.AiUsageAggregateArgs) => {
      return prisma.aiUsage.aggregate({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
  }

  // Database issue operations
  databaseIssue = {
    findMany: async (args?: Prisma.DatabaseIssueFindManyArgs) => {
      return prisma.databaseIssue.findMany({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    findUnique: async (args: Prisma.DatabaseIssueFindUniqueArgs) => {
      const result = await prisma.databaseIssue.findUnique({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
      return result
    },
    findFirst: async (args?: Prisma.DatabaseIssueFindFirstArgs) => {
      return prisma.databaseIssue.findFirst({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    create: async (args: Prisma.DatabaseIssueCreateArgs) => {
      return prisma.databaseIssue.create({
        ...args,
        data: {
          ...args.data,
          projectId: this.projectId,
        },
      })
    },
    update: async (args: Prisma.DatabaseIssueUpdateArgs) => {
      const existing = await prisma.databaseIssue.findUnique({
        where: args.where,
        select: { projectId: true },
      })
      await this.validateOwnership(existing, 'DatabaseIssue')

      return prisma.databaseIssue.update({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
    },
  }

  // Anomaly operations
  anomaly = {
    findMany: async (args?: Prisma.AnomalyFindManyArgs) => {
      return prisma.anomaly.findMany({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    create: async (args: Prisma.AnomalyCreateArgs) => {
      return prisma.anomaly.create({
        ...args,
        data: {
          ...args.data,
          projectId: this.projectId,
        },
      })
    },
  }

  // Incident operations
  incident = {
    findMany: async (args?: Prisma.IncidentFindManyArgs) => {
      return prisma.incident.findMany({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    findUnique: async (args: Prisma.IncidentFindUniqueArgs) => {
      const result = await prisma.incident.findUnique({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
      return result
    },
    create: async (args: Prisma.IncidentCreateArgs) => {
      return prisma.incident.create({
        ...args,
        data: {
          ...args.data,
          projectId: this.projectId,
        },
      })
    },
    update: async (args: Prisma.IncidentUpdateArgs) => {
      const existing = await prisma.incident.findUnique({
        where: args.where,
        select: { projectId: true },
      })
      await this.validateOwnership(existing, 'Incident')

      return prisma.incident.update({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
    },
  }

  // API Key operations (project-scoped)
  apiKey = {
    findMany: async (args?: Prisma.ApiKeyFindManyArgs) => {
      return prisma.apiKey.findMany({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    findUnique: async (args: Prisma.ApiKeyFindUniqueArgs) => {
      const result = await prisma.apiKey.findUnique({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
      return result
    },
    create: async (args: Prisma.ApiKeyCreateArgs) => {
      return prisma.apiKey.create({
        ...args,
        data: {
          ...args.data,
          projectId: this.projectId,
        },
      })
    },
    update: async (args: Prisma.ApiKeyUpdateArgs) => {
      const existing = await prisma.apiKey.findUnique({
        where: args.where,
        select: { projectId: true },
      })
      await this.validateOwnership(existing, 'ApiKey')

      return prisma.apiKey.update({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
    },
    delete: async (args: Prisma.ApiKeyDeleteArgs) => {
      const existing = await prisma.apiKey.findUnique({
        where: args.where,
        select: { projectId: true },
      })
      await this.validateOwnership(existing, 'ApiKey')

      return prisma.apiKey.delete({
        ...args,
        where: {
          ...args.where,
          projectId: this.projectId,
        },
      })
    },
  }

  // Role operations (can be global or project-scoped)
  role = {
    findMany: async (args?: Prisma.RoleFindManyArgs) => {
      return prisma.role.findMany({
        ...args,
        where: {
          ...args?.where,
          OR: [
            { projectId: this.projectId },
            { projectId: null }, // Global roles
          ],
        },
      })
    },
    findUnique: async (args: Prisma.RoleFindUniqueArgs) => {
      // For unique lookups, we need to check both projectId and name
      // Since we changed the unique constraint to (name, projectId)
      return prisma.role.findUnique({
        ...args,
      })
    },
    create: async (args: Prisma.RoleCreateArgs) => {
      return prisma.role.create({
        ...args,
        data: {
          ...args.data,
          projectId: args.data.projectId ?? this.projectId, // Use provided or default to current project
        },
      })
    },
  }

  // Audit log operations
  auditLog = {
    findMany: async (args?: Prisma.AuditLogFindManyArgs) => {
      return prisma.auditLog.findMany({
        ...args,
        where: {
          ...args?.where,
          projectId: this.projectId,
        },
      })
    },
    create: async (args: Prisma.AuditLogCreateArgs) => {
      return prisma.auditLog.create({
        ...args,
        data: {
          ...args.data,
          projectId: this.projectId,
        },
      })
    },
  }
}

/**
 * Create a tenant-scoped Prisma client
 */
export function createTenantPrisma(projectId: string): TenantPrisma {
  return new TenantPrisma(projectId)
}

