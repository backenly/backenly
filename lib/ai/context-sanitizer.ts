/**
 * AI CONTEXT SANITIZER
 * ====================
 * Security guard that ensures AI context contains ONLY schema/metadata.
 * Prevents any row-level data from reaching AI prompts.
 * 
 * CRITICAL SECURITY RULE:
 * - AI can see: table names, column names, field types, relationships
 * - AI CANNOT see: actual row data, user content, file contents
 * 
 * This runs BEFORE every AI call as a defense-in-depth measure.
 */

export interface SanitizedContext {
  schema: {
    tables: Array<{
      name: string
      columns: Array<{
        name: string
        type: string
        nullable?: boolean
        isPrimaryKey?: boolean
      }>
      relationships?: Array<{
        field: string
        references: string
      }>
    }>
  }
  metadata: {
    projectId: string
    projectName: string
    databaseProvisioned: boolean
  }
  apis?: Array<{
    tableName: string
    basePath: string
    operations: string[]
  }>
}

// Patterns that indicate row data (not schema)
const FORBIDDEN_PATTERNS = [
  // Email patterns (user data)
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  // UUID patterns that look like row IDs
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  // Phone numbers (simplified pattern)
  /\d{3}[-.]\d{3}[-.]\d{4}/,
  // Credit card patterns
  /\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/,
  // Large text blocks (likely content)
  /".{200,}"/,
]

// Keys that should NEVER be in AI context
const FORBIDDEN_KEYS = [
  'rows',
  'records',
  'documents',
  'contents',
  'values',
  'password',
  'token',
  'secret',
  'creditCard',
  'ssn',
]

// Keys that are safe even if they contain forbidden substrings
const SAFE_KEY_EXCEPTIONS = [
  'metadata',
  'schemaMetadata',
  'databaseProvisioned',
  'graphData', // BackendGraph metadata
  'apiData',   // API definitions
  'fieldData', // Schema field info
]

/**
 * Deep scan object for potential row data
 * Returns true if suspicious data patterns found
 */
function containsRowData(obj: any, path: string = ''): { hasData: boolean; violations: string[] } {
  const violations: string[] = []

  if (obj === null || obj === undefined) {
    return { hasData: false, violations }
  }

  // Check strings for patterns
  if (typeof obj === 'string') {
    // Check for forbidden patterns
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(obj)) {
        violations.push(`Pattern match at ${path}: potential PII/data detected`)
      }
    }
    return { hasData: violations.length > 0, violations }
  }

  // Check arrays - if they have many items with similar structure, likely row data
  if (Array.isArray(obj)) {
    // Arrays with >20 items of objects = likely row data
    if (obj.length > 20 && obj.every(item => typeof item === 'object' && item !== null)) {
      violations.push(`Large array at ${path} (${obj.length} items): potential row data`)
    }
    
    for (let i = 0; i < obj.length; i++) {
      const result = containsRowData(obj[i], `${path}[${i}]`)
      violations.push(...result.violations)
    }
    return { hasData: violations.length > 0, violations }
  }

  // Check objects
  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      const keyPath = path ? `${path}.${key}` : key
      
      // Check if key is in safe exceptions list
      const isSafeException = SAFE_KEY_EXCEPTIONS.some(safe => 
        key.toLowerCase() === safe.toLowerCase()
      )
      
      if (!isSafeException) {
        // Check if key is forbidden
        if (FORBIDDEN_KEYS.some(fk => key.toLowerCase().includes(fk.toLowerCase()))) {
          violations.push(`Forbidden key at ${keyPath}: "${key}" suggests row data`)
        }
      }
      
      const result = containsRowData(value, keyPath)
      violations.push(...result.violations)
    }
    return { hasData: violations.length > 0, violations }
  }

  return { hasData: false, violations }
}

/**
 * Sanitize context to ensure only schema/metadata reaches AI
 * This is the MAIN SECURITY GUARD
 */
export function sanitizeAIContext(context: any): { 
  sanitized: SanitizedContext | null
  allowed: boolean
  violations: string[]
} {
  console.log('[Context Sanitizer] 🔒 Scanning AI context for data violations...')

  // Deep scan for row data
  const scanResult = containsRowData(context)
  
  if (scanResult.hasData) {
    console.error('[Context Sanitizer] ❌ SECURITY VIOLATION DETECTED:')
    scanResult.violations.forEach(v => console.error(`  - ${v}`))
    
    // In production, block the request
    // In development, log but allow (for debugging)
    const isProduction = process.env.NODE_ENV === 'production'
    
    if (isProduction) {
      return {
        sanitized: null,
        allowed: false,
        violations: scanResult.violations,
      }
    }
    
    // Development: warn but try to extract safe schema
    console.warn('[Context Sanitizer] ⚠️ Development mode: attempting to extract safe schema')
  }

  // Extract only safe schema information
  const sanitized: SanitizedContext = {
    schema: {
      tables: extractSafeTables(context),
    },
    metadata: extractSafeMetadata(context),
    apis: extractSafeApis(context),
  }

  console.log('[Context Sanitizer] ✅ Context sanitized:', {
    tables: sanitized.schema.tables.length,
    violations: scanResult.violations.length,
  })

  return {
    sanitized,
    allowed: true,
    violations: scanResult.violations,
  }
}

