/**
 * Intent Extractor - Step 2 of Backenly Flow
 * 
 * This module converts human intent (project description) into structured metadata
 * WITHOUT generating any code.
 * 
 * Flow: User Prompt → AI Understanding → Metadata Storage
 */

import { getOpenAIClient } from './openai-service'
import { getModel } from './model-router'
import {
  analyzeAllTablePurposes,
  extractWorkflowsFromPrompt,
  extractBusinessRulesFromPrompt,
  buildSystemPromptEnrichment,
  type TablePurposeResult,
  type StateMachineConfig,
  type Workflow,
  type BusinessRule,
} from './semantic-domain-analyzer'

export interface ExtractedEntity {
  name: string
  description: string
  fields: Array<{
    name: string
    type: string
    required: boolean
    unique?: boolean
    defaultValue?: string
    description?: string
  }>
}

export interface ExtractedRelationship {
  from: string
  to: string
  type: 'one-to-one' | 'one-to-many' | 'many-to-many'
  description: string
}

export interface ExtractedBehavior {
  entity: string
  operations: Array<'create' | 'read' | 'update' | 'delete' | 'search' | 'bulk'>
  description?: string
}

export interface SecurityExpectations {
  requiresAuth: boolean
  publicEndpoints: string[]
  protectedEndpoints: string[]
  rolesRequired?: string[]
}

export interface TablePlan {
  name: string
  description: string
  columns: Array<{
    name: string
    type: string
    nullable: boolean
    unique: boolean
    isPrimaryKey: boolean
    references?: { table: string; column: string }
  }>
  isPlan: true // Always true - these are plans, not real tables
}

export interface ApiPlan {
  name: string
  tableName: string
  basePath: string
  version: string
  authStrategy: 'jwt' | 'api-key' | 'public'
  operations: {
    list: boolean
    get: boolean
    create: boolean
    update: boolean
    delete: boolean
    search: boolean
    bulk: boolean
  }
  rateLimit: number
  validation: boolean
  customEndpoints?: Array<{
    method: string
    path: string
    enabled: boolean
    auth: boolean
    description?: string
  }> // Action-based endpoints derived from intent
}

export interface ExtractedMetadata {
  entities: ExtractedEntity[]
  relationships: ExtractedRelationship[]
  behaviors: ExtractedBehavior[]
  security: SecurityExpectations
  tablePlans: TablePlan[]
  apiPlans: ApiPlan[]

  // ── Semantic enrichment (issues #46–#50) ──────────────────────────────────
  /** Per-table semantic purpose analysis (#46) */
  tablePurposes?: Record<string, TablePurposeResult>
  /** Detected state machines — tables with a status column and typed transitions (#47) */
  stateMachines?: StateMachineConfig[]
  /** Multi-step workflows inferred from the prompt (#48) */
  workflows?: Workflow[]
  /** Business rules and constraints extracted from the prompt (#49) */
  businessRules?: BusinessRule[]
  /**
   * Ready-to-inject system prompt enrichment block.
   * Contains state machine enforcement, business rules, and workflow sequences.
   * Should be appended to the AI system prompt when executing build actions.
   */
  systemPromptEnrichment?: string
}

/**
 * Derive action-based endpoints from user prompt
 * 
 * This function analyzes the user's plain-English prompt and generates
 * specific action endpoints based on intent, NOT generic CRUD.
 * 
 * Examples:
 * - "users can like posts" → POST /posts/:id/like
 * - "users can comment" → POST /posts/:id/comments
 * - "users can edit their posts" → PATCH /posts/:id (with ownership)
 */
