/**
 * SCHEMA INTROSPECTION TOOLS (#4)
 * ================================
 * Live database query functions the agent calls mid-execution.
 * Replaces stale cached schema with real-time truth.
 * Eliminates "tried to create a table that already exists" bugs.
 */

export interface TableInfo {
  name: string
  columns: Array<{ name: string; type: string; nullable: boolean; foreignKey?: string }>
}

export interface ApiInfo {
  basePath: string
  tableName: string
}

export async function listTables(projectId: string): Promise<string[]> {
  const { prisma } = await import('@/lib/db/prisma')
  try {
    const tables = await prisma.table.findMany({
      where: { projectId },
      select: { name: true },
      orderBy: { name: 'asc' },
    })
    return tables.map((t: { name: string }) => t.name)
  } catch {
    return []
  }
}

export async function tableExists(projectId: string, tableName: string): Promise<boolean> {
  const { prisma } = await import('@/lib/db/prisma')
  try {
    const table = await prisma.table.findFirst({
      where: { projectId, name: tableName },
      select: { id: true },
    })
    return !!table
  } catch {
    return false
  }
}

export async function describeTable(projectId: string, tableName: string): Promise<TableInfo | null> {
  const { prisma } = await import('@/lib/db/prisma')
  try {
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

    const columns = await prisma.$queryRawUnsafe<any[]>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      postgresSchema, tableName
    )
    if (columns.length === 0) return null

    const fkRows = await (prisma.$queryRawUnsafe<any[]>(
      `SELECT kcu.column_name, ccu.table_name AS referenced_table
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1 AND kcu.table_name = $2`,
      postgresSchema, tableName
    ) as Promise<any[]>).catch((err: any) => { console.error('[SchemaTools] FK query failed:', err); return [] as any[] })

    const fkMap = new Map(fkRows.map((r: any) => [r.column_name, r.referenced_table]))

    return {
      name: tableName,
      columns: columns.map((col: any) => ({
        name: col.column_name,
        type: col.data_type,
        nullable: col.is_nullable === 'YES',
        foreignKey: fkMap.get(col.column_name) as string | undefined,
      })),
    }
  } catch {
    return null
  }
}

export async function listApis(projectId: string): Promise<ApiInfo[]> {
  // Agent-facing: this is what a coding agent is told the backend exposes.
  // It read ApiDefinition, which has had no create path since the PostgREST
  // cutover, so agents building against any modern project were told the
  // backend had no APIs at all.
  try {
    const { listExposedResources } = await import('@/lib/api/exposed-resources')
    const apis = await listExposedResources(projectId)
    return apis.map(a => ({ basePath: a.basePath, tableName: a.name }))
  } catch {
    return []
  }
}

export async function apiExistsForTable(projectId: string, tableName: string): Promise<boolean> {
  // "Is this table reachable over REST?" is a catalog question.
  try {
    const { listExposedResources } = await import('@/lib/api/exposed-resources')
    const apis = await listExposedResources(projectId)
    return apis.some(a => a.name.toLowerCase() === tableName.toLowerCase())
  } catch {
    return false
  }
}

/**
 * SEMANTIC CODE UNDERSTANDING (#9)
 * ==================================
 * Read the actual implementation of a generated API so the AI can understand
 * what's already built before suggesting changes.
 * Equivalent to Claude Code's "read file before editing" capability.
 */

export interface ApiImplementation {
  tableName: string
  basePath: string
  operations: {
    list: boolean
    get: boolean
    create: boolean
    update: boolean
    delete: boolean
    search: boolean
    bulk: boolean
  }
  authStrategy: string
  rateLimit: number
  enabled: boolean
}

