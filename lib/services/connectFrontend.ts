/**
 * CONNECT FRONTEND — canonical engine
 *
 * The ONE place that connects/disconnects a frontend to a deployed backend.
 * UI, chat, and REST API all funnel through `connectFrontend` /
 * `disconnectFrontend`. Anything that writes a CORS allowance and doesn't
 * call this file is a bug.
 *
 * Guarantees:
 *   1. Backend must be DEPLOYED before any origin can be connected.
 *   2. Origin is normalized to exact protocol+host+port — no wildcards,
 *      no trailing slashes, no path component.
 *   3. Confirmation gate on every write unless `force: true` is passed by
 *      the layer that already has user consent (chat replay, REST POST).
 *   4. Every connect/disconnect writes an AuditLog row.
 *   5. Each ConnectedApp row pins the DeploymentAudit graphVersion at
 *      connect time — so we know which version the frontend agreed to.
 *
 * State machine per (projectId, origin):
 *   NOT_CONNECTED  →  AWAITING_CONFIRMATION  →  CONNECTED  →  DISCONNECTED
 *                                                    ↑___________|
 *                                                    (reconnect)
 */

import { prisma } from '@/lib/db/prisma'

export interface ConnectFrontendOptions {
  projectId: string
  frontendUrl: string
  userId: string
  confirmedBy: 'CHAT' | 'UI' | 'API'
  force?: boolean
}

export interface ConnectFrontendResult {
  success: boolean
  message: string
  connected?: boolean
  requiresConfirmation?: boolean
  origin?: string
  backendVersion?: number
  errors?: string[]
}

export interface DisconnectFrontendOptions {
  projectId: string
  origin: string
  userId: string
  confirmedBy: 'CHAT' | 'UI' | 'API'
  force?: boolean
}

export interface DisconnectFrontendResult {
  success: boolean
  message: string
  disconnected?: boolean
  requiresConfirmation?: boolean
  errors?: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// URL normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize an arbitrary user-typed URL to an exact CORS origin string.
 * Examples:
 *   "app.acme.com"            → "https://app.acme.com"
 *   "app.acme.com/dashboard"  → "https://app.acme.com"
 *   "localhost:3000"          → "http://localhost:3000"
 *   "https://x.com/"          → "https://x.com"
 * Throws on anything `new URL(...)` can't parse.
 */
export function normalizeOrigin(raw: string): string {
  let v = raw.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(v)) {
    v = (v.includes('localhost') || v.startsWith('127.0.0.1') ? 'http://' : 'https://') + v
  }
  const parsed = new URL(v)
  return parsed.origin
}

// ─────────────────────────────────────────────────────────────────────────────
// Deployment gate
// ─────────────────────────────────────────────────────────────────────────────

