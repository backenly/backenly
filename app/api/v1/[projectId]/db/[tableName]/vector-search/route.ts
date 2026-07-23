export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * Vector-search runtime endpoint.
 * ===============================
 *
 *   GET  /api/v1/{projectId}/db/{tableName}/vector-search?q=...&limit=10
 *
 * Returns the rows in `{tableName}` whose embedding column is closest (cosine
 * similarity) to the embedded `q`. The embedding column, source columns, and
 * dimensions are recorded in ApiDefinition.config.vectorSearch when the
 * enable_vector_search tool ran. The embedding itself is stripped from the
 * response — it's 1536 floats, the client never wants it.
 *
 * Auth: same modern v1 middleware path as table CRUD, including project match,
 * publish gating, quota checks, and end-user context for RLS. */

import { NextRequest, NextResponse } from 'next/server'
import { v1ApiMiddleware } from '@/lib/api/v1/middleware'
import { prisma } from '@/lib/db'
import { embedText, formatVectorLiteral } from '@/lib/ai/embeddings'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import { executeWithUserContext } from '@/lib/services/workspace-rls'

const MAX_LIMIT = 50
const DEFAULT_LIMIT = 10
const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/

export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string; tableName: string } },
) {
  try {
    const middleware = await v1ApiMiddleware(request, { projectId: params.projectId })
    if (middleware.response) return middleware.response

    if (!SAFE_IDENT.test(params.tableName)) {
      return NextResponse.json(
        { error: 'Invalid table name', code: 'BAD_REQUEST' },
        { status: 400 },
      )
    }

    // ── Query params ───────────────────────────────────────────────────────
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') || '').trim()
    const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : DEFAULT_LIMIT))

    if (!q) {
      return NextResponse.json(
        { error: 'Missing "q" query parameter (the natural-language search text)', code: 'BAD_REQUEST' },
        { status: 400 },
      )
    }

    // ── Resolve table + ApiDefinition config ───────────────────────────────
    const table = await prisma.table.findFirst({
      where: { projectId: params.projectId, name: params.tableName },
      select: { id: true, name: true, apiDefinition: { select: { config: true, enabled: true } } },
    })
    if (!table) {
      return NextResponse.json(
        { error: `Table "${params.tableName}" not found`, code: 'NOT_FOUND' },
        { status: 404 },
      )
    }
    const vs = (table.apiDefinition?.config as any)?.vectorSearch
    if (!vs?.enabled) {
      return NextResponse.json(
        {
          error: `Vector search is not enabled on "${params.tableName}"`,
          code: 'VECTOR_SEARCH_NOT_ENABLED',
          hint: 'Ask your connected coding agent to "enable semantic search on this table" — Backenly runs the setup.',
        },
        { status: 409 },
      )
    }

    const embeddingColumn: string = typeof vs.embeddingColumn === 'string' && SAFE_IDENT.test(vs.embeddingColumn)
      ? vs.embeddingColumn
      : 'embedding'

    // ── Embed the query ────────────────────────────────────────────────────
    let queryVec: number[]
    try {
      queryVec = await embedText(q)
    } catch (e: any) {
      return NextResponse.json(
        { error: 'Embedding failed', code: 'EMBED_FAILED', detail: e?.message },
        { status: 502 },
      )
    }
    if (!queryVec || queryVec.length === 0) {
      return NextResponse.json(
        { error: 'Query produced an empty embedding', code: 'BAD_REQUEST' },
        { status: 400 },
      )
    }

    // ── Search ─────────────────────────────────────────────────────────────
    const { postgresSchema } = getWorkspaceDatabaseNames(params.projectId)
    const vecLiteral = formatVectorLiteral(queryVec)

    // `<=>` is pgvector's cosine-distance operator (0 = identical, 2 = opposite).
    // We expose `score = 1 - distance` so higher = better, which is what every
    // ML / RAG client expects.
    const sql = `
      SELECT *, ("${embeddingColumn}" <=> $1::vector) AS _distance
        FROM "${postgresSchema}"."${params.tableName}"
       WHERE "${embeddingColumn}" IS NOT NULL
       ORDER BY "${embeddingColumn}" <=> $1::vector
       LIMIT $2
    `
    let rows: Array<Record<string, unknown>>
    try {
      rows = await executeWithUserContext<Record<string, unknown>>(
        middleware.context.endUserId ?? '',
        middleware.context.apiKey.serviceRole,
        sql,
        [vecLiteral, limit],
        middleware.context.endUserRole ?? 'user'
      )
    } catch (e: any) {
      return NextResponse.json(
        { error: 'Search query failed', code: 'DB_ERROR', detail: e?.message },
        { status: 500 },
      )
    }

    // Strip the giant embedding column from the response and surface a usable score.
    const data = rows.map(r => {
      const out: Record<string, unknown> = {}
      let distance: number | null = null
      for (const k of Object.keys(r)) {
        if (k === embeddingColumn) continue
        if (k === '_distance') {
          const v = r[k]
          distance = typeof v === 'number' ? v : Number(v)
          continue
        }
        out[k] = r[k]
      }
      out._score = distance == null ? null : Math.max(0, 1 - distance)
      out._distance = distance
      return out
    })

    return NextResponse.json({
      data,
      meta: {
        query: q,
        limit,
        returned: data.length,
        model: vs.model ?? 'text-embedding-3-small',
        sourceColumns: vs.sourceColumns ?? [],
        indexKind: vs.indexKind ?? 'hnsw',
      },
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'Unexpected error', code: 'INTERNAL' },
      { status: 500 },
    )
  }
}
