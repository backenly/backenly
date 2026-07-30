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
    // Read the CATALOG, which is what actually decides reachability.
    //
    // This read ApiDefinition until 2026-07-30. That table has no create path
    // since the PostgREST cutover, so on every project built after it the list
    // came back EMPTY — and this document is the first thing an agent fetches to
    // decide what it can call. The comment above warns that a confident wrong
    // answer is worse than no answer; "you have no resources" on a backend with
    // seven working tables is exactly that, reached from the other direction.
    //
    // Under PostgREST a table is reachable because it exists and the role holds
    // a grant, and the runtime registers the full verb set on /db/* (see
    // server/routes/dynamic.ts). So the methods are the standard CRUD set for
    // every exposed table rather than a per-row projection nothing maintains.
    const { listExposedTables } = await import('@/lib/mcp/schema-introspection')
    const exposed = await listExposedTables(projectId).catch(() => [] as Array<{ name: string }>)

    const resources = exposed
      .map(t => t.name)
      .sort((a, b) => a.localeCompare(b))
      .map(name => ({
        resource: name,
        url: `${baseUrl}/db/${name}`,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        // Every /db/* request is key- or JWT-authenticated; row visibility is
        // then decided by RLS rather than by a per-endpoint flag.
        authRequired: true,
      }))

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
      // ── Name the npm package, not just the CDN bundle ────────────────────
      //
      // This block advertised only the CDN URL and a bare `new BackenlyClient(…)`
      // with no import line. A CDN script cannot be bundled, server-rendered,
      // type-checked or lockfile-pinned, so an agent building a real app in a
      // real framework read this and hand-wrote its own client instead.
      // `@backenly/sdk` is the published package; the CDN build stays for
      // script-tag use.
      sdk: {
        npm: '@backenly/sdk',
        install: 'npm install @backenly/sdk',
        usage:
          `import { createClient } from "@backenly/sdk"\n` +
          `const backend = createClient({ projectId: "${project.id}", apiKey: "<your-api-key>" })`,
        supabaseCompat: '@backenly/sdk/supabase',
        cdn: 'https://backenly.com/backenly-sdk.esm.js',
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
