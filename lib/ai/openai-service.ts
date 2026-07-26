import OpenAI from 'openai'
import { getModel } from './model-router'

// Initialize OpenAI client (singleton)
let openaiClient: OpenAI | null = null

export function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey || apiKey === 'sk-proj-your-openai-api-key-here') {
      throw new Error('OPENAI_API_KEY not configured in .env file')
    }
    openaiClient = new OpenAI({
      apiKey,
      timeout: 30_000,   // 30s hard timeout — prevents indefinite hangs
      maxRetries: 1,      // 1 retry on transient failures (default is 2)
    })
  }
  return openaiClient
}

/**
 * #14 — Cost Tracking: record usage after any OpenAI completion response.
 * Pass projectId and endpoint label alongside the response object.
 * Fire-and-forget — never blocks the caller.
 */
export function trackCompletionCost(
  response: OpenAI.Chat.ChatCompletion,
  projectId: string,
  endpoint: string,
): void {
  if (!projectId) return
  const usage = response.usage
  if (!usage) return

  // Tokens OpenAI served from its prompt cache at 25% of the input rate. The
  // brain's ~15.7k-token tool catalog is byte-identical on every request, so
  // this is normally the bulk of the prompt after the first call of a turn —
  // pricing it as fresh input overstated the loop's cost roughly fourfold.
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0

  import('./cost-tracker')
    .then(({ recordAiUsage }) =>
      recordAiUsage(projectId, response.model, usage.prompt_tokens, usage.completion_tokens, endpoint, cachedTokens)
    )
    .catch((err: any) => console.error('[OpenAIService] cost tracking failed:', err))
}

// Intent detection using GPT
export interface DetectedIntent {
  intent: string
  confidence: number
  entities: Record<string, any>
  reasoning: string
  requiresConfirmation: boolean
  destructive: boolean
}

export async function detectIntentWithAI(
  userMessage: string,
  projectContext?: any
): Promise<DetectedIntent> {
  const openai = getOpenAIClient()

  const systemPrompt = `You are an intent detection AI for a Backend-as-a-Service platform.
Your job is to analyze user messages and detect their intent.

Available intents:
- CREATE_API: User wants to create REST/GraphQL API endpoints
- CREATE_TABLE: User wants to create database tables/schema
- READ_PROJECT_STATE: User asks about current project status
- DEBUG_DEPLOY: User needs help with deployment issues
- DEBUG_ERROR: User wants to understand errors
- OPTIMIZE_QUERY: User wants database optimization
- EXPLAIN_FEATURE: User asks how something works
- DESTRUCTIVE_DB_ACTION: User wants to delete/drop data
- CONFIGURE_AUTH: User wants to setup authentication
- SETUP_STORAGE: User wants to configure file storage
- EXECUTE_CODE: User wants to run/test something
- MODIFY_EXISTING: User wants to change existing code/schema

Respond ONLY with valid JSON:
{
  "intent": "INTENT_NAME",
  "confidence": 0.0-1.0,
  "entities": { "tableName": "users", "fields": ["email", "password"] },
  "reasoning": "Brief explanation",
  "requiresConfirmation": true/false,
  "destructive": true/false
}

CRITICAL RULES:
1. CREATE_TABLE → ALWAYS set requiresConfirmation: true
2. CREATE_API → ALWAYS set requiresConfirmation: true
3. DESTRUCTIVE_DB_ACTION → ALWAYS set requiresConfirmation: true, destructive: true
4. MODIFY_EXISTING → ALWAYS set requiresConfirmation: true
5. READ_PROJECT_STATE, EXPLAIN_FEATURE → requiresConfirmation: false

Any action that modifies files, database, or code MUST require confirmation.`

  const userPrompt = projectContext
    ? `User message: "${userMessage}"\n\nProject context: ${JSON.stringify(projectContext)}`
    : `User message: "${userMessage}"`

  try {
    const response = await openai.chat.completions.create({
      model: getModel('classify'), // Intent detection — cheap model
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3, // Low temperature for consistent intent detection
      max_tokens: 500,
      response_format: { type: 'json_object' },
    })

    const result = JSON.parse(response.choices[0].message.content || '{}')
    return result
  } catch (error) {
    console.error('❌ OpenAI intent detection failed:', error)
    // Fallback to basic detection
    return {
      intent: 'UNKNOWN',
      confidence: 0.1,
      entities: {},
      reasoning: 'Failed to detect intent with AI',
      requiresConfirmation: false,
      destructive: false,
    }
  }
}

// Generate intelligent response using GPT
export async function generateAIResponse(
  userMessage: string,
  detectedIntent: DetectedIntent,
  projectContext: any,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<string> {
  const openai = getOpenAIClient()

  // Extract schema/tables from project context for grounding
  const tables = projectContext?.database?.tables || []
  const tableNames = tables.map((t: any) => t.name || t).join(', ')
  const hasAuth = projectContext?.features?.authEnabled || false
  const apiCount = projectContext?.apis?.count || 0

  const systemPrompt = `You are Backenly AI — an expert backend engineer for this specific project.

## This Project's Current State:
- Tables: ${tableNames || 'none yet'}
- APIs: ${apiCount} endpoint${apiCount !== 1 ? 's' : ''} live
- Auth: ${hasAuth ? 'JWT (email/password) enabled' : 'not configured'}
- Project: ${projectContext?.project?.name || 'unnamed project'}

## Your Role:
Answer as the engineer who built this backend. Be direct, specific, and grounded in what actually exists.

## For "is it done?" / "can I connect frontend?" questions:
Evaluate completeness based on the tables and APIs above. Give a specific yes/no with any remaining steps.

## For "how do I connect?" questions:
1. Go to the Connect section in the sidebar
2. Copy the SDK snippet (or use the Client Key)
3. Initialize: \`const backend = new BackenlyClient({ projectId: '...', clientKey: '...' })\`
4. Call APIs: \`backend.tableName.list()\`, \`backend.tableName.create({...})\`

## For "what is this project?" questions:
Describe what it does based on the table names and their relationships.

## Rules:
- Never say "That's a great question" or start with generic openers
- Reference actual table names from the project context above
- If nothing is built yet, say so and ask what they want to build
- Max 200 words. Be concise.`

  try {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.map(
        (msg) =>
          ({
            role: msg.role,
            content: msg.content,
          } as OpenAI.Chat.ChatCompletionMessageParam)
      ),
      { role: 'user', content: userMessage },
    ]

    const response = await openai.chat.completions.create({
      model: getModel('respond'), // Conversational response — smart model
      messages,
      temperature: 0.7,
      max_tokens: 1000,
    })

    return response.choices[0].message.content || 'I apologize, I could not generate a response.'
  } catch (error) {
    console.error('❌ OpenAI response generation failed:', error)
    return 'I encountered an error processing your request. Please try again.'
  }
}

