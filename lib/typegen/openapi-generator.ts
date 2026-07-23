/**
 * OPENAPI 3.0 SPEC GENERATOR
 * ===========================
 * Auto-generates an OpenAPI 3.0 specification from:
 *   - Workspace schema tables (via schema-reader)
 *   - API definitions stored in the ApiDefinition model
 *
 * Output can be:
 *   - Returned as JSON (for Swagger UI / Redoc embed)
 *   - Downloaded as openapi.json (for Postman / Insomnia import)
 *   - Used to generate client SDKs via openapi-generator-cli
 *
 * Spec is importable into Postman via: Import → Link → paste the download URL
 */

import type { WorkspaceSchema, TableSchema, ColumnInfo } from './schema-reader'
import { pgTypeToTs } from './type-generator'
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from '@/lib/api/v1/schemas'

// ── PG type → OpenAPI schema type mapping ─────────────────────────────────────

interface OpenApiSchema {
  type?: string
  format?: string
  nullable?: boolean
  description?: string
  readOnly?: boolean
  default?: unknown
  items?: OpenApiSchema
  $ref?: string
}

function pgColToOpenApiSchema(col: ColumnInfo): OpenApiSchema {
  const nullable = col.isNullable

  // Arrays
  if (col.dataType === 'ARRAY') {
    const elementUdt = col.udtName.startsWith('_') ? col.udtName.slice(1) : col.udtName
    return { type: 'array', items: pgColToOpenApiSchema({ ...col, dataType: elementUdt, udtName: elementUdt }), nullable }
  }

  const pgType = col.dataType.toLowerCase()

  if (['integer', 'int', 'int2', 'int4', 'smallint'].includes(pgType)) {
    return { type: 'integer', format: 'int32', nullable }
  }
  if (['int8', 'bigint', 'bigserial'].includes(pgType)) {
    return { type: 'integer', format: 'int64', nullable }
  }
  if (['numeric', 'decimal', 'real', 'float4', 'float8', 'double precision', 'money'].includes(pgType)) {
    return { type: 'number', nullable }
  }
  if (['boolean', 'bool'].includes(pgType)) {
    return { type: 'boolean', nullable }
  }
  if (pgType === 'uuid') {
    return { type: 'string', format: 'uuid', nullable }
  }
  if (pgType === 'date') {
    return { type: 'string', format: 'date', nullable }
  }
  if (pgType.includes('timestamp') || pgType === 'timestamptz') {
    return { type: 'string', format: 'date-time', nullable }
  }
  if (pgType.includes('time')) {
    return { type: 'string', format: 'time', nullable }
  }
  if (pgType === 'json' || pgType === 'jsonb') {
    return { type: 'object', nullable }
  }
  if (pgType === 'bytea') {
    return { type: 'string', format: 'byte', nullable }
  }

  // Default: string
  return { type: 'string', nullable }
}

function toPascalCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase()).replace(/^[a-z]/, c => c.toUpperCase())
}

// ── Build OpenAPI schema objects for a table ──────────────────────────────────

const AUTO_COLS = new Set(['id', 'created_at', 'updated_at', 'deleted_at'])

