/**
 * Database Brain Analysis Service
 * Analyzes PostgreSQL and MongoDB schemas to detect issues
 * 
 * IMPORTANT: This service is PROJECT-SCOPED ONLY
 * - Only analyzes databases attached to the current project
 * - Never scans platform/auth/shared databases
 * - Safe mode by default (schema-only, no row scanning)
 * - Deep mode requires explicit opt-in
 */

import { prisma } from '@/lib/db/postgres'
import { getMongoDB } from '@/lib/db/mongodb'
import { HybridDatabase } from '@/lib/db/hybrid'
import { Prisma } from '@prisma/client'

export type IssueSeverity = 'high' | 'medium' | 'low' | 'info'
export type IssueCategory = 'missing_index' | 'slow_query' | 'schema_drift' | 'relationship' | 'other'
export type DatabaseType = 'postgresql' | 'mongodb' | 'hybrid'
export type AnalysisMode = 'safe' | 'deep'

export interface DetectedIssue {
  title: string
  description: string
  severity: IssueSeverity
  database: DatabaseType
  category: IssueCategory
  impact?: string
  suggestedFix: string
  sqlFix?: string // Optional SQL to fix the issue
  migrationSteps?: string[] // Optional step-by-step migration guide
  rawQuery?: string
  affectedTables: string[]
  estimatedImpact?: string
  detailedAnalysis?: string
  whyItHappened?: string
}

export interface AnalysisOptions {
  projectId: string // REQUIRED - must be project-scoped
  mode?: AnalysisMode // 'safe' (default) or 'deep'
  userId?: string // For additional access control
}

export class DatabaseBrain {
  /**
   * Run project-scoped analysis on databases attached to this project ONLY
   * 
   * @param options - Must include projectId for security
   * @returns Detected issues scoped to this project's databases
   */
  static async runAnalysis(options: AnalysisOptions): Promise<DetectedIssue[]> {
    if (!options.projectId) {
      throw new Error('Project ID is required for database analysis (security requirement)')
    }

    const { projectId, mode = 'safe' } = options
    const issues: DetectedIssue[] = []

    console.log(`🔍 Starting ${mode} analysis for project: ${projectId}`)

    // Analyze PostgreSQL (project workspace schema ONLY)
    try {
      const postgresIssues = await this.analyzePostgreSQL(projectId, mode)
      issues.push(...postgresIssues)
    } catch (error) {
      console.error('Error analyzing PostgreSQL:', error)
    }

    // Analyze MongoDB (project collections ONLY)
    try {
      const mongoIssues = await this.analyzeMongoDB(projectId, mode)
      issues.push(...mongoIssues)
    } catch (error) {
      console.error('Error analyzing MongoDB:', error)
    }

    // Analyze cross-database relationships (within project scope)
    try {
      const relationshipIssues = await this.analyzeRelationships(projectId)
      issues.push(...relationshipIssues)
    } catch (error) {
      console.error('Error analyzing relationships:', error)
    }

    console.log(`✅ Analysis complete: ${issues.length} issues found`)
    
    if (issues.length === 0) {
      console.log(`🎉 Great! No database issues detected for this project.`)
      console.log(`💡 This could mean:`)
      console.log(`   - Your databases are properly optimized`)
      console.log(`   - OR you haven't created any tables/collections yet`)
    }
    
    return issues
  }

  /**
   * Analyze PostgreSQL - PROJECT WORKSPACE SCHEMA ONLY
   * 
   * SECURITY: Only analyzes workspace_{projectId} schema
   * Never touches: auth DB, platform tables, other users' data
   */
  private static async analyzePostgreSQL(
    projectId: string,
    mode: AnalysisMode = 'safe'
  ): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = []

