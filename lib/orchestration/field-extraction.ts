/**
 * PHASE 2: INTENT FIELD EXTRACTION HARDENING
 * 
 * Natural language → accurate schema generation with ≥90% field extraction accuracy.
 * 
 * This module ensures explicit user-described fields are ALWAYS reflected in generated schemas.
 * NEVER generates minimal fallback schema silently.
 */

export interface ExtractedField {
  name: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'reference' | 'text' | 'email' | 'url' | 'image'
  required: boolean
  unique?: boolean
  referenceTo?: string
  default?: any
  confidence: number // 0-1 confidence score
  source: string // Original text that led to this extraction
}

export interface FieldExtractionResult {
  fields: ExtractedField[]
  confidence: number // Overall confidence (0-1)
  warnings: string[]
  needsClarification: boolean
  clarificationQuestion?: string
}

/**
 * SEMANTIC FIELD MAPPING
 * 
 * Maps common natural language patterns to canonical field types.
 * This handles synonyms, aliases, and domain-specific terminology.
 */
const SEMANTIC_FIELD_PATTERNS: Record<string, Partial<ExtractedField>> = {
  // Identity & Profile
  'name': { type: 'string', required: true },
  'full name': { type: 'string', required: true },
  'first name': { type: 'string', required: true },
  'last name': { type: 'string', required: true },
  'username': { type: 'string', required: true, unique: true },
  'display name': { type: 'string', required: false },
  'nickname': { type: 'string', required: false },
  
  // Contact
  'email': { type: 'email', required: true, unique: true },
  'email address': { type: 'email', required: true, unique: true },
  'phone': { type: 'string', required: false },
  'phone number': { type: 'string', required: false },
  'mobile': { type: 'string', required: false },
  'address': { type: 'text', required: false },
  'location': { type: 'string', required: false },
  'city': { type: 'string', required: false },
  'country': { type: 'string', required: false },
  'zip': { type: 'string', required: false },
  'zipcode': { type: 'string', required: false },
  'postal code': { type: 'string', required: false },
  
  // Content
  'title': { type: 'string', required: true },
  'description': { type: 'text', required: false },
  'bio': { type: 'text', required: false },
  'biography': { type: 'text', required: false },
  'about': { type: 'text', required: false },
  'content': { type: 'text', required: true },
  'body': { type: 'text', required: true },
  'text': { type: 'text', required: true },
  'message': { type: 'text', required: true },
  'comment': { type: 'text', required: true },
  'note': { type: 'text', required: false },
  'caption': { type: 'string', required: false },
  
  // Media
  'image': { type: 'image', required: false },
  'photo': { type: 'image', required: false },
  'picture': { type: 'image', required: false },
  'avatar': { type: 'image', required: false },
  'profile picture': { type: 'image', required: false },
  'profile photo': { type: 'image', required: false },
  'thumbnail': { type: 'image', required: false },
  'cover': { type: 'image', required: false },
  'cover photo': { type: 'image', required: false },
  'banner': { type: 'image', required: false },
  'icon': { type: 'image', required: false },
  'logo': { type: 'image', required: false },
  'url': { type: 'url', required: false },
  'link': { type: 'url', required: false },
  'website': { type: 'url', required: false },
  
  // Numeric
  'price': { type: 'number', required: true },
  'cost': { type: 'number', required: true },
  'amount': { type: 'number', required: true },
  'quantity': { type: 'number', required: true },
  'count': { type: 'number', required: true },
  'rating': { type: 'number', required: false },
  'score': { type: 'number', required: false },
  'age': { type: 'number', required: false },
  'year': { type: 'number', required: false },
  'views': { type: 'number', required: false },
  'likes': { type: 'number', required: false },
  'followers': { type: 'number', required: false },
  'reputation': { type: 'number', required: false },
  
  // Boolean
  'active': { type: 'boolean', required: false, default: true },
  'enabled': { type: 'boolean', required: false, default: true },
  'verified': { type: 'boolean', required: false, default: false },
  'published': { type: 'boolean', required: false, default: false },
  'featured': { type: 'boolean', required: false, default: false },
  'public': { type: 'boolean', required: false, default: false },
  'private': { type: 'boolean', required: false, default: true },
  'deleted': { type: 'boolean', required: false, default: false },
  'archived': { type: 'boolean', required: false, default: false },
  
  // Dates
  'date': { type: 'date', required: false },
  'birthday': { type: 'date', required: false },
  'birth date': { type: 'date', required: false },
  'start date': { type: 'date', required: false },
  'end date': { type: 'date', required: false },
  'due date': { type: 'date', required: false },
  'published at': { type: 'datetime', required: false },
  'created at': { type: 'datetime', required: false },
  'updated at': { type: 'datetime', required: false },
  'deleted at': { type: 'datetime', required: false },
  
  // Status & State
  'status': { type: 'string', required: true },
  'state': { type: 'string', required: true },
  'type': { type: 'string', required: true },
  'category': { type: 'string', required: false },
  'tag': { type: 'string', required: false },
  'role': { type: 'string', required: false },
  'tier': { type: 'string', required: false },
  'level': { type: 'string', required: false },
  'priority': { type: 'string', required: false },
}

