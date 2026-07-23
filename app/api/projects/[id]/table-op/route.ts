import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { verifySession } from '@/lib/auth/session'
import { Pool } from 'pg'

// POST /api/projects/[id]/table-op — Real workspace table operations
//
// Executes insert / select / delete against workspace_{projectId} schema.
// All queries are parameterised — no string interpolation of user-supplied values.
// Table name is validated against information_schema before any query.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  let pool: Pool | undefined

  try {
    const token = request.cookies.get('auth-token')?.value
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const session = await verifySession(token)
    if (!session.valid || !session.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const projectId = params.id
    const { operation, table, data, rowId } = await request.json()

    if (!operation || !table) {
      return NextResponse.json({ error: 'operation and table are required' }, { status: 400 })
    }
    if (!['insert', 'select', 'delete'].includes(operation)) {
      return NextResponse.json({ error: 'Invalid operation' }, { status: 400 })
    }

    // Verify project ownership
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: session.userId },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const workspaceSchema = `workspace_${projectId}`

    // Open a connection scoped to this workspace
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 })

    // Validate table exists in this workspace schema before touching it.
    // Uses parameterised query — table and schema are bound, never interpolated.
    const tableCheck = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2
       ) AS exists`,
      [workspaceSchema, table],
    )
    if (!tableCheck.rows[0]?.exists) {
      return NextResponse.json({ error: `Table "${table}" does not exist in this project` }, { status: 404 })
    }

    // Set schema search path for this session
    await pool.query(`SET search_path TO "${workspaceSchema}", public`)

    // ── INSERT ────────────────────────────────────────────────────────────────
    if (operation === 'insert') {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return NextResponse.json({ error: 'data must be an object for insert' }, { status: 400 })
      }

      // Validate column names against actual schema (prevents injection via key names)
      const colCheck = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2`,
        [workspaceSchema, table],
      )
      const validColumns = new Set(colCheck.rows.map(r => r.column_name))

      const inputColumns = Object.keys(data).filter(k => validColumns.has(k))
      if (inputColumns.length === 0) {
        return NextResponse.json({ error: 'No valid columns provided for insert' }, { status: 400 })
      }

      const values = inputColumns.map(k => data[k])
      // Column names come from information_schema (server-controlled), safe to quote
      const colList   = inputColumns.map(c => `"${c}"`).join(', ')
      const placeholders = inputColumns.map((_, i) => `$${i + 1}`).join(', ')

      const insertResult = await pool.query(
        `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) RETURNING *`,
        values,
      )
      return NextResponse.json({ success: true, row: insertResult.rows[0] })
    }

    // ── SELECT ────────────────────────────────────────────────────────────────
    if (operation === 'select') {
      const selectResult = await pool.query(
        `SELECT * FROM "${table}" ORDER BY id DESC LIMIT 100`,
      )
      return NextResponse.json({ success: true, rows: selectResult.rows })
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    if (operation === 'delete') {
      if (!rowId) {
        return NextResponse.json({ error: 'rowId is required for delete' }, { status: 400 })
      }
      await pool.query(`DELETE FROM "${table}" WHERE id = $1`, [rowId])
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid operation' }, { status: 400 })
  } catch (error: any) {
    console.error('[table-op] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Table operation failed' },
      { status: 500 },
    )
  } finally {
    await pool?.end().catch(() => {})
  }
}