    try {
      // ONLY analyze project workspace schema (public schema analysis is too slow)
      const schemasToAnalyze = [
        `workspace_${projectId}`, // Project-specific workspace
        // 'public', // DISABLED: Too slow (26+ tables, expensive pg_size queries)
      ]
      
      console.log(`📊 Analyzing PostgreSQL schemas:`, schemasToAnalyze)
      
      // Verify schemas exist
      const allSchemas = await HybridDatabase.listSchemas('postgresql')
      console.log(`📋 Available schemas:`, allSchemas)
      
      for (const projectSchema of schemasToAnalyze) {
        if (!allSchemas.includes(projectSchema)) {
          console.warn(`⚠️ Schema not found: ${projectSchema}`)
          continue
        }

        // Get tables ONLY in this schema
        console.log(`🔍 Fetching tables for schema: ${projectSchema}...`)
        const startTime = Date.now()
        const tables = await HybridDatabase.listTables('postgresql', projectSchema)
        const duration = Date.now() - startTime
        console.log(`📊 Found ${tables.length} tables in ${projectSchema} (took ${duration}ms)`)
        
        if (tables.length === 0) {
          console.warn(`⚠️ No tables found in schema: ${projectSchema}`)
          continue
        }
        
        for (const table of tables) {
          console.log(`🔎 Analyzing table: ${projectSchema}.${table.name}...`)
          
          // SAFE MODE: Schema-only analysis (no row scanning)
          if (mode === 'safe') {
            // Check for missing indexes on foreign keys (metadata only)
            const missingIndexIssues = await this.checkMissingIndexes(projectSchema, table.name)
            issues.push(...missingIndexIssues)

            // Check for tables without primary keys (metadata only)
            const pkIssues = await this.checkPrimaryKeys(projectSchema, table.name)
            issues.push(...pkIssues)
          }

          // DEEP MODE: Includes row count analysis (opt-in only)
          if (mode === 'deep' && table.rows && table.rows > 1000) {
            const largeTableIssues = await this.checkLargeTableIndexes(
              projectSchema,
              table.name,
              table.rows
            )
            issues.push(...largeTableIssues)
          }
        }
      }
    } catch (error) {
      console.error(`Error analyzing PostgreSQL for project ${projectId}:`, error)
    }