function buildSchemaObject(table: TableSchema, mode: 'row' | 'insert' | 'update') {
  const properties: Record<string, OpenApiSchema> = {}
  const required: string[] = []

  for (const col of table.columns) {
    const schema = pgColToOpenApiSchema(col)

    if (col.isPrimaryKey || AUTO_COLS.has(col.columnName)) {
      schema.readOnly = true
      if (mode !== 'row') continue  // omit from insert/update
    }

    if (mode === 'update') {
      // All fields optional in update
    } else if (mode === 'insert') {
      if (!col.isNullable && col.columnDefault === null && !col.isPrimaryKey) {
        required.push(col.columnName)
      }
    }

    properties[col.columnName] = schema
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

// ── OpenAPI path items for one table ─────────────────────────────────────────

function buildTablePaths(
  table: TableSchema,
  projectId: string,
  apiKey: string
): Record<string, unknown> {
  const name = table.tableName
  const pascal = toPascalCase(name)
  const basePath = `/api/v1/${projectId}/database`
  const paths: Record<string, unknown> = {}

  // GET list
  paths[`${basePath}/query`] = {
    get: {
      tags: [pascal],
      summary: `List ${name}`,
      operationId: `list${pascal}`,
      security: [{ ApiKeyAuth: [] }],
      parameters: [
        { name: 'table', in: 'query', required: true, schema: { type: 'string', enum: [name] } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: PAGINATION_DEFAULT_LIMIT, maximum: PAGINATION_MAX_LIMIT } },
        { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        { name: 'cursor', in: 'query', description: 'Cursor value for efficient pagination on large tables', schema: { type: 'string' } },
        { name: 'cursorColumn', in: 'query', description: 'Column to use for cursor pagination (default: id)', schema: { type: 'string', default: 'id' } },
        { name: 'sort', in: 'query', schema: { type: 'string', default: 'id' } },
        { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' } },
        ...table.columns
          .filter(c => !c.isPrimaryKey && !AUTO_COLS.has(c.columnName))
          .slice(0, 5)  // show up to 5 filterable columns as example params
          .map(c => ({
            name: c.columnName,
            in: 'query',
            description: `Filter by ${c.columnName}`,
            required: false,
            schema: pgColToOpenApiSchema(c),
          })),
      ],
      responses: {
        '200': {
          description: `List of ${name}`,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  data: { type: 'array', items: { $ref: `#/components/schemas/${pascal}Row` } },
                  count: { type: 'integer' },
                  limit: { type: 'integer' },
                  total: { type: 'integer' },
                  hasMore: { type: 'boolean' },
                  nextCursor: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '404': { $ref: '#/components/responses/NotFound' },
      },
    },
    // POST advanced query
    post: {
      tags: [pascal],
      summary: `Query ${name} with filters`,
      operationId: `query${pascal}`,
      security: [{ ApiKeyAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['table'],
              properties: {
                table: { type: 'string', enum: [name] },
                select: { type: 'array', items: { type: 'string' } },
                where: { type: 'object', description: 'Filter conditions — use {gt, gte, lt, lte, not, contains, in} operators' },
                orderBy: { type: 'object', description: 'e.g. {"created_at": "desc"}' },
                limit: { type: 'integer', default: PAGINATION_DEFAULT_LIMIT, maximum: PAGINATION_MAX_LIMIT },
                offset: { type: 'integer', default: 0 },
                cursor: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: `Filtered list of ${name}`,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  data: { type: 'array', items: { $ref: `#/components/schemas/${pascal}Row` } },
                },
              },
            },
          },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
      },
    },
  }

  // POST insert
  paths[`${basePath}/insert`] = {
    ...(paths[`${basePath}/insert`] as any ?? {}),
    post: {
      tags: [pascal],
      summary: `Insert into ${name}`,
      operationId: `insert${pascal}`,
      security: [{ ApiKeyAuth: [] }, { UserTokenAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['table', 'data'],
              properties: {
                table: { type: 'string', enum: [name] },
                data: {
                  oneOf: [
                    { $ref: `#/components/schemas/${pascal}Insert` },
                    { type: 'array', items: { $ref: `#/components/schemas/${pascal}Insert` } },
                  ],
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Inserted row(s)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  data: { $ref: `#/components/schemas/${pascal}Row` },
                },
              },
            },
          },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '422': { $ref: '#/components/responses/ValidationError' },
      },
    },
  }

  // PUT update
  paths[`${basePath}/update`] = {
    ...(paths[`${basePath}/update`] as any ?? {}),
    put: {
      tags: [pascal],
      summary: `Update ${name}`,
      operationId: `update${pascal}`,
      security: [{ ApiKeyAuth: [] }, { UserTokenAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['table', 'where', 'data'],
              properties: {
                table: { type: 'string', enum: [name] },
                where: { type: 'object', description: 'Row selector (e.g. {"id": "uuid"})' },
                data: { $ref: `#/components/schemas/${pascal}Update` },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated row(s)',
          content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: `#/components/schemas/${pascal}Row` } } } } } },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
      },
    },
  }

  // DELETE
  paths[`${basePath}/delete`] = {
    ...(paths[`${basePath}/delete`] as any ?? {}),
    delete: {
      tags: [pascal],
      summary: `Delete from ${name}`,
      operationId: `delete${pascal}`,
      security: [{ ApiKeyAuth: [] }, { UserTokenAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['table', 'where'],
              properties: {
                table: { type: 'string', enum: [name] },
                where: { type: 'object', description: 'Row selector (e.g. {"id": "uuid"})' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Delete result',
          content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, deleted: { type: 'integer' } } } } },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
      },
    },
  }

  return paths
}

// ── Public entry point ────────────────────────────────────────────────────────

