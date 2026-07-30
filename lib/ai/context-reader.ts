/**
 * CONTEXT READER
 * ==============
 * Reads actual project state before AI executes anything.
 * This is what makes AI "aware" instead of "blind".
 */

import { prisma } from '@/lib/db'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'

export interface ProjectContext {
  // Database state
  tables: Array<{
    name: string
    columns: Array<{
      name: string
      type: string
      nullable: boolean
      isPrimaryKey: boolean
    }>
    relationships: Array<{
      column: string
      referencesTable: string
      referencesColumn: string
    }>
  }>
  
  // API state
  apis: Array<{
    tableName: string
    basePath: string
    operations: string[]
  }>
  
  // Project metadata
  project: {
    id: string
    name: string
    databaseProvisioned: boolean
  }
}

/**
 * Read current project state from database
 * This makes AI context-aware
 */
export async function readProjectContext(projectId: string): Promise<ProjectContext> {
  console.log('📖 [Context Reader] Reading project state...')
  
  try {
    // Get project info
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
      },
    })
    
    if (!project) {
      throw new Error('Project not found')
    }
    
    // Check if database is provisioned
    const workspace = await prisma.workspace.findFirst({
      where: { projectId },
      select: { databaseProvisioned: true, postgresSchema: true },
    })
    
    const databaseProvisioned = workspace?.databaseProvisioned || false
    
    // Get tables from metadata
    const tables = await prisma.table.findMany({
      where: { projectId },
      select: {
        id: true,
        name: true,
        schema: true,
      },
    })
    
    // Get actual table structures from PostgreSQL
    const tablesWithStructure = await Promise.all(
      tables.map(async (table) => {
        try {
          const columns = await getTableColumns(projectId, table.name, table.schema)
          const relationships = await getTableRelationships(projectId, table.name, table.schema)
          
          return {
            name: table.name,
            columns: columns || [],
            relationships: relationships || [],
          }
        } catch (error) {
          console.error(`❌ [Context Reader] Error loading table ${table.name}:`, error)
          return {
            name: table.name,
            columns: [],
            relationships: [],
          }
        }
      })
    )
    
    // REST surface, from the catalog.
    //
    // This read ApiDefinition, which has no create path since the PostgREST
    // cutover, so the AI's context said the project had no APIs on every modern
    // project. An assistant reasoning from that will tell the user to build
    // what already exists.
    //
    // Operations are the CRUD set the /db/* route serves for any exposed table;
    // per-operation toggles were a property of the projection, and restriction
    // is a Postgres grant now.
    const { listExposedResources } = await import('@/lib/api/exposed-resources')
    const apis = (await listExposedResources(projectId)).map(a => ({
      tableName: a.name,
      basePath: a.basePath,
      operations: ['list', 'get', 'create', 'update', 'delete'],
    }))
    
    const context: ProjectContext = {
      tables: tablesWithStructure,
      apis,
      project: {
        id: project.id,
        name: project.name,
        databaseProvisioned,
      },
    }
    
    console.log('✅ [Context Reader] Context loaded:', {
      tables: context.tables.length,
      apis: context.apis.length,
    })
    
    return context
    
  } catch (error: any) {
    console.error('❌ [Context Reader] Error:', error)
    
    // Return empty context on error
    return {
      tables: [],
      apis: [],
      project: {
        id: projectId,
        name: 'Unknown',
        databaseProvisioned: false,
      },
    }
  }
}

/**
 * Get columns for a specific table
 */
async function getTableColumns(
  projectId: string,
  tableName: string,
  schema: string
): Promise<Array<{
  name: string
  type: string
  nullable: boolean
  isPrimaryKey: boolean
}>> {
  try {
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    const targetSchema = schema || postgresSchema
    
    // Query PostgreSQL information_schema
    const columns: any[] = await prisma.$queryRawUnsafe(`
      SELECT 
        column_name as "name",
        data_type as "type",
        is_nullable = 'YES' as "nullable",
        (SELECT COUNT(*) > 0 
         FROM information_schema.key_column_usage kcu
         JOIN information_schema.table_constraints tc 
           ON kcu.constraint_name = tc.constraint_name
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND kcu.table_schema = c.table_schema
           AND kcu.table_name = c.table_name
           AND kcu.column_name = c.column_name
        ) as "isPrimaryKey"
      FROM information_schema.columns c
      WHERE table_schema = '${targetSchema}'
        AND table_name = '${tableName}'
      ORDER BY ordinal_position
    `)
    
    return Array.isArray(columns) ? columns : []
    
  } catch (error) {
    console.error(`❌ Failed to get columns for ${tableName}:`, error)
    return []
  }
}

/**
 * Get relationships (foreign keys) for a table
 */
async function getTableRelationships(
  projectId: string,
  tableName: string,
  schema: string
): Promise<Array<{
  column: string
  referencesTable: string
  referencesColumn: string
}>> {
  try {
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    const targetSchema = schema || postgresSchema
    
    // Query foreign key constraints
    const relationships: any[] = await prisma.$queryRawUnsafe(`
      SELECT 
        kcu.column_name as "column",
        ccu.table_name as "referencesTable",
        ccu.column_name as "referencesColumn"
      FROM information_schema.key_column_usage kcu
      JOIN information_schema.table_constraints tc 
        ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu 
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND kcu.table_schema = '${targetSchema}'
        AND kcu.table_name = '${tableName}'
    `)
    
    return Array.isArray(relationships) ? relationships : []
    
  } catch (error) {
    console.error(`❌ Failed to get relationships for ${tableName}:`, error)
    return []
  }
}

/**
 * Check if table exists in project
 */
export async function tableExists(
  projectId: string,
  tableName: string
): Promise<boolean> {
  const context = await readProjectContext(projectId)
  return context.tables.some(t => t.name.toLowerCase() === tableName.toLowerCase())
}

/**
 * Check if API exists for table
 */
export async function apiExists(
  projectId: string,
  tableName: string
): Promise<boolean> {
  const context = await readProjectContext(projectId)
  return context.apis.some(a => a.tableName.toLowerCase() === tableName.toLowerCase())
}

/**
 * Get table structure
 */
export async function getTableStructure(
  projectId: string,
  tableName: string
) {
  const context = await readProjectContext(projectId)
  return context.tables.find(t => t.name.toLowerCase() === tableName.toLowerCase())
}
