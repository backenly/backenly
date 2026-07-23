/**
 * File Processor for AI Chat
 *
 * Handles three upload types:
 *  - image   → GPT-4o vision analysis → backend structure description
 *  - csv     → parse headers + sample rows → schema context
 *  - openapi → parse JSON/YAML spec → endpoints + models context
 */

import { getOpenAIClient } from './openai-service'
import { load as parseYaml } from 'js-yaml'

export interface UploadedFile {
  type: 'image' | 'csv' | 'openapi'
  /** base64-encoded data for images; raw text for CSV and OpenAPI */
  content: string
  mimeType?: string
  fileName?: string
}

// ─── Image ────────────────────────────────────────────────────────────────────

/**
 * Send a UI screenshot to GPT-4o vision and get a backend structure description.
 * Returns a compact text block like:
 *   TABLES: users(id,email), products(id,title,price,sellerId)
 *   RELATIONSHIPS: products.sellerId → users.id
 */
export async function analyzeImageForBackend(base64: string, mimeType: string): Promise<string> {
  const openai = getOpenAIClient()

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'low' },
          },
          {
            type: 'text',
            text: `You are a backend architect analyzing a UI screenshot to determine what database tables and APIs are needed.

Look at every visible element — lists, cards, forms, navigation, labels — and infer the underlying data model.

Respond ONLY in this compact format (no prose):
TABLES: tableName(field1, field2, field3), anotherTable(field1, field2)
RELATIONSHIPS: table1.foreignKey → table2.id, ...

Rules:
- Include a users table if there are any user-facing features (login, profiles, ownership)
- Infer foreign keys from visual ownership (e.g. a product owned by a seller → sellerId)
- Only list what you can directly see or strongly infer
- Keep field names camelCase`,
          },
        ],
      },
    ],
  })

  return response.choices[0]?.message?.content?.trim() ?? ''
}

/**
 * GAP 8: Deep wireframe/mockup analysis.
 * Instead of a shallow TABLES/RELATIONSHIPS text, this makes a dedicated
 * vision call that extracts a fully-structured JSON suitable for feeding
 * directly into the build pipeline as pre-analyzed context.
 *
 * Output shape:
 * {
 *   pages: ["Dashboard", "Products", "Users"],
 *   entities: [{"name": "products", "fields": ["title", "price", "status"]}, ...],
 *   relations: [{"from": "orders", "to": "users", "type": "FK"}],
 *   userRoles: ["admin", "customer"],
 *   actions: ["create product", "checkout", "manage users"],
 *   authRequired: true
 * }
 */
export async function analyzeWireframeStructured(base64: string, mimeType: string): Promise<{
  pages: string[]
  entities: Array<{ name: string; fields: string[]; purpose: string }>
  relations: Array<{ from: string; to: string; type: 'FK' | 'M2M'; description: string }>
  userRoles: string[]
  actions: string[]
  authRequired: boolean
  rawText: string
} | null> {
  try {
    const openai = getOpenAIClient()

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' },
          },
          {
            type: 'text',
            text: `You are a senior backend architect extracting data model requirements from a UI wireframe or mockup.

Analyze every visible screen element — navigation items, page titles, form fields, table columns, buttons, labels, user avatars, role indicators — and extract the complete backend data model.

Return ONLY valid JSON (no markdown fences) in this exact shape:
{
  "pages": ["page name visible in nav or heading"],
  "entities": [
    {"name": "snake_case_table_name", "fields": ["field1", "field2"], "purpose": "what this table stores"}
  ],
  "relations": [
    {"from": "child_table", "to": "parent_table", "type": "FK", "description": "child belongs to parent"}
  ],
  "userRoles": ["role1", "role2"],
  "actions": ["short verb-noun action visible in UI buttons/menus"],
  "authRequired": true
}

Rules:
- Include a "users" entity if any user-facing UI is visible
- Infer FKs from visual ownership patterns (product → seller, comment → post)
- Use M2M for many-to-many patterns (users belong to many teams, tags on products)
- Extract roles from role badges, admin panels, or permission indicators
- authRequired: true if any login/profile/user-specific UI is visible
- Return exactly the JSON shape above — nothing else`,
          },
        ],
      }],
    })

    const raw = response.choices[0]?.message?.content?.trim() ?? ''

    try {
      const parsed = JSON.parse(raw)
      return { ...parsed, rawText: raw }
    } catch {
      // JSON parse failed — return null to fall back to simple analysis
      return null
    }
  } catch {
    return null
  }
}

