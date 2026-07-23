/**
 * CONNECT MANIFEST — the full "how to wire a frontend to this backend"
 * artifact: project id, anon key, SDK URLs, every table with columns,
 * enabled auth methods, realtime/storage availability, and copy-pasteable
 * example calls. Deterministic, schema-aware, no inference.
 *
 * Consumed by the Assistant (⌘J) to answer connect/wiring questions with
 * project-exact snippets. Exposes only what a frontend bundle would already
 * see (the anon key is public, column names and types are reflected in the
 * SDK calls anyway). Service role keys, jwt secrets, env vars, audit logs
 * are NEVER included.
 */

import { prisma } from '@/lib/db/prisma'
import { getProjectAuthStatus } from '@/lib/services/auth-status'
import { createHash } from 'crypto'
import { generateApiKey } from '@/lib/auth/apiKeyAuth'

export interface ManifestColumn {
  name: string
  type: string         // canonical (string, integer, boolean, date-time, json, uuid)
  required: boolean
  readOnly: boolean    // id, created_at, updated_at
}

export interface ManifestTable {
  name: string
  description?: string
  columns: ManifestColumn[]
  examples: {
    list: string
    create: string
    get: string
    update: string
    delete: string
  }
}

export interface ManifestAuth {
  enabled: boolean
  methods: ('email' | 'google' | 'github')[]
  examples: {
    signUp?: string
    signIn?: string
    signInGoogle?: string
    signInGithub?: string
    signOut?: string
  }
}

export interface ManifestStorage {
  enabled: boolean
  buckets: string[]
  example?: string
}

export interface ManifestRealtime {
  enabled: boolean
  example?: string
}

export interface ConnectManifest {
  version: '1.0'
  generatedAt: string
  project: {
    id: string
    name: string
    apiBaseUrl: string
  }
  apiKey: string
  sdk: {
    cdnEsm: string
    cdnUmd: string
    importLine: string
    initLine: string
  }
  tables: ManifestTable[]
  auth: ManifestAuth
  realtime: ManifestRealtime
  storage: ManifestStorage
  instructions: string[]
  warnings: string[]
}

// ─── pg → canonical type ─────────────────────────────────────────────────────

function canonicalType(pgType: string): string {
  const t = (pgType || '').toUpperCase()
  if (t === 'UUID') return 'uuid'
  if (t === 'TEXT' || t === 'VARCHAR' || t.startsWith('VARCHAR(') || t.startsWith('CHAR(')) return 'string'
  if (t === 'INTEGER' || t === 'INT' || t === 'INT4' || t === 'BIGINT' || t === 'INT8' || t === 'SMALLINT') return 'integer'
  if (t.startsWith('DECIMAL') || t.startsWith('NUMERIC') || t === 'FLOAT' || t === 'FLOAT8' || t === 'DOUBLE PRECISION' || t === 'REAL') return 'number'
  if (t === 'BOOLEAN' || t === 'BOOL') return 'boolean'
  if (t === 'TIMESTAMP' || t === 'TIMESTAMPTZ' || t === 'TIMESTAMP WITH TIME ZONE') return 'date-time'
  if (t === 'DATE') return 'date'
  if (t === 'JSONB' || t === 'JSON') return 'json'
  if (t.endsWith('[]')) return 'array'
  return 'string'
}

function isReadOnly(name: string): boolean {
  return name === 'id' || name === 'created_at' || name === 'updated_at'
}

// ─── example sample value per column type ─────────────────────────────────────

function sampleValue(col: ManifestColumn): string {
  switch (col.type) {
    case 'string':   return `"sample ${col.name}"`
    case 'uuid':     return `"00000000-0000-0000-0000-000000000000"`
    case 'integer':  return '1'
    case 'number':   return '1.5'
    case 'boolean':  return 'true'
    case 'date-time':
    case 'date':     return `new Date().toISOString()`
    case 'json':     return '{}'
    case 'array':    return '[]'
    default:         return 'null'
  }
}

