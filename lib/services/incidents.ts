/**
 * Incident Management Service
 */

import { prisma } from '@/lib/db/postgres'

export interface CreateIncidentData {
  title: string
  description: string
  severity: 'critical' | 'warning' | 'info'
  affectedServices: string[]
  projectId?: string
  metadata?: Record<string, any>
}

export interface UpdateIncidentData {
  title?: string
  description?: string
  severity?: 'critical' | 'warning' | 'info'
  status?: 'active' | 'resolved' | 'acknowledged'
  affectedServices?: string[]
  metadata?: Record<string, any>
}

/**
 * Create a new incident
 */
export async function createIncident(data: CreateIncidentData): Promise<string> {
  const incident = await prisma.incident.create({
    data: {
      title: data.title,
      description: data.description,
      severity: data.severity,
      affectedServices: data.affectedServices,
      projectId: data.projectId,
      metadata: data.metadata || {},
    },
  })

  return incident.id
}

/**
 * Get active incidents
 */
export async function getActiveIncidents(projectId?: string) {
  const where: any = {
    status: 'active',
  }

  if (projectId) where.projectId = projectId

  return await prisma.incident.findMany({
    where,
    orderBy: [
      { severity: 'asc' }, // critical first
      { startedAt: 'desc' },
    ],
    include: {
      project: {
        select: {
          id: true,
          name: true,
        },
      },
      acknowledgedByUser: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
  })
}

/**
 * Get all incidents (with optional filters)
 */
export async function getIncidents(
  projectId?: string,
  status?: 'active' | 'resolved' | 'acknowledged',
  severity?: 'critical' | 'warning' | 'info',
  limit: number = 50
) {
  const where: any = {}

  if (projectId) where.projectId = projectId
  if (status) where.status = status
  if (severity) where.severity = severity

  return await prisma.incident.findMany({
    where,
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: {
      project: {
        select: {
          id: true,
          name: true,
        },
      },
      acknowledgedByUser: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
  })
}

/**
 * Get a single incident
 */
export async function getIncident(incidentId: string) {
  return await prisma.incident.findUnique({
    where: { id: incidentId },
    include: {
      project: {
        select: {
          id: true,
          name: true,
        },
      },
      acknowledgedByUser: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
  })
}

/**
 * Update an incident
 */
export async function updateIncident(
  incidentId: string,
  data: UpdateIncidentData
): Promise<void> {
  const updateData: any = {}

  if (data.title !== undefined) updateData.title = data.title
  if (data.description !== undefined) updateData.description = data.description
  if (data.severity !== undefined) updateData.severity = data.severity
  if (data.status !== undefined) {
    updateData.status = data.status
    if (data.status === 'resolved') {
      updateData.resolvedAt = new Date()
    }
  }
  if (data.affectedServices !== undefined) updateData.affectedServices = data.affectedServices
  if (data.metadata !== undefined) updateData.metadata = data.metadata

  await prisma.incident.update({
    where: { id: incidentId },
    data: updateData,
  })
}

/**
 * Acknowledge an incident
 */
export async function acknowledgeIncident(
  incidentId: string,
  userId: string
): Promise<void> {
  await prisma.incident.update({
    where: { id: incidentId },
    data: {
      status: 'acknowledged',
      acknowledgedAt: new Date(),
      acknowledgedBy: userId,
    },
  })
}

/**
 * Resolve an incident
 */
export async function resolveIncident(incidentId: string): Promise<void> {
  await prisma.incident.update({
    where: { id: incidentId },
    data: {
      status: 'resolved',
      resolvedAt: new Date(),
    },
  })
}