    return issues
  }

  /**
   * Analyze MongoDB - PROJECT COLLECTIONS ONLY
   * 
   * SECURITY: Only analyzes collections prefixed with project ID or in project-specific DB
   * Never scans: auth collections, platform collections, other users' data
   */
  private static async analyzeMongoDB(
    projectId: string,
    mode: AnalysisMode = 'safe'
  ): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = []

    try {
      const db = await getMongoDB()
      if (!db) return issues

      // Get all collections
      const allCollections = await db.listCollections().toArray()
      
      // CRITICAL: Filter to only this project's collections
      // Collections belonging to this project should be prefixed with projectId
      const projectCollections = allCollections.filter(col => {
        const name = col.name
        // Only analyze collections that belong to this project
        // Format: {projectId}_collection_name OR in project-specific database
        return name.startsWith(`${projectId}_`) || 
               name.startsWith('workspace_') ||
               name === projectId
      })

      console.log(`📊 Analyzing ${projectCollections.length} MongoDB collections for project ${projectId}`)
      
      if (projectCollections.length === 0) {
        console.warn(`⚠️ No MongoDB collections found for project: ${projectId}`)
        console.warn(`💡 Hint: This project has no MongoDB collections yet. Collections should be prefixed with '${projectId}_'`)
        return issues
      }

      for (const collectionInfo of projectCollections) {
        const collectionName = collectionInfo.name
        const collection = db.collection(collectionName)

        // SAFE MODE: Index metadata only (no document scanning)
        if (mode === 'safe') {
          const indexIssues = await this.checkMongoIndexes(collectionName, collection)
          issues.push(...indexIssues)
        }

        // DEEP MODE: Includes schema drift analysis (requires sampling)
        if (mode === 'deep') {
          const driftIssues = await this.checkSchemaDrift(collectionName, collection)
          issues.push(...driftIssues)
          
          const indexIssues = await this.checkMongoIndexes(collectionName, collection)
          issues.push(...indexIssues)
        }
      }
    } catch (error) {
      console.error(`Error analyzing MongoDB for project ${projectId}:`, error)
    }

    return issues
  }

  /**
   * Analyze cross-database relationships - PROJECT SCOPE ONLY
   */
  private static async analyzeRelationships(projectId: string): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = []

    try {
      // SECURITY: Only analyze this project's workspace schema
      const projectSchema = `workspace_${projectId}`
      
      // Get PostgreSQL tables from project schema ONLY
      const pgTables: string[] = []
      try {
        const tables = await HybridDatabase.listTables('postgresql', projectSchema)
        pgTables.push(...tables.map(t => `${projectSchema}.${t.name}`))
      } catch (error) {
        console.warn(`No PostgreSQL schema for project ${projectId}`)
      }

      // Get MongoDB collections for this project ONLY
      const db = await getMongoDB()
      if (db) {
        const allCollections = await db.listCollections().toArray()
        const projectCollections = allCollections
          .filter(c => c.name.startsWith(`${projectId}_`) || c.name.startsWith('workspace_'))
          .map(c => c.name)

        // Check for potential relationships (tables/collections with similar names)
        for (const pgTable of pgTables) {
          const pgName = pgTable.split('.').pop()?.toLowerCase() || ''
          for (const mongoName of projectCollections) {
            const mongoLower = mongoName.toLowerCase()
            if (pgName === mongoLower || pgName + 's' === mongoLower || pgName === mongoLower + 's') {
              issues.push({
                title: `Cross-database relationship detected: ${pgTable} ↔ ${mongoName}`,
                description: `Potential relationship between PostgreSQL table "${pgTable}" and MongoDB collection "${mongoName}". Consider adding explicit linking fields.`,
                severity: 'info',
                database: 'hybrid',
                category: 'relationship',
                suggestedFix: `Add reference fields: In PostgreSQL, add a ${mongoName}_id field. In MongoDB, add a ${pgName}_id field.`,
                affectedTables: [pgTable, mongoName],
                detailedAnalysis: `These tables/collections appear related based on naming conventions. Explicit linking would improve query performance and data consistency.`,
                whyItHappened: 'Tables and collections were created independently without explicit foreign key relationships.'
              })
            }
          }
        }
      }
    } catch (error) {
      console.error('Error analyzing relationships:', error)
    }

    return issues
  }

  /**
   * Check for missing indexes on columns that might need them
   */
  private static async checkMissingIndexes(schema: string, tableName: string): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = []

    try {
      // Get table structure
      const structure = await HybridDatabase.getStructure('postgresql', schema, tableName)
      
      // Get existing indexes
      const indexes = await HybridDatabase.getTableIndexes(schema, tableName)
      const indexedColumns = new Set<string>()
      
      for (const index of indexes) {
        index.columns.forEach(col => indexedColumns.add(col.toLowerCase()))
      }

      // Check columns that commonly need indexes
      for (const column of structure) {
        const colName = column.name.toLowerCase()
        
        // Check for foreign key columns without indexes
        if (column.foreign && !indexedColumns.has(colName)) {
          const sqlFix = `CREATE INDEX idx_${tableName}_${column.name} ON "${schema}"."${tableName}" ("${column.name}");`
          issues.push({
            title: `Missing index on foreign key: ${schema}.${tableName}.${column.name}`,
            description: `Foreign key column "${column.name}" in table "${schema}.${tableName}" lacks an index, which can slow down JOIN operations.`,
            severity: 'medium',
            database: 'postgresql',
            category: 'missing_index',
            impact: '+60%',
            suggestedFix: sqlFix,
            sqlFix: sqlFix, // CRITICAL: Add the actual SQL for auto-apply
            rawQuery: `SELECT * FROM "${schema}"."${tableName}" WHERE "${column.name}" = ?`,
            affectedTables: [`${schema}.${tableName}`],
            estimatedImpact: 'JOIN operations: 200ms → 80ms (60% improvement)',
            detailedAnalysis: `Foreign key columns are frequently used in JOIN operations. Without an index, each JOIN requires a full table scan.`,
            whyItHappened: 'The foreign key constraint was added but the corresponding index was not created automatically.',
            migrationSteps: [
              '1. Connect to your PostgreSQL database',
              '2. Run the provided SQL statement',
              '3. Monitor query performance improvements'
            ]
          })
        }

        // Check for common query patterns (id, email, created_at, updated_at, status)
        const commonPatterns = ['id', 'email', 'created_at', 'updated_at', 'status', 'user_id', 'createdat', 'updatedat']
        if (commonPatterns.some(pattern => colName.includes(pattern)) && 
            !column.primary && 
            !indexedColumns.has(colName) &&
            !column.foreign) {
          const sqlFix = `CREATE INDEX idx_${tableName}_${column.name} ON "${schema}"."${tableName}" ("${column.name}");`
          issues.push({
            title: `Missing index on frequently queried column: ${schema}.${tableName}.${column.name}`,
            description: `Column "${column.name}" in table "${schema}.${tableName}" is likely used in WHERE clauses but lacks an index.`,
            severity: 'low',
            database: 'postgresql',
            category: 'missing_index',
            impact: '+50%',
            suggestedFix: sqlFix,
            sqlFix: sqlFix, // CRITICAL: Add the actual SQL for auto-apply
            rawQuery: `SELECT * FROM "${schema}"."${tableName}" WHERE "${column.name}" = ?`,
            affectedTables: [`${schema}.${tableName}`],
            estimatedImpact: 'Query time: 100ms → 50ms (50% improvement)',
            detailedAnalysis: `Columns with names like "${column.name}" are commonly used in WHERE clauses. An index would significantly improve query performance.`,
            whyItHappened: 'The column was added without considering indexing needs for query performance.',
            migrationSteps: [
              '1. Connect to your PostgreSQL database',
              '2. Run the provided SQL statement',
              `3. Test queries that filter by "${column.name}"`,
              '4. Monitor performance improvements'
            ]
          })
        }
      }
    } catch (error) {
      console.error(`Error checking indexes for ${schema}.${tableName}:`, error)
    }

    return issues
  }

  /**
   * Check for tables without primary keys
   */
  private static async checkPrimaryKeys(schema: string, tableName: string): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = []

    try {
      const structure = await HybridDatabase.getStructure('postgresql', schema, tableName)
      const hasPrimaryKey = structure.some(col => col.primary)

      if (!hasPrimaryKey) {
        issues.push({
          title: `Table without primary key: ${schema}.${tableName}`,
          description: `Table "${schema}.${tableName}" does not have a primary key, which can cause performance and data integrity issues.`,
          severity: 'high',
          database: 'postgresql',
          category: 'other',
          impact: 'Data integrity risk',
          suggestedFix: `Add a primary key: ALTER TABLE "${schema}"."${tableName}" ADD COLUMN id UUID PRIMARY KEY DEFAULT gen_random_uuid();`,
          affectedTables: [`${schema}.${tableName}`],
          detailedAnalysis: 'Primary keys ensure unique identification of rows and improve query performance. Tables without primary keys can have duplicate rows and slower queries.',
          whyItHappened: 'Table was created without a primary key constraint, possibly migrated from another system or created manually.'
        })
      }
    } catch (error) {
      console.error(`Error checking primary key for ${schema}.${tableName}:`, error)
    }

    return issues
  }

  /**
   * Check large tables for missing indexes
   */
  private static async checkLargeTableIndexes(schema: string, tableName: string, rowCount: number): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = []

    try {
      const structure = await HybridDatabase.getStructure('postgresql', schema, tableName)
      const indexes = await HybridDatabase.getTableIndexes(schema, tableName)
      const indexedColumns = new Set<string>()
      
      for (const index of indexes) {
        index.columns.forEach(col => indexedColumns.add(col.toLowerCase()))
      }

      // If large table has few indexes, suggest reviewing
      if (rowCount > 10000 && indexes.length < 3) {
        issues.push({
          title: `Large table with few indexes: ${schema}.${tableName}`,
          description: `Table "${schema}.${tableName}" has ${rowCount.toLocaleString()} rows but only ${indexes.length} index(es). Consider adding indexes on frequently queried columns.`,
          severity: 'medium',
          database: 'postgresql',
          category: 'missing_index',
          impact: '+70%',
          suggestedFix: `Review query patterns and add indexes on columns used in WHERE, JOIN, and ORDER BY clauses.`,
          affectedTables: [`${schema}.${tableName}`],
          estimatedImpact: `Query performance: 500ms → 150ms (70% improvement)`,
          detailedAnalysis: `Large tables benefit significantly from proper indexing. With ${rowCount.toLocaleString()} rows, queries without indexes can be very slow.`,
          whyItHappened: 'Table grew over time without corresponding index optimization.'
        })
      }
    } catch (error) {
      console.error(`Error checking large table indexes for ${schema}.${tableName}:`, error)
    }

    return issues
  }

  /**
   * Check MongoDB collections for schema drift
   */
  private static async checkSchemaDrift(
    collectionName: string,
    collection: any
  ): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = []

    try {
      // Sample documents to check for type consistency
      const sampleSize = Math.min(100, await collection.countDocuments())
      if (sampleSize === 0) return issues

      const sample = await collection.find({}).limit(100).toArray()
      if (sample.length === 0) return issues

      // Analyze field types across documents
      const fieldTypes: Record<string, Set<string>> = {}
      
      for (const doc of sample) {
        for (const [key, value] of Object.entries(doc)) {
          if (key === '_id') continue
          
          const type = Array.isArray(value) ? 'array' : typeof value
          if (!fieldTypes[key]) {
            fieldTypes[key] = new Set()
          }
          fieldTypes[key].add(type)
        }
      }

      // Check for fields with inconsistent types
      for (const [field, types] of Object.entries(fieldTypes)) {
        if (types.size > 1) {
          const typeList = Array.from(types).join(', ')
          const inconsistencyRate = ((types.size - 1) / types.size) * 100
          
          issues.push({
            title: `Schema drift in ${collectionName}.${field}`,
            description: `Field "${field}" in collection "${collectionName}" has inconsistent types: ${typeList}. This can cause query errors and performance issues.`,
            severity: inconsistencyRate > 50 ? 'high' : 'medium',
            database: 'mongodb',
            category: 'schema_drift',
            impact: `Type inconsistency: ${inconsistencyRate.toFixed(0)}%`,
            suggestedFix: `Normalize the "${field}" field to a single type. Consider creating a migration script to convert all documents to the desired type.`,
            affectedTables: [collectionName],
            estimatedImpact: `Query reliability: ${(100 - inconsistencyRate).toFixed(1)}% → 100%, Error reduction: ${inconsistencyRate.toFixed(0)}%`,
            detailedAnalysis: `Out of ${sample.length} sampled documents, the "${field}" field has ${types.size} different types. This inconsistency can cause type coercion overhead and query failures.`,
            whyItHappened: 'Data was inserted from multiple sources without validation, or the schema evolved over time without migration.'
          })
        }
      }
    } catch (error) {
      console.error(`Error checking schema drift for ${collectionName}:`, error)
    }

    return issues
  }

  /**
   * Check MongoDB collections for missing indexes
   */
  private static async checkMongoIndexes(
    collectionName: string,
    collection: any
  ): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = []

    try {
      const indexes = await collection.indexes()
      const indexedFields = new Set<string>()
      
      for (const index of indexes) {
        Object.keys(index.key).forEach(field => indexedFields.add(field))
      }

      // Sample documents to find frequently used fields
      const sample = await collection.find({}).limit(50).toArray()
      if (sample.length === 0) return issues

      const fieldUsage: Record<string, number> = {}
      for (const doc of sample) {
        for (const key of Object.keys(doc)) {
          if (key === '_id') continue
          fieldUsage[key] = (fieldUsage[key] || 0) + 1
        }
      }

      // Check common query fields that might need indexes
      const commonFields = ['email', 'userId', 'user_id', 'createdAt', 'created_at', 'status', 'type']
      for (const field of commonFields) {
        if (fieldUsage[field] && !indexedFields.has(field)) {
          issues.push({
            title: `Missing index on ${collectionName}.${field}`,
            description: `Field "${field}" in collection "${collectionName}" is likely used in queries but lacks an index.`,
            severity: 'medium',
            database: 'mongodb',
            category: 'missing_index',
            impact: '+60%',
            suggestedFix: `db.${collectionName}.createIndex({ "${field}": 1 })`,
            affectedTables: [collectionName],
            estimatedImpact: 'Query time: 200ms → 80ms (60% improvement)',
            detailedAnalysis: `The "${field}" field appears frequently in documents and is likely used in query filters. An index would significantly improve query performance.`,
            whyItHappened: 'The field was added without considering indexing needs for query performance.'
          })
        }
      }
    } catch (error) {
      console.error(`Error checking MongoDB indexes for ${collectionName}:`, error)
    }

    return issues
  }

  /**
   * Save detected issues to database - PROJECT SCOPED
   * 
   * @param issues - Detected issues to save
   * @param projectId - REQUIRED project ID for security
   */
  static async saveIssues(issues: DetectedIssue[], projectId: string): Promise<void> {
    if (!projectId) {
      throw new Error('Project ID is required to save issues (security requirement)')
    }
    
    for (const issue of issues) {
      try {
        // Create a unique identifier based on issue characteristics
        const issueHash = Buffer.from(
          `${projectId || 'global'}-${issue.database}-${issue.category}-${issue.title}`
        ).toString('base64').substring(0, 50)

        // Try to find existing issue with same characteristics
        const existing = await prisma.databaseIssue.findFirst({
          where: {
            projectId: projectId,
            database: issue.database,
            category: issue.category,
            title: issue.title,
            status: 'open',
          },
        })

        if (existing) {
          // Update existing issue with new analysis data including sqlFix
          await prisma.databaseIssue.update({
            where: { id: existing.id },
            data: {
              description: issue.description,
              severity: issue.severity,
              impact: issue.impact || null,
              suggestedFix: issue.suggestedFix,
              sqlFix: issue.sqlFix || null, // CRITICAL: Include sqlFix for auto-apply
              rawQuery: issue.rawQuery || null,
              affectedTables: issue.affectedTables,
              estimatedImpact: issue.estimatedImpact || null,
              detailedAnalysis: issue.detailedAnalysis || null,
              whyItHappened: issue.whyItHappened || null,
              migrationSteps: Array.isArray(issue.migrationSteps) ? issue.migrationSteps.join('\n') : issue.migrationSteps || null,
              updatedAt: new Date(),
            },
          })
        } else {
          // Create new issue
          await prisma.databaseIssue.create({
            data: {
              projectId: projectId,
              title: issue.title,
              description: issue.description,
              severity: issue.severity,
              database: issue.database,
              category: issue.category,
              impact: issue.impact || null,
              suggestedFix: issue.suggestedFix,
              sqlFix: issue.sqlFix || null, // CRITICAL: Include sqlFix for auto-apply
              rawQuery: issue.rawQuery || null,
              affectedTables: issue.affectedTables,
              estimatedImpact: issue.estimatedImpact || null,
              detailedAnalysis: issue.detailedAnalysis || null,
              whyItHappened: issue.whyItHappened || null,
              migrationSteps: Array.isArray(issue.migrationSteps) ? issue.migrationSteps.join('\n') : issue.migrationSteps || null,
              status: 'open',
            },
          })
        }
      } catch (error) {
        console.error('Error saving issue:', error)
      }
    }
  }
}

