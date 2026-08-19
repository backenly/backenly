import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { verifySession } from '@/lib/auth/session'
import { Pool } from 'pg'

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const token = request.cookies.get('auth-token')?.value
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const session = await verifySession(token)
    if (!session.valid || !session.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const projectId = params.id

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: session.userId },
      select: { id: true, name: true },
    })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const schemaName = `workspace_${projectId}`

    // Query information_schema to get all tables + their columns in the workspace schema
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    let sql = ''
    try {
      const tablesResult = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        [schemaName],
      )

      const tables = tablesResult.rows.map(r => r.table_name)
      if (tables.length === 0) {
        const format = new URL(request.url).searchParams.get('format') ?? 'sql'
        if (format === 'json') return NextResponse.json({ schema: schemaName, tables: [] })
        return new NextResponse('-- No tables created yet\n', {
          headers: {
            'Content-Type': 'text/plain',
            'Content-Disposition': `attachment; filename="${project.name}-schema.sql"`,
          },
        })
      }

      // For each table, fetch columns and constraints to generate CREATE TABLE SQL
      const sqlParts: string[] = [
        `-- Schema export for: ${project.name}`,
        `-- Exported at: ${new Date().toISOString()}`,
        `-- Schema: ${schemaName}`,
        '',
      ]

      for (const tableName of tables) {
        const colsResult = await pool.query<{
          column_name: string
          data_type: string
          character_maximum_length: number | null
          is_nullable: string
          column_default: string | null
        }>(
          `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [schemaName, tableName],
        )

        const pkResult = await pool.query<{ column_name: string }>(
          `SELECT kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           WHERE tc.constraint_type = 'PRIMARY KEY'
             AND tc.table_schema = $1 AND tc.table_name = $2`,
          [schemaName, tableName],
        )
        const pkCols = new Set(pkResult.rows.map(r => r.column_name))

        const colDefs = colsResult.rows.map(col => {
          let typeDef = col.data_type.toUpperCase()
          if (col.character_maximum_length) typeDef += `(${col.character_maximum_length})`
          const nullable = col.is_nullable === 'YES' ? '' : ' NOT NULL'
          const defaultVal = col.column_default ? ` DEFAULT ${col.column_default}` : ''
          const pk = pkCols.has(col.column_name) ? ' PRIMARY KEY' : ''
          return `  ${col.column_name} ${typeDef}${pk}${nullable}${defaultVal}`
        })

        sqlParts.push(`CREATE TABLE IF NOT EXISTS "${schemaName}"."${tableName}" (`)
        sqlParts.push(colDefs.join(',\n'))
        sqlParts.push(');')
        sqlParts.push('')
      }

      sql = sqlParts.join('\n')
    } finally {
      await pool.end()
    }

    const format = new URL(request.url).searchParams.get('format') ?? 'sql'
    if (format === 'json') {
      return NextResponse.json({ schema: schemaName, sql, tables: sql.match(/CREATE TABLE/g)?.length ?? 0 });
    }

    return new NextResponse(sql, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${project.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-schema.sql"`,
      },
    });
  } catch (err) {
    console.error('[ExportSchema] Failed:', err)
    return NextResponse.json({ error: 'Export failed' }, { status: 500 })
  }
}
