/**
 * Which project, and which credential, an MCP caller is acting as.
 *
 * Every key and OAuth connection is bound to exactly one project; that is what
 * keeps a leaked credential's reach to one project. It also means an agent
 * working across several projects can be connected to a different one than it
 * thinks, and nothing told it which before it changed something. This does,
 * from the database rather than from anything the caller claims.
 *
 * Creating a project or reaching another one needs account authority, which
 * no project credential carries, on purpose. Switching is re-pointing the
 * connection (`npx @backenly/cli link --project <id> --key <key>`, or Connect
 * in the dashboard), not a tool call.
 */

import { prisma } from '@/lib/db/prisma'

export interface IdentityResult {
  ok: boolean
  summary: string
  data?: unknown
  code?: string
}

export async function connectionIdentity(ctx: {
  projectId: string
  apiKeyId?: string
  keyReadOnly?: boolean
}): Promise<IdentityResult> {
  const project = await prisma.project.findUnique({
    where: { id: ctx.projectId },
    select: { id: true, name: true, slug: true, environment: true, deployedAt: true, pausedAt: true },
  })
  if (!project) return { ok: false, code: 'PROJECT_NOT_FOUND', summary: 'The project this connection names no longer exists.' }

  const key = ctx.apiKeyId
    ? await prisma.apiKey.findFirst({
        where: { id: ctx.apiKeyId, projectId: ctx.projectId },
        select: {
          id: true, name: true, keyPrefix: true, scope: true, mcpReadOnly: true,
          expiresAt: true, lastUsed: true, createdAt: true,
          branch: { select: { id: true, name: true } },
        },
      })
    : null

  // What the caller may do, as the guard decided it: an OAuth token granted
  // only mcp:read is read-only even when its connection row is not.
  const readOnly = ctx.keyReadOnly ?? key?.mcpReadOnly ?? null

  const data = {
    project: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      environment: project.environment,
      published: project.deployedAt !== null,
      paused: project.pausedAt !== null,
    },
    connection: key
      ? {
          id: key.id,
          name: key.name,
          prefix: key.keyPrefix,
          scope: key.scope,
          readOnly,
          branch: key.branch,
          createdAt: key.createdAt,
          lastUsed: key.lastUsed,
          expiresAt: key.expiresAt,
        }
      : null,
  }

  const access = readOnly === null ? 'with access this call could not determine' : readOnly ? 'read-only' : 'read-write'
  return {
    ok: true,
    summary:
      `Connected to project "${project.name}" (${project.id})` +
      (key ? ` through "${key.name}" (${key.keyPrefix}…), ${access}` : '') +
      (key?.branch ? `, bound to preview branch "${key.branch.name}"` : '') +
      `. Every change made through this connection lands in this project${key?.branch ? '’s branch' : ''}. ` +
      'To work on a different project, re-point the connection: npx @backenly/cli link --project <id> --key <key>, ' +
      'or run Connect for that project in the dashboard. Creating a project is done in the dashboard.',
    data,
  }
}