function deriveActionEndpoints(
  userPrompt: string,
  apiPlans: ApiPlan[],
  tablePlans: TablePlan[]
): ApiPlan[] {
  console.log('🔍 [Action Derivation] Analyzing prompt for actions...')
  const lower = userPrompt.toLowerCase()
  
  // Check what tables exist
  const hasUsers = tablePlans.some(t => t.name === 'users')
  const hasPosts = tablePlans.some(t => t.name === 'posts')
  const hasComments = tablePlans.some(t => t.name === 'comments')
  const hasLikes = tablePlans.some(t => t.name === 'likes')
  
  // Derive endpoints for each table
  return apiPlans.map(apiPlan => {
    const endpoints: typeof apiPlan.customEndpoints = apiPlan.customEndpoints || []
    
    // USERS ACTIONS
    if (apiPlan.tableName === 'users') {
      // Sign up/login detection
      if (/\b(sign ?up|register|create account)\b/i.test(lower)) {
        endpoints.push({
          method: 'POST',
          path: '/signup',
          enabled: true,
          auth: false,
          description: 'User registration'
        })
      }
      
      if (/\b(log ?in|sign ?in|authenticate)\b/i.test(lower)) {
        endpoints.push({
          method: 'POST',
          path: '/login',
          enabled: true,
          auth: false,
          description: 'User login'
        })
      }
      
      // Profile management
      if (/\b(profile|account|user.*(info|details|data))\b/i.test(lower)) {
        endpoints.push(
          {
            method: 'GET',
            path: '/me',
            enabled: true,
            auth: true,
            description: 'Get current user profile'
          },
          {
            method: 'PATCH',
            path: '/me',
            enabled: true,
            auth: true,
            description: 'Update own profile'
          }
        )
      }
      
      // Profile picture upload
      if (/\b(upload|change|update).*(profile.*(picture|image|photo|avatar)|avatar|photo)\b/i.test(lower)) {
        endpoints.push({
          method: 'POST',
          path: '/me/avatar',
          enabled: true,
          auth: true,
          description: 'Upload profile picture'
        })
      }
      
      // Account deletion
      if (/\b(delete|remove).*(account|user|profile)\b/i.test(lower)) {
        endpoints.push({
          method: 'DELETE',
          path: '/me',
          enabled: true,
          auth: true,
          description: 'Delete own account'
        })
      }
    }
    
    // POSTS ACTIONS
    if (apiPlan.tableName === 'posts') {
      // Anyone can read posts
      if (/\b(anyone|public|everyone).*(read|view|see|access).*(post|content)\b/i.test(lower) ||
          /\b(read|view|see|access).*(post|content)\b/i.test(lower)) {
        endpoints.push(
          {
            method: 'GET',
            path: '/',
            enabled: true,
            auth: false,
            description: 'List all posts'
          },
          {
            method: 'GET',
            path: '/:id',
            enabled: true,
            auth: false,
            description: 'Get single post'
          }
        )
      }
      
      // Create posts
      if (/\b(create|write|post|publish|add).*(post|content|article)\b/i.test(lower)) {
        endpoints.push({
          method: 'POST',
          path: '/',
          enabled: true,
          auth: true,
          description: 'Create new post'
        })
      }
      
      // Edit/update posts (owner only)
      if (/\b(edit|update|modify|change).*(post|content)\b/i.test(lower)) {
        endpoints.push({
          method: 'PATCH',
          path: '/:id',
          enabled: true,
          auth: true,
          description: 'Update own post (ownership enforced)'
        })
      }
      
      // Delete posts (owner only)
      if (/\b(delete|remove).*(post|content)\b/i.test(lower)) {
        endpoints.push({
          method: 'DELETE',
          path: '/:id',
          enabled: true,
          auth: true,
          description: 'Delete own post (ownership enforced)'
        })
      }
      
      // Like posts (ACTION-BASED, NOT CRUD)
      if (hasLikes && /\b(like|favorite|upvote).*(post|content)\b/i.test(lower)) {
        endpoints.push(
          {
            method: 'POST',
            path: '/:id/like',
            enabled: true,
            auth: true,
            description: 'Like a post (once per user)'
          },
          {
            method: 'DELETE',
            path: '/:id/like',
            enabled: true,
            auth: true,
            description: 'Unlike a post'
          }
        )
      }
      
      // Comment on posts (ACTION-BASED)
      if (hasComments && /\b(comment|reply|respond).*(post|content)\b/i.test(lower)) {
        endpoints.push({
          method: 'POST',
          path: '/:id/comments',
          enabled: true,
          auth: true,
          description: 'Add comment to post'
        })
      }
    }
    
    // COMMENTS ACTIONS
    if (apiPlan.tableName === 'comments') {
      // Edit own comments
      if (/\b(edit|update|modify).*(comment|reply)\b/i.test(lower)) {
        endpoints.push({
          method: 'PATCH',
          path: '/:id',
          enabled: true,
          auth: true,
          description: 'Update own comment (ownership enforced)'
        })
      }
      
      // Delete own comments
      if (/\b(delete|remove).*(comment|reply)\b/i.test(lower)) {
        endpoints.push({
          method: 'DELETE',
          path: '/:id',
          enabled: true,
          auth: true,
          description: 'Delete own comment (ownership enforced)'
        })
      }
    }
    
    // Remove duplicates by path+method
    const uniqueEndpoints = endpoints.filter((endpoint, index, self) =>
      index === self.findIndex(e => e.method === endpoint.method && e.path === endpoint.path)
    )
    
    console.log(`🎯 [Action Derivation] ${apiPlan.tableName}: ${uniqueEndpoints.length} endpoints derived`)
    
    return {
      ...apiPlan,
      customEndpoints: uniqueEndpoints
    }
  })
}