/**
 * TYPE INFERENCE PATTERNS
 * 
 * Patterns to infer types from field names when not in semantic map.
 */
const TYPE_INFERENCE_RULES: Array<{ pattern: RegExp; type: ExtractedField['type'] }> = [
  // Email patterns
  { pattern: /email/i, type: 'email' },
  { pattern: /mail/i, type: 'email' },
  
  // URL patterns
  { pattern: /url/i, type: 'url' },
  { pattern: /link/i, type: 'url' },
  { pattern: /website/i, type: 'url' },
  { pattern: /homepage/i, type: 'url' },
  
  // Image patterns
  { pattern: /image/i, type: 'image' },
  { pattern: /photo/i, type: 'image' },
  { pattern: /picture/i, type: 'image' },
  { pattern: /avatar/i, type: 'image' },
  { pattern: /thumbnail/i, type: 'image' },
  { pattern: /icon/i, type: 'image' },
  { pattern: /logo/i, type: 'image' },
  
  // Number patterns
  { pattern: /count$/i, type: 'number' },
  { pattern: /number$/i, type: 'number' },
  { pattern: /amount$/i, type: 'number' },
  { pattern: /price/i, type: 'number' },
  { pattern: /cost/i, type: 'number' },
  { pattern: /quantity/i, type: 'number' },
  { pattern: /rating/i, type: 'number' },
  { pattern: /score/i, type: 'number' },
  { pattern: /age/i, type: 'number' },
  { pattern: /year/i, type: 'number' },
  
  // Boolean patterns
  { pattern: /^is[A-Z]/i, type: 'boolean' },
  { pattern: /^has[A-Z]/i, type: 'boolean' },
  { pattern: /^can[A-Z]/i, type: 'boolean' },
  { pattern: /active$/i, type: 'boolean' },
  { pattern: /enabled$/i, type: 'boolean' },
  { pattern: /verified$/i, type: 'boolean' },
  { pattern: /published$/i, type: 'boolean' },
  
  // Date patterns
  { pattern: /date$/i, type: 'date' },
  { pattern: /birthday/i, type: 'date' },
  { pattern: /dob/i, type: 'date' },
  { pattern: /_at$/i, type: 'datetime' },
  { pattern: /timestamp/i, type: 'datetime' },
  
  // Text patterns (long content)
  { pattern: /description/i, type: 'text' },
  { pattern: /bio/i, type: 'text' },
  { pattern: /content/i, type: 'text' },
  { pattern: /body/i, type: 'text' },
  { pattern: /message/i, type: 'text' },
  { pattern: /comment/i, type: 'text' },
  { pattern: /note/i, type: 'text' },
  { pattern: /about/i, type: 'text' },
]

/**
 * CONSTRAINT DETECTION PATTERNS
 * 
 * Patterns to detect required, unique, and other constraints.
 */
const REQUIRED_INDICATORS = [
  'required',
  'must have',
  'needs',
  'needs to have',
  'always',
  'mandatory',
]

const UNIQUE_INDICATORS = [
  'unique',
  'one per',
  'only one',
  'no duplicates',
  'distinct',
  'different',
]

/**
 * Extract field name from semantic patterns in text
 */
function extractFieldsFromText(text: string): ExtractedField[] {
  const fields: ExtractedField[] = []
  const lowerText = text.toLowerCase()
  
  // Search for semantic patterns
  for (const [pattern, baseField] of Object.entries(SEMANTIC_FIELD_PATTERNS)) {
    if (lowerText.includes(pattern)) {
      const confidence = pattern.length > 3 ? 0.95 : 0.85
      
      fields.push({
        name: pattern.replace(/\s+/g, '_'),
        type: baseField.type || 'string',
        required: baseField.required ?? false,
        unique: baseField.unique ?? false,
        confidence,
        source: `Matched pattern: "${pattern}"`,
        ...baseField,
      })
    }
  }
  
  return fields
}

/**
 * Infer type from field name using pattern matching
 */
function inferTypeFromName(fieldName: string): ExtractedField['type'] {
  for (const rule of TYPE_INFERENCE_RULES) {
    if (rule.pattern.test(fieldName)) {
      return rule.type
    }
  }
  return 'string' // Default fallback
}

/**
 * Detect constraints from surrounding text
 */
function detectConstraints(fieldName: string, text: string): { required: boolean; unique: boolean } {
  const lowerText = text.toLowerCase()
  const fieldPattern = new RegExp(`${fieldName}\\s+(?:is|must be|should be)\\s+([\\w\\s]+)`, 'i')
  const match = lowerText.match(fieldPattern)
  
  let required = false
  let unique = false
  
  if (match) {
    const constraintText = match[1]
    required = REQUIRED_INDICATORS.some(ind => constraintText.includes(ind))
    unique = UNIQUE_INDICATORS.some(ind => constraintText.includes(ind))
  }
  
  // Also check for global required/unique indicators
  if (!required) {
    required = REQUIRED_INDICATORS.some(ind => lowerText.includes(`${fieldName} ${ind}`))
  }
  if (!unique) {
    unique = UNIQUE_INDICATORS.some(ind => lowerText.includes(`${fieldName} ${ind}`))
  }
  
  return { required, unique }
}