export async function readApiImplementation(projectId: string, tableName: string): Promise<ApiImplementation | null> {
  // Per-operation flags were a property of the ApiDefinition projection. Under
  // PostgREST an exposed table serves the full CRUD set through the /db/* route
  // (which registers GET/POST/PUT/PATCH/DELETE), and restriction is expressed
  // as a Postgres grant rather than a JSON flag. The old code already defaulted
  // every CRUD op to true when the JSON was absent, so this reports the same
  // shape from the source that actually decides it.
  try {
    const { listExposedResources } = await import('@/lib/api/exposed-resources')
    const apis = await listExposedResources(projectId)
    const match = apis.find(a => a.name.toLowerCase() === tableName.toLowerCase())
    if (!match) return null

    return {
      tableName: match.name,
      basePath: match.basePath,
      operations: {
        list: true,
        get: true,
        create: true,
        update: true,
        delete: true,
        // Not plain CRUD: these have no PostgREST equivalent in this shape and
        // are refused by the data plane (see handleViaPostgrest).
        search: false,
        bulk: false,
      },
      authStrategy: 'jwt',
      rateLimit: 100,
      enabled: true,
    }
  } catch {
    return null
  }
}

export interface ProjectSnapshot {
  tables: Array<{
    name: string
    columnCount: number
    hasApi: boolean
    apiPath?: string
  }>
  authEnabled: boolean
  authProviders: string[]
  totalTables: number
  totalApis: number
}

/**
 * Full semantic snapshot of what's currently built in the project.
 * The AI calls this when a user says "fix X" or "change Y" — so it
 * reads what actually exists before reasoning about what to change.
 */
export async function getProjectSnapshot(projectId: string): Promise<ProjectSnapshot> {
  const { prisma } = await import('@/lib/db/prisma')
  try {
    const [tables, apis, authStatus] = await Promise.all([
      prisma.table.findMany({
        where: { projectId },
        select: { name: true },
        orderBy: { name: 'asc' },
      }),
      // Catalog, not the dead projection - otherwise every table in this
      // snapshot reports hasApi:false to whatever reads it.
      import('@/lib/api/exposed-resources').then(m => m.listExposedResources(projectId)),
      checkAuthStatus(projectId),
    ])

    const apiByTable = new Map(apis.map(a => [a.name, a.basePath]))

    return {
      tables: tables.map((t: { name: string }) => ({
        name: t.name,
        columnCount: 0, // Populated lazily — avoid N+1 for snapshots
        hasApi: apiByTable.has(t.name),
        apiPath: apiByTable.get(t.name),
      })),
      authEnabled: authStatus.enabled,
      authProviders: authStatus.providers,
      totalTables: tables.length,
      totalApis: apis.length,
    }
  } catch {
    return {
      tables: [],
      authEnabled: false,
      authProviders: [],
      totalTables: 0,
      totalApis: 0,
    }
  }
}

/**
 * Format a project snapshot as a concise text block for the AI system prompt.
 * Used when the user says "fix X" or "change Y" so the AI reads current state first.
 */
export function formatProjectSnapshot(snapshot: ProjectSnapshot): string {
  if (snapshot.totalTables === 0) return ''

  const lines: string[] = ['\n## CURRENT PROJECT STATE (semantic snapshot — read before suggesting changes)']
  lines.push(`Tables (${snapshot.totalTables}): ${snapshot.tables.map(t => t.name + (t.hasApi ? ' [API]' : '')).join(', ')}`)

  if (snapshot.authEnabled) {
    lines.push(`Auth: enabled (${snapshot.authProviders.join(', ') || 'email'})`)
  }

  lines.push(`APIs (${snapshot.totalApis}): ${snapshot.tables.filter(t => t.hasApi).map(t => t.apiPath || t.name).join(', ')}`)

  return lines.join('\n')
}

export async function checkAuthStatus(projectId: string): Promise<{ enabled: boolean; providers: string[] }> {
  const { prisma } = await import('@/lib/db/prisma')
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { authManifest: true },
    })
    const manifest = project?.authManifest as any
    if (!manifest?.enabled) return { enabled: false, providers: [] }

    const providers: string[] = []
    if (manifest.providers?.emailPassword?.enabled) providers.push('email')
    if (manifest.providers?.google?.enabled) providers.push('google')
    if (manifest.providers?.github?.enabled) providers.push('github')

    return { enabled: true, providers }
  } catch {
    return { enabled: false, providers: [] }
  }
}