/**
 * Format wireframe analysis as structured context for the intent planner.
 * This is far richer than the simple TABLES:/RELATIONSHIPS: text format.
 */
export function formatWireframeContext(analysis: Awaited<ReturnType<typeof analyzeWireframeStructured>>): string {
  if (!analysis) return ''

  const lines: string[] = ['## WIREFRAME ANALYSIS (Pre-analyzed from uploaded image)']

  if (analysis.pages.length > 0) {
    lines.push(`\nPAGES: ${analysis.pages.join(', ')}`)
  }

  if (analysis.entities.length > 0) {
    lines.push('\nENTITIES:')
    for (const e of analysis.entities) {
      lines.push(`  ${e.name}(${e.fields.join(', ')}) — ${e.purpose}`)
    }
  }

  if (analysis.relations.length > 0) {
    lines.push('\nRELATIONSHIPS:')
    for (const r of analysis.relations) {
      lines.push(`  ${r.from} → ${r.to} (${r.type}): ${r.description}`)
    }
  }

  if (analysis.userRoles.length > 0) {
    lines.push(`\nUSER ROLES: ${analysis.userRoles.join(', ')}`)
  }

  if (analysis.actions.length > 0) {
    lines.push(`\nUI ACTIONS: ${analysis.actions.join(', ')}`)
  }

  if (analysis.authRequired) {
    lines.push('\nAUTH: Required (login/user features visible)')
  }

  lines.push('\nINSTRUCTION: Use the above wireframe analysis to build an EXACT backend match — include every entity, relation, and role listed above.')

  return lines.join('\n')
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

/**
 * Parse a CSV string and return a schema description the AI can act on.
 */
export function parseCsvSchema(content: string, fileName?: string): string {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return ''

  const parseRow = (row: string): string[] => {
    const result: string[] = []
    let cur = ''
    let inQuotes = false
    for (const ch of row) {
      if (ch === '"') { inQuotes = !inQuotes; continue }
      if (ch === ',' && !inQuotes) { result.push(cur.trim()); cur = ''; continue }
      cur += ch
    }
    result.push(cur.trim())
    return result
  }

  const headers = parseRow(lines[0])
  const sampleRows = lines.slice(1, 6).map(parseRow)
  const totalRows = lines.length - 1

  const columnTypes = headers.map((header, idx) => {
    const values = sampleRows.map(row => row[idx] ?? '').filter(Boolean)
    if (values.length === 0) return `${header}:text`
    if (values.every(v => !isNaN(Number(v)) && v !== '')) {
      return `${header}:${values.some(v => v.includes('.')) ? 'decimal' : 'integer'}`
    }
    if (values.every(v => /^\d{4}-\d{2}-\d{2}/.test(v))) return `${header}:timestamp`
    if (values.every(v => v === 'true' || v === 'false' || v === '0' || v === '1')) return `${header}:boolean`
    return `${header}:text`
  })

  const rawName = fileName?.replace(/\.[^.]+$/, '') ?? 'data'
  const tableName = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

  return `[Uploaded CSV: ${fileName ?? 'data.csv'}]
Suggested table name: ${tableName}
Columns (${headers.length}): ${columnTypes.join(', ')}
Total rows: ~${totalRows}
Sample: ${sampleRows[0]?.join(' | ') ?? 'none'}
${sampleRows[1] ? `        ${sampleRows[1].join(' | ')}` : ''}`
}

// ─── OpenAPI ──────────────────────────────────────────────────────────────────

/**
 * Parse an OpenAPI / Swagger spec (JSON or YAML) and return a structured summary.
 */
export function parseOpenApiSpec(content: string, fileName?: string): string {
  let spec: any

  try {
    spec = JSON.parse(content)
  } catch {
    // Not valid JSON — try YAML
    try {
      spec = parseYaml(content)
    } catch {
      // Unparseable — pass raw text so the AI can still interpret it
      return `[Uploaded OpenAPI Spec: ${fileName ?? 'spec.yaml'} — raw content]
${content.slice(0, 3000)}`
    }
  }

  const info = spec.info ?? {}
  const paths: Record<string, any> = spec.paths ?? {}
  const schemas: Record<string, any> = spec.components?.schemas ?? spec.definitions ?? {}

  const endpoints: string[] = []
  for (const [path, methods] of Object.entries(paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      if (methods?.[method]) {
        const op = methods[method]
        endpoints.push(`${method.toUpperCase()} ${path}${op.summary ? ` — ${op.summary}` : ''}`)
      }
    }
  }

  const modelLines: string[] = []
  for (const [name, schema] of Object.entries(schemas)) {
    const props = Object.keys((schema as any).properties ?? {})
    modelLines.push(props.length > 0 ? `${name}(${props.join(', ')})` : name)
  }

  return `[Uploaded OpenAPI Spec: ${info.title ?? fileName ?? 'API'} v${info.version ?? '1.0'}]
Endpoints (${endpoints.length}):
${endpoints.slice(0, 30).join('\n')}

Data models: ${modelLines.join(', ')}`
}

// ─── CSV Data Extraction (Gap 6) ──────────────────────────────────────────────

/**
 * Extract all data rows from a CSV as an array of objects.
 * Used for bulk import after the table is created from the schema.
 * Max 500 rows to avoid overwhelming the DB on first import.
 */
export interface CsvRowData {
  tableName: string
  headers: string[]
  rows: Record<string, string>[]
  totalRows: number
}

export function extractCsvData(content: string, fileName?: string): CsvRowData | null {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) return null  // Need at least header + 1 row

  const parseRow = (row: string): string[] => {
    const result: string[] = []
    let cur = ''
    let inQuotes = false
    for (const ch of row) {
      if (ch === '"') { inQuotes = !inQuotes; continue }
      if (ch === ',' && !inQuotes) { result.push(cur.trim()); cur = ''; continue }
      cur += ch
    }
    result.push(cur.trim())
    return result
  }

  const headers = parseRow(lines[0])
  const MAX_ROWS = 500
  const dataLines = lines.slice(1, MAX_ROWS + 1)
  const totalRows = lines.length - 1

  const rows = dataLines.map(line => {
    const values = parseRow(line)
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => {
      obj[h] = values[i] ?? ''
    })
    return obj
  })

  const rawName = fileName?.replace(/\.[^.]+$/, '') ?? 'data'
  const tableName = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

  return { tableName, headers, rows, totalRows }
}