/**
 * Extract structured metadata from user's project description
 * This is the CORE of Backenly's "no code" philosophy
 */
export async function extractMetadataFromIntent(
  userPrompt: string
): Promise<ExtractedMetadata> {
  console.log('🧠 [Intent Extractor] Analyzing user intent...')
  console.log('📝 [Intent Extractor] Prompt:', userPrompt.substring(0, 200))

  const openai = getOpenAIClient()

  const systemPrompt = `You are Backenly's Intent Analyzer. Your job is to understand what the user wants to build and extract structured metadata.

**CRITICAL RULES:**
1. DO NOT generate code
2. DO NOT write SQL
3. DO NOT create implementation details
4. ONLY extract: entities, relationships, behaviors, and expectations

**BACKENLY DOCTRINE - ACTION-BASED ENDPOINTS:**
NEVER generate generic CRUD endpoints. Instead, derive SPECIFIC ACTIONS from user intent.

Examples:
- "users can like posts" → POST /posts/:id/like (NOT PUT /likes/:id)
- "users can comment on posts" → POST /posts/:id/comments (NOT POST /comments)
- "users can follow other users" → POST /users/:id/follow (NOT POST /follows)
- "only owner can edit posts" → PATCH /posts/:id (with ownership check, NO generic PUT)
- "anyone can read posts" → GET /posts, GET /posts/:id (read-only)
- "users can upload profile picture" → POST /users/me/avatar (NOT POST /files)

**What you extract:**
- Entities (nouns: User, Post, Comment, Product, Order)
- Relationships (User has many Posts, Post belongs to User)
- Actions (specific operations: like, comment, follow, upload, publish)
- Security (auth requirements per action)

**Output format (JSON):**
{
  "entities": [
    {
      "name": "users",
      "description": "People who use the platform",
      "fields": [
        { "name": "id", "type": "uuid", "required": true, "unique": true },
        { "name": "email", "type": "string", "required": true, "unique": true },
        { "name": "name", "type": "string", "required": true },
        { "name": "createdAt", "type": "timestamp", "required": true }
      ]
    }
  ],
  "relationships": [
    {
      "from": "users",
      "to": "posts",
      "type": "one-to-many",
      "description": "A user can create many posts"
    }
  ],
  "behaviors": [
    {
      "entity": "posts",
      "operations": ["create", "read", "update", "delete"],
      "description": "Users can manage their own posts"
    }
  ],
  "security": {
    "requiresAuth": true,
    "publicEndpoints": ["GET /posts", "GET /posts/:id"],
    "protectedEndpoints": ["POST /posts", "PATCH /posts/:id", "DELETE /posts/:id"]
  },
  "tablePlans": [
    {
      "name": "users",
      "description": "User accounts",
      "columns": [
        { "name": "id", "type": "UUID", "nullable": false, "unique": true, "isPrimaryKey": true },
        { "name": "email", "type": "TEXT", "nullable": false, "unique": true, "isPrimaryKey": false },
        { "name": "name", "type": "TEXT", "nullable": false, "unique": false, "isPrimaryKey": false },
        { "name": "createdAt", "type": "TIMESTAMP", "nullable": false, "unique": false, "isPrimaryKey": false }
      ],
      "isPlan": true
    }
  ],
  "apiPlans": [
    {
      "name": "users",
      "tableName": "users",
      "basePath": "/users",
      "version": "v1",
      "authStrategy": "jwt",
      "operations": {
        "list": false,
        "get": false,
        "create": false,
        "update": false,
        "delete": false,
        "search": false,
        "bulk": false
      },
      "customEndpoints": [
        { "method": "GET", "path": "/me", "enabled": true, "auth": true, "description": "Get current user profile" },
        { "method": "PATCH", "path": "/me", "enabled": true, "auth": true, "description": "Update own profile" },
        { "method": "POST", "path": "/me/avatar", "enabled": true, "auth": true, "description": "Upload profile picture" }
      ],
      "rateLimit": 100,
      "validation": true
    }
  ]
}

**CRITICAL: For community app with posts, comments, likes:**
- Posts table needs: id, title, content, authorId, createdAt
- Comments table needs: id, postId, authorId, content, createdAt
- Likes table (junction) needs: id, postId, userId, createdAt + UNIQUE(postId, userId)
- Post actions: GET /posts, GET /posts/:id, POST /posts, PATCH /posts/:id, DELETE /posts/:id
- Like action: POST /posts/:id/like, DELETE /posts/:id/like (NOT CRUD on /likes)
- Comment action: POST /posts/:id/comments, PATCH /comments/:id, DELETE /comments/:id

**Field Types (use these):**
- UUID (for IDs)
- TEXT (for strings)
- INTEGER (for numbers)
- BOOLEAN (for true/false)
- TIMESTAMP (for dates/times)
- JSON (for complex data)

**Respond ONLY with valid JSON. No explanations, no markdown, just JSON.**`

  try {
    const response = await openai.chat.completions.create({
      model: getModel('plan'), // Intent extraction — smart model
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3, // Low temperature for consistent extraction
      max_tokens: 8000,
      response_format: { type: 'json_object' },
    })

    const rawContent = response.choices[0].message.content || '{}'
    console.log('🤖 [Intent Extractor] Raw OpenAI response:', rawContent.substring(0, 500))
    
    const extracted = JSON.parse(rawContent)
    
    // Convert entities to tablePlans if not provided
    if (!extracted.tablePlans || extracted.tablePlans.length === 0) {
      if (extracted.entities && extracted.entities.length > 0) {
        console.log('🔧 [Intent Extractor] Converting entities to tablePlans')
        extracted.tablePlans = extracted.entities.map((entity: any) => ({
          name: entity.name,
          description: entity.description,
          columns: entity.fields.map((field: any) => ({
            name: field.name,
            type: field.type,
            nullable: !field.required,
            unique: field.unique || false,
            isPrimaryKey: field.name === 'id',
          })),
          isPlan: true,
        }))
      }
    }
    
    // Convert entities to apiPlans if not provided
    if (!extracted.apiPlans || extracted.apiPlans.length === 0) {
      if (extracted.entities && extracted.entities.length > 0) {
        console.log('🔧 [Intent Extractor] Converting entities to apiPlans (NO CRUD - action-based only)')
        extracted.apiPlans = extracted.entities.map((entity: any) => ({
          name: entity.name,
          tableName: entity.name,
          basePath: `/${entity.name}`,
          version: 'v1',
          authStrategy: 'jwt' as const,
          operations: {
            list: false,  // No automatic CRUD
            get: false,
            create: false,
            update: false,
            delete: false,
            search: false,
            bulk: false,
          },
          customEndpoints: [], // Empty - actions must be explicitly derived
          rateLimit: 100,
          validation: true,
        }))
      }
    } else {
      // DOCTRINE ENFORCEMENT: Even if AI returned apiPlans, disable CRUD operations
      console.log('⛔ [Intent Extractor] ENFORCING DOCTRINE - Disabling automatic CRUD in AI-generated apiPlans')
      extracted.apiPlans = extracted.apiPlans.map((apiPlan: any) => ({
        ...apiPlan,
        operations: {
          list: false,  // Disable all CRUD
          get: false,
          create: false,
          update: false,
          delete: false,
          search: false,
          bulk: false,
        },
        // Keep customEndpoints if provided by AI, otherwise empty
        customEndpoints: apiPlan.customEndpoints || [],
      }))
    }
    
    // POST-PROCESS: Derive action-based endpoints from user prompt
    // This ensures we generate the RIGHT endpoints even if AI doesn't specify them
    console.log('🎯 [Intent Extractor] PRE-DERIVATION: apiPlans count =', extracted.apiPlans?.length || 0)
    if (extracted.apiPlans && extracted.apiPlans.length > 0) {
      console.log('🎯 [Intent Extractor] First apiPlan before derivation:', JSON.stringify(extracted.apiPlans[0], null, 2))
    }
    
    extracted.apiPlans = deriveActionEndpoints(userPrompt, extracted.apiPlans, extracted.tablePlans)
    
    console.log('🎯 [Intent Extractor] POST-DERIVATION: apiPlans count =', extracted.apiPlans?.length || 0)
    if (extracted.apiPlans && extracted.apiPlans.length > 0) {
      console.log('🎯 [Intent Extractor] First apiPlan after derivation:', JSON.stringify(extracted.apiPlans[0], null, 2))
    }
    
    console.log('✅ [Intent Extractor] Successfully extracted metadata')
    console.log('📊 [Intent Extractor] Found:', {
      entities: extracted.entities?.length || 0,
      relationships: extracted.relationships?.length || 0,
      tablePlans: extracted.tablePlans?.length || 0,
      apiPlans: extracted.apiPlans?.length || 0,
    })

    // ── Semantic enrichment (#46–#50) ─────────────────────────────────────────
    // Run in parallel — none depend on each other.
    // #46: classify purpose of each table from its name and columns
    // #47: detect state machines from status columns
    // #48: extract multi-step workflows from the prompt
    // #49: extract business rules and constraints from the prompt
    const tableInputs = (extracted.tablePlans ?? []).map((t: TablePlan) => ({
      name: t.name,
      columns: (t.columns ?? []).map((c: { name: string }) => c.name),
    }))

    const [semanticAnalysis, workflows, businessRules] = await Promise.all([
      tableInputs.length > 0
        ? analyzeAllTablePurposes(tableInputs)
        : Promise.resolve({ purposes: {} as Record<string, TablePurposeResult>, stateMachines: [] as StateMachineConfig[] }),
      extractWorkflowsFromPrompt(userPrompt),
      extractBusinessRulesFromPrompt(userPrompt),
    ])

    const systemPromptEnrichment = buildSystemPromptEnrichment(
      semanticAnalysis.stateMachines,
      businessRules,
      workflows,
    )

    extracted.tablePurposes = semanticAnalysis.purposes
    extracted.stateMachines = semanticAnalysis.stateMachines
    extracted.workflows = workflows
    extracted.businessRules = businessRules
    extracted.systemPromptEnrichment = systemPromptEnrichment.trim() || undefined

    // Merge state machine recommended endpoints into apiPlans (#47 fix)
    // For each table with a state machine, inject its required transition endpoints
    if (semanticAnalysis.stateMachines.length > 0 && Array.isArray(extracted.apiPlans)) {
      for (const sm of semanticAnalysis.stateMachines) {
        const plan = extracted.apiPlans.find((p: ApiPlan) => p.tableName === sm.tableName)
        if (plan) {
          const existing = new Set(
            (plan.customEndpoints ?? []).map((e: { method: string; path: string }) => `${e.method}:${e.path}`)
          )
          const toAdd = sm.transitions
            .filter(t => t.endpoint && !existing.has(`${t.endpoint.method}:${t.endpoint.path}`))
            .map(t => ({
              method: t.endpoint!.method,
              path: t.endpoint!.path,
              enabled: true,
              auth: true,
              description: `${t.action} transition (${Array.isArray(t.from) ? t.from.join('|') : t.from} → ${t.to})`,
            }))
          if (toAdd.length > 0) {
            plan.customEndpoints = [...(plan.customEndpoints ?? []), ...toAdd]
            console.log(`🔄 [Intent Extractor] Injected ${toAdd.length} state machine endpoints into ${sm.tableName} API plan`)
          }
        }
      }
    }

    console.log('🧠 [Intent Extractor] Semantic enrichment:', {
      stateMachines: semanticAnalysis.stateMachines.length,
      workflows: workflows.length,
      businessRules: businessRules.length,
      hasEnrichment: !!extracted.systemPromptEnrichment,
    })

    return extracted
  } catch (error) {
    console.error('❌ [Intent Extractor] Failed to extract metadata:', error)
    throw new Error('Failed to analyze project intent')
  }
}

/**
 * Validate extracted metadata
 */
export function validateMetadata(metadata: ExtractedMetadata): boolean {
  if (!metadata.entities || metadata.entities.length === 0) {
    throw new Error('No entities found in project description')
  }

  if (!metadata.tablePlans || metadata.tablePlans.length === 0) {
    throw new Error('No table plans generated')
  }

  if (!metadata.apiPlans || metadata.apiPlans.length === 0) {
    throw new Error('No API plans generated')
  }

  // Ensure each entity has at least an id field
  for (const entity of metadata.entities) {
    const hasId = entity.fields.some(f => f.name === 'id')
    if (!hasId) {
      entity.fields.unshift({
        name: 'id',
        type: 'uuid',
        required: true,
        unique: true,
        description: 'Unique identifier',
      })
    }
  }

  return true
}