/**
 * CONFIDENCE THRESHOLD
 * 
 * Minimum confidence score required to accept field extraction without clarification.
 */
const MIN_CONFIDENCE_THRESHOLD = 0.75

/**
 * Main field extraction function
 * 
 * Extracts fields from entity specification with confidence scoring.
 */
export function extractFieldsFromEntity(
  entityName: string,
  entityFields: Array<{ name: string; type?: string; required?: boolean; unique?: boolean }>,
  sourceText: string
): FieldExtractionResult {
  const extractedFields: ExtractedField[] = []
  const warnings: string[] = []
  
  // If entity already has explicit fields from LLM, use them with high confidence
  if (entityFields && entityFields.length > 0) {
    for (const field of entityFields) {
      const type = field.type as ExtractedField['type'] || inferTypeFromName(field.name)
      const constraints = detectConstraints(field.name, sourceText)
      
      extractedFields.push({
        name: field.name,
        type,
        required: field.required ?? constraints.required ?? false,
        unique: field.unique ?? constraints.unique ?? false,
        confidence: 0.95, // High confidence from LLM extraction
        source: 'LLM extraction',
      })
    }
  }
  
  // Calculate overall confidence
  const avgConfidence = extractedFields.length > 0
    ? extractedFields.reduce((sum, f) => sum + f.confidence, 0) / extractedFields.length
    : 0
  
  // Determine if clarification is needed
  const needsClarification = avgConfidence < MIN_CONFIDENCE_THRESHOLD || extractedFields.length === 0
  
  let clarificationQuestion: string | undefined
  if (needsClarification && extractedFields.length === 0) {
    clarificationQuestion = `I want to create the ${entityName} entity, but I need clarification on what fields it should have. Could you specify the fields? For example: "${entityName} should have: name (text), email (required), bio (optional text), profile picture (image)"`
  } else if (needsClarification) {
    clarificationQuestion = `I found these fields for ${entityName}: ${extractedFields.map(f => f.name).join(', ')}. Are these correct, or should I add/remove any fields?`
  }
  
  // Warnings for low confidence fields
  extractedFields.forEach(field => {
    if (field.confidence < 0.80) {
      warnings.push(`Low confidence (${(field.confidence * 100).toFixed(0)}%) for field: ${field.name}`)
    }
  })
  
  return {
    fields: extractedFields,
    confidence: avgConfidence,
    warnings,
    needsClarification,
    clarificationQuestion,
  }
}

/**
 * Normalize field type from LLM output to canonical type
 */
export function normalizeFieldType(llmType: string): ExtractedField['type'] {
  const lower = llmType.toLowerCase()
  
  // String variants
  if (lower.includes('string') || lower.includes('text') || lower.includes('varchar')) {
    return lower.includes('long') || lower.includes('large') ? 'text' : 'string'
  }
  
  // Number variants
  if (lower.includes('number') || lower.includes('int') || lower.includes('float') || lower.includes('decimal')) {
    return 'number'
  }
  
  // Boolean variants
  if (lower.includes('bool') || lower.includes('flag')) {
    return 'boolean'
  }
  
  // Date variants
  if (lower.includes('datetime') || lower.includes('timestamp')) {
    return 'datetime'
  }
  if (lower.includes('date')) {
    return 'date'
  }
  
  // Reference variants
  if (lower.includes('reference') || lower.includes('foreign') || lower.includes('relation')) {
    return 'reference'
  }
  
  // Special types
  if (lower.includes('email')) return 'email'
  if (lower.includes('url') || lower.includes('link')) return 'url'
  if (lower.includes('image') || lower.includes('photo') || lower.includes('picture')) return 'image'
  
  // Fallback
  return 'string'
}

/**
 * Convert extracted field to Prisma-compatible column definition
 */
export function fieldToColumnDef(field: ExtractedField): any {
  const colDef: any = {
    name: field.name,
    type: mapTypeToPrisma(field.type),
    required: field.required,
  }
  
  if (field.unique) {
    colDef.unique = true
  }
  
  if (field.default !== undefined) {
    colDef.default = field.default
  }
  
  if (field.referenceTo) {
    colDef.referenceTo = field.referenceTo
  }
  
  return colDef
}

/**
 * Map semantic type to Prisma SQL type
 */
function mapTypeToPrisma(type: ExtractedField['type']): string {
  switch (type) {
    case 'string':
      return 'VARCHAR(255)'
    case 'text':
      return 'TEXT'
    case 'number':
      return 'INTEGER'
    case 'boolean':
      return 'BOOLEAN'
    case 'date':
      return 'DATE'
    case 'datetime':
      return 'TIMESTAMP'
    case 'reference':
      return 'UUID'
    case 'email':
      return 'VARCHAR(255)'
    case 'url':
      return 'VARCHAR(2048)'
    case 'image':
      return 'VARCHAR(2048)' // URL to image
    default:
      return 'VARCHAR(255)'
  }
}
