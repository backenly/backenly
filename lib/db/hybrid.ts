/**
 * Unified Hybrid Database Service
 * Manages both PostgreSQL and MongoDB operations
 */

import { prisma } from './postgres'
import { getMongoDB, getCollection } from './mongodb'
import { Prisma } from '@prisma/client'

// Types
export type DatabaseType = 'postgresql' | 'mongodb'

export interface TableInfo {
  schema?: string
  name: string
  rows?: number
  documents?: number
  size: string
  description?: string
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  primary?: boolean
  foreign?: boolean
  default?: string
  unique?: boolean
  indexed?: boolean
  description?: string
}

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
  type: string
}

export interface RelationshipInfo {
  name: string
  type: 'foreign_key' | 'reference'
  from: { table: string; column: string }
  to: { table: string; column: string }
}

export interface PaginationParams {
  page?: number
  limit?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  /** Free-text search applied across every column (case-insensitive ILIKE). */
  search?: string
}

export interface FilterParams {
  [key: string]: any
}

/**
 * PostgreSQL Operations
 */
export class PostgresService {
  /**
   * List all schemas
   */
  static async listSchemas(): Promise<string[]> {
    const callId = Math.random().toString(36).substring(7);
    console.log(`[${callId}] 🔄 PostgresService.listSchemas() called`);
    try {
      const result = await prisma.$queryRaw<Array<{ schema_name: string }>>`
        SELECT schema_name 
        FROM information_schema.schemata 
        WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        ORDER BY schema_name
      `
      const schemas = result.map((r) => r.schema_name);
      console.log(`[${callId}] ✅ PostgresService.listSchemas() returned ${schemas.length} schemas:`, schemas);
      return schemas;
    } catch (error: any) {
      console.error(`[${callId}] ❌ PostgresService.listSchemas() error:`, {
        message: error.message,
        code: error.code,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * List all tables in a schema (or all schemas)
   */
  static async listTables(schema?: string): Promise<TableInfo[]> {
    if (schema) {
      const result = await prisma.$queryRaw<Array<{
        table_schema: string
        table_name: string
        row_count: bigint
        table_size: string
      }>>`
        SELECT 
          t.table_schema,
          t.table_name,
          COALESCE(c.reltuples::bigint, 0) as row_count,
          pg_size_pretty(pg_total_relation_size(quote_ident(t.table_schema)||'.'||quote_ident(t.table_name))) as table_size
        FROM information_schema.tables t
        LEFT JOIN pg_class c ON c.relname = t.table_name
          AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.table_schema LIMIT 1)
        WHERE t.table_schema = ${schema}
          AND t.table_type = 'BASE TABLE'
        GROUP BY t.table_schema, t.table_name, c.reltuples
        ORDER BY t.table_name
      `
      // Additional deduplication to ensure no duplicates
      const seen = new Set<string>()
      return result
        .filter((r) => {
          const key = `${r.table_schema}.${r.table_name}`
          if (seen.has(key)) {
            return false
          }
          seen.add(key)
          return true
        })
        .map((r) => ({
          schema: r.table_schema,
          name: r.table_name,
          rows: Number(r.row_count),
          size: r.table_size,
        }))
    } else {
      const result = await prisma.$queryRaw<Array<{
        table_schema: string
        table_name: string
        row_count: bigint
        table_size: string
      }>>`
        SELECT 
          t.table_schema,
          t.table_name,
          COALESCE(c.reltuples::bigint, 0) as row_count,
          pg_size_pretty(pg_total_relation_size(quote_ident(t.table_schema)||'.'||quote_ident(t.table_name))) as table_size
        FROM information_schema.tables t
        LEFT JOIN pg_class c ON c.relname = t.table_name
          AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.table_schema LIMIT 1)
        WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND t.table_type = 'BASE TABLE'
        GROUP BY t.table_schema, t.table_name, c.reltuples
        ORDER BY t.table_schema, t.table_name
      `
      // Additional deduplication to ensure no duplicates
      const seen = new Set<string>()
      return result
        .filter((r) => {
          const key = `${r.table_schema}.${r.table_name}`
          if (seen.has(key)) {
            return false
          }
          seen.add(key)
          return true
        })
        .map((r) => ({
          schema: r.table_schema,
          name: r.table_name,
          rows: Number(r.row_count),
          size: r.table_size,
        }))
    }
  }

  /**
   * Get table columns/structure
   */
  static async getTableStructure(schema: string, tableName: string): Promise<ColumnInfo[]> {
    try {
      // First, check if the table exists in the schema
      // PostgreSQL stores schema names case-sensitively when quoted, but information_schema uses lowercase
      // We need to check both the exact case and lowercase versions
      const schemaExists = await prisma.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 
          FROM information_schema.tables 
          WHERE LOWER(table_schema) = LOWER(${schema})
            AND LOWER(table_name) = LOWER(${tableName})
            AND table_type = 'BASE TABLE'
        ) as exists
      `
      
      if (!schemaExists[0]?.exists) {
        console.warn('[PostgresService.getTableStructure] Table not found:', {
          schema,
          tableName,
          // Try to find what tables exist in this schema
        })
        
        // Try to find tables in the schema to help debug
        const tablesInSchema = await prisma.$queryRaw<Array<{ table_name: string }>>`
          SELECT table_name
          FROM information_schema.tables
          WHERE LOWER(table_schema) = LOWER(${schema})
            AND table_type = 'BASE TABLE'
          ORDER BY table_name
          LIMIT 10
        `
        console.log('[PostgresService.getTableStructure] Tables in schema:', {
          schema,
          tables: tablesInSchema.map(t => t.table_name),
        })
      }
      
      // Use case-insensitive comparison for schema and table names
      // information_schema stores identifiers in lowercase, but we need to handle
      // case-insensitive matching for user input
      // Use LOWER() in the WHERE clause for case-insensitive comparison
      const result = await prisma.$queryRaw<Array<{
        column_name: string
        data_type: string
        is_nullable: string
        column_default: string | null
        is_primary: boolean
        is_unique: boolean
        is_indexed: boolean
      }>>`
        SELECT 
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.column_default,
          CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary,
          CASE WHEN u.column_name IS NOT NULL THEN true ELSE false END as is_unique,
          CASE WHEN idx.column_name IS NOT NULL THEN true ELSE false END as is_indexed
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT ku.column_name, ku.table_schema, ku.table_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku
            ON tc.constraint_name = ku.constraint_name
            AND tc.table_schema = ku.table_schema
            AND tc.table_name = ku.table_name
          WHERE LOWER(tc.table_schema) = LOWER(${schema})
            AND LOWER(tc.table_name) = LOWER(${tableName})
            AND tc.constraint_type = 'PRIMARY KEY'
        ) pk ON c.column_name = pk.column_name 
          AND LOWER(c.table_schema) = LOWER(pk.table_schema)
          AND LOWER(c.table_name) = LOWER(pk.table_name)
        LEFT JOIN (
          SELECT ku.column_name, ku.table_schema, ku.table_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku
            ON tc.constraint_name = ku.constraint_name
            AND tc.table_schema = ku.table_schema
            AND tc.table_name = ku.table_name
          WHERE LOWER(tc.table_schema) = LOWER(${schema})
            AND LOWER(tc.table_name) = LOWER(${tableName})
            AND tc.constraint_type = 'UNIQUE'
        ) u ON c.column_name = u.column_name
          AND LOWER(c.table_schema) = LOWER(u.table_schema)
          AND LOWER(c.table_name) = LOWER(u.table_name)
        LEFT JOIN (
          SELECT a.attname as column_name
          FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          JOIN pg_class t ON t.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE LOWER(n.nspname) = LOWER(${schema}) AND LOWER(t.relname) = LOWER(${tableName})
        ) idx ON c.column_name = idx.column_name
        WHERE LOWER(c.table_schema) = LOWER(${schema})
          AND LOWER(c.table_name) = LOWER(${tableName})
        ORDER BY c.ordinal_position
      `
      
      let columns = result.map((r) => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === 'YES',
        primary: r.is_primary,
        unique: r.is_unique,
        indexed: r.is_indexed,
        default: r.column_default || undefined,
      }))
      
      // If no columns found, try querying pg_catalog directly as a fallback
      if (columns.length === 0) {
        console.warn('[PostgresService.getTableStructure] No columns found via information_schema, trying pg_catalog:', {
          schema,
          tableName,
        })
        
        try {
          const pgResult = await prisma.$queryRaw<Array<{
            column_name: string
            data_type: string
            is_nullable: boolean
            column_default: string | null
          }>>`
            SELECT 
              a.attname as column_name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
              NOT a.attnotnull as is_nullable,
              pg_get_expr(adbin, adrelid) as column_default
            FROM pg_catalog.pg_attribute a
            LEFT JOIN pg_catalog.pg_attrdef ad ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
            JOIN pg_catalog.pg_class t ON a.attrelid = t.oid
            JOIN pg_catalog.pg_namespace n ON t.relnamespace = n.oid
            WHERE LOWER(n.nspname) = LOWER(${schema})
              AND LOWER(t.relname) = LOWER(${tableName})
              AND a.attnum > 0
              AND NOT a.attisdropped
            ORDER BY a.attnum
          `
          
          columns = pgResult.map((r) => ({
            name: r.column_name,
            type: r.data_type,
            nullable: r.is_nullable,
            primary: false, // Would need additional query to determine
            unique: false, // Would need additional query to determine
            indexed: false, // Would need additional query to determine
            default: r.column_default || undefined,
          }))
          
          console.log('[PostgresService.getTableStructure] Found columns via pg_catalog:', {
            schema,
            tableName,
            columnCount: columns.length,
            columns: columns.map(c => c.name),
          })
        } catch (pgError: any) {
          console.error('[PostgresService.getTableStructure] Error querying pg_catalog:', {
            schema,
            tableName,
            error: pgError.message,
          })
        }
      }
      
      console.log('[PostgresService.getTableStructure] Final result:', {
        schema,
        tableName,
        columnCount: columns.length,
        columns: columns.map(c => c.name),
      })
      
      return columns
    } catch (error: any) {
      console.error('[PostgresService.getTableStructure] Error:', {
        schema,
        tableName,
        errorMessage: error.message,
        errorCode: error.code,
        errorName: error.name,
        errorMeta: error.meta,
        stack: error.stack,
      })
      throw new Error(
        `Failed to get table structure for ${schema}.${tableName}: ${error.message || 'Unknown error'}`
      )
    }
  }

  /**
   * Get table indexes
   */
  static async getTableIndexes(schema: string, tableName: string): Promise<IndexInfo[]> {
    const result = await prisma.$queryRaw<Array<{
      index_name: string
      column_names: string[]
      is_unique: boolean
      index_type: string
    }>>`
      SELECT
        i.relname as index_name,
        ARRAY_AGG(a.attname ORDER BY array_position(ix.indkey, a.attnum)) as column_names,
        ix.indisunique as is_unique,
        am.amname as index_type
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_am am ON am.oid = i.relam
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      WHERE n.nspname = ${schema}
        AND t.relname = ${tableName}
      GROUP BY i.relname, ix.indisunique, am.amname
      ORDER BY i.relname
    `
    return result.map((r) => ({
      name: r.index_name,
      columns: r.column_names,
      unique: r.is_unique,
      type: r.index_type,
    }))
  }

  /**
   * Get table relationships (foreign keys)
   */
  static async getTableRelationships(schema: string, tableName: string): Promise<RelationshipInfo[]> {
    const result = await prisma.$queryRaw<Array<{
      constraint_name: string
      from_column: string
      to_schema: string
      to_table: string
      to_column: string
    }>>`
      SELECT
        tc.constraint_name,
        kcu.column_name as from_column,
        ccu.table_schema as to_schema,
        ccu.table_name as to_table,
        ccu.column_name as to_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.table_schema = ${schema}
        AND tc.table_name = ${tableName}
        AND tc.constraint_type = 'FOREIGN KEY'
    `
    return result.map((r) => ({
      name: r.constraint_name,
      type: 'foreign_key' as const,
      from: { table: tableName, column: r.from_column },
      to: { table: r.to_table, column: r.to_column },
    }))
  }

  /**
   * Get table rows with pagination and filtering
   */
  static async getTableRows(
    schema: string,
    tableName: string,
    pagination: PaginationParams = {},
    filters: FilterParams = {}
  ): Promise<{ data: any[]; total: number; page: number; limit: number }> {
    const page = pagination.page || 1
    const limit = pagination.limit || 50
    const offset = (page - 1) * limit
    // Try to get a primary key or first column for sorting, default to no sort if none found
    let sortBy = pagination.sortBy
    const sortOrder = pagination.sortOrder || 'asc'

    // Escape schema and table names to prevent SQL injection
    const escapedSchema = `"${schema.replace(/"/g, '""')}"`
    const escapedTable = `"${tableName.replace(/"/g, '""')}"`
    
    // Build WHERE clause from filters using Prisma.sql for safety
    const filterConditions: Prisma.Sql[] = []

    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') {
        // Escape column name and use parameterized query
        const escapedKey = Prisma.raw(`"${key.replace(/"/g, '""')}"`)
        filterConditions.push(Prisma.sql`${escapedKey} = ${value}`)
      }
    }