async function getDeployedVersion(projectId: string): Promise<{ deployed: boolean; version?: number; reason?: string }> {
  // Source of truth must match what the deploy/publish flow actually writes.
  // lib/deployment/go-live.ts records a live backend as a Deployment row with
  // `environment: 'live'` + `status: 'live'` (and sets project.isDeployed /
  // projectStatus = 'LIVE'). The old query here looked for `status: 'DEPLOYED'`,
  // a string go-live NEVER writes — so every published backend was wrongly
  // reported as "not deployed" and frontend binding was permanently blocked.
  const latest = await prisma.deployment.findFirst({
    where: { projectId, environment: 'live', status: 'live' },
    orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    select: { version: true },
  })

  if (latest) {
    return { deployed: true, version: latest.version ?? 1 }
  }

  // Fallback: a project can be live via project-level flags even if a
  // Deployment row is missing (older projects, alternate go-live paths).
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { isDeployed: true, projectStatus: true },
  })
  if (project?.isDeployed || project?.projectStatus === 'LIVE') {
    return { deployed: true, version: 1 }
  }

  return {
    deployed: false,
    reason:
      "I can't connect a frontend yet because your backend hasn't been deployed.\n\nDeploy your backend first, then connect your app.",
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Connect
// ─────────────────────────────────────────────────────────────────────────────

export async function connectFrontend(options: ConnectFrontendOptions): Promise<ConnectFrontendResult> {
  const { projectId, frontendUrl, userId, confirmedBy, force = false } = options

  let origin: string
  try {
    origin = normalizeOrigin(frontendUrl)
  } catch {
    return {
      success: false,
      message: `That doesn't look like a valid URL: "${frontendUrl}"`,
      connected: false,
      errors: ['invalid URL'],
    }
  }

  const deploy = await getDeployedVersion(projectId)
  if (!deploy.deployed) {
    return { success: false, message: deploy.reason!, connected: false, errors: ['backend not deployed'] }
  }

  const existing = await prisma.connectedApp.findUnique({
    where: { projectId_origin: { projectId, origin } },
  })

  if (existing && existing.isActive) {
    return {
      success: true,
      message: `${origin} is already connected to this backend.`,
      connected: true,
      origin,
      backendVersion: existing.backendVersion,
    }
  }

  if (!force) {
    return {
      success: true,
      message:
        `You're about to connect this frontend:\n\n` +
        `• URL: ${origin}\n` +
        `• Backend version: v${deploy.version} (deployed)\n\n` +
        `Once connected, this app can call your backend APIs.\n\n` +
        `Type CONNECT to confirm.`,
      connected: false,
      requiresConfirmation: true,
      origin,
      backendVersion: deploy.version,
    }
  }

  const row = await prisma.connectedApp.upsert({
    where: { projectId_origin: { projectId, origin } },
    update: {
      isActive: true,
      connectedBy: confirmedBy,
      backendVersion: deploy.version!,
      connectedAt: new Date(),
      disconnectedAt: null,
    },
    create: {
      projectId,
      origin,
      isActive: true,
      connectedBy: confirmedBy,
      backendVersion: deploy.version!,
    },
  })

  await prisma.auditLog.create({
    data: {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      projectId,
      userId,
      action: 'CONNECT_FRONTEND',
      type: 'connected_app',
      details: JSON.stringify({
        origin,
        backendVersion: deploy.version,
        triggerSource: confirmedBy,
        resourceId: row.id,
        timestamp: new Date().toISOString(),
      }),
      timestamp: new Date(),
    },
  })

  // Flip the project-level flag so dashboards/onboarding know a frontend exists.
  await prisma.project.update({
    where: { id: projectId },
    data: { isFrontendConnected: true },
  })

  return {
    success: true,
    message: `Connected: ${origin}\n\nYour frontend can now call your backend APIs.`,
    connected: true,
    origin,
    backendVersion: deploy.version,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Disconnect
// ─────────────────────────────────────────────────────────────────────────────

export async function disconnectFrontend(options: DisconnectFrontendOptions): Promise<DisconnectFrontendResult> {
  const { projectId, origin: rawOrigin, userId, confirmedBy, force = false } = options

  let origin: string
  try {
    origin = normalizeOrigin(rawOrigin)
  } catch {
    return {
      success: false,
      message: `That doesn't look like a valid URL: "${rawOrigin}"`,
      disconnected: false,
      errors: ['invalid URL'],
    }
  }

  const existing = await prisma.connectedApp.findUnique({
    where: { projectId_origin: { projectId, origin } },
  })

  if (!existing || !existing.isActive) {
    return {
      success: false,
      message: `${origin} is not connected to this backend.`,
      disconnected: false,
      errors: ['not connected'],
    }
  }

  if (!force) {
    return {
      success: true,
      message:
        `You're about to disconnect:\n\n` +
        `• URL: ${origin}\n` +
        `• Backend version: v${existing.backendVersion}\n\n` +
        `This app will no longer be able to call your backend APIs.\n\n` +
        `Type DISCONNECT to confirm.`,
      disconnected: false,
      requiresConfirmation: true,
    }
  }

  await prisma.connectedApp.update({
    where: { projectId_origin: { projectId, origin } },
    data: { isActive: false, disconnectedAt: new Date() },
  })

  await prisma.auditLog.create({
    data: {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      projectId,
      userId,
      action: 'DISCONNECT_FRONTEND',
      type: 'connected_app',
      details: JSON.stringify({
        origin,
        backendVersion: existing.backendVersion,
        triggerSource: confirmedBy,
        resourceId: existing.id,
        timestamp: new Date().toISOString(),
      }),
      timestamp: new Date(),
    },
  })

  // If no active frontends remain, clear the project flag.
  const remaining = await prisma.connectedApp.count({
    where: { projectId, isActive: true },
  })
  if (remaining === 0) {
    await prisma.project.update({
      where: { id: projectId },
      data: { isFrontendConnected: false },
    })
  }

  return {
    success: true,
    message: `Disconnected: ${origin}\n\nThis app can no longer call your backend APIs.`,
    disconnected: true,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read paths
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full record (active + inactive) — for management UI/audit.
 */
export async function listConnectedApps(projectId: string) {
  return prisma.connectedApp.findMany({
    where: { projectId },
    orderBy: [{ isActive: 'desc' }, { connectedAt: 'desc' }],
  })
}

/**
 * Hot path — called by CORS middleware. Returns just the origin strings
 * for active connections. Keep this query as cheap as possible.
 */
export async function getActiveOrigins(projectId: string): Promise<string[]> {
  const rows = await prisma.connectedApp.findMany({
    where: { projectId, isActive: true },
    select: { origin: true },
  })
  return rows.map((r) => r.origin)
}