/**
 * Extract only table schema (names, columns, types) - NO ROW DATA
 */
function extractSafeTables(context: any): SanitizedContext['schema']['tables'] {
  const tables: SanitizedContext['schema']['tables'] = []

  // Handle various context structures
  const tableSources = [
    context?.schema?.tables,
    context?.database?.tables,
    context?.tables,
    context?.projectContext?.tables,
  ]

  for (const source of tableSources) {
    if (!Array.isArray(source)) continue

    for (const table of source) {
      if (!table || typeof table !== 'object') continue

      // Extract ONLY schema info
      const safeTable: SanitizedContext['schema']['tables'][0] = {
        name: String(table.name || table.tableName || 'unknown'),
        columns: [],
      }

      // Extract column definitions (NOT column values)
      const columnSource = table.columns || table.fields || table.schema?.columns
      if (Array.isArray(columnSource)) {
        safeTable.columns = columnSource
          .filter((col: any) => col && typeof col === 'object')
          .map((col: any) => ({
            name: String(col.name || col.columnName || col.field || 'unknown'),
            type: String(col.type || col.dataType || col.kind || 'string'),
            nullable: col.nullable === true || col.isNullable === true || col.required === false,
            isPrimaryKey: col.isPrimaryKey === true || col.primary === true,
          }))
      }

      // Extract relationships (metadata only)
      const relSource = table.relationships || table.relations || table.foreignKeys
      if (Array.isArray(relSource)) {
        safeTable.relationships = relSource
          .filter((rel: any) => rel && typeof rel === 'object')
          .map((rel: any) => ({
            field: String(rel.field || rel.column || rel.from || 'unknown'),
            references: String(rel.references || rel.to || rel.referencesTable || 'unknown'),
          }))
      }

      tables.push(safeTable)
    }
  }

  return tables
}

/**
 * Extract safe metadata only
 */
function extractSafeMetadata(context: any): SanitizedContext['metadata'] {
  const project = context?.project || context?.metadata?.project || context
  
  return {
    projectId: String(project?.id || context?.projectId || 'unknown'),
    projectName: String(project?.name || context?.projectName || 'Untitled'),
    databaseProvisioned: project?.databaseProvisioned === true || 
                         context?.database?.provisioned === true ||
                         false,
  }
}

/**
 * Extract API definitions (paths, methods) - NO REQUEST DATA
 */
function extractSafeApis(context: any): SanitizedContext['apis'] | undefined {
  const apiSource = context?.apis || context?.apiDefinitions || context?.endpoints
  
  if (!Array.isArray(apiSource)) return undefined

  return apiSource
    .filter((api: any) => api && typeof api === 'object')
    .map((api: any) => ({
      tableName: String(api.tableName || api.table?.name || api.entity || 'unknown'),
      basePath: String(api.basePath || api.path || '/api'),
      operations: Array.isArray(api.operations) 
        ? api.operations.map(String)
        : Object.keys(api.operations || {}).filter(k => api.operations[k] === true),
    }))
}

/**
 * Guard function that MUST be called before every AI API call
 * Throws error if row data detected in production
 */
export function enforceSchemaOnlyContext(context: any): SanitizedContext {
  const result = sanitizeAIContext(context)
  
  if (!result.allowed) {
    const errorMessage = `SECURITY VIOLATION: AI context contains row data. Violations: ${result.violations.join(', ')}`
    console.error('[Context Sanitizer] 🚫 BLOCKED:', errorMessage)
    throw new Error(errorMessage)
  }

  if (result.violations.length > 0) {
    console.warn('[Context Sanitizer] ⚠️ Warnings (allowed in dev):', result.violations)
  }

  return result.sanitized!
}

/**
 * Quick check for common data patterns
 * Use for fast-path rejection
 */
export function quickDataCheck(value: any): boolean {
  if (typeof value !== 'string') return false
  
  // Quick regex checks for obvious data
  const hasEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(value)
  const hasPhone = /\d{3}[-.]\d{3}[-.]\d{4}/.test(value)
  const hasCreditCard = /\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/.test(value)
  
  return hasEmail || hasPhone || hasCreditCard
}
