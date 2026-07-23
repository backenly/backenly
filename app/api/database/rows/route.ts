export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { HybridDatabase, type DatabaseType } from '@/lib/db/hybrid'
import { prisma } from '@/lib/db'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import { getWorkspaceMongoDB } from '@/lib/services/workspaceDatabase'
import { invalidateTableStats } from '@/lib/services/workspace-table-stats'
import { z } from 'zod'

const querySchema = z.object({
  type: z.enum(['postgresql', 'mongodb']),
  schema: z.string().nullable().optional().transform((val) => (val && val.trim() ? val : undefined)),
  table: z.string().min(1),
  projectId: z.string().optional(),
  view: z.enum(['platform', 'workspace', 'all']).optional(),
  page: z.string().nullable().optional().transform((val) => {
    if (!val || val.trim() === '') return 1
    const parsed = parseInt(val, 10)
    return isNaN(parsed) ? 1 : parsed
  }),
  limit: z.string().nullable().optional().transform((val) => {
    if (!val || val.trim() === '') return 50
    const parsed = parseInt(val, 10)
    return isNaN(parsed) ? 50 : parsed
  }),
  sortBy: z.string().nullable().optional().transform((val) => (val && val.trim() ? val : undefined)),
  sortOrder: z.string().nullable().optional().transform((val) => {
    if (!val || val.trim() === '') return 'asc'
    const lower = val.toLowerCase().trim()
    return lower === 'desc' ? 'desc' : 'asc'
  }),
  search: z.string().nullable().optional().transform((val) => (val && val.trim() ? val.trim() : undefined)),
})

// GET /api/database/rows - Get rows/documents with pagination
export const GET = withProjectAccess(async (request: NextRequest, { user, project, projectId }) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const sortOrderParam = searchParams.get('sortOrder') || searchParams.get('sortorder') || 'asc'
    
    // Get table parameter - required
    const tableParam = searchParams.get('table')
    if (!tableParam) {
      return NextResponse.json(
        {
          success: false,
          error: 'Missing required parameter: table',
        },
        { status: 400 }
      )
    }
    
    const validated = querySchema.parse({
      type: searchParams.get('type') || 'postgresql',
      schema: searchParams.get('schema'),
      table: tableParam,
      projectId: searchParams.get('projectId') || undefined,
      view: searchParams.get('view') || 'workspace', // Default to workspace
      page: searchParams.get('page'),
      limit: searchParams.get('limit'),
      sortBy: searchParams.get('sortBy'),
      sortOrder: sortOrderParam,
      search: searchParams.get('search'),
    })

    // Extract filters from query params (everything except known params)
    const knownParams = ['type', 'schema', 'table', 'projectId', 'view', 'page', 'limit', 'sortBy', 'sortOrder', 'search']
    const filters: Record<string, any> = {}
    searchParams.forEach((value, key) => {
      if (!knownParams.includes(key) && value) {
        filters[key] = value
      }
    })

    let result: { data: any[]; total: number; page: number; limit: number }

    // At this point, project access is already verified by withProjectAccess middleware
    // If workspace schema is detected (starts with 'workspace_'), use workspace database
    const isWorkspaceSchema = validated.schema?.startsWith('workspace_')
    
    if (isWorkspaceSchema && validated.type === 'postgresql') {
      const expectedSchema = `workspace_${projectId}`
      if (validated.schema !== expectedSchema) {
        return NextResponse.json(
          {
            success: false,
            error: 'Invalid workspace schema for this project',
          },
          { status: 403 }
        )
      }
      
      // Use workspace-specific query for PostgreSQL - use PostgresService which handles schema properly
      const { PostgresService } = await import('@/lib/db/hybrid')
      try {
        result = await PostgresService.getTableRows(
          expectedSchema,
          validated.table,
          {
            page: validated.page,
            limit: validated.limit,
            sortBy: validated.sortBy,
            sortOrder: validated.sortOrder,
            search: validated.search,
          },
          filters
        )
      } catch (error: any) {
        // If table doesn't exist, return empty result instead of error
        if (error.message?.includes('does not exist') || error.message?.includes('relation') || error.message?.includes('schema')) {
          console.warn(`Table ${validated.table} not found in schema ${validated.schema}:`, error.message)
          result = {
            data: [],
            total: 0,
            page: validated.page || 1,
            limit: validated.limit || 50,
          }
        } else {
          throw error
        }
      }
    } else if (validated.view === 'workspace' && validated.type === 'mongodb') {
      // Use workspace-specific query for MongoDB
      const mongoDb = await getWorkspaceMongoDB(projectId)
      if (!mongoDb) {
        throw new Error('MongoDB workspace database not available')
      }
      
      const collection = mongoDb.collection(validated.table)
      const page = validated.page || 1
      const limit = validated.limit || 50
      const skip = (page - 1) * limit
      
      // Build filter query
      const mongoFilter: any = {}
      if (Object.keys(filters).length > 0) {
        Object.assign(mongoFilter, filters)
      }
      
      // Get total count
      const total = await collection.countDocuments(mongoFilter)
      
      // Build sort
      const sort: any = {}
      if (validated.sortBy) {
        sort[validated.sortBy] = validated.sortOrder === 'desc' ? -1 : 1
      } else {
        sort._id = 1
      }
      
      // Get paginated documents
      const documents = await collection
        .find(mongoFilter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .toArray()
      
      result = {
        data: documents,
        total,
        page,
        limit,
      }
    } else {
      // Use standard HybridDatabase for platform database
      result = await HybridDatabase.getRows(
        validated.type as DatabaseType,
        validated.schema,
        validated.table,
        {
          page: validated.page,
          limit: validated.limit,
          sortBy: validated.sortBy,
          sortOrder: validated.sortOrder,
          search: validated.search,
        },
        filters
      )
    }

    return NextResponse.json({
      success: true,
      data: result.data,
      pagination: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: Math.ceil(result.total / result.limit),
      },
    })
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      console.error('Validation error details:', error.errors)
      return NextResponse.json(
        {
          success: false,
          error: 'Validation error',
          details: error.errors,
          message: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
        },
        { status: 400 }
      )
    }

    console.error('Error fetching rows:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch rows',
        message: error.message,
      },
      { status: 500 }
    )
  }
});

