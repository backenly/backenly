/**
 * GET /api/projects/:id/types
 * Generate and return TypeScript type definitions for a project's workspace schema.
 *
 * Returns a zip-like JSON payload with:
 *   - backenly.types.d.ts  — Row/Insert/Update types for every table
 *   - backenly.client.ts   — typed backend client (createTypedClient<Database>)
 *
 * Frontend can trigger download of both files from the Connect tab.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { readWorkspaceSchema } from '@/lib/typegen/schema-reader'
import { generateTypes } from '@/lib/typegen/type-generator'
import { generateTypedClient } from '@/lib/typegen/client-generator'
import { prisma } from '@/lib/db'

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const { searchParams } = request.nextUrl
    const file = searchParams.get('file') // 'types' | 'client' | null (returns both)

    // Read live workspace schema
    const schema = await readWorkspaceSchema(projectId)

    if (!schema || schema.tables.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'No tables found. Create tables through your connected coding agent or the Database section first.',
      }, { status: 404 })
    }

    // Get project API URL for the client file
    const project = await prisma.project.findFirst({
      where: { id: projectId },
      select: { apiUrlProd: true, apiUrlDev: true, name: true },
    })

    const apiUrl = project?.apiUrlProd || project?.apiUrlDev || 'https://api.backenly.com'

    const types = generateTypes(schema)
    const client = generateTypedClient(schema, types, { projectId, apiUrl })

    // Return specific file as plain text download
    if (file === 'types') {
      return new NextResponse(types.source, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="backenly.types.d.ts"',
        },
      })
    }

    if (file === 'client') {
      return new NextResponse(client.source, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="backenly.client.ts"',
        },
      })
    }

    // Default: return both as JSON
    return NextResponse.json({
      success: true,
      data: {
        tables: schema.tables.map(t => t.tableName),
        files: {
          'backenly.types.d.ts': { content: types.source, language: 'typescript' },
          'backenly.client.ts': { content: client.source, language: 'typescript' },
        },
        usage: [
          '// 1. Drop both files into your frontend project',
          '// 2. Import the typed client:',
          `import { backend } from './backenly.client'`,
          '',
          '// 3. Use with full TypeScript autocomplete:',
          'const posts = await backend.posts.list()  // → PostsRow[]',
          'await backend.posts.create({ title: "Hello", body: "World" })  // typed!',
        ].join('\n'),
      },
    })
  })
}
