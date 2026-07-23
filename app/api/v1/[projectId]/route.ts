import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'

/**
 * Base project API info endpoint.
 * Returns a friendly JSON description of the project's API instead of a 500.
 *
 * Example: GET https://backenly.com/api/v1/{projectId}
 */
export async function GET(
  _request: NextRequest,
  context: { params: { projectId: string } }
) {
  const { projectId } = context.params

  if (!projectId) {
    return NextResponse.json(
      { error: 'Project ID is required', code: 'MISSING_PROJECT_ID' },
      { status: 400 }
    )
  }

  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        isDeployed: true,
        publicEnabled: true,
        projectStatus: true,
        environment: true,
        expiresAt: true,
        publicUrl: true,
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found', code: 'PROJECT_NOT_FOUND' },
        { status: 404 }
      )
    }

    const isLive = project.isDeployed && project.publicEnabled && project.projectStatus === 'LIVE'
    const baseUrl = project.publicUrl || `https://backenly.com/api/v1/${projectId}`

    // Resources come from the live ApiDefinition catalogue, not from a fixed
    // list. The previous version advertised cart, checkout and stats endpoints
    // to EVERY project, whether or not those tables existed — so a project with
    // no cart was told it had one. For an agent reading this document to decide
    // what to call, a confident wrong answer is worse than no answer: it turns a
    // missing feature into a 404 the agent has to reverse-engineer.
    const apis = await prisma.apiDefinition.findMany({
      where: { projectId, enabled: true },
      select: { name: true, operations: true, authRequired: true },
      orderBy: { name: 'asc' },
    })

    const resources = apis.map(api => {
      const ops: string[] = Array.isArray(api.operations)
        ? (api.operations as unknown[])
            .map(o => (typeof o === 'string' ? o : ((o as Record<string, unknown>)?.method as string) ?? ''))
            .filter(Boolean)
        : api.operations && typeof api.operations === 'object'
          ? Object.keys(api.operations as Record<string, unknown>)
          : []
      return {
        resource: api.name,
        url: `${baseUrl}/db/${api.name}`,
        methods: ops.map(o => o.toUpperCase()),
        authRequired: api.authRequired,
      }
    })

    return NextResponse.json({
      // projectId was absent, which made the document unusable as the single
      // thing an agent fetches first — it could not construct a client from it.
      projectId: project.id,
      project: project.name,
      status: isLive ? 'live' : 'inactive',
      environment: project.environment ?? 'production',
      baseUrl,
      // How to authenticate was not stated anywhere. Every resource below
      // requires a key, so omitting this guaranteed a first 401.
      authentication: {
        scheme: 'apiKey',
        header: 'x-api-key',
        alternativeScheme: 'bearer',
        alternativeHeader: 'Authorization: Bearer <token>',
        note: 'All data routes require authentication. Create a key in the dashboard under Connect.',
      },
      sdk: {
        javascript: 'https://backenly.com/backenly-sdk.js',
        usage: `const backend = new BackenlyClient({ projectId: "${project.id}", apiKey: "<your-api-key>" })`,
      },
      endpoints: {
        auth: {
          signUp: `POST ${baseUrl}/auth/signup`,
          signIn: `POST ${baseUrl}/auth/signin`,
        },
        // Only what this project actually exposes.
        database: resources.length > 0 ? resources : `No REST resources generated yet. POST ${baseUrl}/db/{table} once a table exists.`,
        storage: {
          upload: `POST ${baseUrl}/storage/upload`,
          files:  `GET  ${baseUrl}/storage/files`,
        },
        realtime: `GET ${baseUrl}/realtime  (SSE)`,
        health:   `GET ${baseUrl}/healthz   (no auth required)`,
      },
      docs: 'https://backenly.com/docs',
    })
  } catch (error: any) {
    console.error('[/api/v1/:projectId] Error:', error?.message || error)
    return NextResponse.json(
      { error: 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 }
    )
  }
}