// POST /api/database/rows - Insert a new row/document
export const POST = withProjectAccess(async (request: NextRequest, { user, project, projectId }) => {
  try {
    const body = await request.json()
    const { type, schema, table, data } = body

    if (!type || !table || !data) {
      return NextResponse.json(
        {
          success: false,
          error: 'Missing required fields: type, table, data',
        },
        { status: 400 }
      )
    }

    // Check if workspace schema (starts with 'workspace_')
    const isWorkspaceSchema = schema?.startsWith('workspace_')
    
    let result: any
    
    if (isWorkspaceSchema && type === 'postgresql') {
      const expectedSchema = `workspace_${projectId}`
      if (schema !== expectedSchema) {
        return NextResponse.json(
          {
            success: false,
            error: 'Invalid workspace schema for this project',
          },
          { status: 403 }
        )
      }
      
      // Use workspace-specific insert for PostgreSQL - use PostgresService which handles schema properly
      const { PostgresService } = await import('@/lib/db/hybrid')
      try {
        result = await PostgresService.insertRow(expectedSchema, table, data)
      } catch (error: any) {
        console.error('Error inserting row into workspace schema:', error)
        throw error
      }
    } else if (projectId && type === 'mongodb') {
      // Use workspace-specific insert for MongoDB
      const mongoDb = await getWorkspaceMongoDB(projectId)
      if (!mongoDb) {
        throw new Error('MongoDB workspace database not available')
      }
      
      const collection = mongoDb.collection(table)
      const insertResult = await collection.insertOne(data)
      result = { ...data, _id: insertResult.insertedId }
    } else {
      // Use standard HybridDatabase for platform database
      result = await HybridDatabase.insertRow(
        type as DatabaseType,
        schema,
        table,
        data
      )
    }

    // Bust the unified row-count cache so the dashboard "Database" card and
    // the inspector sidebar reflect the new row immediately, not on next mount.
    invalidateTableStats(projectId, table)

    return NextResponse.json(
      {
        success: true,
        data: result,
      },
      { status: 201 }
    )
  } catch (error: any) {
    console.error('Error inserting row:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to insert row',
        message: error.message,
      },
      { status: 500 }
    )
  }
});
