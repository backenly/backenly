/**
 * HANDOFF GENERATOR
 * =================
 * Produces framework-specific integration snippets that developers (or AI
 * tools like Cursor / Bolt / Lovable) paste into their frontend projects.
 *
 * Supported targets:
 *   react      — React hook + provider pattern
 *   nextjs     — Next.js App Router (server component helper + client hook)
 *   typescript — plain TypeScript / Vite / vanilla
 *   cursor     — AI-tool-friendly bundle with types + annotated examples
 *   bolt       — StackBlitz Bolt integration snippet
 *   lovable    — Lovable integration snippet
 */

import type { WorkspaceSchema } from './schema-reader'
import type { GeneratedTypes } from './type-generator'

export type HandoffFramework = 'react' | 'nextjs' | 'typescript' | 'cursor' | 'bolt' | 'lovable'

export interface HandoffAsset {
  framework: HandoffFramework
  /** Suggested filename the developer should create */
  filename: string
  language: 'tsx' | 'ts' | 'md'
  source: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toPascalCase(s: string): string {
  return s
    .replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    .replace(/^[a-z]/, c => c.toUpperCase())
}

function firstTable(schema: WorkspaceSchema): string {
  return schema.tables[0]?.tableName ?? 'items'
}

function exampleInsert(schema: WorkspaceSchema, tableIndex = 0): string {
  const t = schema.tables[tableIndex]
  if (!t) return '{ name: "example" }'
  const cols = t.columns.filter(
    c => !c.isPrimaryKey && c.columnName !== 'created_at' && c.columnName !== 'updated_at'
  )
  if (cols.length === 0) return '{}'
  const pairs = cols.slice(0, 2).map(c => {
    const ex =
      c.dataType === 'boolean' ? 'false' : c.dataType.includes('int') ? '0' : `"example"`
    return `${c.columnName}: ${ex}`
  })
  return `{ ${pairs.join(', ')} }`
}

/** Build per-table example snippets showing real table names and column names */
function buildTableExamples(schema: WorkspaceSchema): string {
  if (schema.tables.length === 0) return '// No tables yet — create some via the AI chat'
  return schema.tables.slice(0, 6).map(t => {
    const insert = exampleInsert(schema, schema.tables.indexOf(t))
    const pascal = toPascalCase(t.tableName)
    return [
      `// ${pascal}`,
      `const ${t.tableName} = await backend.${t.tableName}.list({ limit: 20 })`,
      `const new${pascal} = await backend.${t.tableName}.create(${insert})`,
      `await backend.${t.tableName}.update(new${pascal}.id, ${insert})`,
      `await backend.${t.tableName}.delete(new${pascal}.id)`,
    ].join('\n')
  }).join('\n\n')
}

// ── React ─────────────────────────────────────────────────────────────────────

function generateReact(schema: WorkspaceSchema, types: GeneratedTypes, projectId: string): HandoffAsset {
  const table = firstTable(schema)
  const pascal = toPascalCase(table)
  const insert = exampleInsert(schema)

  const source = `/**
 * Backenly — React integration for project ${projectId}
 *
 * 1. Copy \`backenly.types.ts\` and \`backenly.client.ts\` into your project.
 * 2. Copy this file alongside them.
 * 3. import { useTable } from './backenly.hooks'
 */

import { useState, useEffect, useCallback } from 'react'
import { backend } from './backenly.client'
import type { Database, TableName } from './backenly.types'

type Row<T extends TableName> = Database[T]['Row']
type Insert<T extends TableName> = Database[T]['Insert']

// ── Generic hook ─────────────────────────────────────────────────────────────

export function useTable<T extends TableName>(
  tableName: T,
  options?: { where?: Record<string, unknown>; limit?: number }
) {
  type R = Row<T>
  const [rows, setRows] = useState<R[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await (backend[tableName] as any).list(options)
      setRows(data)
    } catch (err: any) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [tableName, JSON.stringify(options)])

  useEffect(() => { refresh() }, [refresh])

  const create = useCallback(async (data: Insert<T>) => {
    const row = await (backend[tableName] as any).create(data)
    setRows(prev => [...prev, row])
    return row as R
  }, [tableName])

  const remove = useCallback(async (id: string) => {
    await (backend[tableName] as any).delete(id)
    setRows(prev => prev.filter((r: any) => r.id !== id))
  }, [tableName])

  return { rows, loading, error, refresh, create, remove }
}

// ── Example usage ─────────────────────────────────────────────────────────────
//
// function ${pascal}List() {
//   const { rows, loading, create } = useTable('${table}')
//   if (loading) return <p>Loading…</p>
//   return (
//     <ul>
//       {rows.map(row => <li key={row.id}>{JSON.stringify(row)}</li>)}
//     </ul>
//   )
// }
//
// ── Realtime variant ──────────────────────────────────────────────────────────

export function useRealtimeTable<T extends TableName>(tableName: T) {
  const { rows, loading, error, refresh } = useTable(tableName)

  useEffect(() => {
    const unsub = (backend[tableName] as any).subscribe(() => refresh())
    return () => unsub()
  }, [tableName, refresh])

  return { rows, loading, error }
}
`

  return { framework: 'react', filename: 'backenly.hooks.tsx', language: 'tsx', source }
}

// ── Next.js ───────────────────────────────────────────────────────────────────

function generateNextjs(schema: WorkspaceSchema, types: GeneratedTypes, projectId: string): HandoffAsset {
  const table = firstTable(schema)
  const pascal = toPascalCase(table)
  const insert = exampleInsert(schema)

  const source = `/**
 * Backenly — Next.js App Router integration for project ${projectId}
 *
 * Setup:
 *   1. Copy \`backenly.types.ts\`, \`backenly.client.ts\`, and this file into your project.
 *   2. Set NEXT_PUBLIC_BACKENLY_URL=https://backenly.com in .env.local (optional — default already set)
 *   3. Import from '@/lib/backenly' (or wherever you place these files)
 */

// ── Server-side helper (Server Components / Route Handlers) ──────────────────

import { createTypedClient } from './backenly.client'

/**
 * Returns a typed backend client for use in Server Components and
 * Route Handlers.  Pass a service-role token if you need to bypass RLS.
 *
 * @example
 *   // app/posts/page.tsx
 *   export default async function PostsPage() {
 *     const { ${table} } = getServerBackend()
 *     const posts = await ${table}.list()
 *     return <PostsList initialPosts={posts} />
 *   }
 */
export function getServerBackend() {
  return createTypedClient()
}

// ── Client-side hook (Client Components) ─────────────────────────────────────

'use client'

import { useState, useEffect } from 'react'
import { backend } from './backenly.client'
import type { Database, TableName } from './backenly.types'

type Row<T extends TableName> = Database[T]['Row']

/**
 * Client Component hook — fetches and subscribes to a table.
 *
 * @example
 *   'use client'
 *   export default function ${pascal}Feed() {
 *     const { rows, loading } = useBackenlyTable('${table}')
 *     if (loading) return <p>Loading…</p>
 *     return <ul>{rows.map(r => <li key={r.id}>{JSON.stringify(r)}</li>)}</ul>
 *   }
 */
export function useBackenlyTable<T extends TableName>(
  tableName: T,
  options?: { where?: Record<string, unknown>; limit?: number }
) {
  const [rows, setRows] = useState<Row<T>[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(backend[tableName] as any).list(options).then((data: Row<T>[]) => {
      if (!cancelled) { setRows(data); setLoading(false) }
    })
    const unsub = (backend[tableName] as any).subscribe(() => {
      ;(backend[tableName] as any).list(options).then((data: Row<T>[]) => {
        if (!cancelled) setRows(data)
      })
    })
    return () => { cancelled = true; unsub() }
  }, [tableName])

  return { rows, loading }
}

// ── Mutation helpers ──────────────────────────────────────────────────────────

export async function createRow<T extends TableName>(
  tableName: T,
  data: Database[T]['Insert']
): Promise<Row<T>> {
  return (backend[tableName] as any).create(data)
}

export async function updateRow<T extends TableName>(
  tableName: T,
  id: string,
  data: Database[T]['Update']
): Promise<Row<T>> {
  return (backend[tableName] as any).update(id, data)
}

export async function deleteRow<T extends TableName>(
  tableName: T,
  id: string
): Promise<void> {
  await (backend[tableName] as any).delete(id)
}
`

  return { framework: 'nextjs', filename: 'backenly.nextjs.ts', language: 'ts', source }
}

// ── Plain TypeScript ──────────────────────────────────────────────────────────

function generateTypescript(schema: WorkspaceSchema, types: GeneratedTypes, projectId: string): HandoffAsset {
  const table = firstTable(schema)
  const pascal = toPascalCase(table)
  const insert = exampleInsert(schema)
  const allExamples = buildTableExamples(schema)
  const typeImports = schema.tables.slice(0, 4).map(t => `${toPascalCase(t.tableName)}Row`).join(', ')

  const source = `/**
 * Backenly — TypeScript integration for project ${projectId}
 *
 * Works with any TS project: Vite, Astro, SvelteKit, plain Node, etc.
 *
 * Setup:
 *   1. Download types:  GET /api/typegen?projectId=${projectId}&format=dts  → save as backenly.types.ts
 *   2. Download client: GET /api/typegen?projectId=${projectId}&format=client → save as backenly.client.ts
 *   3. Download OpenAPI spec: GET /api/typegen?projectId=${projectId}&format=openapi&download=true → import into Postman
 */

import { backend } from './backenly.client'
import type { ${typeImports}, Database, TableName } from './backenly.types'

// ── All tables in this project ────────────────────────────────────────────────

${allExamples}

// ── Auth ──────────────────────────────────────────────────────────────────────

const { token, user } = await backend.auth.signUp({ email: 'user@example.com', password: 'secret' })
backend.setAuthToken(token)

// ── Cursor-based pagination (efficient for large tables) ──────────────────────

let cursor: string | undefined
do {
  const page = await backend.${table}.list({ limit: 20, cursor })
  console.log(page.data)
  cursor = page.nextCursor ?? undefined
} while (cursor)

// ── Realtime subscription ─────────────────────────────────────────────────────

const unsub = backend.${table}.subscribe((event) => {
  if (event.type === 'insert') console.log('New row:', event.data)
  if (event.type === 'update') console.log('Updated row:', event.data)
  if (event.type === 'delete') console.log('Deleted:', event.data)
})
// Call unsub() to stop listening

// ── Generic typed helper (utility) ───────────────────────────────────────────

async function fetchAll<T extends TableName>(
  tableName: T,
  where?: Record<string, unknown>
): Promise<Database[T]['Row'][]> {
  return (backend[tableName] as any).list({ where })
}
`

  return { framework: 'typescript', filename: 'backenly.example.ts', language: 'ts', source }
}

// ── Cursor (AI tool) ──────────────────────────────────────────────────────────

function generateCursor(schema: WorkspaceSchema, types: GeneratedTypes, projectId: string): HandoffAsset {
  const tableList = schema.tables.map(t => {
    const cols = t.columns.filter(c => !c.isPrimaryKey).slice(0, 3).map(c => c.columnName).join(', ')
    return `- \`${t.tableName}\` (${cols || 'id'})`
  }).join('\n')
  const table = firstTable(schema)
  const insert = exampleInsert(schema)
  const allExamples = buildTableExamples(schema)

  const source = `# Backenly Project ${projectId} — AI Context for Cursor / Copilot / Bolt / Lovable

## What this backend provides

This project is powered by **Backenly** (https://backenly.com).
All database, auth, storage and realtime capabilities are pre-built.
You do NOT need to write any server-side code.

## Tables in this project

${tableList}

## SDK Setup

\`\`\`bash
npm install @backenly/sdk
# or include via CDN:
# <script src="https://backenly.com/backenly-sdk.js"></script>
\`\`\`

Download these generated files and copy into your project:
- **Types**: \`GET /api/typegen?projectId=${projectId}&format=dts\` → save as \`backenly.types.ts\`
- **Client**: \`GET /api/typegen?projectId=${projectId}&format=client\` → save as \`backenly.client.ts\`
- **OpenAPI spec**: \`GET /api/typegen?projectId=${projectId}&format=openapi&download=true\` → import into Postman/Insomnia

## All tables in this project (domain-specific examples)

\`\`\`typescript
import { backend } from './backenly.client'

${allExamples}
\`\`\`

## Cursor-based pagination (efficient for large tables)

\`\`\`typescript
let cursor: string | undefined
do {
  const page = await backend.${table}.list({ limit: 20, cursor })
  console.log(page.data)
  cursor = page.nextCursor ?? undefined
} while (cursor)
\`\`\`

## Realtime (live updates)

\`\`\`typescript
backend.${table}.subscribe((event) => console.log(event))
\`\`\`

## Auth

\`\`\`typescript
const { token } = await backend.auth.signUp({ email: '', password: '' })
backend.setAuthToken(token)
\`\`\`

## Storage

\`\`\`typescript
await backend.storage.upload(file, { bucket: 'uploads' })
\`\`\`

## Type reference

See \`backenly.types.ts\` for the full \`Database\` type map.

Every table has three types:
- \`<Table>Row\`    — shape returned by SELECT
- \`<Table>Insert\` — data required for INSERT
- \`<Table>Update\` — optional fields for PATCH/PUT

## Environment variable

\`\`\`
NEXT_PUBLIC_BACKENLY_URL=https://backenly.com  # (default — only override for self-hosted)
\`\`\`

## API base URL

\`\`\`
https://backenly.com/api/v1/${projectId}/
\`\`\`
`

  return { framework: 'cursor', filename: 'BACKENLY.md', language: 'md', source }
}

// ── Public entry point ────────────────────────────────────────────────────────

export function generateHandoffAssets(
  schema: WorkspaceSchema,
  types: GeneratedTypes,
  projectId: string
): HandoffAsset[] {
  return [
    generateReact(schema, types, projectId),
    generateNextjs(schema, types, projectId),
    generateTypescript(schema, types, projectId),
    generateCursor(schema, types, projectId),
  ]
}

export function generateHandoffAsset(
  framework: HandoffFramework,
  schema: WorkspaceSchema,
  types: GeneratedTypes,
  projectId: string
): HandoffAsset {
  switch (framework) {
    case 'react':      return generateReact(schema, types, projectId)
    case 'nextjs':     return generateNextjs(schema, types, projectId)
    case 'typescript': return generateTypescript(schema, types, projectId)
    case 'cursor':
    case 'bolt':
    case 'lovable':    return generateCursor(schema, types, projectId)
    default:           return generateCursor(schema, types, projectId)
  }
}