    // Free-text search: match the term against every column (cast to text so it
    // works for numbers, dates, uuids, jsonb, etc.) with a case-insensitive
    // ILIKE. Parameterized, so the term itself is never interpolated into SQL.
    const searchTerm = (pagination.search || '').trim()
    let searchGroup: Prisma.Sql | null = null
    if (searchTerm) {
      const structure = await this.getTableStructure(schema, tableName)
      const like = `%${searchTerm}%`
      const perColumn = structure.map((col) => {
        const escapedCol = Prisma.raw(`"${col.name.replace(/"/g, '""')}"`)
        return Prisma.sql`${escapedCol}::text ILIKE ${like}`
      })
      if (perColumn.length > 0) {
        searchGroup = Prisma.sql`(${Prisma.join(perColumn, ' OR ')})`
      }
    }

    // Combine search + filters into a single WHERE clause (AND across groups).
    const whereParts: Prisma.Sql[] = []
    if (searchGroup) whereParts.push(searchGroup)
    if (filterConditions.length > 0) whereParts.push(...filterConditions)
    const whereClause = whereParts.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(whereParts, ' AND ')}`
      : null

    // Build ORDER BY clause
    let orderByClause: Prisma.Sql | null = null
    if (sortBy) {
      const escapedSortBy = Prisma.raw(`"${sortBy.replace(/"/g, '""')}"`)
      const sortOrderRaw = Prisma.raw(sortOrder.toUpperCase())
      orderByClause = Prisma.sql`ORDER BY ${escapedSortBy} ${sortOrderRaw}`
    }

    // Get total count
    const countQuery = whereClause
      ? Prisma.sql`SELECT COUNT(*) as count FROM ${Prisma.raw(escapedSchema)}.${Prisma.raw(escapedTable)} ${whereClause}`
      : Prisma.sql`SELECT COUNT(*) as count FROM ${Prisma.raw(escapedSchema)}.${Prisma.raw(escapedTable)}`
    
    const countResult = await prisma.$queryRaw<Array<{ count: bigint }>>(countQuery)
    const total = Number(countResult[0]?.count || 0)

    // Build the data query with pagination
    let dataQuery: Prisma.Sql
    if (whereClause && orderByClause) {
      dataQuery = Prisma.sql`SELECT * FROM ${Prisma.raw(escapedSchema)}.${Prisma.raw(escapedTable)} ${whereClause} ${orderByClause} LIMIT ${limit} OFFSET ${offset}`
    } else if (whereClause) {
      dataQuery = Prisma.sql`SELECT * FROM ${Prisma.raw(escapedSchema)}.${Prisma.raw(escapedTable)} ${whereClause} LIMIT ${limit} OFFSET ${offset}`
    } else if (orderByClause) {
      dataQuery = Prisma.sql`SELECT * FROM ${Prisma.raw(escapedSchema)}.${Prisma.raw(escapedTable)} ${orderByClause} LIMIT ${limit} OFFSET ${offset}`
    } else {
      dataQuery = Prisma.sql`SELECT * FROM ${Prisma.raw(escapedSchema)}.${Prisma.raw(escapedTable)} LIMIT ${limit} OFFSET ${offset}`
    }
    
    const data = await prisma.$queryRaw<any[]>(dataQuery)
    
    // Convert BigInt values to numbers for JSON serialization
    const serializedData = data.map(row => {
      const serialized: any = {}
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'bigint') {
          serialized[key] = Number(value)
        } else {
          serialized[key] = value
        }
      }
      return serialized
    })
    
    return { data: serializedData, total, page, limit }
  }

  /**
   * Insert a new row
   */
  static async insertRow(schema: string, tableName: string, data: Record<string, any>): Promise<any> {
    console.log('[PostgresService.insertRow] Input data:', data)
    
    // Get the table structure to know exact column names
    const columns = await this.getTableStructure(schema, tableName)
    const columnMap = new Map(columns.map((c: ColumnInfo) => [c.name.toLowerCase(), c.name]))  // Map lowercase to actual names
    
    console.log('[PostgresService.insertRow] Table columns:', columns.map((c: ColumnInfo) => c.name))
    
    // Add default values for timestamp columns if not provided
    const dataWithDefaults = { ...data }
    
    // Check if createdAt/updatedAt columns exist and add current timestamp if missing
    // Use the actual column names from the database
    const hasCreatedAt = columnMap.has('createdat')
    const hasUpdatedAt = columnMap.has('updatedat')
    const actualCreatedAtName = columnMap.get('createdat')
    const actualUpdatedAtName = columnMap.get('updatedat')
    
    if (hasCreatedAt && actualCreatedAtName && !dataWithDefaults[actualCreatedAtName] && !dataWithDefaults.createdat) {
      dataWithDefaults[actualCreatedAtName] = new Date()  // Use actual column name (e.g., createdAt)
    }
    if (hasUpdatedAt && actualUpdatedAtName && !dataWithDefaults[actualUpdatedAtName] && !dataWithDefaults.updatedat) {
      dataWithDefaults[actualUpdatedAtName] = new Date()  // Use actual column name (e.g., updatedAt)
    }
    
    console.log('[PostgresService.insertRow] Data with defaults:', dataWithDefaults)
    
    const columnList = Object.keys(dataWithDefaults).map(col => `"${col}"`)
    const values = Object.values(dataWithDefaults)
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')

    const escapedSchema = `"${schema}"`
    const escapedTable = `"${tableName}"`
    
    console.log('[PostgresService.insertRow] SQL:', `INSERT INTO ${escapedSchema}.${escapedTable} (${columnList.join(', ')}) VALUES (${placeholders})`)
    console.log('[PostgresService.insertRow] Values:', values)

    const result = await prisma.$queryRawUnsafe<any[]>(
      `INSERT INTO ${escapedSchema}.${escapedTable} (${columnList.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      ...values
    )

    return result[0]
  }

  /**
   * Update a row
   */
  static async updateRow(
    schema: string,
    tableName: string,
    id: any,
    data: Record<string, any>
  ): Promise<any> {
    const updates = Object.keys(data).map((key, i) => `"${key}" = $${i + 1}`).join(', ')
    const values = Object.values(data)
    const idValue = values.length + 1

    const escapedSchema = `"${schema}"`
    const escapedTable = `"${tableName}"`

    const result = await prisma.$queryRawUnsafe<any[]>(
      `UPDATE ${escapedSchema}.${escapedTable} SET ${updates} WHERE "id" = $${idValue} RETURNING *`,
      ...values,
      id
    )

    return result[0]
  }

  /**
   * Delete a row
   */
  static async deleteRow(schema: string, tableName: string, id: any): Promise<boolean> {
    const escapedSchema = `"${schema}"`
    const escapedTable = `"${tableName}"`

    const result = await prisma.$queryRawUnsafe<Array<{ id: any }>>(
      `DELETE FROM ${escapedSchema}.${escapedTable} WHERE "id" = $1 RETURNING "id"`,
      id
    )

    return result.length > 0
  }
}

/**
 * MongoDB Operations
 */
export class MongoService {
  /**
   * List all collections
   */
  static async listCollections(): Promise<TableInfo[]> {
    try {
      const db = await getMongoDB()
      const collections = await db.listCollections().toArray()

      const result: TableInfo[] = []
      for (const coll of collections) {
        const collection = db.collection(coll.name)
        const count = await collection.countDocuments()
        const stats = await db.command({ collStats: coll.name }).catch(() => null)
        const size = stats?.size ? this.formatBytes(stats.size) : '0 B'

        result.push({
          name: coll.name,
          documents: count,
          size,
        })
      }

      return result.sort((a, b) => a.name.localeCompare(b.name))
    } catch (error) {
      console.error('Error listing MongoDB collections:', error)
      return []
    }
  }

  /**
   * Get collection structure (sample document schema)
   */
  static async getCollectionStructure(collectionName: string): Promise<ColumnInfo[]> {
    try {
      const collection = await getCollection(collectionName)
      const sample = await collection.findOne({})

      if (!sample) {
        return []
      }

      // Infer schema from sample document
      const columns: ColumnInfo[] = []
      for (const [key, value] of Object.entries(sample)) {
        columns.push({
          name: key,
          type: this.inferMongoType(value),
          nullable: value === null || value === undefined,
          primary: key === '_id',
        })
      }

      return columns
    } catch (error) {
      console.error('Error getting collection structure:', error)
      return []
    }
  }

  /**
   * Get collection documents with pagination and filtering
   */
  static async getCollectionDocuments(
    collectionName: string,
    pagination: PaginationParams = {},
    filters: FilterParams = {}
  ): Promise<{ data: any[]; total: number; page: number; limit: number }> {
    try {
      const collection = await getCollection(collectionName)
      const page = pagination.page || 1
      const limit = pagination.limit || 50
      const skip = (page - 1) * limit

      // Build filter query
      const query: any = {}
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null && value !== '') {
          if (typeof value === 'string' && value.includes('*')) {
            // Simple wildcard support
            query[key] = { $regex: value.replace(/\*/g, '.*'), $options: 'i' }
          } else {
            query[key] = value
          }
        }
      }

      // Build sort
      const sort: any = {}
      if (pagination.sortBy) {
        sort[pagination.sortBy] = pagination.sortOrder === 'desc' ? -1 : 1
      }

      const [data, total] = await Promise.all([
        collection.find(query).sort(sort).skip(skip).limit(limit).toArray(),
        collection.countDocuments(query),
      ])

      return { data, total, page, limit }
    } catch (error) {
      console.error('Error getting collection documents:', error)
      return { data: [], total: 0, page: 1, limit: 50 }
    }
  }

  /**
   * Insert a new document
   */
  static async insertDocument(collectionName: string, data: Record<string, any>): Promise<any> {
    const collection = await getCollection(collectionName)
    const result = await collection.insertOne(data)
    return await collection.findOne({ _id: result.insertedId })
  }

  /**
   * Update a document
   */
  static async updateDocument(
    collectionName: string,
    id: string,
    data: Record<string, any>
  ): Promise<any> {
    const collection = await getCollection(collectionName)
    const { ObjectId } = await import('mongodb')
    const objectId: any = ObjectId.isValid(id) ? new ObjectId(id) : id
    await collection.updateOne({ _id: objectId }, { $set: data })
    return await collection.findOne({ _id: objectId })
  }

  /**
   * Delete a document
   */
  static async deleteDocument(collectionName: string, id: string): Promise<boolean> {
    const collection = await getCollection(collectionName)
    const { ObjectId } = await import('mongodb')
    const objectId: any = ObjectId.isValid(id) ? new ObjectId(id) : id
    const result = await collection.deleteOne({ _id: objectId })
    return result.deletedCount > 0
  }

  // Helper methods
  private static formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
  }

  private static inferMongoType(value: any): string {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    if (value instanceof Date) return 'date'
    if (typeof value === 'object') return 'object'
    return typeof value
  }
}

/**
 * Unified Hybrid Database Service
 */
export class HybridDatabase {
  /**
   * List schemas (PostgreSQL only)
   */
  static async listSchemas(dbType: DatabaseType): Promise<string[]> {
    if (dbType === 'postgresql') {
      return await PostgresService.listSchemas()
    } else {
      // MongoDB doesn't have schemas, return empty array
      return []
    }
  }

  /**
   * List schemas/tables/collections based on database type
   */
  static async listTables(dbType: DatabaseType, schema?: string): Promise<TableInfo[]> {
    if (dbType === 'postgresql') {
      return await PostgresService.listTables(schema)
    } else {
      return await MongoService.listCollections()
    }
  }

  /**
   * Get table/collection structure
   */
  static async getStructure(
    dbType: DatabaseType,
    schema: string | undefined,
    tableName: string
  ): Promise<ColumnInfo[]> {
    if (dbType === 'postgresql') {
      if (!schema) throw new Error('Schema is required for PostgreSQL')
      return await PostgresService.getTableStructure(schema, tableName)
    } else {
      return await MongoService.getCollectionStructure(tableName)
    }
  }

  /**
   * Get table indexes (PostgreSQL only)
   */
  static async getTableIndexes(schema: string, tableName: string): Promise<IndexInfo[]> {
    return await PostgresService.getTableIndexes(schema, tableName)
  }

  /**
   * Get table relationships (PostgreSQL only)
   */
  static async getTableRelationships(schema: string, tableName: string): Promise<RelationshipInfo[]> {
    return await PostgresService.getTableRelationships(schema, tableName)
  }

  /**
   * Get rows/documents with pagination
   */
  static async getRows(
    dbType: DatabaseType,
    schema: string | undefined,
    tableName: string,
    pagination: PaginationParams = {},
    filters: FilterParams = {}
  ): Promise<{ data: any[]; total: number; page: number; limit: number }> {
    if (dbType === 'postgresql') {
      if (!schema) throw new Error('Schema is required for PostgreSQL')
      return await PostgresService.getTableRows(schema, tableName, pagination, filters)
    } else {
      return await MongoService.getCollectionDocuments(tableName, pagination, filters)
    }
  }

  /**
   * Insert row/document
   */
  static async insertRow(
    dbType: DatabaseType,
    schema: string | undefined,
    tableName: string,
    data: Record<string, any>
  ): Promise<any> {
    if (dbType === 'postgresql') {
      if (!schema) throw new Error('Schema is required for PostgreSQL')
      return await PostgresService.insertRow(schema, tableName, data)
    } else {
      return await MongoService.insertDocument(tableName, data)
    }
  }

  /**
   * Update row/document
   */
  static async updateRow(
    dbType: DatabaseType,
    schema: string | undefined,
    tableName: string,
    id: any,
    data: Record<string, any>
  ): Promise<any> {
    if (dbType === 'postgresql') {
      if (!schema) throw new Error('Schema is required for PostgreSQL')
      return await PostgresService.updateRow(schema, tableName, id, data)
    } else {
      return await MongoService.updateDocument(tableName, id, data)
    }
  }

  /**
   * Delete row/document
   */
  static async deleteRow(
    dbType: DatabaseType,
    schema: string | undefined,
    tableName: string,
    id: any
  ): Promise<boolean> {
    if (dbType === 'postgresql') {
      if (!schema) throw new Error('Schema is required for PostgreSQL')
      return await PostgresService.deleteRow(schema, tableName, id)
    } else {
      return await MongoService.deleteDocument(tableName, id)
    }
  }
}

