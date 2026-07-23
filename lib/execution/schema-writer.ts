/**
 * Schema Writer - Generates REAL Prisma schema files
 * 
 * This is where simulation ends and reality begins.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { BackendStateGraph, EntityState } from '@/lib/orchestration/backend-state-graph'

export interface SchemaGenerationResult {
  success: boolean
  schemaPath: string
  schemaContent: string
  tablesGenerated: string[]
  error?: string
}

/**
 * Generate Prisma schema from BackendStateGraph
 * 
 * This creates REAL .prisma files that will be used for migrations
 */
export async function generatePrismaSchema(
  graph: BackendStateGraph,
  projectId: string
): Promise<SchemaGenerationResult> {
  try {
    console.log(`[Schema Writer] Generating Prisma schema for project: ${projectId}`)
    
    // Get workspace schema name
    const workspaceSchema = `workspace_${projectId}`
    console.log(`[Schema Writer] Using PostgreSQL schema: ${workspaceSchema}`)
    
    // Build schema content
    const schemaLines: string[] = []
    
    // Datasource with schema support
    schemaLines.push('datasource db {')
    schemaLines.push('  provider = "postgresql"')
    schemaLines.push('  url      = env("DATABASE_URL")')
    schemaLines.push(`  schemas  = ["public", "${workspaceSchema}"]`)
    schemaLines.push('}')
    schemaLines.push('')
    
    // Generator with multiSchema preview feature
    schemaLines.push('generator client {')
    schemaLines.push('  provider        = "prisma-client-js"')
    schemaLines.push('  previewFeatures = ["multiSchema"]')
    schemaLines.push('}')
    schemaLines.push('')
    
    // Generate models from graph entities
    const tablesGenerated: string[] = []
    
    for (const [entityName, entity] of Object.entries(graph.entities)) {
      tablesGenerated.push(entityName)
      
      schemaLines.push(`model ${capitalize(entityName)} {`)
      
      // Check which system fields already exist (handle both camelCase and snake_case)
      const entityFieldNames = Object.keys(entity.fields as Record<string, any>)
      const hasId = entityFieldNames.includes('id')
      const hasCreatedAt = entityFieldNames.includes('createdAt') || entityFieldNames.includes('created_at')
      const hasUpdatedAt = entityFieldNames.includes('updatedAt') || entityFieldNames.includes('updated_at')
      
      // Only add id field if not already present
      if (!hasId) {
        schemaLines.push('  id        String   @id @default(uuid())')
      }
      
      // Add entity fields — track output names to prevent duplicates
      const writtenFields = new Set<string>()

      for (const [fieldName, field] of Object.entries(entity.fields as Record<string, any>)) {
        const fieldDef = field as any
        const prismaType = mapToPrismaType(fieldDef.type as string)

        // Handle id field — always add @id @default(uuid()) regardless of fieldDef.primary
        if (fieldName === 'id') {
          if (!writtenFields.has('id')) {
            schemaLines.push(`  ${fieldName.padEnd(10)} ${prismaType}   @id @default(uuid())`)
            writtenFields.add('id')
          }
          continue
        }

        // Handle timestamp fields specially — normalise both snake_case and camelCase to camelCase
        if (fieldName === 'created_at' || fieldName === 'createdAt') {
          if (!writtenFields.has('createdAt')) {
            schemaLines.push(`  ${'createdAt'.padEnd(10)} DateTime @default(now())`)
            writtenFields.add('createdAt')
          }
          continue
        }
        if (fieldName === 'updated_at' || fieldName === 'updatedAt') {
          if (!writtenFields.has('updatedAt')) {
            schemaLines.push(`  ${'updatedAt'.padEnd(10)} DateTime @updatedAt`)
            writtenFields.add('updatedAt')
          }
          continue
        }

        // Skip any other field we've already written
        if (writtenFields.has(fieldName)) continue

        const nullable = fieldDef.nullable !== false ? '?' : ''
        const unique = fieldDef.unique ? ' @unique' : ''

        schemaLines.push(`  ${fieldName.padEnd(10)} ${prismaType}${nullable}${unique}`)
        writtenFields.add(fieldName)
      }
      
      // Only add timestamps if not already present
      if (!hasCreatedAt) {
        schemaLines.push('  createdAt DateTime @default(now())')
      }
      if (!hasUpdatedAt) {
        schemaLines.push('  updatedAt DateTime @updatedAt')
      }
      
      // CRITICAL: Specify the workspace-specific PostgreSQL schema
      schemaLines.push('')
      schemaLines.push(`  @@schema("${workspaceSchema}")`)
      schemaLines.push('}')
      schemaLines.push('')
    }
    
    const schemaContent = schemaLines.join('\n')
    
    // Write to workspace-specific schema file
    // IMPORTANT: Use the same path that workspaceDatabaseSetup expects
    const workspaceDir = path.join(process.cwd(), 'workspace', projectId, 'prisma')
    await fs.mkdir(workspaceDir, { recursive: true })
    
    const schemaPath = path.join(workspaceDir, 'schema.prisma')
    await fs.writeFile(schemaPath, schemaContent, 'utf-8')
    
    console.log(`[Schema Writer] ✅ Schema written to: ${schemaPath}`)
    console.log(`[Schema Writer] Generated ${tablesGenerated.length} tables: ${tablesGenerated.join(', ')}`)
    
    return {
      success: true,
      schemaPath,
      schemaContent,
      tablesGenerated,
    }
  } catch (error) {
    console.error('[Schema Writer] Failed to generate schema:', error)
    return {
      success: false,
      schemaPath: '',
      schemaContent: '',
      tablesGenerated: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Map graph field types to Prisma types
 */
function mapToPrismaType(graphType: string): string {
  const typeMap: Record<string, string> = {
    'string': 'String',
    'text': 'String',
    'number': 'Int',
    'integer': 'Int',
    'float': 'Float',
    'decimal': 'Decimal',
    'boolean': 'Boolean',
    'date': 'DateTime',
    'datetime': 'DateTime',
    'timestamp': 'DateTime',
    'json': 'Json',
    'uuid': 'String',
    'email': 'String',
    'url': 'String',
  }
  
  return typeMap[graphType.toLowerCase()] || 'String'
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}