function buildCreateExample(tableName: string, columns: ManifestColumn[]): string {
  const writable = columns.filter(c => !c.readOnly)
  if (writable.length === 0) return `backend.${tableName}.create({})`
  // Include up to 4 writable fields, prioritizing required ones
  const sorted = [...writable].sort((a, b) => (b.required ? 1 : 0) - (a.required ? 1 : 0))
  const shown = sorted.slice(0, 4)
  const body = shown.map(c => `${c.name}: ${sampleValue(c)}`).join(', ')
  return `backend.${tableName}.create({ ${body} })`
}

// ─── workspace schema fallback (live reflection if Table.schema is empty) ────

async function reflectLiveColumns(projectId: string, tableName: string): Promise<ManifestColumn[]> {
  // Use the canonical schema-name helper. The earlier `replace(/-/g, '_')`
  // produced a name that doesn't match the actual workspace schema (which
  // keeps hyphens), so this fallback returned empty columns silently.
  const { workspaceSchemaName } = await import('@/lib/security/workspace-schema')
  const workspaceSchema = workspaceSchemaName(projectId)
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{
      column_name: string
      data_type: string
      is_nullable: string
    }>>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      workspaceSchema,
      tableName,
    )
    return rows.map(r => {
      const t = canonicalType(r.data_type)
      return {
        name: r.column_name,
        type: t,
        required: r.is_nullable === 'NO' && !isReadOnly(r.column_name),
        readOnly: isReadOnly(r.column_name),
      }
    })
  } catch {
    return []
  }
}

// ─── main builder ────────────────────────────────────────────────────────────

