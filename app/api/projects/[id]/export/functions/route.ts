import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { verifySession } from '@/lib/auth/session'
import { canAccessProject } from '@/lib/edition/guard'

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const token = request.cookies.get('auth-token')?.value
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const session = await verifySession(token)
    if (!session.valid || !session.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const projectId = params.id
    const { searchParams } = new URL(request.url)
    const functionId = searchParams.get('functionId')
    const format = searchParams.get('format') ?? 'json'

    if (!(await canAccessProject(session.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true },
    })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    // Fetch specific function or all functions
    const fns = await prisma.aiFunction.findMany({
      where: {
        projectId,
        ...(functionId ? { id: functionId } : {}),
      },
      select: {
        id: true,
        name: true,
        description: true,
        triggerType: true,
        triggerTable: true,
        generatedCode: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    })

    if (fns.length === 0) {
      if (format === 'json') {
        return NextResponse.json({ functions: [], count: 0 })
      }
      return new NextResponse('// No AI functions generated yet\n', {
        headers: {
          'Content-Type': 'text/plain',
          'Content-Disposition': `attachment; filename="${project.name}-functions.ts"`,
        },
      })
    }

    if (format === 'json') {
      return NextResponse.json({
        functions: fns.map(f => ({
          id: f.id,
          name: f.name,
          description: f.description,
          triggerType: f.triggerType,
          triggerTable: f.triggerTable,
          hasCode: !!f.generatedCode,
          code: f.generatedCode,
          createdAt: f.createdAt,
          updatedAt: f.updatedAt,
        })),
        count: fns.length,
      })
    }

    // TypeScript bundle: concatenate all functions into one downloadable file
    const fileLines: string[] = [
      `/**`,
      ` * AI Functions export for: ${project.name}`,
      ` * Exported at: ${new Date().toISOString()}`,
      ` * Functions: ${fns.length}`,
      ` */`,
      '',
    ]

    for (const fn of fns) {
      fileLines.push(`// ── ${fn.name} ────────────────────────────────────────────`)
      fileLines.push(`// ${fn.description || '(no description)'}`)
      if (fn.triggerType) fileLines.push(`// Trigger: ${fn.triggerType}${fn.triggerTable ? ` on ${fn.triggerTable}` : ''}`)
      fileLines.push('')
      if (fn.generatedCode) {
        fileLines.push(fn.generatedCode)
      } else {
        fileLines.push(`// No generated code for this function yet.`)
      }
      fileLines.push('')
    }

    const fileName = functionId
      ? `${fns[0]?.name ?? 'function'}.ts`
      : `${project.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-functions.ts`

    return new NextResponse(fileLines.join('\n'), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
      },
    })
  } catch (err) {
    console.error('[ExportFunctions] Failed:', err)
    return NextResponse.json({ error: 'Export failed' }, { status: 500 })
  }
}
