export const dynamic = 'force-dynamic'

/**
 * REST surface for per-project encrypted env vars.
 *
 *   GET    /api/projects/:id/env-vars               → list (keys + 4-char previews)
 *   POST   /api/projects/:id/env-vars               → set / update
 *   DELETE /api/projects/:id/env-vars?key=...       → delete
 *
 * Plaintext values NEVER leave the server. All writes funnel through
 * lib/services/projectEnvVars.ts so encryption + audit logging cannot be
 * bypassed.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/auth/route-protection'
import {
  setEnvVar,
  deleteEnvVar,
  listEnvVars,
  EnvVarValidationError,
} from '@/lib/services/projectEnvVars'
import { canAccessProject, canAdministerProject, canWriteProject } from '@/lib/edition/guard'

function extractProjectId(request: NextRequest): string | null {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean)
  const i = parts.indexOf('projects')
  return i >= 0 && parts[i + 1] ? parts[i + 1] : null
}


const setSchema = z.object({
  key: z.string().min(1).max(64),
  value: z.string().min(1).max(8192),
  description: z.string().max(280).optional().nullable(),
})

export const GET = withAuth(async (request, { user }) => {
  const projectId = extractProjectId(request)
  if (!projectId) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 })
  }
  if (!(await canAccessProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
  }

  const vars = await listEnvVars(projectId)
  return NextResponse.json({ success: true, vars })
})

export const POST = withAuth(async (request, { user }) => {
  const projectId = extractProjectId(request)
  if (!projectId) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 })
  }
  if (!(await canWriteProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
  }

  let body: z.infer<typeof setSchema>
  try {
    body = setSchema.parse(await request.json())
  } catch (err: any) {
    return NextResponse.json({ error: 'Invalid request', details: err?.errors }, { status: 400 })
  }

  try {
    const summary = await setEnvVar({
      projectId,
      key: body.key,
      value: body.value,
      userId: user.userId,
      description: body.description ?? undefined,
    })
    return NextResponse.json({ success: true, envVar: summary })
  } catch (err: any) {
    if (err instanceof EnvVarValidationError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 })
    }
    console.error('[env-vars] set error:', err)
    return NextResponse.json({ success: false, error: 'Failed to save env var' }, { status: 500 })
  }
})

export const DELETE = withAuth(async (request, { user }) => {
  const projectId = extractProjectId(request)
  if (!projectId) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 })
  }
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
  }

  const key = new URL(request.url).searchParams.get('key')
  if (!key) {
    return NextResponse.json({ error: 'key query param required' }, { status: 400 })
  }

  try {
    const deleted = await deleteEnvVar(projectId, key, user.userId)
    if (!deleted) {
      return NextResponse.json({ success: false, error: `No env var named "${key}"` }, { status: 404 })
    }
    return NextResponse.json({ success: true })
  } catch (err: any) {
    if (err instanceof EnvVarValidationError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 })
    }
    console.error('[env-vars] delete error:', err)
    return NextResponse.json({ success: false, error: 'Failed to delete env var' }, { status: 500 })
  }
})