// Generate execution plan from intent
export async function generateExecutionPlan(
  userMessage: string,
  detectedIntent: DetectedIntent,
  projectContext: any
): Promise<{
  steps: Array<{ action: string; description: string; code?: string }>
  confirmation: string
  estimatedTime: string
}> {
  const openai = getOpenAIClient()

  const systemPrompt = `You are a backend execution planner.
Generate a detailed, executable plan based on user intent.

Respond ONLY with valid JSON:
{
  "steps": [
    {
      "action": "CREATE_DATABASE_TABLE",
      "description": "Create products table",
      "code": {"tableName": "products", "columns": [{"name": "id", "type": "SERIAL", "primary": true}, {"name": "name", "type": "TEXT", "nullable": false}, {"name": "price", "type": "DECIMAL(10,2)"}, {"name": "created_at", "type": "TIMESTAMP", "nullable": false}]}
    },
    {
      "action": "CREATE_API_DEFINITION",
      "description": "Generate API definition for products table",
      "code": {"tableName": "products", "apiName": "products", "version": "v1", "basePath": "/products", "authStrategy": "jwt", "operations": {"list": true, "get": true, "create": true, "update": true, "delete": true, "search": false, "bulk": false}, "rateLimit": 100, "validation": true}
    }
  ],
  "confirmation": "I will create a products table and API definition. Confirm?",
  "estimatedTime": "10 seconds"
}

Actions available:
- CREATE_DATABASE_TABLE: Create table directly in workspace database (PREFERRED for simple tables)
- INSERT_MOCK_DATA: Insert sample data rows into existing table
- CREATE_API_DEFINITION: Create metadata-driven API (REQUIRED for all API generation - NO code files!)
- CREATE_PRISMA_MODEL: Generate Prisma schema (for complex models with relationships)
- RUN_MIGRATION: Execute database migration (REQUIRED after CREATE_PRISMA_MODEL)
- MODIFY_ENV: Add environment variable
- GENERATE_AUTH: Setup authentication
- CREATE_STORAGE_BUCKET: Configure storage

CRITICAL RULES:
1. For simple table creation → Use CREATE_DATABASE_TABLE (faster, no migration needed)
2. For adding data to existing tables → Use INSERT_MOCK_DATA (do NOT use CREATE_DATABASE_TABLE)
3. INSERT_MOCK_DATA MUST include actual data in code field: {"tableName": "Addresses", "rows": [{"userId": 1, "street": "123 Main St", "city": "New York", "state": "NY", "zipCode": "10001"}]}
4. ALWAYS generate realistic sample data with proper values (don't leave code field empty)
5. For Addresses table: include realistic street names, cities, states, and zip codes
6. For complex models with relations → Use CREATE_PRISMA_MODEL + RUN_MIGRATION
7. ALWAYS add RUN_MIGRATION step after CREATE_PRISMA_MODEL
8. RUN_MIGRATION must come AFTER all schema changes
9. CREATE_DATABASE_TABLE expects JSON: {"tableName": "reviews", "columns": [{"name": "id", "type": "SERIAL", "primary": true}]}
10. For CREATE_DATABASE_TABLE, include column types: TEXT, INTEGER, BOOLEAN, TIMESTAMP, DECIMAL(10,2), SERIAL
11. Always include createdAt and updatedAt fields
12. **NEVER use CREATE_API_ROUTE** - It's deprecated! Use CREATE_API_DEFINITION instead
13. When generating APIs → Use CREATE_API_DEFINITION with proper config JSON
14. API Definition format: {"tableName": "products", "apiName": "products", "version": "v1", "basePath": "/products", "authStrategy": "jwt", "operations": {...}, "rateLimit": 100, "validation": true}
15. authStrategy options: "jwt" (default), "api-key", "public"
16. operations must specify: list, get, create, update, delete, search, bulk (true/false)
17. API Definitions are stored in database - NO code generation!
18. For public APIs → Set authStrategy to "public" and disable create/update/delete operations`

  try {
    const response = await openai.chat.completions.create({
      model: getModel('plan'), // Execution plan generation — smart model
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Intent: ${detectedIntent.intent}\nUser message: "${userMessage}"\nEntities: ${JSON.stringify(detectedIntent.entities)}\nProject: ${JSON.stringify(projectContext)}`,
        },
      ],
      temperature: 0.2,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    })

    return JSON.parse(response.choices[0].message.content || '{}')
  } catch (error) {
    console.error('❌ OpenAI plan generation failed:', error)
    return {
      steps: [],
      confirmation: 'Could not generate execution plan. Please try again.',
      estimatedTime: 'unknown',
    }
  }
}