export async function buildConnectManifest(
  projectId: string,
  hostBase: string,
): Promise<ConnectManifest> {
  const baseUrl = hostBase.replace(/\/$/, '')

  const [project, tables, authStatus, buckets] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, anonKey: true, apiUrlProd: true, userId: true },
    }),
    prisma.table.findMany({
      where: { projectId },
      select: { name: true, description: true, schema: true },
      orderBy: { createdAt: 'asc' },
    }),
    getProjectAuthStatus(projectId).catch(() => null),
    prisma.storageBucket.count({ where: { projectId } }).catch(() => 0),
  ])

  if (!project) {
    throw new Error(`Project not found: ${projectId}`)
  }

  let anonKey = project.anonKey
  if (!anonKey) {
    anonKey = generateApiKey('live')
    const keyHash = createHash('sha256').update(anonKey).digest('hex')
    const keyPrefix = anonKey.substring(0, 16)

    await prisma.$transaction([
      prisma.apiKey.create({
        data: {
          name: 'Public Anon Key',
          keyHash,
          keyPrefix,
          projectId,
          userId: project.userId,
          permissions: ['read', 'write'],
          rateLimit: 1000,
          keyType: 'public',
          serviceRole: false,
        },
      }),
      prisma.project.update({
        where: { id: projectId },
        data: { anonKey },
      }),
    ])
  }

  // Filter reserved internal tables that must never be exposed to the frontend —
  // canonical predicate covers every leading-underscore plumbing table
  // (_backenly_*, _token_blacklist, _email_verifications, _magic_links,
  // _password_resets, _prisma_*) plus pg_*/information_schema.
  const { isReservedWorkspaceTable } = await import('@/lib/security/workspace-schema')
  const visibleTables = tables.filter(t => !isReservedWorkspaceTable(t.name))

  // Build per-table column data — prefer Table.schema.columns, fall back to live reflection
  const manifestTables: ManifestTable[] = []
  for (const t of visibleTables) {
    const schema = (t.schema as any) || {}
    const rawColumns: any[] = Array.isArray(schema.columns) ? schema.columns : []
    let columns: ManifestColumn[] = rawColumns.map(c => ({
      name: c.name,
      type: canonicalType(c.type || 'TEXT'),
      required: !!c.required && !isReadOnly(c.name),
      readOnly: isReadOnly(c.name),
    }))
    if (columns.length === 0) {
      columns = await reflectLiveColumns(projectId, t.name)
    }
    // Guarantee at least the standard CRUD columns are advertised
    if (columns.length === 0) {
      columns = [
        { name: 'id', type: 'uuid', required: false, readOnly: true },
        { name: 'created_at', type: 'date-time', required: false, readOnly: true },
        { name: 'updated_at', type: 'date-time', required: false, readOnly: true },
      ]
    }

    manifestTables.push({
      name: t.name,
      description: t.description || undefined,
      columns,
      examples: {
        list: `backend.${t.name}.list()`,
        create: buildCreateExample(t.name, columns),
        get: `backend.${t.name}.get(id)`,
        update: `backend.${t.name}.update(id, { /* fields */ })`,
        delete: `backend.${t.name}.delete(id)`,
      },
    })
  }

  // Auth block
  const auth: ManifestAuth = {
    enabled: !!authStatus && authStatus.status !== 'none',
    methods: [],
    examples: {},
  }
  if (auth.enabled && authStatus) {
    if (authStatus.emailPasswordEnabled) {
      auth.methods.push('email')
      auth.examples.signUp = `const { user, token } = await backend.auth.signUp({ email: "alex@example.com", password: "********" })`
      auth.examples.signIn = `const { user, token } = await backend.auth.signIn({ email: "alex@example.com", password: "********" })`
      auth.examples.signOut = `await backend.auth.signOut()`
    }
    for (const p of authStatus.oauthProviders) {
      auth.methods.push(p)
      if (p === 'google') {
        auth.examples.signInGoogle = `backend.auth.signInWithProvider("google")`
      } else if (p === 'github') {
        auth.examples.signInGithub = `backend.auth.signInWithProvider("github")`
      }
    }
  }

  // Storage block
  const storage: ManifestStorage = {
    enabled: buckets > 0,
    buckets: [],
    example: buckets > 0
      ? `const file = await backend.storage.upload(fileInput.files[0])`
      : undefined,
  }
  if (buckets > 0) {
    const bucketRows = await prisma.storageBucket.findMany({
      where: { projectId },
      select: { name: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    }).catch(() => [])
    storage.buckets = bucketRows.map(b => b.name)
  }

  // Realtime — always on (PostgreSQL LISTEN/NOTIFY runtime)
  const realtime: ManifestRealtime = {
    enabled: true,
    example: manifestTables[0]
      ? `backend.${manifestTables[0].name}.subscribe((event) => console.log(event))`
      : undefined,
  }

  // Construct the manifest
  const sdkEsm = `${baseUrl}/backenly-sdk.esm.js`
  const sdkUmd = `${baseUrl}/backenly-sdk.js`

  const manifest: ConnectManifest = {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      apiBaseUrl: `${baseUrl}/api/v1/${project.id}`,
    },
    apiKey: anonKey,
    sdk: {
      cdnEsm: sdkEsm,
      cdnUmd: sdkUmd,
      importLine: `import { createClient } from "${sdkEsm}"`,
      initLine: `const backend = createClient({ projectId: "${project.id}", apiKey: "${anonKey}" })`,
    },
    tables: manifestTables,
    auth,
    realtime,
    storage,
    instructions: [
      `The backend is fully deployed on Backenly. DO NOT scaffold any server code, database, or API routes — they already exist and are live.`,
      `Import the SDK from "${sdkEsm}" and call createClient({ projectId, apiKey }) with the exact strings above. Do not wrap the key in import.meta.env or process.env — the Backenly anon key is public by design and is safe to embed in your shipped bundle.`,
      manifestTables.length > 0
        ? `Replace mock data with the SDK calls below. Tables available: ${manifestTables.map(t => t.name).join(', ')}.`
        : `No tables exist yet — create tables from the dashboard or via your MCP-connected agent before wiring the frontend.`,
      auth.enabled
        ? `Auth is wired. Use backend.auth.signUp / signIn / signOut. Token is auto-persisted to localStorage by the SDK.`
        : `Auth is not enabled — skip any sign-up/sign-in UI for now.`,
      `If you ever get 401 "Invalid API key", the builder likely rewrote the apiKey into an env var that wasn't set at build time. Hardcode the string literal.`,
    ],
    warnings: [],
  }

  if (manifestTables.length === 0) {
    manifest.warnings.push('No tables exist yet — create tables from the dashboard or via your MCP-connected agent before connecting a frontend.')
  }

  return manifest
}