export function generateOpenApiSpec(
  schema: WorkspaceSchema,
  options: {
    title?: string
    description?: string
    serverUrl?: string
    version?: string
  } = {}
): Record<string, unknown> {
  const projectId = schema.projectId
  const baseUrl = options.serverUrl ?? `https://backenly.com`
  const title = options.title ?? `Backenly API — Project ${projectId}`

  // Collect all paths (tables may share path keys like /database/insert — merge them)
  const allPaths: Record<string, unknown> = {}
  for (const table of schema.tables) {
    const tablePaths = buildTablePaths(table, projectId, 'x-api-key')
    for (const [path, ops] of Object.entries(tablePaths)) {
      if (!allPaths[path]) {
        allPaths[path] = {}
      }
      Object.assign(allPaths[path] as object, ops as object)
    }
  }

  // Auth + Storage + Realtime boilerplate paths
  const builtinPaths: Record<string, unknown> = {
    [`/api/v1/${projectId}/auth/signup`]: {
      post: {
        tags: ['Auth'],
        summary: 'End-user sign-up',
        operationId: 'authSignUp',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object', required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 8 },
                  name: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'User created + JWT token', content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string' }, refreshToken: { type: 'string' }, user: { type: 'object' } } } } } },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    [`/api/v1/${projectId}/auth/signin`]: {
      post: {
        tags: ['Auth'],
        summary: 'End-user sign-in',
        operationId: 'authSignIn',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object', required: ['email', 'password'],
                properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'JWT token', content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string' }, refreshToken: { type: 'string' }, user: { type: 'object' } } } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    [`/api/v1/${projectId}/storage/upload`]: {
      post: {
        tags: ['Storage'],
        summary: 'Upload a file',
        operationId: 'storageUpload',
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: { 'multipart/form-data': { schema: { type: 'object', required: ['file', 'bucket'], properties: { file: { type: 'string', format: 'binary' }, bucket: { type: 'string' }, path: { type: 'string' } } } } },
        },
        responses: {
          '200': { description: 'File uploaded', content: { 'application/json': { schema: { type: 'object', properties: { fileId: { type: 'string' }, url: { type: 'string' } } } } } },
        },
      },
    },
    [`/api/v1/${projectId}/realtime`]: {
      get: {
        tags: ['Realtime'],
        summary: 'Subscribe to real-time DB change events (SSE)',
        operationId: 'realtimeSubscribe',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          { name: 'table', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'event', in: 'query', schema: { type: 'string', enum: ['insert', 'update', 'delete', '*'], default: '*' } },
        ],
        responses: {
          '200': { description: 'Server-sent event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
        },
      },
    },
  }

  // Component schemas
  const schemas: Record<string, unknown> = {}
  for (const table of schema.tables) {
    const pascal = toPascalCase(table.tableName)
    schemas[`${pascal}Row`]    = buildSchemaObject(table, 'row')
    schemas[`${pascal}Insert`] = buildSchemaObject(table, 'insert')
    schemas[`${pascal}Update`] = buildSchemaObject(table, 'update')
  }

  return {
    openapi: '3.0.3',
    info: {
      title,
      description: options.description ?? `Auto-generated API spec for Backenly project ${projectId}. Import into Postman or Insomnia to get started.`,
      version: options.version ?? '1.0.0',
      contact: { url: 'https://backenly.com' },
    },
    servers: [
      { url: baseUrl, description: 'Production' },
      { url: 'http://localhost:3000', description: 'Local development' },
    ],
    tags: [
      ...schema.tables.map(t => ({ name: toPascalCase(t.tableName), description: `CRUD operations for the ${t.tableName} table` })),
      { name: 'Auth', description: 'End-user authentication' },
      { name: 'Storage', description: 'File storage' },
      { name: 'Realtime', description: 'Server-sent event subscriptions' },
    ],
    paths: { ...allPaths, ...builtinPaths },
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'Project API key (from Backenly dashboard → API Keys)',
        },
        UserTokenAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'End-user JWT returned by /auth/signin',
        },
      },
      schemas,
      responses: {
        Unauthorized: {
          description: 'Authentication required or invalid',
          content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } },
        },
        NotFound: {
          description: 'Resource not found',
          content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } },
        },
        BadRequest: {
          description: 'Invalid request parameters',
          content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } },
        },
        ValidationError: {
          description: 'Input validation failed',
          content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, fields: { type: 'object' } } } } },
        },
        Conflict: {
          description: 'Resource already exists',
          content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } },
        },
      },
    },
  }
}