/**
 * Bulk insert CSV rows into a workspace table after it's been created.
 * Silently ignores errors for individual rows (best-effort import).
 */
export async function bulkInsertCsvRows(
  projectId: string,
  tableName: string,
  rows: Record<string, string>[],
): Promise<{ inserted: number; errors: number }> {
  if (rows.length === 0) return { inserted: 0, errors: 0 }

  try {
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

    const { prisma } = await import('@/lib/db/prisma')

    let inserted = 0
    let errors = 0

    // Insert rows one at a time using prisma.$queryRawUnsafe
    // Batch inserts are complex with dynamic columns — single inserts are simpler and still fast
    for (const row of rows.slice(0, 500)) {
      try {
        const columns = Object.keys(row).filter(k => row[k] !== '' && row[k] !== undefined)
        if (columns.length === 0) continue

        // Build parameterized INSERT using positional parameters
        const colNames = columns.map(c => `"${c}"`).join(', ')
        const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ')
        const values = columns.map(k => {
          const v = row[k]
          // Try to coerce numeric strings to numbers for proper typing
          if (v !== '' && !isNaN(Number(v))) return Number(v)
          return v
        })
        const sql = `INSERT INTO "${postgresSchema}"."${tableName}" (${colNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`
        await prisma.$queryRawUnsafe(sql, ...values)
        inserted++
      } catch {
        errors++
      }
    }

    console.log(`[CsvImport] Inserted ${inserted} rows into ${tableName} (${errors} errors)`)
    return { inserted, errors }
  } catch (err: any) {
    console.warn('[CsvImport] Bulk insert failed:', err?.message)
    return { inserted: 0, errors: rows.length }
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Process any uploaded file into an AI-readable context string.
 * For images, this makes an async GPT-4o vision call.
 * For CSV/OpenAPI, parsing is synchronous.
 */
export async function processUploadedFile(file: UploadedFile): Promise<string> {
  switch (file.type) {
    case 'image':
      return analyzeImageForBackend(file.content, file.mimeType ?? 'image/png')
    case 'csv':
      return parseCsvSchema(file.content, file.fileName)
    case 'openapi':
      return parseOpenApiSpec(file.content, file.fileName)
    default:
      return ''
  }
}
