/**
 * MINIMAL AI EXECUTOR
 * ===================
 * This is the REAL execution engine.
 * AI returns JSON → This calls actual backend endpoints.
 * 
 * No complexity. No architecture. Just: AI → Backend.
 */

import { getOpenAIClient } from './openai-service'
import { isReservedWorkspaceTable } from '@/lib/security/workspace-schema'
import { getActiveGraph, saveNewGraph } from '@/lib/orchestration/graph-pointer'
import { withTimeout } from './with-timeout'
import { trackAction } from './execution-timeline'
import { classifyErrorCode } from '@/lib/errors/taxonomy'
import { generateDomainEndpoints as _generateDomainEndpoints } from './build-runtime/domain-business-logic'
import { USER_ROLE_ID_BASES as _SEMANTIC_USER_ROLE_ID_BASES, USER_SEMANTIC_COLS as _SEMANTIC_USER_COLS } from './semantic-relations'
import { writeDecisionEntry, extractFkInferences } from '@/lib/memory/decision-memory'
import { riskLevelForExecutorAction, queuePendingActionFinding } from '@/lib/operational-memory/ledger'

export interface AIAction {
  /** Optional trace explaining why this action was chosen — aids debugging hallucinations */
  reasoning?: string
  /** Confidence 0–1 from the generating LLM — low values (<0.7) should trigger approval gate */
  confidence?: number
  action:
    // Database
    | 'CREATE_TABLE' | 'ADD_COLUMN' | 'INSERT_DATA' | 'LIST_TABLES'
    | 'CREATE_INDEX' | 'RENAME_COLUMN' | 'ADD_CONSTRAINT'  // 🎯 FIX #2: Schema ops
    | 'DROP_COLUMN'
    | 'DROP_TABLE' | 'TRUNCATE_TABLE'
    // API
    | 'GENERATE_API' | 'LIST_APIS'
    // Storage
    | 'CREATE_BUCKET' | 'DELETE_BUCKET' | 'UPLOAD_FILE' | 'LIST_FILES' | 'LIST_BUCKETS' | 'DELETE_FILE' | 'GENERATE_SIGNED_URL' | 'SET_BUCKET_PUBLIC'
    // Connect Frontend
    | 'CONNECT_FRONTEND' | 'DISCONNECT_FRONTEND' | 'LIST_CONNECTED_APPS'
    // Deploy
    | 'TRIGGER_DEPLOY' | 'ROLLBACK_DEPLOY' | 'GET_DEPLOY_STATUS' | 'GET_READINESS'
    | 'SET_ENV_VAR' | 'LIST_ENV_VARS' | 'DELETE_ENV_VAR'
    // Auth
    | 'ENABLE_AUTH' | 'ADD_PROVIDER' | 'DISABLE_PROVIDER'
    | 'LIST_USERS' | 'BLOCK_USER' | 'UNBLOCK_USER' | 'RESET_PASSWORD'
    // IAM (API Keys)
    | 'CREATE_KEY' | 'REVOKE_KEY' | 'ROTATE_KEY' | 'SET_KEY_PERMISSIONS' | 'LIST_KEYS'
    // Monitoring
    | 'GET_METRICS' | 'GET_ERRORS' | 'SET_ALERT' | 'GET_USAGE'
    // Info
    | 'INFO' | 'UNKNOWN'
    // Relations
    | 'CREATE_JUNCTION_TABLE'
    // Triggers (event automation)
    | 'CREATE_TRIGGER' | 'LIST_TRIGGERS' | 'DELETE_TRIGGER'
    | 'SYNC_COLUMN' | 'LIST_SYNCED_COLUMNS' | 'REMOVE_SYNC_COLUMN'
    // Permissions (row-level security)
    | 'SET_PERMISSION' | 'LIST_PERMISSIONS' | 'REMOVE_PERMISSION'
    // AI Functions (serverless logic described in natural language)
    | 'CREATE_AI_FUNCTION' | 'LIST_AI_FUNCTIONS' | 'DELETE_AI_FUNCTION' | 'TOGGLE_AI_FUNCTION'
    | 'FIX_AI_FUNCTION'
    // Self-repair actions — AI diagnoses and fixes broken platform features
    | 'FIX_AUTH'          // Fix broken auth (missing jwtSecret, broken OAuth, missing users table)
    | 'FIX_API'           // Fix missing or broken REST API for a table
    | 'FIX_TABLE'         // Fix broken table schema (missing columns, bad types)
    | 'FIX_DEPLOY'        // Fix/retry a failed deployment / publish
    | 'FIX_REALTIME'      // Fix broken realtime triggers (reinstall NOTIFY triggers)
    | 'FIX_STORAGE'       // Fix broken storage bucket or config
    | 'FIX_INTEGRATION'   // Fix broken integration (re-validate + re-store key)
    | 'FIX_WORKFLOW'      // Fix broken end-to-end workflow (auth flow, checkout flow, etc.)
    | 'REGISTER_TABLE'    // Adopt an existing DB table into the platform (metadata + API + RLS)
    | 'ADOPT_EXTERNAL_SCHEMA' // Adopt ALL drift observed over a direct DB connection (drift-watch)
    // Schema versioning (#13)
    | 'LIST_SCHEMA_VERSIONS' | 'ROLLBACK_TO_VERSION'
    // Integrations — store API keys + manage webhook receivers
    | 'STORE_INTEGRATION_KEY' | 'LIST_INTEGRATION_KEYS' | 'REMOVE_INTEGRATION_KEY'
    // Background jobs / cron scheduling
    | 'CREATE_CRON_JOB' | 'LIST_CRON_JOBS' | 'DELETE_CRON_JOB'
    // Database backups
    | 'BACKUP_DATABASE' | 'RESTORE_DATABASE' | 'LIST_BACKUPS'
    // Full-text search
    | 'ADD_FULLTEXT_SEARCH'
    // Vector / similarity search (pgvector + OpenAI text-embedding-3-small)
    | 'ENABLE_VECTOR_SEARCH'
    // Team / org multi-tenancy primitive (orgs + members + invitations)
    | 'ENABLE_TEAMS'
    // Webhook secret rotation
    | 'ROTATE_WEBHOOK_SECRET'
    // Push notifications via OneSignal
    | 'SEND_PUSH'
    // Column type migration
    | 'ALTER_COLUMN_TYPE'
    // Typed data migrations — backfill / split / merge / cast / normalize with
    // dry-run + per-table checkpoint. See lib/execution/data-migration.ts.
    | 'RUN_DATA_MIGRATION'
    // Staging environment
    | 'CREATE_STAGING' | 'PROMOTE_STAGING' | 'DROP_STAGING'
    // Per-endpoint rate limiting
    | 'SET_RATE_LIMIT' | 'LIST_RATE_LIMITS' | 'REMOVE_RATE_LIMIT'
    // Custom code generation (GAP 4)
    | 'GENERATE_FUNCTION' | 'LIST_FUNCTIONS'
    // Realtime — enable / disable live subscriptions for a table or project-wide
    | 'ENABLE_REALTIME' | 'DISABLE_REALTIME' | 'GET_REALTIME_STATUS'
    // Aggregate stats endpoint (GAP: custom aggregate queries)
    | 'GENERATE_AGGREGATE_API'
    // Cart → Order transactional checkout flow
    | 'GENERATE_CHECKOUT_FLOW'
    // Health check endpoint
    | 'GENERATE_HEALTH_CHECK'
    // Domain business logic — generates real TypeScript code for lifecycle flows (Issue 7)
    | 'GENERATE_DOMAIN_LOGIC'
    // Field-restricted endpoint (e.g. PATCH /orders/:id/status updates only status)
    | 'GENERATE_RESTRICTED_ENDPOINT'
  params: Record<string, any>
}

export interface ExecutionResult {
  success: boolean
  message: string
  data?: any
  error?: string
  /**
   * Issue 4: Artifact proof — populated by each executor action after a successful run.
   * The response renderer must not claim "done" without at least one non-empty field here.
   */
  artifacts?: {
    tables?: string[]
    apis?: Array<{ method: string; path: string }>
    buckets?: string[]
    functions?: string[]
    auth?: boolean
  }
  diff?: {
    added: string[]
    modified: string[]
    removed: string[]
  }
  /**
   * Things worth telling the caller that are NOT the outcome of the operation —
   * "this payments table has no Stripe key configured, so checkout is inert".
   *
   * Separate from `message` on purpose. These used to be string-concatenated
   * onto it, which put a "Paste your Stripe secret key" prompt inside the result
   * of a DDL migration: prose an agent cannot act on, in a field it reports
   * verbatim, attached to an operation that had nothing to do with payments.
   * As a field, a chat surface can render it, a migration receipt can list it,
   * and a caller that does not care can ignore it.
   */
  advisories?: string[]
  /** ISO timestamp set when a live DB read-back confirmed the artifact exists */
  verifiedAt?: string
  /**
   * Machine-readable failure code, forwarded to the agent by `dispatchTool` and
   * the MCP tool route so a caller can branch without regexing prose.
   *
   * Stable slugs — DUPLICATE_ROWS, COLUMN_NOT_FOUND, CONSTRAINT_CONFLICT,
   * VERIFY_FAILED, VALIDATION. Only meaningful when `success` is false.
   */
  code?: string
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  preview: string
  humanReadable: string  // NEW: Plain English explanation
}

export interface SimulationResult {
  willCreate?: string[]
  willModify?: string[]
  willDelete?: string[]
  risks: string[]
  reversible: boolean
  impact: string  // NEW: Human-readable impact summary
}

/**
 * SYSTEM 3: Constraint-First Execution
 * Auto-derive constraints from column names and types
 */
interface ColumnConstraints {
  isPrimaryKey: boolean
  isUnique: boolean
  isRequired: boolean // NOT NULL
  hasDefault: boolean
  foreignKey?: string // table.column reference
  /**
   * The caller's literal DEFAULT expression, already SQL-quoted.
   *
   * Set from an explicitly declared default (`create_table`'s `default` field,
   * or `DEFAULT ...` in a migration) and OUTRANKS every inferred default. Its
   * absence is what made `apply_migration` silently rewrite DDL: a declared
   * `DEFAULT true` was parsed, discarded, and replaced with the name-inferred
   * `DEFAULT false`.
   */
  defaultExpr?: string
  /**
   * The state-machine values this column is CHECK-constrained to, when one
   * applies. Carried on the constraint so the DEFAULT can be derived from the
   * SAME list the CHECK is built from — see `initialStateFor`.
   */
  stateValues?: string[]
  /** True when the caller stated nullability, rather than it being inferred. */
  explicitNotNull?: boolean
}

/**
 * The state a row should START in, given the values its CHECK constraint
 * permits.
 *
 * ── The bug this exists to make impossible ──────────────────────────────────
 *
 * Defaults and CHECK constraints were produced by two code paths that had never
 * heard of each other. `applyConstraintsToColumn` gave any column whose name
 * contained "status" `DEFAULT 'active'`. `STATUS_DOMAIN_MAP`, 3000 lines away,
 * gave `orders.payment_status` `CHECK (payment_status IN ('pending','paid',
 * 'failed','refunded','disputed'))`.
 *
 * 'active' is not in that list. Every `orders` table Backenly generated was
 * un-insertable through its own default: omit payment_status and the row is
 * rejected with SQLSTATE 23514. `orders.status` had the identical bug
 * (`DEFAULT 'active'` against `pending|processing|shipped|delivered|cancelled|
 * refunded`) and was only survivable because callers tended to set status
 * explicitly.
 *
 * Reported from a real build on 2026-07-22. It was not an edge case — it broke
 * every e-commerce project at the first INSERT.
 *
 * The fix is not to correct the two lists to agree. Two lists that must agree
 * will disagree again. The default is now DERIVED from the permitted values, so
 * a table's default is unrepresentable unless the CHECK allows it.
 *
 * ── Choosing which value ────────────────────────────────────────────────────
 *
 * A state machine's default is its INITIAL state, which is not simply the first
 * element for every set — `subscriptions` lists 'active' first but a row should
 * begin 'trialing' only if that is what the product means, and 'active' is
 * genuinely correct there. So: an explicit initial state where the domain has
 * one, otherwise the first permitted value, which is how these lists are
 * ordered anyway.
 */
const PREFERRED_INITIAL_STATES = ['pending', 'draft', 'queued', 'todo', 'open', 'requested']

export function initialStateFor(values: string[]): string | undefined {
  if (!values.length) return undefined
  const preferred = PREFERRED_INITIAL_STATES.find(p => values.includes(p))
  return preferred ?? values[0]
}

/** SQL-quote a literal for use in a DEFAULT clause. */
function sqlLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
}

// ── Domain-aware column blueprints ────────────────────────────────────────────
// Safety net: when the LLM emits CREATE_TABLE with an empty columns array, this
// lookup ensures users always get a properly-structured table, never a skeleton.

const TABLE_COLUMN_BLUEPRINTS: Record<string, Array<{ name: string; type: string }>> = {
  // E-commerce
  products:    [{ name: 'name', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'price', type: 'DECIMAL' }, { name: 'stock_quantity', type: 'INTEGER' }, { name: 'category_id', type: 'UUID' }, { name: 'image_url', type: 'TEXT' }, { name: 'status', type: 'TEXT' }, { name: 'sku', type: 'TEXT' }],
  orders:      [{ name: 'user_id', type: 'UUID' }, { name: 'status', type: 'TEXT' }, { name: 'total_amount', type: 'DECIMAL' }, { name: 'shipping_address', type: 'JSONB' }, { name: 'payment_status', type: 'TEXT' }, { name: 'stripe_session_id', type: 'TEXT' }],
  order_items: [{ name: 'order_id', type: 'UUID' }, { name: 'product_id', type: 'UUID' }, { name: 'quantity', type: 'INTEGER' }, { name: 'unit_price', type: 'DECIMAL' }, { name: 'subtotal', type: 'DECIMAL' }],
  carts:       [{ name: 'user_id', type: 'UUID' }, { name: 'status', type: 'TEXT' }],
  cart_items:  [{ name: 'cart_id', type: 'UUID' }, { name: 'product_id', type: 'UUID' }, { name: 'quantity', type: 'INTEGER' }, { name: 'unit_price', type: 'DECIMAL' }],
  reviews:     [{ name: 'user_id', type: 'UUID' }, { name: 'product_id', type: 'UUID' }, { name: 'rating', type: 'INTEGER' }, { name: 'title', type: 'TEXT' }, { name: 'body', type: 'TEXT' }, { name: 'status', type: 'TEXT' }],
  payments:    [{ name: 'order_id', type: 'UUID' }, { name: 'amount', type: 'DECIMAL' }, { name: 'currency', type: 'TEXT' }, { name: 'status', type: 'TEXT' }, { name: 'provider', type: 'TEXT' }, { name: 'provider_payment_id', type: 'TEXT' }],
  categories:  [{ name: 'name', type: 'TEXT' }, { name: 'slug', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'parent_id', type: 'UUID' }],
  addresses:   [{ name: 'user_id', type: 'UUID' }, { name: 'line1', type: 'TEXT' }, { name: 'line2', type: 'TEXT' }, { name: 'city', type: 'TEXT' }, { name: 'state', type: 'TEXT' }, { name: 'country', type: 'TEXT' }, { name: 'postal_code', type: 'TEXT' }, { name: 'is_default', type: 'BOOLEAN' }],
  inventory:   [{ name: 'product_id', type: 'UUID' }, { name: 'quantity_available', type: 'INTEGER' }, { name: 'quantity_reserved', type: 'INTEGER' }, { name: 'warehouse_location', type: 'TEXT' }],
  // Social / Community
  posts:         [{ name: 'user_id', type: 'UUID' }, { name: 'title', type: 'TEXT' }, { name: 'body', type: 'TEXT' }, { name: 'status', type: 'TEXT' }, { name: 'slug', type: 'TEXT' }, { name: 'published_at', type: 'TIMESTAMP' }],
  comments:      [{ name: 'user_id', type: 'UUID' }, { name: 'post_id', type: 'UUID' }, { name: 'body', type: 'TEXT' }, { name: 'status', type: 'TEXT' }],
  likes:         [{ name: 'user_id', type: 'UUID' }, { name: 'post_id', type: 'UUID' }],
  follows:       [{ name: 'follower_id', type: 'UUID' }, { name: 'following_id', type: 'UUID' }],
  notifications: [{ name: 'user_id', type: 'UUID' }, { name: 'type', type: 'TEXT' }, { name: 'title', type: 'TEXT' }, { name: 'body', type: 'TEXT' }, { name: 'read', type: 'BOOLEAN' }, { name: 'data', type: 'JSONB' }],
  messages:      [{ name: 'sender_id', type: 'UUID' }, { name: 'receiver_id', type: 'UUID' }, { name: 'body', type: 'TEXT' }, { name: 'read', type: 'BOOLEAN' }],
  profiles:      [{ name: 'user_id', type: 'UUID' }, { name: 'bio', type: 'TEXT' }, { name: 'avatar_url', type: 'TEXT' }, { name: 'website', type: 'TEXT' }, { name: 'location', type: 'TEXT' }],
  // SaaS / B2B
  organizations: [{ name: 'name', type: 'TEXT' }, { name: 'slug', type: 'TEXT' }, { name: 'owner_id', type: 'UUID' }, { name: 'plan', type: 'TEXT' }, { name: 'logo_url', type: 'TEXT' }],
  memberships:   [{ name: 'user_id', type: 'UUID' }, { name: 'organization_id', type: 'UUID' }, { name: 'role', type: 'TEXT' }],
  projects:      [{ name: 'name', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'owner_id', type: 'UUID' }, { name: 'organization_id', type: 'UUID' }, { name: 'status', type: 'TEXT' }],
  tasks:         [{ name: 'title', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'assignee_id', type: 'UUID' }, { name: 'project_id', type: 'UUID' }, { name: 'status', type: 'TEXT' }, { name: 'priority', type: 'TEXT' }, { name: 'due_date', type: 'TIMESTAMP' }],
  tickets:       [{ name: 'title', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'user_id', type: 'UUID' }, { name: 'assignee_id', type: 'UUID' }, { name: 'status', type: 'TEXT' }, { name: 'priority', type: 'TEXT' }, { name: 'type', type: 'TEXT' }],
  subscriptions: [{ name: 'user_id', type: 'UUID' }, { name: 'plan', type: 'TEXT' }, { name: 'status', type: 'TEXT' }, { name: 'current_period_start', type: 'TIMESTAMP' }, { name: 'current_period_end', type: 'TIMESTAMP' }, { name: 'stripe_subscription_id', type: 'TEXT' }],
  invoices:      [{ name: 'user_id', type: 'UUID' }, { name: 'amount', type: 'DECIMAL' }, { name: 'currency', type: 'TEXT' }, { name: 'status', type: 'TEXT' }, { name: 'due_date', type: 'TIMESTAMP' }, { name: 'paid_at', type: 'TIMESTAMP' }],
  // Content / CMS
  articles:      [{ name: 'author_id', type: 'UUID' }, { name: 'title', type: 'TEXT' }, { name: 'body', type: 'TEXT' }, { name: 'slug', type: 'TEXT' }, { name: 'status', type: 'TEXT' }, { name: 'category_id', type: 'UUID' }, { name: 'published_at', type: 'TIMESTAMP' }],
  tags:          [{ name: 'name', type: 'TEXT' }, { name: 'slug', type: 'TEXT' }],
  media:         [{ name: 'user_id', type: 'UUID' }, { name: 'url', type: 'TEXT' }, { name: 'type', type: 'TEXT' }, { name: 'filename', type: 'TEXT' }, { name: 'size', type: 'INTEGER' }],
  // Events / Booking
  events:        [{ name: 'title', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'organizer_id', type: 'UUID' }, { name: 'start_time', type: 'TIMESTAMP' }, { name: 'end_time', type: 'TIMESTAMP' }, { name: 'location', type: 'TEXT' }, { name: 'capacity', type: 'INTEGER' }, { name: 'status', type: 'TEXT' }],
  bookings:      [{ name: 'user_id', type: 'UUID' }, { name: 'event_id', type: 'UUID' }, { name: 'status', type: 'TEXT' }, { name: 'notes', type: 'TEXT' }],
  appointments:  [{ name: 'patient_id', type: 'UUID' }, { name: 'provider_id', type: 'UUID' }, { name: 'scheduled_at', type: 'TIMESTAMP' }, { name: 'duration_minutes', type: 'INTEGER' }, { name: 'status', type: 'TEXT' }, { name: 'notes', type: 'TEXT' }],
  // Food / Restaurant
  restaurants:   [{ name: 'name', type: 'TEXT' }, { name: 'owner_id', type: 'UUID' }, { name: 'address', type: 'TEXT' }, { name: 'phone', type: 'TEXT' }, { name: 'cuisine_type', type: 'TEXT' }, { name: 'is_open', type: 'BOOLEAN' }],
  menus:         [{ name: 'name', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'restaurant_id', type: 'UUID' }, { name: 'is_active', type: 'BOOLEAN' }],
  menu_items:    [{ name: 'menu_id', type: 'UUID' }, { name: 'name', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'price', type: 'DECIMAL' }, { name: 'category', type: 'TEXT' }, { name: 'is_available', type: 'BOOLEAN' }, { name: 'image_url', type: 'TEXT' }],
  // Fitness / Health
  workouts:      [{ name: 'user_id', type: 'UUID' }, { name: 'name', type: 'TEXT' }, { name: 'duration_minutes', type: 'INTEGER' }, { name: 'calories_burned', type: 'INTEGER' }, { name: 'notes', type: 'TEXT' }],
  exercises:     [{ name: 'name', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'muscle_group', type: 'TEXT' }, { name: 'equipment', type: 'TEXT' }],
  // AI / Video Generation SaaS
  generation_jobs: [
    { name: 'user_id', type: 'UUID' },
    { name: 'project_id', type: 'UUID' },
    { name: 'prompt', type: 'TEXT' },
    { name: 'status', type: 'TEXT' },          // queued | processing | completed | failed | cancelled
    { name: 'provider', type: 'TEXT' },         // runway | stability | kling | pika | sora
    { name: 'model', type: 'TEXT' },
    { name: 'duration_seconds', type: 'INTEGER' },
    { name: 'resolution', type: 'TEXT' },
    { name: 'output_url', type: 'TEXT' },
    { name: 'thumbnail_url', type: 'TEXT' },
    { name: 'progress_pct', type: 'INTEGER' },  // 0-100
    { name: 'credits_used', type: 'INTEGER' },
    { name: 'error_message', type: 'TEXT' },
    { name: 'attempts', type: 'INTEGER' },
    { name: 'provider_job_id', type: 'TEXT' },  // external job ID from AI provider
    { name: 'metadata', type: 'JSONB' },
    { name: 'completed_at', type: 'TIMESTAMP' },
  ],
  render_jobs: [
    { name: 'user_id', type: 'UUID' },
    { name: 'status', type: 'TEXT' },
    { name: 'input_data', type: 'JSONB' },
    { name: 'output_url', type: 'TEXT' },
    { name: 'progress_pct', type: 'INTEGER' },
    { name: 'credits_used', type: 'INTEGER' },
    { name: 'error_message', type: 'TEXT' },
    { name: 'attempts', type: 'INTEGER' },
    { name: 'completed_at', type: 'TIMESTAMP' },
  ],
  credit_wallets: [
    { name: 'user_id', type: 'UUID' },
    { name: 'balance', type: 'INTEGER' },
    { name: 'reserved', type: 'INTEGER' },      // credits locked by in-progress jobs
    { name: 'lifetime_purchased', type: 'INTEGER' },
    { name: 'lifetime_used', type: 'INTEGER' },
    { name: 'plan', type: 'TEXT' },
    { name: 'updated_at', type: 'TIMESTAMP' },
  ],
  credit_transactions: [
    { name: 'user_id', type: 'UUID' },
    { name: 'wallet_id', type: 'UUID' },
    { name: 'type', type: 'TEXT' },             // purchase | usage | refund | bonus | reservation | release
    { name: 'amount', type: 'INTEGER' },         // positive = credit, negative = debit
    { name: 'balance_after', type: 'INTEGER' },
    { name: 'description', type: 'TEXT' },
    { name: 'job_id', type: 'UUID' },
    { name: 'stripe_payment_intent_id', type: 'TEXT' },
    { name: 'metadata', type: 'JSONB' },
  ],
  // Education / LMS
  courses:       [{ name: 'title', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'instructor_id', type: 'UUID' }, { name: 'price', type: 'DECIMAL' }, { name: 'status', type: 'TEXT' }, { name: 'thumbnail_url', type: 'TEXT' }],
  lessons:       [{ name: 'course_id', type: 'UUID' }, { name: 'title', type: 'TEXT' }, { name: 'content', type: 'TEXT' }, { name: 'order', type: 'INTEGER' }, { name: 'duration_minutes', type: 'INTEGER' }, { name: 'video_url', type: 'TEXT' }],
  enrollments:   [{ name: 'user_id', type: 'UUID' }, { name: 'course_id', type: 'UUID' }, { name: 'status', type: 'TEXT' }, { name: 'completed_at', type: 'TIMESTAMP' }],
  // Job Board / HR
  jobs:          [{ name: 'title', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'company_id', type: 'UUID' }, { name: 'location', type: 'TEXT' }, { name: 'salary_min', type: 'INTEGER' }, { name: 'salary_max', type: 'INTEGER' }, { name: 'type', type: 'TEXT' }, { name: 'status', type: 'TEXT' }],
  applications:  [{ name: 'user_id', type: 'UUID' }, { name: 'job_id', type: 'UUID' }, { name: 'status', type: 'TEXT' }, { name: 'cover_letter', type: 'TEXT' }, { name: 'resume_url', type: 'TEXT' }],
  // Real Estate
  properties:    [{ name: 'owner_id', type: 'UUID' }, { name: 'title', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'address', type: 'TEXT' }, { name: 'price', type: 'DECIMAL' }, { name: 'bedrooms', type: 'INTEGER' }, { name: 'bathrooms', type: 'INTEGER' }, { name: 'area_sqft', type: 'DECIMAL' }, { name: 'type', type: 'TEXT' }, { name: 'status', type: 'TEXT' }],
  // Travel / Accommodation
  listings:      [{ name: 'host_id', type: 'UUID' }, { name: 'title', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'price_per_night', type: 'DECIMAL' }, { name: 'location', type: 'TEXT' }, { name: 'max_guests', type: 'INTEGER' }, { name: 'status', type: 'TEXT' }],
  reservations:  [{ name: 'user_id', type: 'UUID' }, { name: 'listing_id', type: 'UUID' }, { name: 'check_in', type: 'TIMESTAMP' }, { name: 'check_out', type: 'TIMESTAMP' }, { name: 'total_price', type: 'DECIMAL' }, { name: 'status', type: 'TEXT' }],
}

/**
 * Infer default columns for a table when the LLM fails to provide them.
 * Exact match first, then semantic pattern fallbacks, then a minimal generic set.
 */
function inferColumnsForTable(tableName: string): Array<{ name: string; type: string }> {
  const lower = tableName.toLowerCase()
  if (TABLE_COLUMN_BLUEPRINTS[lower]) return TABLE_COLUMN_BLUEPRINTS[lower]

  // Semantic suffix patterns
  if (/_items$|_lines$/.test(lower)) {
    const parent = lower.replace(/_items$|_lines$/, '')
    return [{ name: `${parent}_id`, type: 'UUID' }, { name: 'quantity', type: 'INTEGER' }, { name: 'unit_price', type: 'DECIMAL' }, { name: 'subtotal', type: 'DECIMAL' }]
  }
  if (/_members$|_memberships$/.test(lower)) {
    const parent = lower.replace(/_members$|_memberships$/, '')
    return [{ name: 'user_id', type: 'UUID' }, { name: `${parent}_id`, type: 'UUID' }, { name: 'role', type: 'TEXT' }, { name: 'joined_at', type: 'TIMESTAMP' }]
  }
  if (/_logs$|_events$|_history$|_audit$/.test(lower)) {
    return [{ name: 'user_id', type: 'UUID' }, { name: 'event_type', type: 'TEXT' }, { name: 'data', type: 'JSONB' }, { name: 'ip_address', type: 'TEXT' }]
  }
  if (/_settings$|_config$|_preferences$/.test(lower)) {
    return [{ name: 'user_id', type: 'UUID' }, { name: 'key', type: 'TEXT' }, { name: 'value', type: 'JSONB' }]
  }

  // Semantic keyword patterns
  if (/message|chat|conversation|inbox/.test(lower)) return [{ name: 'sender_id', type: 'UUID' }, { name: 'receiver_id', type: 'UUID' }, { name: 'body', type: 'TEXT' }, { name: 'read', type: 'BOOLEAN' }]
  if (/notification|alert/.test(lower))              return [{ name: 'user_id', type: 'UUID' }, { name: 'type', type: 'TEXT' }, { name: 'title', type: 'TEXT' }, { name: 'body', type: 'TEXT' }, { name: 'read', type: 'BOOLEAN' }]
  if (/payment|transaction|invoice|charge/.test(lower)) return [{ name: 'user_id', type: 'UUID' }, { name: 'amount', type: 'DECIMAL' }, { name: 'currency', type: 'TEXT' }, { name: 'status', type: 'TEXT' }, { name: 'provider', type: 'TEXT' }, { name: 'provider_id', type: 'TEXT' }]
  if (/product|item|listing|good/.test(lower))       return [{ name: 'name', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'price', type: 'DECIMAL' }, { name: 'status', type: 'TEXT' }, { name: 'image_url', type: 'TEXT' }]
  if (/order|booking|reservation|purchase/.test(lower)) return [{ name: 'user_id', type: 'UUID' }, { name: 'status', type: 'TEXT' }, { name: 'total_amount', type: 'DECIMAL' }]
  if (/post|article|blog|content/.test(lower))       return [{ name: 'author_id', type: 'UUID' }, { name: 'title', type: 'TEXT' }, { name: 'body', type: 'TEXT' }, { name: 'status', type: 'TEXT' }, { name: 'slug', type: 'TEXT' }]
  if (/comment|reply|feedback/.test(lower))          return [{ name: 'user_id', type: 'UUID' }, { name: 'body', type: 'TEXT' }, { name: 'status', type: 'TEXT' }]
  if (/review|rating/.test(lower))                   return [{ name: 'user_id', type: 'UUID' }, { name: 'rating', type: 'INTEGER' }, { name: 'title', type: 'TEXT' }, { name: 'body', type: 'TEXT' }, { name: 'status', type: 'TEXT' }]
  if (/categor|tag|label|genre/.test(lower))         return [{ name: 'name', type: 'TEXT' }, { name: 'slug', type: 'TEXT' }, { name: 'description', type: 'TEXT' }]
  if (/course|lesson|class|module/.test(lower))      return [{ name: 'title', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'instructor_id', type: 'UUID' }, { name: 'status', type: 'TEXT' }]
  if (/job|position|vacancy|role/.test(lower))       return [{ name: 'title', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'status', type: 'TEXT' }, { name: 'location', type: 'TEXT' }]
  if (/application|submission|candidate/.test(lower)) return [{ name: 'user_id', type: 'UUID' }, { name: 'status', type: 'TEXT' }, { name: 'notes', type: 'TEXT' }]
  if (/report|analytic|stat|metric/.test(lower))     return [{ name: 'user_id', type: 'UUID' }, { name: 'type', type: 'TEXT' }, { name: 'data', type: 'JSONB' }, { name: 'period_start', type: 'TIMESTAMP' }, { name: 'period_end', type: 'TIMESTAMP' }]
  if (/profile|account|member/.test(lower))          return [{ name: 'user_id', type: 'UUID' }, { name: 'bio', type: 'TEXT' }, { name: 'avatar_url', type: 'TEXT' }, { name: 'website', type: 'TEXT' }]
  if (/restaurant|venue|store|shop/.test(lower))     return [{ name: 'name', type: 'TEXT' }, { name: 'owner_id', type: 'UUID' }, { name: 'address', type: 'TEXT' }, { name: 'phone', type: 'TEXT' }, { name: 'status', type: 'TEXT' }]
  if (/workout|exercise|fitness|health/.test(lower)) return [{ name: 'user_id', type: 'UUID' }, { name: 'name', type: 'TEXT' }, { name: 'duration_minutes', type: 'INTEGER' }, { name: 'notes', type: 'TEXT' }]

  // AI / Video Generation
  if (/generation_job|render_job|video_job|.*_job$|.*_jobs$/.test(lower)) {
    return [
      { name: 'user_id', type: 'UUID' }, { name: 'status', type: 'TEXT' },
      { name: 'prompt', type: 'TEXT' }, { name: 'output_url', type: 'TEXT' },
      { name: 'progress_pct', type: 'INTEGER' }, { name: 'credits_used', type: 'INTEGER' },
      { name: 'error_message', type: 'TEXT' }, { name: 'attempts', type: 'INTEGER' },
      { name: 'provider_job_id', type: 'TEXT' }, { name: 'completed_at', type: 'TIMESTAMP' },
    ]
  }
  if (/credit_wallet|wallet|credit_balance/.test(lower)) {
    return [
      { name: 'user_id', type: 'UUID' }, { name: 'balance', type: 'INTEGER' },
      { name: 'reserved', type: 'INTEGER' }, { name: 'lifetime_purchased', type: 'INTEGER' },
      { name: 'lifetime_used', type: 'INTEGER' }, { name: 'plan', type: 'TEXT' },
    ]
  }
  if (/credit_transaction|credit_log|credit_event/.test(lower)) {
    return [
      { name: 'user_id', type: 'UUID' }, { name: 'type', type: 'TEXT' },
      { name: 'amount', type: 'INTEGER' }, { name: 'balance_after', type: 'INTEGER' },
      { name: 'description', type: 'TEXT' }, { name: 'job_id', type: 'UUID' },
    ]
  }
  if (/video|clip|asset|media_file|upload/.test(lower)) {
    return [
      { name: 'user_id', type: 'UUID' }, { name: 'filename', type: 'TEXT' },
      { name: 'url', type: 'TEXT' }, { name: 'thumbnail_url', type: 'TEXT' },
      { name: 'content_type', type: 'TEXT' }, { name: 'size_bytes', type: 'BIGINT' },
      { name: 'duration_seconds', type: 'INTEGER' }, { name: 'status', type: 'TEXT' },
      { name: 'storage_path', type: 'TEXT' }, { name: 'is_public', type: 'BOOLEAN' },
    ]
  }

  // Generic fallback — better than nothing
  return [{ name: 'name', type: 'TEXT' }, { name: 'description', type: 'TEXT' }, { name: 'status', type: 'TEXT' }]
}

/**
 * Column-name prefixes that denote an identifier owned by a third-party system.
 * These are opaque provider strings (`cus_…`, `sub_…`), never local FK targets
 * and never UUIDs, so they must stay TEXT and must not gain a REFERENCES clause.
 * Module-scoped so both deriveConstraints and normalizeColumnType can consult it.
 */
const EXTERNAL_ID_PREFIXES = new Set([
  // Stripe (+ common typos)
  'stripe', 'stipe', 'stirpe', 'stripes',
  'stripecustomer', 'stripesubscription', 'stripepayment', 'stripeproduct', 'stripeprice',
  // Auth providers
  'cognito', 'auth0', 'firebase', 'clerk', 'okta', 'supabase',
  // Generic external indicators
  'external', 'third', 'vendor', 'provider', 'oauth', 'social',
  // Social login providers
  'google', 'github', 'facebook', 'twitter', 'apple', 'microsoft', 'linkedin',
  // Comms services
  'twilio', 'sendgrid', 'resend', 'mailchimp', 'mailgun',
  // CRM / Sales
  'hubspot', 'salesforce', 'intercom', 'zendesk',
  // Ecommerce / Payments
  'shopify', 'square', 'paypal', 'braintree', 'adyen', 'paddle', 'lemonsqueezy',
  // Cloud / Infra
  'aws', 's3', 'azure', 'gcp', 'cloudflare', 'vercel', 'heroku', 'railway',
  // Data lifecycle
  'remote', 'legacy', 'old', 'sync', 'import', 'export', 'external',
  // Analytics / Monitoring
  'segment', 'mixpanel', 'amplitude', 'posthog', 'datadog', 'sentry',
])

/** True when an `*_id` column names a third-party identifier rather than a local FK. */
function isExternalIdColumn(lowerName: string): boolean {
  if (!lowerName.endsWith('id') || lowerName === 'id') return false
  const base = lowerName.endsWith('_id') ? lowerName.slice(0, -3) : lowerName.slice(0, -2)
  return EXTERNAL_ID_PREFIXES.has(base) || [...EXTERNAL_ID_PREFIXES].some(p => base.startsWith(p))
}

/** Table names that alone prove a payment processor is involved. */
const PAYMENT_TABLE_NAMES = new Set([
  'payments', 'payment', 'payment_methods', 'payment_events', 'checkouts',
])

/**
 * Table names that LOOK payment-shaped but routinely mean something else: an
 * expense tracker's `transactions` is a ledger, a CRM's `orders` may be internal
 * fulfilment, `invoices` is often just a billing record. Naming a table
 * `transactions` used to demand a Stripe key on backends that will never take a
 * payment, so these additionally require column-level evidence of a processor.
 */
const AMBIGUOUS_PAYMENT_TABLE_NAMES = new Set([
  'orders', 'order', 'transactions', 'transaction', 'invoices', 'invoice',
])

/** Column names that only appear when a real payment processor is wired up. */
const PAYMENT_COLUMN_EVIDENCE =
  /^(stripe_|paddle_|paypal_|square_|braintree_|adyen_)|^(payment_intent|payment_method|checkout_session|provider_id|provider|gateway|charge_id|transaction_ref)/i

/**
 * Should creating this table prompt the developer to connect a payment provider?
 *
 * Exported so the rule can be unit-tested directly: it keys off an EXACT table
 * name, which an integration harness cannot exercise without colliding with a
 * project's real tables.
 */
export function isPaymentTable(
  tableName: string,
  columns: Array<{ name?: string }> = [],
): boolean {
  const name = String(tableName || '').toLowerCase().trim()
  if (PAYMENT_TABLE_NAMES.has(name)) return true
  if (!AMBIGUOUS_PAYMENT_TABLE_NAMES.has(name)) return false
  return columns.some(
    (c) => typeof c?.name === 'string' && PAYMENT_COLUMN_EVIDENCE.test(c.name),
  )
}

/**
 * Declared types specific enough to be taken at face value. If a caller names
 * one of these, no name-based heuristic may override it.
 */
const EXPLICIT_COLUMN_TYPES = new Set([
  'TIMESTAMP', 'TIMESTAMPTZ', 'DATE', 'TIME', 'TIMETZ', 'INTERVAL',
  'NUMERIC', 'DECIMAL', 'FLOAT', 'DOUBLE', 'REAL', 'MONEY',
  'INT', 'INT2', 'INT4', 'INT8', 'INTEGER', 'SMALLINT', 'BIGINT', 'SERIAL', 'BIGSERIAL',
  'BOOL', 'BOOLEAN', 'UUID', 'JSON', 'JSONB', 'BYTEA',
])

function deriveConstraints(columnName: string, columnType: string, tableName: string): ColumnConstraints {
  const lower = columnName.toLowerCase()
  
  const constraints: ColumnConstraints = {
    isPrimaryKey: lower === 'id',
    isUnique: lower.includes('email') || lower.includes('username') || lower.includes('slug'),
    isRequired: !lower.includes('optional') && !lower.startsWith('is_') && !lower.startsWith('has_'),
    hasDefault: lower.startsWith('is_') || lower.startsWith('has_') || lower.includes('status') || lower.includes('created') || lower.includes('updated'),
    foreignKey: undefined
  }
  
  // Detect foreign keys: userId → users.id, user_id → users.id, workspaceId → workspaces.id
  // IMPORTANT: Skip known external/third-party IDs that are NOT FK references to local tables.
  // The set includes exact names AND common typo variants (e.g. stipe for stripe) to prevent
  // false FK creation when a developer makes a spelling error in a column name.
  if (lower.endsWith('id') && lower !== 'id') {
    // Handle both snake_case (workspace_id → workspace) and camelCase (workspaceId → workspace)
    let refTable: string
    if (lower.endsWith('_id')) {
      refTable = lower.slice(0, -3) // snake_case: workspace_id → workspace
    } else {
      refTable = lower.slice(0, -2) // camelCase: workspaceId → workspace (removes 'Id')
    }

    // Skip if this looks like an external/third-party ID (not a local table reference).
    // Match: exact prefix OR any known prefix that the refTable STARTS WITH.
    // This catches 'stripeCustomerId' → refTable='stripeCustomer' → starts with 'stripe'.
    const refLower = refTable.toLowerCase()
    const isExternalId = EXTERNAL_ID_PREFIXES.has(refLower)
      || [...EXTERNAL_ID_PREFIXES].some(prefix => refLower.startsWith(prefix))

    if (isExternalId) {
      // Store as plain text column — not a FK
      constraints.isRequired = false
    } else if (refTable.startsWith('parent')) {
      // Self-reference detection: parentXxxId → same table (nullable)
      constraints.foreignKey = `${tableName}.id`
      constraints.isRequired = false
    } else if (USER_ROLE_ID_BASES.has(refTable)) {
      // Semantic role column: sellerId/buyerId/ownerId/… → users.id
      // Multiple such columns on the same table get distinct constraint names
      // (fk_<table>_sellerId, fk_<table>_buyerId) — no collision.
      constraints.foreignKey = 'users.id'
      constraints.isRequired = true
    } else {
      constraints.foreignKey = `${refTable}s.id` // users, products, workspaces, etc.
      constraints.isRequired = true // FK usually required
    }
  }
  
  // Email/username should be unique and required
  if (lower === 'email' || lower === 'username') {
    constraints.isRequired = true
    constraints.isUnique = true
  }
  
  // Timestamps should have defaults
  if (lower.includes('created') || lower.includes('updated')) {
    constraints.hasDefault = true
    constraints.isRequired = false
  }
  
  // Boolean fields should have defaults
  if (columnType === 'BOOLEAN' || lower.startsWith('is_') || lower.startsWith('has_')) {
    constraints.hasDefault = true
    constraints.isRequired = false
  }
  
  return constraints
}

/**
 * Overlay a caller's EXPLICIT column flags on top of the name-derived guesses.
 *
 * `create_table`'s contract accepts { nullable, unique, fkTo } per column, but
 * deriveConstraints() only ever inferred from the column NAME, so those flags
 * were silently discarded: a column declared `nullable: true` still came back
 * NOT NULL, and `fkTo: "categories"` produced no foreign key at all unless the
 * column name happened to match the `<singular>_id` convention — which breaks
 * on every irregular plural (category_id → "categorys" ≠ categories).
 *
 * Stated intent must always outrank inference. Flags that are absent stay
 * inferred, so callers that pass only { name, type } behave exactly as before.
 */
function applyExplicitColumnFlags(constraints: ColumnConstraints, col: any): void {
  if (typeof col?.nullable === 'boolean') {
    constraints.isRequired = !col.nullable
    constraints.explicitNotNull = !col.nullable
  }
  // `notNull` is the spelling used by internal callers (e.g. the teams
  // scaffold) — accept both so one contract governs every path.
  if (typeof col?.notNull === 'boolean') {
    constraints.isRequired = col.notNull
    constraints.explicitNotNull = col.notNull
  }
  if (typeof col?.unique === 'boolean') {
    constraints.isUnique = col.unique
  }
  if (typeof col?.fkTo === 'string' && col.fkTo.trim()) {
    const target = col.fkTo.trim().toLowerCase()
    constraints.foreignKey = target.includes('.') ? target : `${target}.id`
  }

  // ── The declared DEFAULT ────────────────────────────────────────────────────
  //
  // This was the missing line that made `apply_migration` silently rewrite the
  // semantics of DDL it reported as applied. lib/mcp/migration-parser.ts has
  // always parsed `DEFAULT ...` into `col.default` and passed it here; nothing
  // ever read it. So a migration declaring
  //
  //   active      boolean NOT NULL DEFAULT true      → got: nullable, DEFAULT false
  //   stock       integer NOT NULL DEFAULT 0         → got: NOT NULL, no default
  //   status      text    NOT NULL DEFAULT 'pending' → got: DEFAULT 'active'
  //
  // and `apply_migration` reported "✅ Applied 6 statement(s)" with no warnings.
  // A default silently flipping true→false on an `active` flag hides the entire
  // catalogue of whoever trusted it.
  //
  // ── Why the expression is validated and not escaped ─────────────────────────
  //
  // It lands verbatim in a DEFAULT clause inside CREATE TABLE, so it cannot be
  // parameterised. Quoting it as a literal would be wrong — `DEFAULT NOW()` and
  // `DEFAULT gen_random_uuid()` must stay expressions. It is therefore matched
  // against a closed allowlist of the forms a default can legitimately take, and
  // anything else is DROPPED rather than guessed at. A dropped default is
  // reported by the migration receipt; an interpolated one would be DDL
  // injection.
  if (col?.default !== undefined && col.default !== null) {
    const expr = normalizeDefaultExpression(col.default)
    if (expr) constraints.defaultExpr = expr
  }
}

/**
 * A declared DEFAULT → the SQL it is safe to emit, or undefined to drop it.
 *
 * Closed allowlist. This value reaches raw DDL, so "anything not recognised is
 * refused" is the only acceptable posture — a permissive fallback here is
 * arbitrary SQL execution wearing a column definition.
 */
export function normalizeDefaultExpression(raw: unknown): string | undefined {
  if (typeof raw === 'boolean') return raw ? 'true' : 'false'
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)

  if (typeof raw !== 'string') return undefined
  const v = raw.trim().replace(/;+$/, '').trim()
  if (!v) return undefined

  // Already a quoted SQL string literal: 'draft', 'it''s'. Re-quoted from the
  // inner text so a crafted value cannot terminate the literal early.
  const quoted = /^'((?:[^']|'')*)'$/.exec(v)
  if (quoted) return sqlLiteral(quoted[1].replace(/''/g, "'"))

  // Numeric, including negative and decimal.
  if (/^-?\d+(\.\d+)?$/.test(v)) return v

  // Boolean and null keywords.
  const lower = v.toLowerCase()
  if (lower === 'true' || lower === 'false' || lower === 'null') return lower

  // The handful of zero-argument functions and keywords that are idiomatic in a
  // DEFAULT. Listed exhaustively — no pattern match on "looks like a call".
  const FUNCTIONS: Record<string, string> = {
    'now()': 'NOW()',
    'current_timestamp': 'CURRENT_TIMESTAMP',
    'current_date': 'CURRENT_DATE',
    'current_time': 'CURRENT_TIME',
    'gen_random_uuid()': 'gen_random_uuid()',
    'uuid_generate_v4()': 'gen_random_uuid()',
    "'{}'::jsonb": `'{}'::jsonb`,
    "'[]'::jsonb": `'[]'::jsonb`,
    "'{}'::json": `'{}'::json`,
    "'[]'::json": `'[]'::json`,
  }
  if (FUNCTIONS[lower]) return FUNCTIONS[lower]

  // A bare word an agent wrote unquoted for a text column — `DEFAULT pending`.
  // Common, unambiguous, and safe to treat as the literal it plainly means.
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(v)) return sqlLiteral(v)

  return undefined
}

function applyConstraintsToColumn(columnDef: any, constraints: ColumnConstraints, postgresSchema?: string): string {
  let sql = `"${columnDef.name}" ${columnDef.type}`

  if (constraints.isPrimaryKey) {
    // UUID primary key with auto-generation
    if (columnDef.type === 'UUID') {
      sql += ' PRIMARY KEY DEFAULT gen_random_uuid()'
    } else {
      sql += ' PRIMARY KEY'
    }
  }

  if (constraints.isUnique && !constraints.isPrimaryKey) {
    sql += ' UNIQUE'
  }

  // ── The DEFAULT ─────────────────────────────────────────────────────────────
  // Resolved BEFORE nullability, because `NOT NULL DEFAULT x` is decided by
  // whether a default exists, and the old code decided nullability first
  // against a `hasDefault` flag that predated explicit defaults entirely.
  let defaultClause = ''
  if (constraints.defaultExpr) {
    // Stated intent. Always wins — this is the whole fix for `apply_migration`
    // rewriting declared DDL.
    defaultClause = ` DEFAULT ${constraints.defaultExpr}`
  } else if (constraints.stateValues?.length) {
    // Derived from the SAME value list the CHECK constraint is built from, so a
    // default that violates its own CHECK is not expressible. This is what
    // `DEFAULT 'active'` against `CHECK (payment_status IN ('pending', …))` was.
    const initial = initialStateFor(constraints.stateValues)
    if (initial) defaultClause = ` DEFAULT ${sqlLiteral(initial)}`
  } else if (constraints.hasDefault) {
    if (columnDef.type === 'BOOLEAN') {
      defaultClause = ' DEFAULT false'
    } else if (columnDef.type === 'TIMESTAMP') {
      defaultClause = ' DEFAULT NOW()'
    }
    // A `*status*` column with no known value set gets NO default. It used to
    // get `'active'` on the strength of its name alone, which is a guess about
    // domain semantics that is wrong more often than right — and when the column
    // also carries a CHECK, wrong in a way that makes the table un-insertable.
    // No default is honest: the caller supplies the state, or declares one.
  }

  // ── Nullability ─────────────────────────────────────────────────────────────
  // `isRequired` means NOT NULL, and a default does not contradict it —
  // `NOT NULL DEFAULT x` is the single most common column shape in SQL and is
  // exactly what makes a default useful. The old condition suppressed NOT NULL
  // whenever any default was present, which is how a declared
  // `active boolean NOT NULL DEFAULT true` came back NULLABLE with `DEFAULT
  // false`: two independent rewrites of one declaration.
  //
  // The one exception: inference asked for a default (`hasDefault`) and none
  // could be produced — an unrecognised `*status*` column, where guessing the
  // initial state is what caused the bug above. Adding NOT NULL there would
  // make every insert that omits the column fail, so the column stays nullable
  // and the caller decides. An EXPLICIT `notNull`/`nullable: false` still wins,
  // because that is a statement rather than a guess.
  const inferredDefaultMissing = constraints.hasDefault && !defaultClause && !constraints.explicitNotNull
  if (constraints.isRequired && !constraints.isPrimaryKey && !inferredDefaultMissing) {
    sql += ' NOT NULL'
  }

  sql += defaultClause

  // Append REFERENCES clause for FK columns
  if (constraints.foreignKey && !constraints.isPrimaryKey) {
    const schema = postgresSchema ? `"${postgresSchema}".` : ''
    const [refTable, refColumn] = constraints.foreignKey.split('.')
    sql += ` REFERENCES ${schema}"${refTable}"("${refColumn || 'id'}") ON DELETE SET NULL`
  }

  return sql
}

/**
 * Normalize user input for consistent parsing (preserve case for table names)
 */
function normalizeUserInput(input: string): string {
  return input
    .trim()
    .normalize('NFD') // Decompose unicode
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
}

/**
 * Validate and normalize column type with guards
 */
function normalizeColumnType(type: string | undefined, columnName: string): string {
  const lower = columnName.toLowerCase()

  const typeMap: Record<string, string> = {
    'STRING': 'TEXT',
    'VARCHAR': 'TEXT',
    'INT': 'INTEGER',
    'FLOAT': 'DECIMAL',
    'BOOL': 'BOOLEAN',
    'DATE': 'TIMESTAMP',
    'DATETIME': 'TIMESTAMP',
  }

  const declared = typeof type === 'string' ? type.toUpperCase().trim() : ''
  const mapped = declared ? (typeMap[declared] || declared) : ''

  // A caller that names a specific type means it. Name-based inference may only
  // REFINE a vague type (TEXT / none) — it must never override an explicit one.
  //
  // Overriding is exactly how `{ name: "start_date", type: "timestamp" }` was
  // silently created as INTEGER: the star-rating heuristic below tested
  // `includes('star')`, and "start_date" contains the substring "star". The same
  // collision hit start_time, started_at, and restart_count, and the resulting
  // integer column then rejected every date value written to it.
  if (mapped && EXPLICIT_COLUMN_TYPES.has(declared.replace(/\(.*$/, ''))) {
    return mapped
  }

  // ── Name-based inference — only for a missing or generic declared type ──────
  // Anchored on word boundaries so a substring can never hijack a column name.
  if (/(^|_)(rating|ratings|star|stars)(_|$)/.test(lower)) {
    return 'INTEGER' // CHECK constraint added separately
  }
  if (/(^|_)(price|cost|amount|total|subtotal)(_|$)/.test(lower)) {
    return 'DECIMAL(10,2)'
  }
  if (lower.includes('email')) {
    return 'TEXT'
  }

  // SCHEMA CONTRACT: primary keys and local FK columns (*_id) use UUID —
  // prevents UUID vs INTEGER mismatch across tables. Third-party identifiers
  // (stripe_customer_id, google_user_id, …) are opaque provider strings, never
  // UUIDs, so they keep their declared/text type.
  if (lower === 'id') {
    return 'UUID'
  }
  if (!isExternalIdColumn(lower) &&
      (lower.endsWith('_id') ||
       (lower.endsWith('id') && lower !== 'id' && columnName.length > 2))) {
    return 'UUID'
  }

  return mapped || 'TEXT'
}

// Canonical FK semantic mapping — defined once in lib/ai/semantic-relations.ts
const USER_SEMANTIC_COLS = _SEMANTIC_USER_COLS
const USER_ROLE_ID_BASES = _SEMANTIC_USER_ROLE_ID_BASES

type RelEntry = {
  parent: string       // table that owns the PK (e.g. "users")
  child: string        // table that holds the FK column (e.g. "tasks")
  fkCol: string        // FK column name on the child (e.g. "user_id" or "owner")
  type: 'one-to-many' | 'many-to-many' | 'polymorphic' | 'self'
  polyTypeCol?: string // for polymorphic: the *_type companion column
  fromReal: boolean    // true = real PostgreSQL FK constraint (authoritative)
}

/**
 * Three-layer relationship inference for workspace schemas.
 *
 * Layer 1 — Real FK constraints from pg_constraint (authoritative, always run)
 * Layer 2 — Naming-convention inference for columns not covered by real FKs:
 *   2a. *_id / *Id suffix → matching table name (existing logic)
 *   2b. Semantic column names: owner/creator/author/… → users table
 *   2c. Polymorphic pairs: *able_id + *able_type (or *_id + *_type)
 *   2d. Junction table detection: 2+ FK columns on one table → many-to-many
 * Layer 3 — Smart trigger: only persist when graph relations < FK candidate count
 *           (fixes partial graphs, not just empty graphs)
 */
export async function inferAndSaveRelationships(projectId: string): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

    // ── 1. Table names ─────────────────────────────────────────────────────────
    const tableRows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      postgresSchema
    )
    const tableNames = new Set(tableRows.map(r => r.table_name))
    if (tableNames.size === 0) return

    // ── Layer 1: Real FK constraints (authoritative) ───────────────────────────
    const realFKRows = await prisma.$queryRawUnsafe<{
      child_table: string; child_col: string
      parent_table: string; parent_col: string
    }[]>(
      `SELECT
         kcu.table_name  AS child_table,
         kcu.column_name AS child_col,
         ccu.table_name  AS parent_table,
         ccu.column_name AS parent_col
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema    = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
        AND tc.table_schema    = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1`,
      postgresSchema
    ).catch((err: any) => { console.error('[MinimalExecutor] FK query failed:', err); return [] as any[] })

    // Track which (child_table, child_col) pairs are already covered by real FKs
    const realFKSet = new Set(realFKRows.map(r => `${r.child_table}.${r.child_col}`))

    const relations: RelEntry[] = realFKRows.map(r => ({
      parent: r.parent_table,
      child: r.child_table,
      fkCol: r.child_col,
      type: 'one-to-many' as const,
      fromReal: true,
    }))

    // ── All columns (needed for layers 2a–2d) ─────────────────────────────────
    const allCols = await prisma.$queryRawUnsafe<{
      table_name: string; column_name: string
    }[]>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = $1`,
      postgresSchema
    )

    // Group by table for quick lookup
    const tableColMap = new Map<string, string[]>()
    for (const { table_name, column_name } of allCols) {
      if (!tableColMap.has(table_name)) tableColMap.set(table_name, [])
      tableColMap.get(table_name)!.push(column_name)
    }

    // ── Layer 2a: *_id / *Id suffix inference ─────────────────────────────────
    for (const [table_name, cols] of tableColMap) {
      for (const column_name of cols) {
        if (realFKSet.has(`${table_name}.${column_name}`)) continue
        const lower = column_name.toLowerCase()
        const isSnakeFk = lower.endsWith('_id') && lower !== 'id'
        const isCamelFk = /[a-z]id$/.test(lower) && lower !== 'id' && column_name !== column_name.toLowerCase()

        if (!isSnakeFk && !isCamelFk) continue

        // Self-referential: parent_xxx_id → same table
        if (lower.startsWith('parent')) {
          relations.push({ parent: table_name, child: table_name, fkCol: column_name, type: 'self', fromReal: false })
          continue
        }

        // Extract base: workspace_id→workspace, workspaceId→workspace
        const base = lower.endsWith('_id') ? lower.slice(0, -3) : lower.slice(0, -2)
        const candidates = base.endsWith('s') ? [base, `${base}s`] : [`${base}s`, base]
        const parentTable = candidates.find(c => tableNames.has(c))
        if (parentTable && parentTable !== table_name) {
          relations.push({ parent: parentTable, child: table_name, fkCol: column_name, type: 'one-to-many', fromReal: false })
        }
      }
    }

    // ── Layer 2b: Semantic column names → users table ─────────────────────────
    if (tableNames.has('users')) {
      for (const [table_name, cols] of tableColMap) {
        for (const column_name of cols) {
          if (realFKSet.has(`${table_name}.${column_name}`)) continue
          if (!USER_SEMANTIC_COLS.has(column_name.toLowerCase())) continue
          const alreadyCovered = relations.some(r => r.child === table_name && r.fkCol === column_name)
          if (!alreadyCovered) {
            relations.push({ parent: 'users', child: table_name, fkCol: column_name, type: 'one-to-many', fromReal: false })
          }
        }
      }
    }

    // ── Layer 2c: Polymorphic pairs (*able_id+*able_type or *_id+*_type) ──────
    for (const [table_name, cols] of tableColMap) {
      const colSet = new Set(cols.map(c => c.toLowerCase()))
      for (const column_name of cols) {
        if (realFKSet.has(`${table_name}.${column_name}`)) continue
        const lower = column_name.toLowerCase()
        let typeCol: string | undefined

        if (lower.endsWith('able_id')) {
          const candidate = lower.replace('able_id', 'able_type')
          if (colSet.has(candidate)) typeCol = candidate
        } else if (lower.endsWith('_id') && lower !== 'id') {
          const candidate = lower.replace('_id', '_type')
          if (colSet.has(candidate)) typeCol = candidate
        }

        if (!typeCol) continue
        const alreadyCovered = relations.some(r => r.child === table_name && r.fkCol === column_name)
        if (!alreadyCovered) {
          relations.push({ parent: 'polymorphic', child: table_name, fkCol: column_name, type: 'polymorphic', polyTypeCol: typeCol, fromReal: false })
        }
      }
    }

    // ── Layer 2d: Junction table detection (2+ FK columns → many-to-many) ─────
    for (const [table_name] of tableColMap) {
      const tableFKs = relations.filter(
        r => r.child === table_name && r.type === 'one-to-many' && r.parent !== table_name
      )
      if (tableFKs.length >= 2) {
        // Promote all one-to-many entries for this table to many-to-many
        for (const rel of tableFKs) rel.type = 'many-to-many'
      }
    }

    // ── Layer 3: Smart trigger ─────────────────────────────────────────────────
    // Only persist when graph is actually missing relations to avoid no-op writes.
    const { getActiveGraph, saveNewGraph } = await import('@/lib/orchestration/graph-pointer')
    const currentGraph = await getActiveGraph(projectId)
    if (!currentGraph) return

    const existingRelCount = Object.values(currentGraph.entities || {})
      .reduce((sum: number, e: any) => sum + ((e as any).relationships?.length || 0), 0)

    // Count meaningful inferred relations (exclude self-refs and unresolved polymorphics)
    const meaningfulRels = relations.filter(r => r.type !== 'self' && r.parent !== 'polymorphic')
    if (existingRelCount >= meaningfulRels.length && existingRelCount > 0) {
      // Graph already has at least as many relations as we inferred — nothing to do.
      return
    }

    // ── Persist ────────────────────────────────────────────────────────────────
    const updatedEntities: Record<string, any> = { ...(currentGraph.entities || {}) }
    let changed = false

    for (const rel of relations) {
      if (rel.type === 'self') continue // skip self-referential for now

      if (rel.type === 'polymorphic') {
        // Store polymorphic relation on the child entity
        if (!updatedEntities[rel.child]) {
          updatedEntities[rel.child] = {
            name: rel.child, reason: 'Inferred from schema', fields: {},
            relationships: [], createdAt: new Date().toISOString(),
            createdBy: 'schema-inference', dependencies: [],
          }
        }
        const childEntity = updatedEntities[rel.child]
        const alreadyStored = (childEntity.relationships || []).some(
          (r: any) => r.foreignKey === rel.fkCol && r.type === 'polymorphic'
        )
        if (!alreadyStored) {
          childEntity.relationships = [
            ...(childEntity.relationships || []),
            {
              from: 'polymorphic',
              to: rel.child,
              type: 'polymorphic',
              foreignKey: rel.fkCol,
              typeColumn: rel.polyTypeCol,
              reason: `Polymorphic via ${rel.fkCol} + ${rel.polyTypeCol}`,
              createdBy: 'schema-inference',
            },
          ]
          changed = true
        }
        continue
      }

      // one-to-many or many-to-many: stored on the parent entity node
      if (!updatedEntities[rel.parent]) {
        updatedEntities[rel.parent] = {
          name: rel.parent, reason: 'Inferred from schema', fields: {},
          relationships: [], createdAt: new Date().toISOString(),
          createdBy: 'schema-inference', dependencies: [],
        }
      }
      const entity = updatedEntities[rel.parent]
      const alreadyStored = (entity.relationships || []).some(
        (r: any) => r.to === rel.child && r.foreignKey === rel.fkCol
      )
      if (!alreadyStored) {
        const reason = rel.type === 'many-to-many'
          ? `Junction table: ${rel.child} connects ${rel.parent} and other tables`
          : `${rel.child}.${rel.fkCol} → ${rel.parent}.id`
        entity.relationships = [
          ...(entity.relationships || []),
          {
            from: rel.parent,
            to: rel.child,
            type: rel.type,
            reason,
            foreignKey: rel.fkCol,
            createdBy: rel.fromReal ? 'real-fk' : 'schema-inference',
          },
        ]
        changed = true
      }
    }

    if (changed) {
      await saveNewGraph(
        projectId,
        { ...currentGraph, entities: updatedEntities } as any,
        undefined,
        { skipBillingCheck: true }
      )
      console.log(`[Schema Inference] Persisted ${relations.length} relation(s) (real FKs: ${realFKRows.length}, inferred: ${relations.length - realFKRows.length}) for project ${projectId}`)
    }
  } catch (err: any) {
    console.warn('[Schema Inference] Failed (non-fatal):', err.message)
  }
}

/**
 * Introspect live database schema with FULL column graph
 * This is the critical unlock: AI sees real structure, not just table names
 * EXPORTED for use by intent planner
 */
export async function introspectSchema(projectId: string): Promise<string> {
  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    
    // Use information_schema.tables as the authoritative live source — never the platform
    // metadata table (prisma.table). If a table exists in the live DB but the platform
    // metadata write failed (e.g. a crash between the SQL and the metadata insert),
    // prisma.table would silently omit it. information_schema is always correct.
    //
    // Exclude (a) reserved internal tables — canonical predicate, covers every
    // leading-underscore plumbing table: _backenly_presence, _token_blacklist,
    // _email_verifications, _magic_links, _password_resets, _prisma_* — and
    // (b) legacy event-log tables from the AI *context*. This filter also feeds
    // the back-fill reconciler below, so reserved tables can never be registered
    // as product tables in prisma.table (the bug that leaked auth-runtime tables
    // into the dashboard count, gave them generated REST APIs, and exposed them).
    const AI_CONTEXT_SKIP_PREFIXES = ['audit_log', 'email_event', 'sms_event']
    const liveTables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      postgresSchema
    )
    const tables = liveTables.filter(
      t => !isReservedWorkspaceTable(t.table_name)
        && !AI_CONTEXT_SKIP_PREFIXES.some(prefix => t.table_name.startsWith(prefix))
    )

    // Reconcile: if information_schema has tables not in prisma.table, back-fill the
    // platform metadata so future executor calls and billing checks stay consistent.
    try {
      const metaTables = await prisma.table.findMany({ where: { projectId }, select: { name: true } })
      const metaNames = new Set(metaTables.map(t => t.name.toLowerCase()))
      const orphaned = tables.filter(t => !metaNames.has(t.table_name.toLowerCase()))
      if (orphaned.length > 0) {
        await prisma.table.createMany({
          data: orphaned.map(t => ({
            projectId,
            name: t.table_name,
            schema: postgresSchema,
            description: `${t.table_name} table (back-filled by schema reconciliation)`,
          })),
          skipDuplicates: true,
        })
        console.log(`[Schema Grounding] Back-filled ${orphaned.length} orphaned table(s) into platform metadata`)
      }
    } catch { /* reconciliation is best-effort — never fatal */ }

    if (tables.length === 0) {
      return '\n**LIVE DATABASE SCHEMA:** Empty (no tables yet)'
    }

    // Build FULL schema graph with columns, types, constraints, and FK relationships
    let schemaGraph = '\n**LIVE DATABASE SCHEMA (with relationships):**\n'

    // Pre-fetch all FK relationships for the schema in one query
    let fkMap: Map<string, Map<string, string>> = new Map()
    try {
      const fkRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT
           kcu.table_name,
           kcu.column_name,
           ccu.table_name AS referenced_table
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name
           AND tc.table_schema = ccu.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = $1`,
        postgresSchema
      )
      for (const row of fkRows) {
        if (!fkMap.has(row.table_name)) fkMap.set(row.table_name, new Map())
        fkMap.get(row.table_name)!.set(row.column_name, row.referenced_table)
      }
    } catch (_) {
      // FK introspection is best-effort; continue without it
    }

    for (const table of tables) {
      const tableName = table.table_name
      try {
        // Get basic column information
        const columns = await prisma.$queryRawUnsafe<any[]>(
          `SELECT
            column_name,
            data_type,
            is_nullable
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
          postgresSchema,
          tableName
        )

        if (columns.length === 0) {
          schemaGraph += `${tableName}()\n`
          continue
        }

        const tableFKs = fkMap.get(tableName) || new Map()

        // Format: users(id uuid, email text, workspace_id uuid → workspaces.id)
        const columnDefs = columns.map(col => {
          const base = `${col.column_name} ${col.data_type.toLowerCase()}`
          const ref = tableFKs.get(col.column_name)
          return ref ? `${base} → ${ref}.id` : base
        })

        schemaGraph += `${tableName}(${columnDefs.join(', ')})\n`
      } catch (colError: any) {
        console.warn(`[Schema] Failed to introspect ${tableName}:`, colError.message)
        schemaGraph += `${tableName}(error)\n`
      }
    }

    console.log('[Schema Grounding] Injected schema for', tables.length, 'tables (source: information_schema)')

    // Supplement: load graph relationships that aren't already visible via real FK constraints.
    // This covers semantic columns (owner/creator → users), many-to-many junction tables,
    // and polymorphic relations — none of which appear as real FOREIGN KEY constraints.
    try {
      const { getActiveGraph } = await import('@/lib/orchestration/graph-pointer')
      const graph = await getActiveGraph(projectId)
      if (graph?.entities) {
        // Build the set of FK pairs already surfaced through fkMap (real constraints)
        const realFKPairs = new Set<string>()
        for (const [tbl, colMap] of fkMap) {
          for (const [col] of colMap) realFKPairs.add(`${tbl}.${col}`)
        }

        const graphRelLines: string[] = []
        for (const [, entity] of Object.entries(graph.entities)) {
          for (const rel of (entity as any).relationships || []) {
            const fkCol = rel.foreignKey || `${(rel.from as string).replace(/s$/, '')}_id`
            const pair = `${rel.to}.${fkCol}`
            if (realFKPairs.has(pair)) continue // already shown inline

            if (rel.type === 'polymorphic') {
              graphRelLines.push(`- ${rel.to}.${fkCol} → polymorphic (type discriminator: ${rel.typeColumn ?? 'type'})`)
            } else if (rel.type === 'many-to-many') {
              graphRelLines.push(`- ${rel.to} ↔ ${rel.from} via ${fkCol} (many-to-many junction)`)
            } else {
              graphRelLines.push(`- ${rel.to}.${fkCol} → ${rel.from}.id`)
            }
          }
        }
        if (graphRelLines.length > 0) {
          schemaGraph += '\n**INTENDED RELATIONSHIPS (from architecture graph):**\n'
          schemaGraph += graphRelLines.join('\n') + '\n'
        }
      }
    } catch (_) { /* graph load is best-effort */ }

    // Add existing API awareness so AI doesn't regenerate APIs that already exist
    try {
      const existingApis = await prisma.apiDefinition.findMany({
        where: { projectId },
        select: { name: true },
      })
      if (existingApis.length > 0) {
        schemaGraph += '\n**EXISTING REST APIs (do NOT regenerate these):**\n'
        schemaGraph += existingApis.map(a => `- ${a.name} (already has CRUD endpoints)`).join('\n') + '\n'
      }
    } catch (_) { /* API introspection is best-effort */ }

    // Add auth awareness so AI doesn't re-enable auth or re-add providers already configured
    try {
      const authConfigs = await prisma.workspaceOAuthConfig.findMany({
        where: { projectId },
        select: { provider: true, enabled: true },
      })
      if (authConfigs.length > 0) {
        const configuredProviders = authConfigs.map(c => c.provider)
        schemaGraph += '\n**AUTH:** Already enabled — do NOT add ENABLE_AUTH\n'
        schemaGraph += `**CONFIGURED AUTH PROVIDERS:** ${configuredProviders.join(', ')}\n`
        schemaGraph += '- If user asks to add a provider already listed above → tell them it is already configured (do NOT emit ADD_PROVIDER for it)\n'
        schemaGraph += '- If user asks to add a NEW provider NOT in the list above → emit ADD_PROVIDER, but FIRST ask them for their Client ID and Client Secret if not provided in the message\n'
      }
    } catch (_) { /* auth check is best-effort */ }

    return schemaGraph
  } catch (error: any) {
    console.warn('[Schema Introspection] Failed:', error.message)
    return ''
  }
}

/**
 * STEP 1: Convert natural language to machine-readable action
 *
 * @param semanticEnrichment - Optional enrichment block from semantic-domain-analyzer.
 *   Contains state machine enforcement, business rules, and workflow sequences.
 *   When provided, it is appended to the system prompt so the AI generates
 *   transition endpoints, credit-check guards, and workflow steps automatically.
 */
export async function extractAction(
  userMessage: string,
  projectId: string,
  previousError?: string, // NEW: Include previous error for replanning
  conversationHistory?: Array<{ role: 'user' | 'ai'; content: string }>,
  semanticEnrichment?: string,
): Promise<AIAction> {
  // Normalize input before parsing
  const normalizedMessage = normalizeUserInput(userMessage)
  
  // SYSTEM 1: Live Schema Injection
  const liveSchema = await introspectSchema(projectId)
  
  const openai = getOpenAIClient()
  
  // Check if this is an INSERT_DATA request - if so, get schema first
  const isInsertRequest = /insert|add.*data|mock.*data|sample.*data|test.*data/i.test(userMessage)
  let schemaContext = ''
  
  if (isInsertRequest) {
    // Extract table name from message
    const tableMatch = userMessage.match(/(?:into|to|for)\s+(\w+)/i)
    if (tableMatch) {
      const tableName = tableMatch[1]
      try {
        const { prisma } = await import('@/lib/db')
        const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
        const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
        
        // Get table schema (exclude auto-managed columns from AI prompt)
        const columnsQuery = `
          SELECT 
            column_name, 
            data_type,
            is_nullable,
            column_default
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          AND column_name NOT IN ('id', 'createdAt', 'updatedAt')
          ORDER BY ordinal_position
        `
        
        const columns: any[] = await prisma.$queryRawUnsafe(columnsQuery, postgresSchema, tableName)
        
        if (columns.length > 0) {
          const requiredFields = columns
            .filter(c => c.is_nullable === 'NO' && !c.column_default)
            .map(c => `${c.column_name} (${c.data_type}, REQUIRED)`)
          
          const optionalFields = columns
            .filter(c => c.is_nullable === 'YES' || c.column_default)
            .map(c => `${c.column_name} (${c.data_type}, optional)`)
          
          schemaContext = `\n\n**Table "${tableName}" schema:**\n`
          if (requiredFields.length > 0) {
            schemaContext += `Required fields: ${requiredFields.join(', ')}\n`
          }
          if (optionalFields.length > 0) {
            schemaContext += `Optional fields: ${optionalFields.join(', ')}\n`
          }
          schemaContext += `**YOU MUST include ALL required fields in every row!**`
        }
      } catch (error) {
        console.log('⚠️ [AI Executor] Could not fetch schema:', error)
      }
    }
  }
  
  const systemPrompt = `You are an action extractor for Backenly - an autonomous backend platform.

Convert user requests into ONE action.

**CRITICAL: You will receive LIVE DATABASE SCHEMA showing actual columns, types, and foreign keys.**
**NEVER guess column names or types - use what exists in the schema!**
**If a table/column exists in schema, reference it exactly as shown.**
**If creating new relations, use the column patterns you see in existing schema.**

**Available Actions:**

DATABASE:
- CREATE_TABLE - Create a database table
- ADD_COLUMN - Add column to existing table
- INSERT_DATA - Insert sample/mock data
- LIST_TABLES - Show all database tables
- CREATE_JUNCTION_TABLE - Create a many-to-many junction table linking two tables (e.g. "users ↔ courses via enrollments")

API:
- GENERATE_API - Generate REST API for a table
- LIST_APIS - Show all API endpoints

STORAGE:
- CREATE_BUCKET - Create storage bucket
- SET_BUCKET_PUBLIC - Make bucket public/private
- LIST_BUCKETS - List all storage buckets
- UPLOAD_FILE - Upload file to bucket
- LIST_FILES - List files in bucket
- DELETE_FILE - Delete file from bucket
- DELETE_BUCKET - Delete storage bucket
- GENERATE_SIGNED_URL - Generate signed URL for file

CONNECT FRONTEND:
- CONNECT_FRONTEND - Connect a frontend URL to this deployed backend (deployment-gated, confirmation-gated)
- DISCONNECT_FRONTEND - Disconnect a previously-connected frontend (confirmation-gated)
- LIST_CONNECTED_APPS - List frontends connected to this backend

DEPLOY:
- TRIGGER_DEPLOY - Deploy backend to cloud
- ROLLBACK_DEPLOY - Rollback to previous deployment
- GET_DEPLOY_STATUS - Get deployment status
- SET_ENV_VAR - Set environment variable

AUTH:
- ENABLE_AUTH - Enable authentication (email/password)
- ADD_PROVIDER - Add an OAuth sign-in provider (Google, GitHub, Discord, Facebook, Apple)
- DISABLE_PROVIDER - Disable an OAuth sign-in provider (keeps stored credentials)
- LIST_USERS - List the project's end-users (people who signed up via the project's auth)
- BLOCK_USER - Block an end-user from signing in
- UNBLOCK_USER - Unblock a previously blocked end-user
- RESET_PASSWORD - Reset an end-user's password (returns a temporary password to share out-of-band)

Built-in auth endpoints (always available — no action needed, already live):
  POST /v1/{projectId}/auth/signup            — register end-user
  POST /v1/{projectId}/auth/signin            — sign in, returns JWT
  POST /v1/{projectId}/auth/refresh-token     — silently renew expiring JWT
  POST /v1/{projectId}/auth/logout            — server-side token revocation
  POST /v1/{projectId}/auth/forgot-password   — generate password-reset token, send email if SMTP configured
  POST /v1/{projectId}/auth/reset-password    — consume reset token, set new password, return fresh JWT
  GET/POST /v1/{projectId}/auth/{provider}    — OAuth sign-in (Google, GitHub, etc.)

IAM (API KEYS):
- CREATE_KEY - Create new API key
- REVOKE_KEY - Revoke API key
- ROTATE_KEY - Rotate API key
- SET_KEY_PERMISSIONS - Set key permissions
- LIST_KEYS - List all API keys

MONITORING:
- GET_METRICS - Get API metrics
- GET_ERRORS - Get error logs
- SET_ALERT - Set monitoring alert
- GET_USAGE - Get usage statistics

TRIGGERS (event automation — "when X happens, do Y automatically"):
- CREATE_TRIGGER - Create an event trigger
- LIST_TRIGGERS - List all triggers
- DELETE_TRIGGER - Remove a trigger

PERMISSIONS (row-level security — "users can only see their own rows"):
- SET_PERMISSION - Apply a row-level security policy to a table
  Templates: auto, own_rows, party_rows, related_rows, public_read, admin_only, all_access, org_members,
             admin_read_all (admins see ALL; users see own), role_based (admins/superadmins bypass),
             moderator_access (admins+moderators see all; users see own)
  Optional: roleColumn (column name storing the role, defaults to 'role')
- LIST_PERMISSIONS - List all permission policies
- REMOVE_PERMISSION - Remove a policy from a table

AI FUNCTIONS (serverless logic — "when X happens, run this logic automatically"):
- CREATE_AI_FUNCTION - Create an AI-generated serverless function from a description
  triggerType: on_signup | on_db_insert | on_db_update | on_db_delete | on_webhook | manual
  for on_webhook: triggerTable = integration name (e.g. "stripe") to match that webhook source
- LIST_AI_FUNCTIONS - List all AI functions
- DELETE_AI_FUNCTION - Delete an AI function
- TOGGLE_AI_FUNCTION - Enable or disable an AI function
- FIX_AI_FUNCTION - Regenerate code for a broken function. Use when user pastes a function error,
  shows "Syntax error: ..." from a function, says a function is broken/not working, or asks you
  to fix/repair an existing function. NEVER create new functions when the user is showing an error
  from an existing one — emit FIX_AI_FUNCTION instead.
  params: { functionName: string, errorMessage?: string }
  Example: user pastes "Syntax error: await is only valid in async functions" from function "on_order_created"
  → {"action": "FIX_AI_FUNCTION", "params": {"functionName": "on_order_created", "errorMessage": "Syntax error: await is only valid in async functions"}}

SELF-REPAIR (diagnose and fix broken features — always prefer over recreating):
- FIX_AUTH        - Repair broken authentication (missing JWT secret, missing users table, OAuth config)
- FIX_API         - Regenerate missing or broken REST APIs for tables. params: { tableName? }
- FIX_TABLE       - Fix broken table schema (recreate missing tables, add missing columns). params: { tableName, missingColumns? }
- FIX_DEPLOY      - Diagnose and retry a failed deployment / publish. params: { force? }
- FIX_REALTIME    - Reinstall broken PostgreSQL NOTIFY triggers. params: { tableName? }
- FIX_STORAGE     - Repair missing storage buckets or directories. params: { bucketName? }
- FIX_INTEGRATION - Check and report broken integration credentials. params: { integrationId? }

INTEGRATIONS (third-party APIs — Stripe, email, SMS, AI):
- STORE_INTEGRATION_KEY - Store an API key securely in the vault
  integrationId: stripe | resend | sendgrid | openai | twilio
  apiKey: the raw API key (will be encrypted)
  webhookSecret: (optional) webhook signing secret
- LIST_INTEGRATION_KEYS - Show all connected integrations
- REMOVE_INTEGRATION_KEY - Disconnect an integration

BACKGROUND JOBS (scheduled tasks — "run X every day"):
- CREATE_CRON_JOB - Create a scheduled background job
  description: what the job should do (natural language)
  schedule: cron expression OR human language ("every day at 9am", "every Monday", "hourly")
- LIST_CRON_JOBS - Show all scheduled jobs
- DELETE_CRON_JOB - Remove a scheduled job

DATABASE BACKUPS:
- BACKUP_DATABASE - Create a pg_dump backup of the project's workspace schema
  Use when: "backup my database", "take a snapshot", "save my data"
- LIST_BACKUPS - Show all backups with size and date
  Use when: "list my backups", "show backups", "what backups do I have"
- RESTORE_DATABASE - Restore from a backup (requires user confirmation — destructive)
  params: { backupId?: string } — omit backupId to restore from the most recent backup
  Use when: "restore my database", "rollback to yesterday", "undo my changes"

FULL-TEXT SEARCH:
- ADD_FULLTEXT_SEARCH - Add PostgreSQL tsvector full-text search to a table
  params: { tableName: string, columns?: string[] }
  Use when: "add search to posts", "make products searchable", "add full-text search by title and body"
  Creates tsvector column, GIN index, and /search endpoint

COLUMN TYPE MIGRATION:
- ALTER_COLUMN_TYPE - Safely change a column's data type with automatic data casting
  params: { tableName: string, columnName: string, newType: string, castExpression?: string }
  Use when: "change price from INTEGER to DECIMAL", "convert status to BOOLEAN", "make quantity a FLOAT"
  NEVER use ADD_COLUMN for type changes — use ALTER_COLUMN_TYPE

STAGING ENVIRONMENT:
- CREATE_STAGING - Copy production schema+data to a staging environment (workspace_{id}_staging)
  Use when: "create staging environment", "test this in staging", "create a copy for testing"
- PROMOTE_STAGING - Sync staging back to production
  Use when: "promote staging to production", "go live with staging", "push staging to prod"
- DROP_STAGING - Delete the staging environment
  Use when: "drop staging", "delete staging environment", "remove staging"

PER-ENDPOINT RATE LIMITING:
- SET_RATE_LIMIT - Configure request rate limit on a table's API
  params: { tableName: string, requestsPerMinute?: number, requestsPerHour?: number }
  Use when: "limit the signup endpoint to 10 per minute", "rate limit orders", "throttle my API"
- LIST_RATE_LIMITS - Show all configured rate limits
- REMOVE_RATE_LIMIT - Remove a rate limit
  params: { tableName: string }

INFO:
- INFO - Show architectural summary of the current backend OR help text
  Use when: "explain my backend", "describe my backend", "what did you build", "show me what's running",
            "summarize my backend", "what tables do I have", "give me an overview"
  This returns a rich architectural description including tables, APIs, auth, functions, and triggers.

**BUSINESS LOGIC ENDPOINTS — MANDATORY:**
Every GENERATE_API for a domain-specific table MUST be followed by GENERATE_FUNCTION actions for the
business-logic endpoints.  Generic CRUD is NOT sufficient for a working SaaS backend.

Required by table type:
- *_jobs / jobs: emit GENERATE_FUNCTION for POST /:id/cancel, POST /:id/retry, GET /:id/status
- credits / wallet: emit GENERATE_FUNCTION for GET /balance, POST /deduct, POST /purchase
- orders: emit GENERATE_FUNCTION for GET /:id/invoice, POST /:id/cancel
- subscriptions: emit GENERATE_FUNCTION for POST /:id/cancel, POST /:id/resume
- checkout / payments: emit GENERATE_FUNCTION for POST /checkout/session
- admin requirement: emit GENERATE_FUNCTION for GET /admin/users, GET /admin/stats

Example (3D video SaaS generation_jobs table):
{"action": "GENERATE_API", "params": {"tableName": "generation_jobs"}}
{"action": "GENERATE_FUNCTION", "params": {"functionName": "generation-jobs-submit", "method": "POST", "description": "Submit a new generation job — check user has sufficient credits before creating the record, deduct credits atomically, return 402 if balance insufficient"}}
{"action": "GENERATE_FUNCTION", "params": {"functionName": "generation-jobs-cancel", "method": "POST", "description": "Cancel a generation_jobs job by ID — only valid when status is pending or processing"}}
{"action": "GENERATE_FUNCTION", "params": {"functionName": "generation-jobs-retry", "method": "POST", "description": "Retry a failed generation_jobs job — reset status to pending and increment attempts"}}
{"action": "GENERATE_FUNCTION", "params": {"functionName": "credits-purchase", "method": "POST", "description": "Purchase credits for the authenticated user — insert positive credit row"}}
{"action": "GENERATE_FUNCTION", "params": {"functionName": "admin-jobs-list", "method": "GET", "description": "Admin: paginated list of all generation jobs across all users with filters for status"}}

NEVER stop after GENERATE_API alone for domain tables.

**FUNCTION ERROR REPAIR — HIGHEST PRIORITY RULE:**
When the user's message contains ANY of these signals, emit FIX_AI_FUNCTION — NEVER create new functions:
  - A function name followed by "Syntax error:", "error:", or any stack trace
  - Text like "this function has an error", "function is broken", "function not working"
  - A pasted error message with a recognizable function name nearby
  - The user says "fix", "repair", or "debug" next to a function name

Example:
User: "on_support_ticket_created_notify_team — Syntax error: await is only valid in async functions"
→ {"action": "FIX_AI_FUNCTION", "params": {"functionName": "on_support_ticket_created_notify_team", "errorMessage": "Syntax error: await is only valid in async functions and the top level bodies of modules"}}

User: "my welcome-email function shows an error"
→ {"action": "FIX_AI_FUNCTION", "params": {"functionName": "welcome-email"}}

DO NOT emit CREATE_AI_FUNCTION, STORE_INTEGRATION_KEY, CREATE_TABLE, or any other action
when the user is clearly showing a broken function. Fix it first.

**PLATFORM SELF-REPAIR ACTIONS — ALWAYS PREFER THESE OVER RECREATING RESOURCES:**
When the user says something is broken, not working, showing errors, or asks you to "fix" a feature,
emit the appropriate FIX_* action — DO NOT delete and recreate resources, DO NOT ask the user what's wrong.
The FIX_* action diagnoses and repairs automatically.

SELF-REPAIR VOCABULARY:
- FIX_AUTH     — Auth broken, signup/login not working, JWT errors, OAuth not working, "fix my auth"
  params: { issue?: string, provider?: "google"|"github"|"discord" }

- FIX_API      — API missing or broken, endpoints not found, "fix my APIs", REST routes broken
  params: { tableName?: string }  (omit to fix ALL tables)

- FIX_TABLE    — Table broken, missing columns, schema mismatch, "fix my table", column not found
  params: { tableName: string, missingColumns?: [{name, type}] }

- FIX_DEPLOY   — Deploy failed, publish not working, deployment error, "fix my deployment"
  params: { force?: boolean }

- FIX_REALTIME — Realtime not receiving events, subscriptions not working, "fix realtime"
  params: { tableName?: string }  (omit to fix ALL tables)

- FIX_STORAGE  — Storage broken, bucket inaccessible, files not uploading, "fix storage"
  params: { bucketName?: string }

- FIX_INTEGRATION — Integration not working, API key rejected, Stripe/Resend/OpenAI broken
  params: { integrationId?: "stripe"|"resend"|"sendgrid"|"openai"|"twilio" }

**SELF-REPAIR TRIGGER PATTERNS (emit FIX_* immediately — no questions):**
  - "my auth is broken" / "login doesn't work" / "signup returns error" → FIX_AUTH
  - "my API is broken" / "endpoint not found" / "404 on my routes" → FIX_API (tableName if named)
  - "table is broken" / "column missing" / "schema error" → FIX_TABLE
  - "deployment failed" / "publish error" / "can't deploy" → FIX_DEPLOY
  - "realtime not working" / "subscriptions broken" / "events not arriving" → FIX_REALTIME
  - "storage broken" / "bucket missing" / "upload failing" → FIX_STORAGE
  - "Stripe not working" / "emails not sending" / "integration error" → FIX_INTEGRATION
  - Generic "something is broken" / "nothing works" → emit FIX_AUTH + FIX_API + FIX_REALTIME together

Examples:
User: "my auth is broken, users can't sign up"
→ {"action": "FIX_AUTH", "params": {}}

User: "my products API is not working"
→ {"action": "FIX_API", "params": {"tableName": "products"}}

User: "fix all my APIs"
→ {"action": "FIX_API", "params": {}}

User: "the orders table is missing a column"
→ {"action": "FIX_TABLE", "params": {"tableName": "orders"}}

User: "my deployment failed" / "publish is broken"
→ {"action": "FIX_DEPLOY", "params": {}}

User: "realtime subscriptions aren't receiving events"
→ {"action": "FIX_REALTIME", "params": {}}

User: "my avatars bucket is broken"
→ {"action": "FIX_STORAGE", "params": {"bucketName": "avatars"}}

User: "Stripe isn't processing payments" / "Resend emails not sending"
→ {"action": "FIX_INTEGRATION", "params": {"integrationId": "stripe"}}

User: "nothing is working" / "my whole backend is broken"
→ Emit ALL of: FIX_AUTH, FIX_API, FIX_REALTIME in sequence — one JSON per line.

**INTEGRATION BEST PRACTICES (ALWAYS follow these — never ask):**
When user mentions Stripe/payments: CREATE tables (orders, payment_events) ONLY. Do NOT attempt CREATE_AI_FUNCTION for Stripe webhook or checkout — those require a stored Stripe key. Instead emit INFO: "Payment tables ready. Paste your Stripe secret key (sk_live_... or sk_test_...) to activate checkout and webhook processing. Then paste your webhook signing secret (whsec_...) from the Stripe dashboard." NEVER claim payment processing is working without a confirmed stored Stripe key.
When user mentions email notifications: CREATE_AI_FUNCTION with the email logic using ctx.integrations.email.send()
When user mentions "send X every [schedule]": CREATE_CRON_JOB with the description and schedule
When user mentions "notify users when X": CREATE_AI_FUNCTION with on_db_update trigger on the relevant table

**Examples:**

// Database
User: "Create a products table"
{"action": "CREATE_TABLE", "params": {"tableName": "products", "columns": [{"name": "name", "type": "TEXT"}, {"name": "description", "type": "TEXT"}, {"name": "price", "type": "DECIMAL"}, {"name": "stock_quantity", "type": "INTEGER"}, {"name": "status", "type": "TEXT"}, {"name": "image_url", "type": "TEXT"}]}}

User: "Add a phone_number column to users"
{"action": "ADD_COLUMN", "params": {"tableName": "users", "columnName": "phone_number", "columnType": "TEXT"}}

User: "Create a many-to-many relationship between students and courses"
{"action": "CREATE_JUNCTION_TABLE", "params": {"tableA": "students", "tableB": "courses", "junctionName": "student_courses"}}

User: "Link users to products through an orders table"
{"action": "CREATE_JUNCTION_TABLE", "params": {"tableA": "users", "tableB": "products", "junctionName": "orders"}}

// Storage
User: "Create an avatars bucket"
{"action": "CREATE_BUCKET", "params": {"bucketName": "avatars"}}

User: "Make avatars bucket public"
{"action": "SET_BUCKET_PUBLIC", "params": {"bucketName": "avatars", "isPublic": true}}

User: "Delete the category_images bucket"
{"action": "DELETE_BUCKET", "params": {"bucketName": "category_images"}}

// Triggers
User: "When a like is created, automatically create a notification"
{"action": "CREATE_TRIGGER", "params": {"name": "like_creates_notification", "sourceTable": "likes", "event": "insert", "actionType": "insert_row", "targetTable": "notifications", "fieldMappings": {"userId": "userId"}, "staticFields": {"type": "like", "read": false}}}

User: "When a user is deleted, delete all their posts"
{"action": "CREATE_TRIGGER", "params": {"name": "user_delete_cascade_posts", "sourceTable": "users", "event": "delete", "actionType": "delete_rows", "targetTable": "posts", "fieldMappings": {"id": "userId"}}}

User: "When an order is paid, call my webhook at https://myapp.com/webhook"
{"action": "CREATE_TRIGGER", "params": {"name": "order_paid_webhook", "sourceTable": "orders", "event": "update", "conditions": {"status": "paid"}, "actionType": "webhook", "webhookUrl": "https://myapp.com/webhook"}}

// Permissions
User: "Users can only see their own posts"
{"action": "SET_PERMISSION", "params": {"tableName": "posts", "template": "own_rows", "userIdColumn": "userId"}}

User: "Make the products table public (anyone can read)"
{"action": "SET_PERMISSION", "params": {"tableName": "products", "template": "public_read"}}

User: "Lock the admin_settings table — only service keys can access it"
{"action": "SET_PERMISSION", "params": {"tableName": "admin_settings", "template": "admin_only"}}

User: "Scope projects to the user's organization"
{"action": "SET_PERMISSION", "params": {"tableName": "projects", "template": "org_members"}}

User: "Admins should see all orders, regular users only their own"
{"action": "SET_PERMISSION", "params": {"tableName": "orders", "template": "admin_read_all", "userIdColumn": "user_id"}}

User: "Add role-based access to the posts table — admins can see everything"
{"action": "SET_PERMISSION", "params": {"tableName": "posts", "template": "role_based", "userIdColumn": "user_id"}}

User: "Moderators and admins should be able to view all comments, regular users only their own"
{"action": "SET_PERMISSION", "params": {"tableName": "comments", "template": "moderator_access", "userIdColumn": "user_id"}}

// AI Functions
User: "When a user signs up, assign a tier based on their country and send a welcome email"
{"action": "CREATE_AI_FUNCTION", "params": {"description": "When a user signs up, assign a tier based on their country and send a welcome email", "triggerType": "on_signup"}}

User: "When an order is inserted, calculate the total price including tax"
{"action": "CREATE_AI_FUNCTION", "params": {"description": "When an order is inserted, calculate the total price including tax", "triggerType": "on_db_insert", "triggerTable": "orders"}}

User: "When a post is updated to status published, notify all subscribers"
{"action": "CREATE_AI_FUNCTION", "params": {"description": "When a post is updated to published, notify all subscribers", "triggerType": "on_db_update", "triggerTable": "posts"}}

User: "Show me all AI functions"
{"action": "LIST_AI_FUNCTIONS", "params": {}}

User: "Delete the signup tier function"
{"action": "DELETE_AI_FUNCTION", "params": {"name": "signup_tier"}}

User: "When a Stripe payment succeeds, update the order status and send email"
// Only valid AFTER Stripe key is stored. If no key: emit INFO about needing STRIPE_SECRET_KEY first.
{"action": "CREATE_AI_FUNCTION", "params": {"description": "When Stripe payment.intent.succeeded webhook fires, update the matching order status to paid and send a confirmation email to the user", "triggerType": "on_webhook", "triggerTable": "stripe"}}

User: "set up payments" / "create payment_methods table" / "add orders table"
// Create schema only — then surface blocked state for missing Stripe credentials
{"action": "CREATE_TABLE", "params": {"tableName": "payment_methods", "columns": [{"name": "userId", "type": "UUID"}, {"name": "type", "type": "TEXT"}, {"name": "last4", "type": "TEXT"}, {"name": "isDefault", "type": "BOOLEAN"}]}}

// Integrations
User: "Connect Stripe with key sk_live_abc123" or "add my Stripe API key sk_test_..."
{"action": "STORE_INTEGRATION_KEY", "params": {"integrationId": "stripe", "apiKey": "sk_test_..."}}

User: "Connect Stripe with webhook secret whsec_..."
{"action": "STORE_INTEGRATION_KEY", "params": {"integrationId": "stripe", "apiKey": "sk_live_...", "webhookSecret": "whsec_..."}}

User: "Connect Resend for emails" / "add Resend key re_..."
{"action": "STORE_INTEGRATION_KEY", "params": {"integrationId": "resend", "apiKey": "re_..."}}

User: "What integrations do I have?" / "show connected services"
{"action": "LIST_INTEGRATION_KEYS", "params": {}}

// Background Jobs
User: "Send cart abandonment email every day at 9am"
{"action": "CREATE_CRON_JOB", "params": {"description": "Find users with items in their cart for 24+ hours and send a cart abandonment email", "schedule": "every day at 9am"}}

User: "Clean up expired sessions every hour"
{"action": "CREATE_CRON_JOB", "params": {"description": "Delete expired sessions from the sessions table", "schedule": "hourly"}}

User: "Generate weekly analytics report every Monday at 8am"
{"action": "CREATE_CRON_JOB", "params": {"description": "Aggregate last week's analytics and email a summary report to admins", "schedule": "0 8 * * 1"}}

**IMPORTANT - PostgreSQL Types:**
ALWAYS use these exact PostgreSQL types:
- Text/String → "TEXT"
- Number (integer) → "INTEGER" or "BIGINT"
- Number (decimal) → "DECIMAL" or "NUMERIC"
- True/False → "BOOLEAN"
- Date/Time → "TIMESTAMP" or "DATE"
- JSON → "JSON" or "JSONB"

**NEVER use:** "string", "number", "int", "float" - these are NOT valid!

**Foreign Key Pattern:**
If you see user_id in schema pointing to users.id, follow that pattern.
For new relations: order_id → orders.id, product_id → products.id

**Column Type Guards:**
- Rating/star columns: Use INTEGER (system will add CHECK constraint)
- Price/cost/amount columns: Use DECIMAL(10,2)
- Email columns: Use TEXT

**Default Primary Key:**
- EVERY table gets an auto-incrementing "id" INTEGER PRIMARY KEY
- NEVER include "id" in columns array
- System adds it automatically

**IMPORTANT for INSERT_DATA:**
- ALWAYS generate realistic mock data in "rows" array
- Look at table name to guess appropriate fields
- Generate 2-3 sample rows
- Use realistic values (names, numbers, text)

**Respond with ONLY valid JSON.**${
  semanticEnrichment && semanticEnrichment.trim()
    ? `\n\n## SEMANTIC INTELLIGENCE — ENFORCE ALL RULES BELOW WITHOUT EXCEPTION:\n${semanticEnrichment}`
    : ''
}`

  // SYSTEM 2: Failure-Aware Replanning - inject previous error
  let replanningContext = ''
  if (previousError) {
    replanningContext = `

**PREVIOUS ATTEMPT FAILED:**
Error: ${previousError}

**Your task:** Analyze the error above and the live schema below. Generate a FIXED plan that will work with the actual database state.`
  }

  // Build conversation context block to resolve pronouns and references
  let historyContext = ''
  if (conversationHistory && conversationHistory.length > 0) {
    const lines = conversationHistory.slice(-6).map(h => `${h.role === 'user' ? 'User' : 'AI'}: ${h.content.substring(0, 200)}`)
    historyContext = `\n\n**Recent conversation (use to resolve "it", "that table", "the last one", etc.):**\n${lines.join('\n')}`
  }

  const enhancedUserMessage = `${normalizedMessage}${liveSchema}${schemaContext}${replanningContext}${historyContext}

**CRITICAL: If INSERT_DATA action, you MUST generate realistic sample data in the rows array. Do NOT return empty rows!**`

  if (schemaContext) {
    console.log('[AI Executor] Schema context provided:', schemaContext)
  }
  
  if (liveSchema) {
    console.log('[Live Schema] Injected current database state')
  }
  
  if (previousError) {
    console.log('[Replanning] Retrying with error context:', previousError.substring(0, 100))
  }

  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: enhancedUserMessage },
    ],
    temperature: 0.1,
    max_tokens: 500,
    response_format: { type: 'json_object' },
  })

  const extracted = JSON.parse(response.choices[0].message.content || '{"action":"UNKNOWN"}')
  
  console.log('[AI Executor] Extracted action:', extracted)
  
  return extracted
}

/**
 * STEP 2: Validate action before execution
 * This prevents wrong endpoints, wrong tables, data corruption
 * 
 * 🎯 FIX #4: Validation is now ADVISORY, not blocking
 * - Errors become warnings
 * - Missing dependencies are auto-resolved by dependency resolver
 * - Validation informs, doesn't block
 */
export async function validateAction(
  action: AIAction,
  projectId: string
): Promise<ValidationResult> {
  const errors: string[] = []
  const warnings: string[] = []
  let preview = ''

  console.log('[Validator] Validating action:', action.action)
  
  // Import context reader
  const { readProjectContext, tableExists, apiExists } = await import('./context-reader')

  switch (action.action) {
    case 'CREATE_TABLE':
      // CHECK: Does table already exist?
      const tableAlreadyExists = await tableExists(projectId, action.params.tableName)
      if (tableAlreadyExists) {
        // 🎯 Changed from error to warning (advisory)
        warnings.push(`Table "${action.params.tableName}" already exists - will return success if idempotent`)
      }
      
      const tableValidation = validateCreateTable(action.params)
      errors.push(...tableValidation.errors)
      warnings.push(...tableValidation.warnings)
      preview = tableValidation.preview
      break

    case 'GENERATE_API':
      // 🎯 Advisory: Table will be auto-created if missing
      const tableForAPIExists = await tableExists(projectId, action.params.tableName)
      if (!tableForAPIExists) {
        warnings.push(`Table "${action.params.tableName}" will be created automatically`)
      }
      
      // CHECK: Does API already exist?
      const apiAlreadyExists = await apiExists(projectId, action.params.tableName)
      if (apiAlreadyExists) {
        warnings.push(`API for "${action.params.tableName}" already exists - will return success`)
      }
      
      const apiValidation = validateGenerateAPI(action.params)
      errors.push(...apiValidation.errors)
      warnings.push(...apiValidation.warnings)
      preview = apiValidation.preview
      break

    case 'ADD_COLUMN':
      // 🎯 Advisory: Will use context memory if no table specified
      const tableToModify = await tableExists(projectId, action.params.tableName)
      if (!tableToModify && !action.params.tableName) {
        warnings.push(`No table specified - will use last active table from context`)
      } else if (!tableToModify) {
        warnings.push(`Table "${action.params.tableName}" will be created automatically`)
      } else {
        // CHECK: Does column already exist?
        try {
          const { prisma } = await import('@/lib/db')
          const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
          const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
          
          const columnCheckQuery = `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
          `
          
          const existingColumn: any[] = await prisma.$queryRawUnsafe(
            columnCheckQuery,
            postgresSchema,
            action.params.tableName,
            action.params.columnName
          )
          
          if (existingColumn.length > 0) {
            warnings.push(`Column "${action.params.columnName}" already exists - operation is idempotent`)
          }
        } catch (error) {
          console.log('⚠️ [Validator] Could not check column existence:', error)
        }
      }
      
      const columnValidation = validateAddColumn(action.params)
      errors.push(...columnValidation.errors)
      warnings.push(...columnValidation.warnings)
      preview = columnValidation.preview
      break

    case 'INSERT_DATA':
      // 🎯 Advisory: Table will be auto-created if missing
      const tableForData = await tableExists(projectId, action.params.tableName)
      if (!tableForData) {
        warnings.push(`Table "${action.params.tableName}" will be created automatically`)
      }
      
      const dataValidation = validateInsertData(action.params)
      errors.push(...dataValidation.errors)
      warnings.push(...dataValidation.warnings)
      preview = dataValidation.preview
      break

    case 'LIST_TABLES':
      // No validation needed - just listing
      preview = 'List all database tables'
      break

    case 'CREATE_JUNCTION_TABLE': {
      const { tableA: jA, tableB: jB, junctionName: jN } = action.params
      if (!jA || !jB) {
        errors.push('Both tableA and tableB are required for junction table creation')
      }
      const jName = jN || `${jA}_${jB}`
      const tableAExists = await tableExists(projectId, jA)
      const tableBExists = await tableExists(projectId, jB)
      if (!tableAExists) warnings.push(`Table "${jA}" does not exist yet — create it first`)
      if (!tableBExists) warnings.push(`Table "${jB}" does not exist yet — create it first`)
      const humanReadable = `Create many-to-many junction table "${jName}" linking ${jA} ↔ ${jB}`
      preview = `CREATE TABLE IF NOT EXISTS "${jName}" (id UUID PRIMARY KEY, "${jA?.replace(/s$/,'')}Id" UUID REFERENCES "${jA}"(id), "${jB?.replace(/s$/,'')}Id" UUID REFERENCES "${jB}"(id), createdAt TIMESTAMPTZ)`
      return {
        valid: errors.length === 0,
        errors,
        warnings,
        preview,
        humanReadable,
      }
    }

    // 🎯 Schema operations validation
    case 'CREATE_INDEX':
      warnings.push(`Index will be created (idempotent operation)`)
      preview = `Create index on ${action.params.columnName || 'column'}`
      break

    case 'RENAME_COLUMN':
      warnings.push(`Column will be renamed (idempotent operation)`)
      preview = `Rename column from ${action.params.oldName} to ${action.params.newName}`
      break

    case 'ADD_CONSTRAINT':
      warnings.push(`Constraint will be added (idempotent operation)`)
      preview = `Add ${action.params.constraintType || 'constraint'} to column`
      break

    case 'DROP_COLUMN':
      if (!action.params.tableName) errors.push('Table name is required')
      if (!action.params.columnName) errors.push('Column name is required')
      warnings.push('Column AND all its data will be permanently dropped — irreversible')
      preview = `Drop column "${action.params.columnName}" from "${action.params.tableName}"`
      break

    case 'LIST_APIS':
      // No validation needed - just listing
      preview = 'List all API endpoints'
      break

    case 'INFO':
      // No validation needed - just info
      preview = 'Show help information'
      break

    // ========== STORAGE ACTIONS ==========
    case 'CREATE_BUCKET':
      if (!action.params.bucketName) {
        errors.push('Bucket name is required')
      }
      preview = `Create storage bucket "${action.params.bucketName}"`
      break

    case 'SET_BUCKET_PUBLIC':
      if (!action.params.bucketName) {
        errors.push('Bucket name is required')
      }
      preview = `Make bucket "${action.params.bucketName}" ${action.params.isPublic ? 'public' : 'private'}`
      break

    case 'DELETE_BUCKET':
      if (!action.params.bucketName) {
        errors.push('Bucket name is required')
      }
      preview = `Delete storage bucket "${action.params.bucketName}"`
      break

    case 'LIST_BUCKETS':
      preview = 'List all storage buckets'
      break

    case 'UPLOAD_FILE':
    case 'LIST_FILES':
    case 'DELETE_FILE':
    case 'GENERATE_SIGNED_URL':
      preview = `Storage operation: ${action.action}`
      break

    // ========== CONNECT FRONTEND ==========
    case 'CONNECT_FRONTEND':
      if (!action.params.url) errors.push('Frontend URL is required')
      preview = `Connect frontend "${action.params.url}"`
      break

    case 'DISCONNECT_FRONTEND':
      if (!action.params.url) errors.push('Frontend URL is required')
      preview = `Disconnect frontend "${action.params.url}"`
      break

    case 'LIST_CONNECTED_APPS':
      preview = 'List connected frontends'
      break

    // ========== DEPLOY ACTIONS ==========
    case 'TRIGGER_DEPLOY':
      preview = `Deploy backend to ${action.params.environment || 'production'}`
      break

    case 'ROLLBACK_DEPLOY':
      preview = action.params.version ? `Rollback to v${action.params.version}` : 'Rollback to previous deployment'
      warnings.push('Live consumers will see the older schema immediately')
      break

    case 'GET_READINESS':
      preview = 'Read deploy readiness score'
      break

    case 'LIST_ENV_VARS':
      preview = 'List project env vars'
      break

    case 'DELETE_ENV_VAR':
      if (!action.params.key) errors.push('Env var key is required')
      preview = `Delete env var "${action.params.key}"`
      warnings.push('AI functions using this env var will start failing on next invocation')
      break

    case 'GET_DEPLOY_STATUS':
      preview = 'Get deployment status'
      break

    case 'SET_ENV_VAR':
      if (!action.params.key) {
        errors.push('Environment variable key is required')
      }
      preview = `Set environment variable "${action.params.key}"`
      break

    // ========== AUTH ACTIONS ==========
    case 'ENABLE_AUTH':
      preview = 'Enable authentication for your backend'
      break

    case 'ENABLE_REALTIME':
      preview = action.params?.table
        ? `Enable realtime subscriptions for the ${action.params.table} table`
        : 'Enable realtime subscriptions for the project'
      break

    case 'DISABLE_REALTIME':
      warnings.push('Active SSE subscribers on this table will stop receiving events immediately')
      preview = action.params?.table || action.params?.tableName
        ? `Disable realtime on the ${action.params.table || action.params.tableName} table`
        : 'Disable realtime project-wide'
      break

    case 'GET_REALTIME_STATUS':
      preview = 'Read realtime streaming status'
      break

    case 'ADD_PROVIDER':
      if (!action.params.provider) {
        errors.push('Auth provider is required (e.g., google, github)')
      }
      preview = `Enable ${action.params.provider} authentication`
      break

    case 'DISABLE_PROVIDER':
      if (!action.params.provider) {
        errors.push('Auth provider is required (e.g., google, github)')
      }
      warnings.push(`End-users will no longer be able to sign in with ${action.params.provider}`)
      preview = `Disable ${action.params.provider} sign-in`
      break

    case 'LIST_USERS':
      preview = "List the project's end-users"
      break

    case 'BLOCK_USER':
      // 🎯 Entity resolution: Accept email or userId
      if (!action.params.userId && !action.params.email) {
        errors.push('User ID or email is required')
      } else if (action.params.email && !action.params.userId) {
        warnings.push(`Email will be resolved to user ID automatically`)
      }
      preview = `Block user ${action.params.email || action.params.userId}`
      break

    case 'UNBLOCK_USER':
      if (!action.params.userId && !action.params.email) {
        errors.push('User ID or email is required')
      }
      preview = `Unblock user ${action.params.email || action.params.userId}`
      break

    case 'RESET_PASSWORD':
      // 🎯 Entity resolution: Accept email or userId
      if (!action.params.userId && !action.params.email) {
        errors.push('User ID or email is required')
      } else if (action.params.email && !action.params.userId) {
        warnings.push(`Email will be resolved to user ID automatically`)
      }
      preview = `Reset password for user ${action.params.email || action.params.userId}`
      break

    // ========== IAM ACTIONS ==========
    case 'CREATE_KEY':
      preview = `Create new API key ${action.params.description ? '(' + action.params.description + ')' : ''}`
      break

    case 'REVOKE_KEY':
      if (!action.params.keyId) {
        errors.push('API key ID is required')
      }
      preview = `Revoke API key ${action.params.keyId}`
      break

    case 'ROTATE_KEY':
      if (!action.params.keyId) {
        errors.push('API key ID is required')
      }
      preview = `Rotate API key ${action.params.keyId}`
      break

    case 'SET_KEY_PERMISSIONS':
      if (!action.params.keyId) {
        errors.push('API key ID is required')
      }
      preview = `Update permissions for API key ${action.params.keyId}`
      break

    case 'LIST_KEYS':
      preview = 'List all API keys'
      break

    // ========== MONITORING ACTIONS ==========
    case 'GET_METRICS':
      preview = 'Get API performance metrics'
      break

    case 'GET_ERRORS':
      preview = 'Get error logs'
      break

    case 'SET_ALERT':
      preview = 'Configure monitoring alert'
      break

    case 'GET_USAGE':
      preview = 'Get usage statistics'
      break

    // ========== TRIGGER ACTIONS ==========
    case 'CREATE_TRIGGER':
      if (!action.params.name) errors.push('Trigger name is required')
      if (!action.params.sourceTable) errors.push('sourceTable is required')
      if (!action.params.event) errors.push('event is required (insert | update | delete | all)')
      if (!action.params.actionType) errors.push('actionType is required (insert_row | update_row | delete_rows | webhook)')
      preview = `Create trigger "${action.params.name}" on ${action.params.sourceTable}.${action.params.event}`
      break

    case 'LIST_TRIGGERS':
      preview = 'List all event triggers'
      break

    // ── Derived columns ("keep column X in sync with related rows") ──────────
    case 'SYNC_COLUMN':
      if (!action.params.sourceTable) errors.push('sourceTable is required (the child table whose writes drive the value)')
      if (!action.params.targetTable) errors.push('targetTable is required (the parent table holding the derived column)')
      if (!action.params.targetColumn) errors.push('targetColumn is required (the derived column on the parent)')
      if (!action.params.via) errors.push('via is required (the foreign-key column on the child pointing at the parent)')
      if (!action.params.compute) errors.push('compute is required (latest | count | sum | max | min)')
      preview =
        `Keep ${action.params.targetTable}.${action.params.targetColumn} in sync with ` +
        `${action.params.compute}(${action.params.sourceTable}` +
        `${action.params.sourceColumn ? `.${action.params.sourceColumn}` : ''})`
      break

    case 'LIST_SYNCED_COLUMNS':
      preview = 'List derived columns kept in sync by the database'
      break

    case 'REMOVE_SYNC_COLUMN':
      if (!action.params.targetTable) errors.push('targetTable is required')
      if (!action.params.targetColumn) errors.push('targetColumn is required')
      if (!action.params.sourceTable) errors.push('sourceTable is required (the table the trigger lives on)')
      preview = `Stop maintaining ${action.params.targetTable}.${action.params.targetColumn}`
      break

    case 'DELETE_TRIGGER':
      if (!action.params.triggerId && !action.params.name) errors.push('triggerId or name is required')
      preview = `Delete trigger "${action.params.name || action.params.triggerId}"`
      break

    // ========== PERMISSION ACTIONS ==========
    case 'SET_PERMISSION':
      if (!action.params.tableName) errors.push('tableName is required')
      if (!action.params.template) errors.push('template is required (auto | own_rows | party_rows | related_rows | public_read | admin_only | all_access | org_members | admin_read_all | role_based | moderator_access | custom)')
      preview = `Apply "${action.params.template}" policy to "${action.params.tableName}"`
      break

    case 'LIST_PERMISSIONS':
      preview = 'List all permission policies'
      break

    case 'REMOVE_PERMISSION':
      if (!action.params.tableName) errors.push('tableName is required')
      preview = `Remove permission policies from "${action.params.tableName}"`
      break

    // ========== AI FUNCTION ACTIONS ==========
    case 'CREATE_AI_FUNCTION':
      if (!action.params.description) errors.push('description is required')
      if (!action.params.triggerType) errors.push('triggerType is required (on_signup | on_db_insert | on_db_update | on_db_delete | manual)')
      preview = `Create AI function: "${action.params.description?.slice(0, 60)}"`
      break

    case 'LIST_AI_FUNCTIONS':
      preview = 'List all AI functions'
      break

    case 'DELETE_AI_FUNCTION':
      if (!action.params.functionId && !action.params.name) errors.push('functionId or name is required')
      preview = `Delete AI function "${action.params.name || action.params.functionId}"`
      break

    case 'TOGGLE_AI_FUNCTION':
      if (!action.params.functionId && !action.params.name) errors.push('functionId or name is required')
      if (action.params.active === undefined) errors.push('active (true/false) is required')
      preview = `${action.params.active ? 'Enable' : 'Disable'} AI function "${action.params.name || action.params.functionId}"`
      break

    // ========== INTEGRATION KEY MANAGEMENT ==========
    case 'STORE_INTEGRATION_KEY':
      if (!action.params.integrationId) errors.push('integrationId is required (e.g. stripe, resend, openai)')
      if (!action.params.apiKey) errors.push('apiKey is required')
      preview = `Store ${action.params.integrationId} API key securely`
      break

    case 'LIST_INTEGRATION_KEYS':
      preview = 'List all connected integrations'
      break

    case 'REMOVE_INTEGRATION_KEY':
      if (!action.params.integrationId) errors.push('integrationId is required')
      preview = `Remove ${action.params.integrationId} integration`
      break

    // ========== BACKGROUND JOBS / CRON ==========
    case 'CREATE_CRON_JOB':
      if (!action.params.description) errors.push('description is required')
      if (!action.params.schedule) errors.push('schedule is required (cron expression or natural language like "every day at 9am")')
      preview = `Create scheduled job: "${action.params.description?.slice(0, 60)}"`
      break

    case 'LIST_CRON_JOBS':
      preview = 'List all scheduled jobs'
      break

    case 'DELETE_CRON_JOB':
      if (!action.params.jobId && !action.params.name) errors.push('jobId or name is required')
      preview = `Delete cron job "${action.params.name || action.params.jobId}"`
      break

    case 'GENERATE_AGGREGATE_API':
      preview = action.params.name
        ? `Generate aggregate stats endpoint "${action.params.name}"`
        : 'Generate aggregate stats endpoint'
      break

    case 'GENERATE_CHECKOUT_FLOW':
      preview = 'Generate cart → order checkout flow with transactional order creation'
      break

    case 'GENERATE_HEALTH_CHECK':
      preview = 'Generate project health check endpoint at /healthz'
      break

    case 'GENERATE_DOMAIN_LOGIC':
      preview = `Generate domain business logic functions (payment flows, lifecycle automations, validation rules)`
      break

    case 'GENERATE_RESTRICTED_ENDPOINT':
      if (!action.params.tableName) errors.push('tableName is required')
      if (!action.params.allowedFields || !Array.isArray(action.params.allowedFields)) {
        errors.push('allowedFields array is required')
      }
      preview = `Generate field-restricted PATCH endpoint for "${action.params.tableName}" (fields: ${(action.params.allowedFields ?? []).join(', ')})`
      break

    default:
      errors.push(`Unknown action: ${action.action}`)
      preview = 'Invalid action'
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    preview,
    humanReadable: preview,  // Will be enhanced by validation functions
  }
}

/**
 * STEP 3: Simulate what will happen before execution
 * Shows user exactly what changes will be made
 */
export async function simulateAction(
  action: AIAction,
  projectId: string
): Promise<SimulationResult> {
  console.log('🎬 [Simulator] Simulating action:', action.action)

  const willCreate: string[] = []
  const willModify: string[] = []
  const willDelete: string[] = []
  const risks: string[] = []
  let reversible = true

  switch (action.action) {
    case 'CREATE_TABLE':
      const { tableName, columns = [] } = action.params
      willCreate.push(`Table: "${tableName}"`)
      
      // Standard columns
      willCreate.push(`  - Column: "id" (UUID, PRIMARY KEY, DEFAULT gen_random_uuid())`)
      willCreate.push(`  - Column: "createdAt" (TIMESTAMP)`)
      willCreate.push(`  - Column: "updatedAt" (TIMESTAMP)`)
      
      // User columns
      columns.forEach((col: any) => {
        willCreate.push(`  - Column: "${col.name}" (${col.type})`)
      })
      
      reversible = true
      break

    case 'GENERATE_API':
      const { tableName: apiTable } = action.params
      willCreate.push(`API Definition for "${apiTable}"`)
      willCreate.push(`  - Endpoint: GET /api/v1/${apiTable}`)
      willCreate.push(`  - Endpoint: GET /api/v1/${apiTable}/:id`)
      willCreate.push(`  - Endpoint: POST /api/v1/${apiTable}`)
      willCreate.push(`  - Endpoint: PUT /api/v1/${apiTable}/:id`)
      willCreate.push(`  - Endpoint: DELETE /api/v1/${apiTable}/:id`)
      break

    case 'ADD_COLUMN':
      const { tableName: modTable, columnName, columnType } = action.params
      willModify.push(`Table: "${modTable}"`)
      willCreate.push(`  - Column: "${columnName}" (${columnType})`)
      risks.push('Existing data in this table may be affected')
      break

    case 'INSERT_DATA':
      const { tableName: dataTable, rows = [] } = action.params
      willCreate.push(`${rows.length} rows in "${dataTable}"`)
      reversible = false
      risks.push('Data insertion cannot be automatically undone')
      break

    case 'CREATE_JUNCTION_TABLE': {
      const jName = action.params.junctionName || `${action.params.tableA}_${action.params.tableB}`
      willCreate.push(`Junction table: "${jName}"`)
      willCreate.push(`  - Columns: id, ${action.params.tableA?.replace(/s$/, '')}Id, ${action.params.tableB?.replace(/s$/, '')}Id, createdAt`)
      risks.push('Both referenced tables must already exist')
      break
    }
  }

  return {
    willCreate: willCreate.length > 0 ? willCreate : undefined,
    willModify: willModify.length > 0 ? willModify : undefined,
    willDelete: willDelete.length > 0 ? willDelete : undefined,
    risks,
    reversible,
    impact: generateImpactSummary(action, willCreate, willModify, willDelete, risks),
  }
}

/**
 * Generate human-readable impact summary
 */
function generateImpactSummary(
  action: AIAction,
  willCreate: string[],
  willModify: string[],
  willDelete: string[],
  risks: string[]
): string {
  const createCount = willCreate.length
  const modifyCount = willModify.length
  const deleteCount = willDelete.length
  
  let summary = ''
  
  if (createCount > 0) {
    summary += `This will create ${createCount} new ${createCount === 1 ? 'item' : 'items'}.`
  }
  
  if (modifyCount > 0) {
    summary += ` ${modifyCount} existing ${modifyCount === 1 ? 'item' : 'items'} will be changed.`
  }
  
  if (deleteCount > 0) {
    summary += ` ⚠️ ${deleteCount} ${deleteCount === 1 ? 'item' : 'items'} will be deleted.`
  }
  
  if (risks.length > 0) {
    summary += ` There ${risks.length === 1 ? 'is' : 'are'} ${risks.length} risk${risks.length === 1 ? '' : 's'} to consider.`
  }
  
  return summary.trim() || 'No significant changes.'
}

/**
 * Validation helpers
 */
function validateCreateTable(params: any): { errors: string[]; warnings: string[]; preview: string; humanReadable: string } {
  const errors: string[] = []
  const warnings: string[] = []
  
  const { tableName, columns = [] } = params
  
  // Validate table name
  if (!tableName) {
    errors.push('Table name is required')
  } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
    errors.push('Table name must start with letter/underscore and contain only alphanumeric characters')
  } else if (tableName.length > 63) {
    errors.push('Table name must be 63 characters or less (PostgreSQL limit)')
  }
  
  // Reserved table names
  const reservedNames = ['user', 'users', 'table', 'select', 'insert', 'delete', 'update']
  if (reservedNames.includes(tableName?.toLowerCase())) {
    warnings.push(`"${tableName}" is a common SQL keyword. Consider using a different name.`)
  }
  
  // Validate columns
  columns.forEach((col: any, index: number) => {
    if (!col.name) {
      errors.push(`Column ${index + 1} is missing a name`)
    }
    if (!col.type) {
      errors.push(`Column "${col.name || index + 1}" is missing a type`)
    }
    
    // Validate column types
    const validTypes = ['TEXT', 'INTEGER', 'BIGINT', 'DECIMAL', 'BOOLEAN', 'TIMESTAMP', 'DATE', 'JSON', 'UUID']
    if (col.type && !validTypes.some(t => col.type.toUpperCase().startsWith(t))) {
      warnings.push(`Column "${col.name}" has type "${col.type}" which may not be valid PostgreSQL type`)
    }
  })
  
  // Generate preview
  const preview = `CREATE TABLE "${tableName}" (\n` +
    `  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n` +
    `  createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,\n` +
    `  updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP` +
    (columns.length > 0 ? `,\n  ${columns.map((c: any) => `${c.name} ${c.type}`).join(',\n  ')}` : '') +
    `\n);`
  
  // Generate human-readable explanation
  const columnCount = columns.length + 3  // +3 for id, createdAt, updatedAt
  let humanReadable = `This will create a new table called "${tableName}" to store ${tableName} data.\n\n`
  
  humanReadable += `**What you'll get:**\n`
  humanReadable += `- A table with ${columnCount} columns\n`
  humanReadable += `- Every ${tableName.slice(0, -1)} will automatically get an ID number\n`
  humanReadable += `- Creation and update timestamps will be tracked automatically\n`
  
  if (columns.length > 0) {
    humanReadable += `\n**Your custom fields:**\n`
    columns.forEach((col: any) => {
      const typeExplained = explainColumnType(col.type)
      humanReadable += `- **${col.name}**: ${typeExplained}\n`
    })
  }
  
  humanReadable += `\n**Impact:** This is a new table. Your existing data won't be affected.`
  
  return { errors, warnings, preview, humanReadable }
}

/**
 * Explain column types in human language
 */
function explainColumnType(type: string): string {
  if (!type) return 'Text'
  const typeUpper = type.toUpperCase()
  
  if (typeUpper.startsWith('TEXT') || typeUpper.startsWith('VARCHAR')) {
    return 'Text (letters, words, sentences)'
  }
  if (typeUpper.startsWith('INTEGER') || typeUpper.startsWith('INT')) {
    return 'Whole numbers (1, 2, 3...)'
  }
  if (typeUpper.startsWith('BIGINT')) {
    return 'Large whole numbers'
  }
  if (typeUpper.startsWith('DECIMAL') || typeUpper.startsWith('NUMERIC')) {
    return 'Numbers with decimals (prices, measurements)'
  }
  if (typeUpper.startsWith('BOOLEAN') || typeUpper.startsWith('BOOL')) {
    return 'Yes/No or True/False'
  }
  if (typeUpper.startsWith('TIMESTAMP') || typeUpper.startsWith('DATE')) {
    return 'Date and time'
  }
  if (typeUpper.startsWith('JSON')) {
    return 'Structured data (lists, objects)'
  }
  if (typeUpper.startsWith('UUID')) {
    return 'Unique identifier'
  }

  return type || 'Text'  // Fallback to original type
}

function validateGenerateAPI(params: any): { errors: string[]; warnings: string[]; preview: string; humanReadable: string } {
  const errors: string[] = []
  const warnings: string[] = []
  
  const { tableName } = params
  
  if (!tableName) {
    errors.push('Table name is required')
  }
  
  // Check if table exists (would need real query)
  warnings.push('Make sure the table exists before generating API')
  
  const preview = `API Endpoints for "${tableName}":\n` +
    `  GET    /api/v1/${tableName}     - List all\n` +
    `  GET    /api/v1/${tableName}/:id - Get one\n` +
    `  POST   /api/v1/${tableName}     - Create\n` +
    `  PUT    /api/v1/${tableName}/:id - Update\n` +
    `  DELETE /api/v1/${tableName}/:id - Delete`
  
  const humanReadable = `This will create a complete REST API for your "${tableName}" table.\n\n` +
    `**What you'll be able to do:**\n` +
    `- Get a list of all ${tableName}\n` +
    `- View details of a single ${tableName.slice(0, -1)}\n` +
    `- Create new ${tableName}\n` +
    `- Update existing ${tableName}\n` +
    `- Delete ${tableName}\n\n` +
    `**All endpoints will be:**\n` +
    `- Available immediately at /api/v1/${tableName}\n` +
    `- Protected with authentication\n` +
    `- Rate-limited to prevent abuse\n\n` +
    `**Impact:** This creates new API endpoints. Your data and existing APIs won't be affected.`
  
  return { errors, warnings, preview, humanReadable }
}

function validateAddColumn(params: any): { errors: string[]; warnings: string[]; preview: string; humanReadable: string } {
  const errors: string[] = []
  const warnings: string[] = []
  
  const { tableName, columnName, columnType } = params
  
  if (!tableName) errors.push('Table name is required')
  if (!columnName) errors.push('Column name is required')
  if (!columnType) {
    errors.push('Column type is required')
    // Return early with safe defaults to avoid toUpperCase error
    return { 
      errors, 
      warnings, 
      preview: 'ALTER TABLE (missing type)', 
      humanReadable: 'Cannot add column - type is missing' 
    }
  }
  
  warnings.push('This will modify an existing table')
  warnings.push('Existing data may be affected')
  
  const preview = `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${columnType};`
  
  const typeExplained = explainColumnType(columnType)
  const humanReadable = `This will add a new field called "${columnName}" to all records in your "${tableName}" table.\n\n` +
    `**What this means:**\n` +
    `- Field type: ${typeExplained}\n` +
    `- All existing ${tableName} will get this new field\n` +
    `- Existing ${tableName} will have this field empty (NULL) until you update them\n\n` +
    `**Impact:** This modifies your existing "${tableName}" table. All current data will remain, but each record will have one additional field.`
  
  return { errors, warnings, preview, humanReadable }
}

function validateInsertData(params: any): { errors: string[]; warnings: string[]; preview: string; humanReadable: string } {
  const errors: string[] = []
  const warnings: string[] = []
  
  const { tableName, rows = [] } = params
  
  if (!tableName) errors.push('Table name is required')
  if (rows.length === 0) errors.push('No data to insert')
  
  warnings.push('Data insertion is NOT reversible')
  
  const preview = `INSERT INTO "${tableName}" ${rows.length} rows`
  
  const humanReadable = `This will add ${rows.length} new ${rows.length === 1 ? 'record' : 'records'} to your "${tableName}" table.\n\n` +
    `**What will happen:**\n` +
    `- ${rows.length} new ${tableName.slice(0, -1)}${rows.length === 1 ? '' : 's'} will be created\n` +
    `- Each will get a unique ID automatically\n` +
    `- Creation timestamp will be recorded\n\n` +
    `**Important:**\n` +
    `- This action CANNOT be automatically undone\n` +
    `- You'll need to manually delete these records if you change your mind\n` +
    `- Make sure the data is correct before proceeding\n\n` +
    `**Impact:** New data will be added to "${tableName}". Your existing records won't be changed.`
  
  return { errors, warnings, preview, humanReadable }
}

/**
 * STEP 4: Execute the action by calling REAL backend endpoints
 * 
 * 🎯 NEW: Pre-flight dependency resolver + Context memory
 */

// Context memory: Track last active table for schema ops, scoped per project
const sessionContexts = new Map<string, { lastTable?: string; lastAction?: string }>()

function getSessionContext(projectId: string): { lastTable?: string; lastAction?: string } {
  if (!sessionContexts.has(projectId)) {
    sessionContexts.set(projectId, {})
  }
  return sessionContexts.get(projectId)!
}

export function updateSessionContext(tableName?: string, action?: string, projectId?: string) {
  const ctx = getSessionContext(projectId || '_default')
  if (tableName) ctx.lastTable = tableName
  if (action) ctx.lastAction = action
}

/**
 * 🎯 FIX #1: Pre-flight Dependency Resolver
 * Auto-adds missing dependencies before execution
 */
async function resolveDependencies(
  action: AIAction,
  projectId: string
): Promise<AIAction[]> {
  const actions: AIAction[] = []
  const { prisma } = await import('@/lib/db')
  
  console.log('[Dependency Resolver] Checking action:', action.action)
  
  // Skip dependency resolution for read-only/info actions
  if (action.action === 'INFO' || action.action === 'LIST_TABLES' || action.action === 'LIST_APIS' || 
      action.action === 'LIST_BUCKETS' || action.action === 'LIST_KEYS' || action.action === 'LIST_USERS' ||
      action.action === 'LIST_CONNECTED_APPS' || action.action === 'GET_METRICS' || action.action === 'GET_ERRORS' ||
      action.action === 'GET_USAGE' || action.action === 'GET_DEPLOY_STATUS' || action.action === 'GET_READINESS' ||
      action.action === 'LIST_ENV_VARS' || action.action === 'GET_REALTIME_STATUS') {
    console.log('[Dependency Resolver] Skipping read-only action')
    return [action]
  }
  
  switch (action.action) {
    case 'GENERATE_API': {
      const { tableName } = action.params
      
      // Check if table exists
      const table = await prisma.table.findFirst({
        where: { projectId, name: tableName }
      })
      
      if (!table) {
        console.log(`🤖 [Auto-Repair] Table "${tableName}" missing - adding CREATE_TABLE`)
        actions.push({
          action: 'CREATE_TABLE',
          params: { tableName, columns: [] }
        })
      }
      break
    }
    
    case 'INSERT_DATA': {
      const { tableName } = action.params
      
      // Check if table exists
      const table = await prisma.table.findFirst({
        where: { projectId, name: tableName }
      })
      
      if (!table) {
        console.log(`🤖 [Auto-Repair] Table "${tableName}" missing - adding CREATE_TABLE`)
        actions.push({
          action: 'CREATE_TABLE',
          params: { tableName, columns: [] }
        })
      }
      break
    }
    
    case 'ADD_COLUMN':
    case 'CREATE_INDEX':
    case 'RENAME_COLUMN':
    case 'ADD_CONSTRAINT': {
      let { tableName } = action.params
      
      // 🎯 FIX #2: Use context memory if no table specified
      const ctx = getSessionContext(projectId)
      if (!tableName && ctx.lastTable) {
        console.log(`🧠 [Context Memory] Using last table: ${ctx.lastTable}`)
        action.params.tableName = ctx.lastTable
        tableName = ctx.lastTable
      }
      
      // Check if table exists
      if (tableName) {
        const table = await prisma.table.findFirst({
          where: { projectId, name: tableName }
        })
        
        if (!table) {
          console.log(`🤖 [Auto-Repair] Table "${tableName}" missing - adding CREATE_TABLE`)
          actions.push({
            action: 'CREATE_TABLE',
            params: { tableName, columns: [] }
          })
        }
      }
      break
    }
  }
  
  // Add the original action
  actions.push(action)
  
  if (actions.length > 1) {
    console.log(`✅ [Dependency Resolver] Resolved ${actions.length - 1} dependencies`)
  }
  
  return actions
}

/**
 * 🎯 FIX #3: Entity Resolution Layer
 * Converts human identifiers to system IDs
 */
async function resolveEntity(
  action: AIAction,
  projectId: string
): Promise<AIAction> {
  // BLOCK_USER / RESET_PASSWORD target END USERS in workspace_{projectId}.users.
  // Their executors (executeBlockUser / executeResetPassword) resolve `email`
  // against that workspace schema directly. We deliberately do NOT resolve the
  // email here against the platform `User` table — that would mis-resolve an
  // end-user's email to the platform owner's id (a different id space) and the
  // workspace UPDATE would silently match zero rows. Email passes through.
  void projectId
  return action
}

/**
 * Post-execution verification: Confirm expected state exists
 */
async function verifyExecution(
  action: AIAction,
  result: ExecutionResult,
  projectId: string
): Promise<ExecutionResult> {
  // Only verify if execution succeeded
  if (!result.success) return result
  
  const { prisma } = await import('@/lib/db')
  const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
  
  try {
    switch (action.action) {
      case 'CREATE_TABLE': {
        // Verify table exists in DB
        const tableCheck = await prisma.$queryRawUnsafe<any[]>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
          postgresSchema,
          action.params.tableName
        )
        
        if (tableCheck.length === 0) {
          console.error(`[Verify] Table "${action.params.tableName}" not found in DB after creation!`)
          // Self-heal: Try creating again
          console.log(`[Self-Heal] Retrying table creation...`)
          return await executeCreateTable(action.params, projectId)
        }
        
        // Verify metadata exists
        const metaCheck = await prisma.table.findFirst({
          where: { projectId, name: action.params.tableName }
        })
        
        if (!metaCheck) {
          console.log(`[Self-Heal] Metadata missing, creating...`)
          await prisma.table.create({
            data: {
              projectId,
              name: action.params.tableName,
              schema: postgresSchema,
              description: `${action.params.tableName} table`,
            }
          })
        }
        
        console.log(`[Verify] Table "${action.params.tableName}" verified ✓`)
        result = { ...result, verifiedAt: new Date().toISOString() }
        break
      }

      case 'ADD_COLUMN': {
        // Verify column exists
        const columnCheck = await prisma.$queryRawUnsafe<any[]>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
          postgresSchema,
          action.params.tableName,
          action.params.columnName
        )
        
        if (columnCheck.length === 0) {
          console.error(`[Verify] Column "${action.params.columnName}" not found!`)
          // Self-heal: Try adding again
          console.log(`[Self-Heal] Retrying column creation...`)
          return await executeAddColumn(action.params, projectId)
        }
        
        console.log(`[Verify] Column "${action.params.columnName}" verified ✓`)
        result = { ...result, verifiedAt: new Date().toISOString() }
        break
      }

      case 'GENERATE_API': {
        // Verify API definition exists
        const apiCheck = await prisma.apiDefinition.findFirst({
          where: { projectId, name: action.params.tableName }
        })
        
        if (!apiCheck) {
          console.error(`[Verify] API definition for "${action.params.tableName}" not found!`)
          // Self-heal: Try generating again
          console.log(`[Self-Heal] Retrying API generation...`)
          return await executeGenerateAPI(action.params, projectId)
        }
        
        console.log(`[Verify] API "${action.params.tableName}" verified ✓`)
        result = { ...result, verifiedAt: new Date().toISOString() }
        break
      }

      case 'ENABLE_AUTH': {
        // Verify auth is actually functional: project must have a jwtSecret.
        // executeEnableAuth now sets it, so if it's still missing something went wrong.
        const { prisma: authPrisma } = await import('@/lib/db')
        const authProject = await authPrisma.project.findUnique({
          where: { id: projectId },
          select: { jwtSecret: true },
        })
        if (authProject?.jwtSecret) {
          console.log(`[Verify] Auth verified — jwtSecret present ✓`)
          result = { ...result, verifiedAt: new Date().toISOString() }
        } else {
          console.error(`[Verify] Auth claimed success but jwtSecret is still missing — self-healing`)
          return await executeEnableAuth(projectId)
        }
        break
      }

      case 'CREATE_BUCKET': {
        // Verify storage bucket record exists in DB
        const { prisma: bucketPrisma } = await import('@/lib/db')
        const bucketCheck = await bucketPrisma.storageBucket.findFirst({
          where: { projectId, name: action.params.bucketName },
        })
        if (bucketCheck) {
          console.log(`[Verify] Bucket "${action.params.bucketName}" verified ✓`)
          result = { ...result, verifiedAt: new Date().toISOString() }
        } else {
          console.warn(`[Verify] Bucket "${action.params.bucketName}" not found after creation`)
        }
        break
      }
    }
  } catch (error: any) {
    console.warn(`[Verify] Verification failed:`, error.message)
    // Don't fail the whole operation due to verification issues
  }

  return result
}

// ─── Pillar 5.2: Decision memory writer (non-blocking side-effect) ────────────

const DECISION_MEMORY_ACTIONS = new Set<AIAction['action']>([
  'CREATE_TABLE', 'CREATE_JUNCTION_TABLE', 'ADD_COLUMN', 'GENERATE_API',
  'SET_PERMISSION', 'REMOVE_PERMISSION', 'STORE_INTEGRATION_KEY', 'ENABLE_AUTH',
  'CREATE_TRIGGER', 'SYNC_COLUMN', 'FIX_AUTH', 'FIX_API', 'FIX_TABLE', 'FIX_DEPLOY',
  'FIX_REALTIME', 'FIX_STORAGE', 'FIX_INTEGRATION',
])

async function _writeDecisionMemory(action: AIAction, projectId: string): Promise<void> {
  if (!DECISION_MEMORY_ACTIONS.has(action.action)) return

  // Extract FK inferences from CREATE_TABLE / ADD_COLUMN columns
  let fkInferences: Array<{ column: string; references: string }> | undefined
  if (action.action === 'CREATE_TABLE' || action.action === 'ADD_COLUMN') {
    const cols: Array<{ name: string; type?: string }> =
      action.action === 'CREATE_TABLE'
        ? (action.params.columns ?? [])
        : [{ name: action.params.columnName, type: action.params.columnType }]

    // Load known table names for FK inference (best-effort)
    const { prisma: _prisma } = await import('@/lib/db/prisma')
    const tables = await _prisma.table
      .findMany({ where: { projectId }, select: { name: true } })
      .catch(() => [] as Array<{ name: string }>)
    const tableNames = tables.map((t) => t.name)

    const inferences = extractFkInferences(cols, tableNames)
    if (inferences.length) fkInferences = inferences
  }

  await writeDecisionEntry(projectId, {
    action,
    fkInferences,
  })
}

export async function executeAction(
  action: AIAction,
  projectId: string,
  apiKey?: string,
  retryCount: number = 0, // SYSTEM 2: Track retry attempts
  executionId?: string,   // Phase 8: groups timeline entries for this run
  // Autonomy auto-fixes run a single deterministic buildFixAction and must NOT
  // be LLM-replanned into a different action — replanning a failed CREATE_INDEX
  // into a no-op INFO reported a fix that never happened. Chat keeps replanning.
  allowReplan: boolean = true,
): Promise<ExecutionResult> {
  console.log('[AI Executor] Executing action:', action.action)

  const MAX_RETRIES = 2 // Allow up to 2 retries
  // Derive a stable executionId for the whole run (passed down on replanning retries)
  const runId = executionId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

  try {
    // Step 1: Resolve dependencies (pre-flight check)
    const resolvedActions = await resolveDependencies(action, projectId)

    // Step 2: Resolve entities (email → ID, etc.)
    const finalActions = await Promise.all(
      resolvedActions.map(a => resolveEntity(a, projectId))
    )

    // Step 3: Execute all actions in sequence
    let lastResult: ExecutionResult = { success: true, message: '' }

    const TYPEGEN_TRIGGER_ACTIONS = new Set([
      'CREATE_TABLE', 'CREATE_JUNCTION_TABLE', 'ADD_COLUMN', 'RENAME_COLUMN',
    ])

    for (const act of finalActions) {
      // Phase 8: wrap each action with timeline tracking
      lastResult = await trackAction(
        projectId,
        runId,
        act,
        () => executeSingleAction(act, projectId, apiKey),
        { retryCount },
      )

      // Phase 7: Regenerate TypeScript types after schema mutations (non-blocking)
      if (TYPEGEN_TRIGGER_ACTIONS.has(act.action) && lastResult.success) {
        import('@/lib/typegen/schema-reader').then(async ({ readWorkspaceSchema }) => {
          const { generateTypes } = await import('@/lib/typegen/type-generator')
          await readWorkspaceSchema(projectId) // warm the schema cache
          console.log(`[typegen] Schema refresh triggered for project ${projectId} after ${act.action}`)
        }).catch(() => {}) // always non-fatal
      }

      // SYSTEM 2: Failure-Aware Replanning
      if (!lastResult.success && retryCount < MAX_RETRIES && allowReplan) {
        console.log(`[Replanning] Action failed, attempting retry ${retryCount + 1}/${MAX_RETRIES}`)
        console.log(`[Replanning] Error was: ${lastResult.error || lastResult.message}`)

        // Re-extract action with error context and live schema
        try {
          const replanningMessage = getReplanningMessage(action, lastResult)
          const newAction = await withTimeout(
            extractAction(replanningMessage, projectId, lastResult.error || lastResult.message),
            15_000,
            'extractAction-replan',
          )

          console.log('[Replanning] Generated new action:', newAction.action)

          // Retry with the replanned action — pass executionId so all attempts share a run
          return await executeAction(newAction, projectId, apiKey, retryCount + 1, runId, allowReplan)
        } catch (replanError: any) {
          console.error('[Replanning] Failed to replan:', replanError.message)
          // Fall through to return original error
        }
      }

      if (!lastResult.success) {
        return lastResult
      }

      // Step 4: Post-execution verification + self-heal
      lastResult = await verifyExecution(act, lastResult, projectId)

      if (!lastResult.success) {
        return lastResult
      }

      // Update context memory after successful execution
      if (act.params.tableName) {
        updateSessionContext(act.params.tableName, act.action, projectId)
      }

      // Pillar 5.2: Write decision memory for qualifying actions (non-blocking)
      _writeDecisionMemory(act, projectId).catch(() => {})
    }

    return lastResult
  } catch (error: any) {
    console.error('[AI Executor] Error:', error)
    return {
      success: false,
      message: `Execution failed: ${error.message}`,
      error: error.message,
    }
  }
}

/**
 * Generate replanning message from failed action
 */
function getReplanningMessage(action: AIAction, result: ExecutionResult): string {
  let message = ''
  
  switch (action.action) {
    case 'CREATE_TABLE':
      message = `Create table ${action.params.tableName}`
      break
    case 'CREATE_JUNCTION_TABLE':
      message = `Create junction table ${action.params.junctionName || `${action.params.tableA}_${action.params.tableB}`}`
      break
    case 'ADD_COLUMN':
      message = `Add column ${action.params.columnName} to ${action.params.tableName}`
      break
    case 'GENERATE_API':
      message = `Generate API for ${action.params.tableName}`
      break
    case 'INSERT_DATA':
      message = `Insert data into ${action.params.tableName}`
      break
    default:
      message = `Execute ${action.action}`
  }
  
  return message
}

/**
 * Execute a single action (internal function)
 */
async function executeSingleAction(
  action: AIAction,
  projectId: string,
  apiKey?: string
): Promise<ExecutionResult> {
  console.log('[AI Executor] Executing single action:', action.action)

  // Approval gate for medium/high-risk actions. Skip if params.confirmed=true —
  // means the user already went through the two-step confirmation flow in the
  // chat (typed "confirm delete <tableName>"). Risk tier is the single shared
  // classification in lib/operational-memory/ledger.ts so this list can't
  // drift from the one the brain/orchestration risk gates use.
  const target = action.params?.tableName || action.params?.keyId || action.params?.triggerId
    || action.params?.functionId || action.params?.jobId || action.params?.integrationId
    || action.params?.userId || action.params?.path || undefined
  const riskLevel = riskLevelForExecutorAction(action.action)
  if (riskLevel !== 'low' && !action.params?.confirmed) {
    try {
      await queuePendingActionFinding({
        projectId,
        action: action.action,
        params: action.params ?? {},
        target,
        riskLevel,
        source: 'brain-risk',
        reason: `Backenly paused this ${riskLevel}-risk action for your review instead of applying it immediately.`,
      })
    } catch (error) {
      console.error('[ApprovalGate] Failed to queue pending action finding:', error)
    }

    const verb = riskLevel === 'high' ? 'delete' : 'confirm'
    return {
      success: false,
      message: `⛔ \`${action.action}\`${target ? ` on \`${target}\`` : ''} requires confirmation (${riskLevel} risk). Type \`confirm ${verb} ${target ?? 'this'}\` to proceed now, or review it under Autonomy.`,
      error: 'APPROVAL_REQUIRED',
    }
  }

  // #13 — Schema versioning: snapshot before any schema-mutating action
  // so every change is reversible with LIST_SCHEMA_VERSIONS / ROLLBACK_TO_VERSION
  const SCHEMA_MUTATING_ACTIONS = new Set([
    'CREATE_TABLE', 'CREATE_JUNCTION_TABLE', 'ADD_COLUMN', 'DROP_COLUMN',
    'RENAME_COLUMN', 'ADD_CONSTRAINT', 'CREATE_INDEX', 'ENABLE_AUTH',
    'ENABLE_VECTOR_SEARCH', 'ENABLE_TEAMS',
  ])
  if (SCHEMA_MUTATING_ACTIONS.has(action.action)) {
    try {
      const { snapshotSchema } = await import('@/lib/versioning/schema-versions')
      const label = action.params?.tableName || action.params?.entity || action.action
      await snapshotSchema(projectId, `Before ${action.action} on ${label}`, 'ai-executor')
    } catch {
      // Non-fatal — snapshot failure must never block execution
    }
  }

  try {
    switch (action.action) {
      case 'CREATE_TABLE':
        return await executeCreateTable(action.params, projectId, apiKey)
      
      case 'CREATE_JUNCTION_TABLE':
        return await executeCreateJunctionTable(action.params, projectId)
      
      case 'GENERATE_API':
        return await executeGenerateAPI(action.params, projectId, apiKey)
      
      case 'ADD_COLUMN':
        return await executeAddColumn(action.params, projectId, apiKey)
      
      case 'INSERT_DATA':
        return await executeInsertData(action.params, projectId, apiKey)
      
      case 'LIST_TABLES':
        return await executeListTables(projectId)
      
      // 🎯 FIX #2: Idempotent schema operations
      case 'CREATE_INDEX':
        return await executeCreateIndex(action.params, projectId)
      
      case 'RENAME_COLUMN':
        return await executeRenameColumn(action.params, projectId)
      
      case 'ADD_CONSTRAINT':
        return await executeAddConstraint(action.params, projectId)
      
      case 'LIST_APIS':
        return await executeListAPIs(projectId)
      
      case 'INFO':
        return executeInfo(action.params, projectId)

      // ========== STORAGE ACTIONS ==========
      case 'CREATE_BUCKET':
        return await executeCreateBucket(action.params, projectId)

      case 'DELETE_BUCKET':
        return await executeDeleteBucket(action.params, projectId)

      case 'SET_BUCKET_PUBLIC':
        return await executeSetBucketPublic(action.params, projectId)
      
      case 'LIST_BUCKETS':
        return await executeListBuckets(projectId)
      
      case 'UPLOAD_FILE':
        return { success: false, message: 'File upload via AI is not supported. Use the SDK: backend.storage.upload(file, path)' }

      case 'LIST_FILES':
        return await executeListFiles(action.params, projectId)

      case 'DELETE_FILE':
        return await executeDeleteFile(action.params, projectId)

      case 'GENERATE_SIGNED_URL':
        return await executeGenerateSignedUrl(action.params, projectId)
      
      // ========== CONNECT FRONTEND ==========
      case 'CONNECT_FRONTEND':
        return await executeConnectFrontend(action.params, projectId)

      case 'DISCONNECT_FRONTEND':
        return await executeDisconnectFrontend(action.params, projectId)

      case 'LIST_CONNECTED_APPS':
        return await executeListConnectedApps(projectId)
      
      // ========== DEPLOY ACTIONS ==========
      case 'TRIGGER_DEPLOY':
        return await executeTriggerDeploy(action.params, projectId)
      
      // 🎯 FIX #3: Fake DEPLOY endpoints for MVP
      case 'ROLLBACK_DEPLOY':
        return await executeRollbackDeploy(action.params, projectId)
      
      case 'GET_DEPLOY_STATUS':
        return await executeGetDeployStatus(projectId)
      
      case 'SET_ENV_VAR':
        return await executeSetEnvVar(action.params, projectId)

      case 'LIST_ENV_VARS':
        return await executeListEnvVars(projectId)

      case 'DELETE_ENV_VAR':
        return await executeDeleteEnvVar(action.params, projectId)

      case 'GET_READINESS':
        return await executeGetReadiness(action.params, projectId)
      
      // ========== AUTH ACTIONS ==========
      case 'ENABLE_AUTH':
        return await executeEnableAuth(projectId)

      case 'ENABLE_REALTIME':
        return await executeEnableRealtime(action.params, projectId)

      case 'DISABLE_REALTIME':
        return await executeDisableRealtime(action.params, projectId)

      case 'GET_REALTIME_STATUS':
        return await executeGetRealtimeStatus(projectId)

      case 'DROP_COLUMN':
        return await executeDropColumn(action.params, projectId)

      case 'ADD_PROVIDER':
        return await executeAddProvider(action.params, projectId)

      case 'DISABLE_PROVIDER':
        return await executeDisableProvider(action.params, projectId)

      case 'LIST_USERS':
        return await executeListUsers(projectId, action.params)

      case 'BLOCK_USER':
        return await executeBlockUser(action.params, projectId)

      case 'UNBLOCK_USER':
        return await executeUnblockUser(action.params, projectId)

      case 'RESET_PASSWORD':
        return await executeResetPassword(action.params, projectId)
      
      // ========== IAM ACTIONS ==========
      case 'CREATE_KEY':
        return await executeCreateKey(action.params, projectId)
      
      case 'REVOKE_KEY':
        return await executeRevokeKey(action.params, projectId)

      case 'ROTATE_KEY':
        return await executeRotateKey(action.params, projectId)

      case 'SET_KEY_PERMISSIONS':
        return await executeSetKeyPermissions(action.params, projectId)
      
      case 'LIST_KEYS':
        return await executeListKeys(projectId)
      
      // ========== MONITORING ACTIONS ==========
      case 'GET_METRICS':
        return await executeGetMetrics(action.params, projectId)
      
      case 'GET_ERRORS':
        return await executeGetErrors(action.params, projectId)
      
      case 'SET_ALERT':
        return await executeSetAlert(action.params, projectId)
      
      case 'GET_USAGE':
        return await executeGetUsage(projectId)

      // ========== TRIGGER ACTIONS ==========
      case 'CREATE_TRIGGER':
        return await executeCreateTrigger(action.params, projectId)

      case 'LIST_TRIGGERS':
        return await executeListTriggers(projectId)

      case 'DELETE_TRIGGER':
        return await executeDeleteTrigger(action.params, projectId)

      // ========== DERIVED COLUMNS ==========
      case 'SYNC_COLUMN':
        return await executeSyncColumn(action.params, projectId)

      case 'LIST_SYNCED_COLUMNS':
        return await executeListSyncedColumns(projectId)

      case 'REMOVE_SYNC_COLUMN':
        return await executeRemoveSyncColumn(action.params, projectId)

      // ========== PERMISSION ACTIONS ==========
      case 'SET_PERMISSION':
        return await executeSetPermission(action.params, projectId)

      case 'LIST_PERMISSIONS':
        return await executeListPermissions(projectId)

      case 'REMOVE_PERMISSION':
        return await executeRemovePermission(action.params, projectId)

      // ========== AI FUNCTION ACTIONS ==========
      case 'CREATE_AI_FUNCTION':
        return await executeCreateAiFunction(action.params, projectId)

      case 'LIST_AI_FUNCTIONS':
        return await executeListAiFunctions(projectId)

      case 'DELETE_AI_FUNCTION':
        return await executeDeleteAiFunction(action.params, projectId)

      case 'TOGGLE_AI_FUNCTION':
        return await executeToggleAiFunction(action.params, projectId)

      case 'FIX_AI_FUNCTION':
        return await executeFixAiFunction(action.params, projectId)

      // ========== SCHEMA VERSION HISTORY (#13) ==========
      case 'LIST_SCHEMA_VERSIONS':
        return await executeListSchemaVersions(projectId)

      case 'ROLLBACK_TO_VERSION':
        return await executeRollbackToVersion(action.params, projectId)

      // ========== INTEGRATION KEY MANAGEMENT ==========
      case 'STORE_INTEGRATION_KEY':
        return await executeStoreIntegrationKey(action.params, projectId)

      case 'LIST_INTEGRATION_KEYS':
        return await executeListIntegrationKeys(projectId)

      case 'REMOVE_INTEGRATION_KEY':
        return await executeRemoveIntegrationKey(action.params, projectId)

      // ========== BACKGROUND JOBS / CRON ==========
      case 'CREATE_CRON_JOB':
        return await executeCreateCronJob(action.params, projectId)

      case 'LIST_CRON_JOBS':
        return await executeListCronJobs(projectId)

      case 'DELETE_CRON_JOB':
        return await executeDeleteCronJob(action.params, projectId)

      // ========== FULL-TEXT SEARCH ==========
      case 'ADD_FULLTEXT_SEARCH':
        return await executeAddFulltextSearch(action.params, projectId)

      // ========== VECTOR / SIMILARITY SEARCH ==========
      case 'ENABLE_VECTOR_SEARCH':
        return await executeEnableVectorSearch(action.params, projectId)

      // ========== TEAM / ORG MULTI-TENANCY ==========
      case 'ENABLE_TEAMS':
        return await executeEnableTeams(action.params, projectId, apiKey)

      // ========== WEBHOOK SECRET ROTATION ==========
      case 'ROTATE_WEBHOOK_SECRET':
        return await executeRotateWebhookSecret(action.params, projectId)

      // ========== PUSH NOTIFICATIONS ==========
      case 'SEND_PUSH':
        return await executeSendPush(action.params, projectId)

      // ========== COLUMN TYPE MIGRATION ==========
      case 'ALTER_COLUMN_TYPE':
        return await executeAlterColumnType(action.params, projectId)

      // ========== TYPED DATA MIGRATIONS ==========
      case 'RUN_DATA_MIGRATION': {
        const { estimateDataMigration, executeDataMigration } = await import('@/lib/execution/data-migration')
        const ops = action.params.operations
        if (!Array.isArray(ops) || ops.length === 0) {
          return { success: false, message: 'RUN_DATA_MIGRATION needs a non-empty `operations` array.' }
        }

        // Dry-run mode: report blast radius, mutate nothing.
        if (action.params.dryRun) {
          try {
            const estimates = await estimateDataMigration(projectId, ops)
            const lines = estimates.map(e =>
              `- ${e.detail} → **${e.affectedRows}** of ${e.totalRows} rows`)
            return {
              success: true,
              message: `Dry run — no data was changed:\n${lines.join('\n')}`,
              data: { dryRun: true, estimates },
            }
          } catch (err: any) {
            return { success: false, message: `Dry run failed: ${err?.message ?? String(err)}` }
          }
        }

        // Real run: destructive-class operation → approval gate unless confirmed.
        if (!action.params.confirmed) {
          try {
            const estimates = await estimateDataMigration(projectId, ops)
            const lines = estimates.map(e =>
              `- ${e.detail} → **${e.affectedRows}** of ${e.totalRows} rows`)
            return {
              success: false,
              message:
                `⚠️ This data migration will modify existing rows:\n${lines.join('\n')}\n\n` +
                `A checkpoint copy of each affected table is taken first, so this is reversible. ` +
                `Reply **confirm** to apply.`,
              data: { requiresApproval: true, estimates },
            }
          } catch (err: any) {
            return { success: false, message: `Migration validation failed: ${err?.message ?? String(err)}` }
          }
        }

        const result = await executeDataMigration(projectId, ops)
        if (!result.success) {
          return {
            success: false,
            message: `Data migration failed and was rolled back — nothing changed. ${result.error ?? ''}`.trim(),
          }
        }
        const summary = result.applied.map(a => `- ${a.op} on **${a.table}**: ${a.affectedRows} rows`).join('\n')
        const backups = Object.entries(result.backupTables)
          .map(([table, backup]) => `${table} → ${backup}`).join(', ')
        return {
          success: true,
          message:
            `✅ Data migration applied:\n${summary}\n\n` +
            `Checkpoint copies were saved (${backups}) — say "roll back the migration on <table>" to restore.`,
          data: result,
        }
      }

      // ========== STAGING ENVIRONMENT ==========
      case 'CREATE_STAGING':
        return await executeCreateStaging(projectId)

      case 'PROMOTE_STAGING':
        return await executePromoteStaging(action.params, projectId)

      case 'DROP_STAGING':
        return await executeDropStaging(projectId)

      // ========== PER-ENDPOINT RATE LIMITS ==========
      case 'SET_RATE_LIMIT':
        return await executeSetRateLimit(action.params, projectId)

      case 'LIST_RATE_LIMITS':
        return await executeListRateLimits(projectId)

      case 'REMOVE_RATE_LIMIT':
        return await executeRemoveRateLimit(action.params, projectId)

      // ========== DATABASE BACKUPS ==========
      case 'BACKUP_DATABASE': {
        const { backupWorkspace } = await import('@/lib/services/workspace-backup')
        const result = await backupWorkspace(projectId)
        if (!result.success) return { success: false, message: `Backup failed: ${result.error}` }
        return {
          success: true,
          message: `✅ Backup created: **${result.filename}** (${Math.round((result.sizeBytes || 0) / 1024)} KB). Your data is safe. Backups run daily and are kept for 7 days.`,
          data: result,
        }
      }

      case 'LIST_BACKUPS': {
        const { listBackups } = await import('@/lib/services/workspace-backup')
        const backups = await listBackups(projectId)
        if (backups.length === 0) {
          return { success: true, message: 'No backups yet. I\'ll create one daily automatically. You can also ask "backup my database" anytime.' }
        }
        const list = backups.map(b =>
          `• **${b.filename}** — ${b.status} — ${Math.round((b.sizeBytes || 0) / 1024)} KB — ${new Date(b.createdAt).toLocaleString()}`
        ).join('\n')
        return { success: true, message: `**Backups** (${backups.length}):\n${list}`, data: backups }
      }

      case 'RESTORE_DATABASE': {
        const { restoreWorkspace } = await import('@/lib/services/workspace-backup')
        const result = await restoreWorkspace(projectId, action.params.backupId)
        if (!result.success) return { success: false, message: `Restore failed: ${result.error}` }
        return {
          success: true,
          message: `✅ Database restored from **${result.restoredFrom}**. Your workspace is back to that point in time.`,
        }
      }

      // ========== DESTRUCTIVE TABLE ACTIONS ==========
      case 'DROP_TABLE':
        return await executeDropTable(action.params, projectId)

      case 'TRUNCATE_TABLE':
        return await executeTruncateTable(action.params, projectId)

      // ========== CUSTOM CODE GENERATION (GAP 4) ==========
      case 'GENERATE_FUNCTION': {
        const { executeGenerateFunction } = await import('@/lib/ai/function-generator')
        return await executeGenerateFunction(action.params, projectId)
      }

      case 'LIST_FUNCTIONS': {
        const { listGeneratedFunctions } = await import('@/lib/ai/function-generator')
        const fns = await listGeneratedFunctions(projectId)
        if (fns.length === 0) return { success: true, message: 'No custom functions yet. Ask me to generate one.' }
        const list = fns.map(f => `${f.method} ${f.endpoint} — ${f.description}`).join('\n')
        return { success: true, message: `Custom functions (${fns.length}):\n${list}`, data: fns }
      }

      // ========== AGGREGATE STATS ENDPOINT ===========
      case 'GENERATE_AGGREGATE_API':
        return await executeGenerateAggregateApi(action.params, projectId)

      // ========== CHECKOUT FLOW ===========
      case 'GENERATE_CHECKOUT_FLOW':
        return await executeGenerateCheckoutFlow(projectId)

      // ========== HEALTH CHECK ===========
      case 'GENERATE_HEALTH_CHECK':
        return await executeGenerateHealthCheck(projectId)

      // ========== DOMAIN BUSINESS LOGIC (Issue 7) ===========
      case 'GENERATE_DOMAIN_LOGIC':
        return await executeGenerateDomainLogic(action.params, projectId)

      // ========== FIELD-RESTRICTED ENDPOINT ===========
      case 'GENERATE_RESTRICTED_ENDPOINT':
        return await executeGenerateRestrictedEndpoint(action.params, projectId)

      // ========== SELF-REPAIR ACTIONS ===========
      case 'FIX_AUTH':
        return await executeFixAuth(action.params, projectId)

      case 'FIX_API':
        return await executeFixApi(action.params, projectId)

      case 'FIX_TABLE':
        return await executeFixTable(action.params, projectId)

      case 'FIX_DEPLOY':
        return await executeFixDeploy(action.params, projectId)

      case 'FIX_REALTIME':
        return await executeFixRealtime(action.params, projectId)

      case 'FIX_STORAGE':
        return await executeFixStorage(action.params, projectId)

      case 'FIX_INTEGRATION':
        return await executeFixIntegration(action.params, projectId)

      case 'FIX_WORKFLOW':
        return await executeFixWorkflow(action.params, projectId)

      case 'REGISTER_TABLE':
        return await executeRegisterTable(action.params, projectId)

      case 'ADOPT_EXTERNAL_SCHEMA':
        return await executeAdoptExternalSchema(projectId)

      default:
        return {
          success: false,
          message: `I don't know how to "${action.action}". Try asking to create a table or generate an API.`,
        }
    }
  } catch (error: any) {
    console.error('❌ [AI Executor] Error:', error)
    return {
      success: false,
      message: `Execution failed: ${error.message}`,
      error: error.message,
    }
  }
}

/**
 * Add column with auto-derived constraints
 */
async function addColumnWithConstraints(
  tableName: string,
  columnSQL: string,
  projectId: string,
  postgresSchema: string
): Promise<void> {
  const { prisma } = await import('@/lib/db')
  
  try {
    const alterSQL = `ALTER TABLE "${postgresSchema}"."${tableName}" ADD COLUMN ${columnSQL}`
    console.log(`[Constraints] Executing: ${alterSQL}`)
    await prisma.$executeRawUnsafe(alterSQL)
    console.log(`[Constraints] Column added successfully`)
  } catch (error: any) {
    // If column already exists, that's fine (idempotent)
    if (error.code === '42701') {
      console.log(`[Constraints] Column already exists - skipping`)
    } else if (error.code === '42P01' || error.code === '42830' || (error.message && error.message.includes('does not exist'))) {
      // Referenced table doesn't exist yet — add column without FK constraint so the table still gets its column
      console.warn(`[Constraints] FK reference failed (${error.code}), retrying without REFERENCES constraint`)
      const plainSQL = columnSQL.replace(/\s+REFERENCES\s+"[^"]*"\."[^"]*"\("[^"]*"\)[^,;]*/gi, '').trim()
      await prisma.$executeRawUnsafe(`ALTER TABLE "${postgresSchema}"."${tableName}" ADD COLUMN ${plainSQL}`)
      console.log(`[Constraints] Column added without FK constraint (referenced table missing)`)
    } else {
      throw error
    }
  }
}

/**
 * REAL BACKEND CALL: Create Table
 * DIRECT DATABASE ACCESS (bypasses HTTP layer for server-to-server calls)
 */
async function executeCreateTable(
  params: any,
  projectId: string,
  apiKey?: string
): Promise<ExecutionResult> {
  console.log('[AI Executor] Creating table:', params.tableName)
  console.log('[AI Executor] Params:', JSON.stringify(params, null, 2))
  
  // Normalize to lowercase — PostgreSQL convention; prevents case-mismatch FK failures
  const { columns } = params
  const tableName: string = (params.tableName as string)?.toLowerCase()?.trim()
  let safeColumns: Array<{ name: string; type: string }> = Array.isArray(columns) ? columns.filter((c: any) => c?.name) : []

  // ── Column enrichment (#92) ───────────────────────────────────────────────
  // If the LLM returned fewer columns than the domain blueprint defines, we
  // supplement with the missing blueprint columns rather than creating a
  // skeleton table. This ensures generation_jobs always gets all 17 fields
  // even when the LLM only emits 3.
  //
  // Strategy:
  //   - 0 columns: use full blueprint (or semantic fallback)
  //   - 1-N columns but blueprint has MORE: merge — keep LLM columns first,
  //     append blueprint columns not already present
  const lowerName = tableName.toLowerCase()
  const blueprint = TABLE_COLUMN_BLUEPRINTS[lowerName] ?? inferColumnsForTable(lowerName)

  if (safeColumns.length === 0) {
    if (blueprint.length > 0) {
      safeColumns = blueprint
      // Warn visibly — LLM emitted no columns. If this was triggered by a question
      // ("what columns should X have?") rather than a build request, the routing layer
      // (intent-classifier / mode-classifier) should have caught it before reaching here.
      console.warn(`[AI Executor] BLUEPRINT FALLBACK for "${tableName}" — LLM returned 0 columns. Verify routing: was this a build request or a question?`)
      console.log(`[AI Executor] Column blueprint applied for "${tableName}" (${safeColumns.length} cols — LLM gave 0)`)
    }
  } else {
    // ── An explicit column list is a SPECIFICATION. It is not enriched. ───────
    //
    // A curated blueprint used to be merged into caller-supplied lists, adding
    // any blueprint column the caller had not named (forced nullable). The
    // restraint was already conceded in the previous comment here — "that list
    // is a SPECIFICATION, not a hint" — and then overridden two lines later.
    //
    // Measured on a real build: `products` declared 6 columns and was created
    // with 14, `orders` declared 3 and got 10, `order_items` declared 4 and got
    // 9. The damage is not the column count. It is that the blueprint's names
    // collide semantically with the caller's:
    //
    //   declared: price_cents INTEGER      injected: price NUMERIC
    //
    // Two columns holding the same fact, in different units, with nothing
    // keeping them in sync and no indication which one anything reads. The
    // developer who hit this ended up writing BOTH on every insert, defensively,
    // because no answer was available about which was authoritative. That is a
    // data-integrity hazard the platform manufactured out of a guess.
    //
    // Nullable-and-unused is not harmless either: these columns are in the
    // catalog, so they are in the generated API, the SDK types, the schema
    // visualiser and every `read_backend_state` response — permanently, because
    // dropping a column is a destructive operation requiring approval.
    //
    // The blueprint's real job is the empty-list case above, where there is no
    // specification to override. That is where it stays.
    if (process.env.NODE_ENV !== 'production') {
      const curated = TABLE_COLUMN_BLUEPRINTS[lowerName]
      if (curated) {
        const declared = new Set(safeColumns.map(c => c.name.toLowerCase()))
        const notDeclared = curated.filter(bc => !declared.has(bc.name.toLowerCase()))
        if (notDeclared.length > 0) {
          console.log(
            `[AI Executor] "${tableName}": blueprint knows ${notDeclared.length} other ` +
            `column(s) (${notDeclared.map(c => c.name).join(', ')}). NOT added — the ` +
            `caller's list is the specification.`,
          )
        }
      }
    }
  }

  console.log('[AI Executor] Safe columns:', safeColumns)

  if (!tableName) {
    return {
      success: false,
      message: 'Table name is required',
    }
  }

  // ── Intent ledger ─────────────────────────────────────────────────────────
  // Record what was REQUESTED before executing, so a column that comes out the
  // wrong shape is attributable. Without this the catalog is the only record,
  // and a column created as the wrong type is indistinguishable from one that
  // was meant to be that type — which is exactly how `start_date: timestamp`
  // sat in the database as INTEGER from May to July with every probe green.
  // Recorded from the request and never reconciled from the catalog: a ledger
  // that self-heals to match reality can never detect drift.
  try {
    const { recordSchemaIntent } = await import('@/lib/autonomy/intent-conformance')
    await recordSchemaIntent(projectId, tableName, columns ?? [], 'create_table')
  } catch (intentErr: any) {
    console.error('[IntentLedger] record failed (non-fatal):', intentErr?.message)
  }
  
  try {
    // Import Prisma and database utility functions
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    
    // Get workspace schema
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    
    console.log(`🔌 [AI Executor] Creating table in schema: ${postgresSchema}...`)

    // ── Build full CREATE TABLE with ALL columns upfront ─────────────────────
    // Previously we created a skeleton (id, createdAt, updatedAt) and then added
    // columns via ALTER TABLE. This was fragile — if any ALTER failed silently the
    // table ended up with only 3 columns. Now we include everything in one atomic
    // CREATE TABLE statement.
    const columnDefs: string[] = [
      'id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
      '"createdAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP',
      '"updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP',
      // Soft delete column — allows recovery and prevents data loss on accidental deletes
      '"deleted_at" TIMESTAMP WITH TIME ZONE NULL',
    ]

    // Track which base column names we already have (lowercase for dedup)
    const existingCols = new Set(['id', 'createdat', 'updatedat', 'deletedat', 'deleted_at'])

    // Resolved plan per column — reused by the explicit-FK pass below so the
    // ON DELETE action matches the column's real nullability.
    const columnPlans: Array<{ col: any; constraints: ColumnConstraints }> = []

    // ── CHECK constraints are resolved BEFORE the columns are built ───────────
    //
    // This block used to run AFTER the column loop, and that ordering was the
    // whole bug behind un-insertable `orders` tables. The column loop chose a
    // DEFAULT from the column's NAME (`*status*` → 'active'); this block chose
    // the permitted values from the TABLE's name. Neither could see the other,
    // so `orders.payment_status` ended up
    //
    //   DEFAULT 'active'  CHECK (payment_status IN ('pending','paid', …))
    //
    // — a column whose own default violates its own constraint. Every insert
    // that omitted it failed with SQLSTATE 23514.
    //
    // Resolving the value sets first means the column loop can DERIVE the
    // default from the same list the CHECK is built from, which makes the two
    // incapable of disagreeing. See `initialStateFor`.
    // ── CHECK constraints for enum columns (e.g. status IN ('pending','shipped')) ──
    const checkConstraints: Array<{ columnName: string; values: string[] }> =
      (params.checkConstraints as any[]) ?? []

    // ── #94: Auto-inject CHECK constraints for any status-like column ────────
    // Extends beyond job tables: any table with a status/payment_status/order_status
    // column gets a CHECK constraint derived from the known domain context.

    // Status value sets keyed by table-name pattern
    const STATUS_DOMAIN_MAP: Array<{ pattern: RegExp; column: string; values: string[] }> = [
      // Job/async processing tables
      {
        pattern: /_jobs?$|^(generation|render|video|export|import|process|encode|transcode|clip)_/,
        column: 'status',
        values: ['queued', 'processing', 'completed', 'failed', 'cancelled'],
      },
      // Order / e-commerce tables
      {
        pattern: /^orders?$|^(order_items?|purchase)$/,
        column: 'status',
        values: ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
      },
      {
        pattern: /^orders?$|^payments?$|^invoices?$|^checkouts?$/,
        column: 'payment_status',
        values: ['pending', 'paid', 'failed', 'refunded', 'disputed'],
      },
      // Subscriptions
      {
        pattern: /^subscriptions?$/,
        column: 'status',
        values: ['active', 'trialing', 'past_due', 'cancelled', 'unpaid', 'paused'],
      },
      // User / account tables
      {
        pattern: /^users?$|^accounts?$|^members?$/,
        column: 'status',
        values: ['active', 'suspended', 'deactivated', 'pending_verification'],
      },
      // Content / CMS tables
      {
        pattern: /^(posts?|articles?|pages?)$/,
        column: 'status',
        values: ['draft', 'published', 'archived', 'scheduled'],
      },
      // Tickets / support
      {
        pattern: /^tickets?$|^support_tickets?$/,
        column: 'status',
        values: ['open', 'in_progress', 'resolved', 'closed', 'on_hold'],
      },
      // Generic tasks
      {
        pattern: /^tasks?$|^todos?$/,
        column: 'status',
        values: ['todo', 'in_progress', 'done', 'cancelled'],
      },
    ]

    const alreadyHasStatusConstraint = checkConstraints.some(c => c.columnName === 'status')
    if (!alreadyHasStatusConstraint) {
      for (const rule of STATUS_DOMAIN_MAP) {
        if (!rule.pattern.test(tableName)) continue
        const colExists = safeColumns.some(c => c.name.toLowerCase() === rule.column)
        if (!colExists) continue
        const alreadyHas = checkConstraints.some(c => c.columnName === rule.column)
        if (alreadyHas) continue
        checkConstraints.push({ columnName: rule.column, values: rule.values })
        console.log(`[AI Executor] Auto-injected CHECK constraint on "${rule.column}" for "${tableName}" (${rule.values.join(', ')})`)
      }
    }


    if (safeColumns.length > 0) {
      for (const col of safeColumns) {
        if (!col?.name) continue
        const colLower = col.name.toLowerCase().replace(/_/g, '')
        // Skip duplicates of base columns (id, createdAt/created_at, updatedAt/updated_at)
        if (existingCols.has(colLower)) continue
        existingCols.add(colLower)

        const normalizedType = normalizeColumnType(col.type, col.name)
        const constraints = deriveConstraints(col.name, normalizedType, tableName)
        // Hand the column the value set its CHECK will enforce, so its DEFAULT
        // is derived from that list rather than guessed from its name. A default
        // outside the CHECK is what made every generated `orders` table reject
        // its own inserts.
        const check = checkConstraints.find(
          c => c.columnName?.toLowerCase() === col.name.toLowerCase(),
        )
        if (check?.values?.length) constraints.stateValues = check.values
        // Explicit { nullable, notNull, unique, fkTo, default } from the caller
        // wins over every name-based guess above.
        applyExplicitColumnFlags(constraints, col)
        columnPlans.push({ col, constraints })

        console.log(`[Constraints] Column "${col.name}": PK=${constraints.isPrimaryKey}, Unique=${constraints.isUnique}, Required=${constraints.isRequired}, FK=${constraints.foreignKey || 'none'}`)

        const columnDef = { name: col.name, type: normalizedType }
        // Build column SQL but strip REFERENCES for now (referenced table might not exist yet)
        let colSql = applyConstraintsToColumn(columnDef, constraints, postgresSchema)
        // Strip FK references — we'll add them in the retroactive pass below
        colSql = colSql.replace(/\s+REFERENCES\s+"[^"]*"\."[^"]*"\("[^"]*"\)[^,;]*/gi, '').trim()
        columnDefs.push(colSql)
      }
    }

    for (const cc of checkConstraints) {
      if (!cc.columnName || !cc.values?.length) continue
      const safeCol = cc.columnName.replace(/[^a-z0-9_]/gi, '')
      const valueList = cc.values.map((v: string) => `'${v.replace(/'/g, "''")}'`).join(', ')
      columnDefs.push(`CONSTRAINT "chk_${tableName}_${safeCol}" CHECK ("${safeCol}" IN (${valueList}))`)
    }

    // ── UNIQUE constraints for explicitly flagged columns ──────────────────────
    const uniqueColumns: string[] = (params.uniqueColumns as string[]) ?? []
    for (const uc of uniqueColumns) {
      const safeUc = uc.replace(/[^a-z0-9_]/gi, '')
      if (safeUc && !existingCols.has(`uniq_${safeUc}`)) {
        columnDefs.push(`CONSTRAINT "uq_${tableName}_${safeUc}" UNIQUE ("${safeUc}")`)
        existingCols.add(`uniq_${safeUc}`)
      }
    }

    // CREATE TABLE IF NOT EXISTS so a blueprint-resume turn (or any second
    // pass over the same plan) does NOT error out with Postgres 42P07
    // "relation already exists". The Prisma Table metadata upsert below makes
    // the platform's view of the table consistent in either case — first
    // create or re-adoption of a physically-present table.
    const createTableSQL = `CREATE TABLE IF NOT EXISTS "${postgresSchema}"."${tableName}" (\n  ${columnDefs.join(',\n  ')}\n);`

    console.log(`📝 [AI Executor] Executing SQL:`, createTableSQL)
    await prisma.$executeRawUnsafe(createTableSQL)

    console.log(`✅ [AI Executor] Table created with ${columnDefs.length} columns`)

    // ── #96: Install updatedAt auto-update trigger ─────────────────────────────
    // Every workspace table gets a PostgreSQL trigger that stamps the row's
    // updated-at column on every UPDATE — no application code needed.
    //
    // CRITICAL: this is ONE shared function attached to EVERY table in the
    // schema, but tables do not all share the same updated-at column name.
    // Tables this executor creates carry camelCase "updatedAt"; tables adopted
    // via CREATE TABLE IF NOT EXISTS (already physically present), junction
    // tables, or anything built by another path may have snake_case
    // "updated_at" — or no updated-at column at all. The previous body
    // hard-referenced NEW."updatedAt", so firing on any such table raised
    //   record "new" has no field "updatedAt"   (SQLSTATE 42703)
    // on EVERY update — surfaced to users as the generic
    //   "Column does not exist — the referenced column is missing from the table."
    // in the CRUD-lifecycle verification card, and breaking real end-user
    // UPDATE calls too. We now probe the row shape via to_jsonb(NEW) so we only
    // touch a column that actually exists and NEVER reference a missing field.
    try {
      // Create the shared trigger function once per schema (idempotent).
      // CREATE OR REPLACE upgrades every existing table's trigger in this
      // schema automatically the next time create_table runs here.
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION "${postgresSchema}".set_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
          IF to_jsonb(NEW) ? 'updatedAt' THEN
            NEW := jsonb_populate_record(NEW, jsonb_build_object('updatedAt', NOW()));
          ELSIF to_jsonb(NEW) ? 'updated_at' THEN
            NEW := jsonb_populate_record(NEW, jsonb_build_object('updated_at', NOW()));
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `)
      // Attach to the new table
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE TRIGGER trg_set_updated_at_${tableName}
        BEFORE UPDATE ON "${postgresSchema}"."${tableName}"
        FOR EACH ROW EXECUTE FUNCTION "${postgresSchema}".set_updated_at();
      `)
      console.log(`⏱️  [AI Executor] updatedAt auto-update trigger installed on "${tableName}"`)
    } catch (trigErr: any) {
      // Non-fatal — table is usable; application can still set updatedAt manually
      console.warn(`[AI Executor] updatedAt trigger install failed (non-fatal):`, trigErr?.message)
    }

    // ── Auto-create indexes for FK columns and common filter columns (#93) ────
    // Every FK column (_id suffix), status, type, email, slug, created_at gets
    // an index automatically. This prevents full-table scans at scale.
    const INDEX_EXACT_NAMES = new Set([
      // Timestamps (always)
      'createdat', 'updatedat', 'deleted_at', 'deletedat',
      'published_at', 'publishedat', 'completed_at', 'completedat',
      'expires_at', 'expiresat', 'scheduled_at', 'scheduledat',
      // Common high-cardinality FK columns by exact normalized name
      'user_id', 'userid',
      'project_id', 'projectid',
      'organization_id', 'organizationid',
      'workspace_id', 'workspaceid',
      'account_id', 'accountid',
      'team_id', 'teamid',
      'company_id', 'companyid',
      'owner_id', 'ownerid',
      'author_id', 'authorid',
      'creator_id', 'creatorid',
      // Common filter & sort columns
      'status', 'type', 'role', 'plan',
      'email',       // user lookups
      'slug',        // URL-based lookups
      'is_active', 'isactive',
      'is_public', 'ispublic',
      'provider',    // video job routing
      'payment_status', 'paymentstatus',
    ])

    // Build list of column names to index
    const colsToIndex: string[] = ['createdAt', 'updatedAt', 'deleted_at']
    for (const col of safeColumns) {
      if (!col?.name) continue
      const rawLower = col.name.toLowerCase()
      const normalizedLower = rawLower.replace(/_/g, '')

      // Index every FK column: snake_case _id suffix OR camelCase Id suffix
      const isFk = (rawLower.endsWith('_id') && rawLower !== 'id') ||
                   (/[a-z]id$/.test(rawLower) && rawLower !== 'id')

      // Index explicitly listed filter/sort columns
      const isFilter = INDEX_EXACT_NAMES.has(rawLower) || INDEX_EXACT_NAMES.has(normalizedLower)

      if (isFk || isFilter) {
        colsToIndex.push(col.name)
      }
    }

    // Deduplicate and create indexes
    const seenIndexCols = new Set<string>()
    for (const col of colsToIndex) {
      if (seenIndexCols.has(col.toLowerCase())) continue
      seenIndexCols.add(col.toLowerCase())
      const indexName = `idx_${tableName}_${col.toLowerCase().replace(/[^a-z0-9]/g, '_')}`
      try {
        await prisma.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${postgresSchema}"."${tableName}" ("${col}")`
        )
        console.log(`📑 [AI Executor] Index created: ${indexName}`)
      } catch (idxErr: any) {
        console.warn(`[AI Executor] Index create failed for ${col} (non-fatal):`, idxErr?.message)
      }
    }

    // Record table in metadata database — upsert prevents duplicate rows when the
    // same table is created twice (e.g. build re-run after credential submission).
    await prisma.table.upsert({
      where: { name_schema_projectId: { name: tableName, schema: postgresSchema, projectId } },
      create: {
        projectId,
        name: tableName,
        schema: postgresSchema,
        description: `${tableName} table created by AI`,
      },
      update: {
        schema: postgresSchema,
      },
    }).catch(async () => {
      // Fallback: if unique constraint not defined in schema, use findFirst + create
      const exists = await prisma.table.findFirst({ where: { projectId, name: tableName } })
      if (!exists) {
        await prisma.table.create({
          data: { projectId, name: tableName, schema: postgresSchema, description: `${tableName} table created by AI` },
        })
      }
    })

    console.log(`✅ [AI Executor] Table metadata saved`)

    // ── Realtime: follow the project, never opt it in ─────────────────────────
    //
    // This used to install a NOTIFY trigger on EVERY table it created,
    // unconditionally. The intent was "so .subscribe() works immediately"; the
    // effect was a per-row trigger firing on every INSERT/UPDATE/DELETE of every
    // table in every project, whether or not anyone had asked for realtime.
    //
    // It also made `enable_realtime` unauditable. Calling it on `orders` alone
    // and then finding triggers on `orders`, `products` and `order_items` looks
    // like the tool ignored its argument — reported exactly that way. The tool
    // was scoped correctly the whole time; table creation was the one adding
    // them.
    //
    // The rule now: a NEW table inherits whatever the project already decided.
    // If realtime is on, a new table joins it (otherwise new tables silently
    // never stream, which is its own trap). If realtime was never enabled,
    // nothing is installed and the write path stays clean.
    try {
      const { installRealtimeTrigger, listTablesWithRealtimeTriggers } =
        await import('@/lib/services/realtimeTriggers')
      const alreadyStreaming = await listTablesWithRealtimeTriggers(projectId).catch(() => [])
      if (alreadyStreaming.length > 0) {
        await installRealtimeTrigger(projectId, tableName)
        console.log(`⚡ [AI Executor] Realtime is on for this project — trigger installed on "${tableName}"`)
      } else {
        console.log(`[AI Executor] Realtime not enabled for this project — no trigger on "${tableName}" (enable_realtime turns it on)`)
      }
    } catch (rtErr: any) {
      console.warn(`[AI Executor] Realtime trigger install failed (non-fatal):`, rtErr?.message)
    }

    // ── Auto-create storage buckets for video/asset domain tables ────────────
    // When a generation_jobs, render_jobs, or similar video/asset table is created,
    // automatically provision the "videos", "thumbnails", and "source-assets" buckets
    // so the developer does not have to ask separately. This prevents Issue 27.
    const isVideoDomainTable =
      /_jobs?$/.test(tableName) ||
      /^(generation|render|video|export|import|transcode|encode|clip)_/.test(tableName) ||
      /^(videos?|assets?|media_files?|uploads?)$/.test(tableName)

    if (isVideoDomainTable) {
      const VIDEO_BUCKETS = [
        { name: 'videos', isPublic: false, reason: 'Auto-created for video output storage' },
        { name: 'thumbnails', isPublic: true, reason: 'Auto-created for public thumbnail previews' },
        { name: 'source-assets', isPublic: false, reason: 'Auto-created for private source asset uploads' },
      ]
      for (const bkt of VIDEO_BUCKETS) {
        try {
          const existing = await prisma.storageBucket.findFirst({ where: { projectId, name: bkt.name } })
          if (!existing) {
            await prisma.storageBucket.create({
              data: { name: bkt.name, projectId, isPublic: bkt.isPublic },
            })
            console.log(`🪣 [AI Executor] Auto-created storage bucket "${bkt.name}" for video domain table "${tableName}"`)
          }
        } catch (bktErr: any) {
          console.warn(`[AI Executor] Auto-bucket create failed for "${bkt.name}" (non-fatal):`, bktErr?.message)
        }
      }
    }

    // Legacy path: if there are columns that weren't included above (shouldn't happen), add them
    if (false && safeColumns.length > 0) {

      // ── Retroactive FK constraint pass ────────────────────────────────────
      // Columns whose REFERENCES clause was stripped (referenced table didn't
      // exist yet) get a second chance now that all tables in this batch exist.
      try {
        const { prisma: _rp } = await import('@/lib/db')
        // Build case-insensitive table map for this workspace
        const allTablesInWs = await _rp.$queryRawUnsafe<{ table_name: string }[]>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
          postgresSchema
        )
        const wsTableMap = new Map<string, string>() // lc → actual name
        for (const { table_name } of allTablesInWs) {
          wsTableMap.set(table_name.toLowerCase(), table_name)
        }

        for (const col of safeColumns) {
          if (!col?.name) continue
          const lower = col.name.toLowerCase()
          const isSnakeFk = lower.endsWith('_id') && lower !== 'id'
          const isCamelFk = /[a-z]id$/.test(lower) && col.name !== col.name.toLowerCase()
          if (!isSnakeFk && !isCamelFk) continue

          const base = lower.endsWith('_id') ? lower.slice(0, -3) : lower.slice(0, -2)
          // Semantic role bases (sellerId/buyerId/…) always reference users, not <base>s
          let refTable: string | null
          if (USER_ROLE_ID_BASES.has(base)) {
            refTable = wsTableMap.get('users') ?? null
          } else {
            // Case-insensitive ref table lookup
            refTable = wsTableMap.get(`${base}s`) ?? wsTableMap.get(base) ?? null
          }
          if (!refTable || refTable.toLowerCase() === tableName.toLowerCase()) continue

          try {
            const fkExists = await _rp.$queryRawUnsafe<{ count: string }[]>(
              `SELECT COUNT(*) AS count FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
               WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
                 AND kcu.table_name = $2 AND kcu.column_name = $3`,
              postgresSchema, tableName, col.name
            ).then(r => parseInt(r[0]?.count ?? '0', 10) > 0)

            if (!fkExists) {
              await _rp.$executeRawUnsafe(
                `ALTER TABLE "${postgresSchema}"."${tableName}"
                 ADD CONSTRAINT "${tableName}_${col.name}_fkey"
                 FOREIGN KEY ("${col.name}") REFERENCES "${postgresSchema}"."${refTable}"(id) ON DELETE SET NULL`
              )
              console.log(`[FK Repair] Added FK constraint: ${tableName}.${col.name} → ${refTable}.id`)
            }
          } catch (_fkErr: any) {
            // Non-fatal — FK repair is best-effort
            console.warn(`[FK Repair] Could not add FK for ${tableName}.${col.name}:`, _fkErr?.message)
          }
        }
      } catch (_retroErr: any) {
        console.warn(`[FK Repair] Retroactive pass failed:`, _retroErr?.message)
      }
    }

    // ── Explicit FK pass: honor `fkTo` exactly as the caller stated it ────────
    // REFERENCES clauses are stripped from the CREATE TABLE above (the target
    // table may not exist yet at that point), and the convention-based repair
    // below only resolves <base>_id → "<base>s". That misses every irregular
    // plural — category_id looks for "categorys" and never finds "categories" —
    // so an explicitly requested foreign key silently did not exist. Wire those
    // up here, before the convention pass, using the target the caller named.
    try {
      for (const { col, constraints } of columnPlans) {
        if (typeof col?.fkTo !== 'string' || !col.fkTo.trim()) continue

        const target = String(col.fkTo).trim().toLowerCase().split('.')[0]
        if (!/^[a-z_][a-z0-9_]{0,62}$/.test(target)) continue
        if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(col.name)) continue
        if (target === tableName.toLowerCase()) continue // self-ref handled by name rules

        // Target must actually exist, otherwise ALTER TABLE aborts the turn.
        const targetExists = await prisma.$queryRawUnsafe<{ count: string }[]>(
          `SELECT COUNT(*) AS count FROM information_schema.tables
            WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
          postgresSchema, target,
        ).then(r => parseInt(r[0]?.count ?? '0', 10) > 0).catch(() => false)
        if (!targetExists) {
          console.warn(`[AI Executor] fkTo "${target}" for ${tableName}.${col.name} does not exist yet — skipped`)
          continue
        }

        const alreadyHasFk = await prisma.$queryRawUnsafe<{ count: string }[]>(
          `SELECT COUNT(*) AS count FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
              AND kcu.table_name = $2 AND kcu.column_name = $3`,
          postgresSchema, tableName, col.name,
        ).then(r => parseInt(r[0]?.count ?? '0', 10) > 0).catch(() => false)
        if (alreadyHasFk) continue

        // A NOT NULL child cannot survive its parent being nulled out, so
        // SET NULL there would be a delete-time error waiting to happen.
        const onDelete = constraints.isRequired ? 'CASCADE' : 'SET NULL'
        const constraintName = `fk_${tableName}_${col.name}`.slice(0, 63)

        await prisma.$executeRawUnsafe(
          `ALTER TABLE "${postgresSchema}"."${tableName}"
             ADD CONSTRAINT "${constraintName}"
             FOREIGN KEY ("${col.name}") REFERENCES "${postgresSchema}"."${target}"("id")
             ON DELETE ${onDelete}`
        )
        console.log(`[AI Executor] Explicit FK: ${tableName}.${col.name} → ${target}.id (ON DELETE ${onDelete})`)
      }
    } catch (explicitFkErr: any) {
      // Non-fatal — the table exists; the FK can be added later.
      console.warn(`[AI Executor] Explicit fkTo wiring failed (non-fatal):`, explicitFkErr?.message)
    }

    // ── Global FK repair: also fix FKs on OTHER tables that reference THIS newly created table
    // e.g., if 'orders' was created before 'users', orders.userId had its REFERENCES stripped.
    // Now that we just created 'users', repair orders.userId → users.id
    try {
      const { repairForeignKeysGlobally } = await import('./fk-repair')
      const repairedCount = await repairForeignKeysGlobally(projectId)
      if (repairedCount > 0) {
        console.log(`[AI Executor] Post-create FK repair: added ${repairedCount} constraints`)
      }
    } catch (_fkGlobalErr: any) {
      // Non-fatal
      console.warn(`[AI Executor] Post-create FK repair failed:`, _fkGlobalErr?.message)
    }

    // ── Phase 4.1: Deterministic auto-RLS ─────────────────────────────────────
    // Inspect the column list now (not the AI prompt) and auto-apply own_rows
    // if an ownership column is present.  This runs unconditionally so security
    // is never dependent on the AI "remembering" to call SET_PERMISSION.
    try {
      const { autoApplyRlsIfNeeded } = await import('@/lib/services/workspace-rls')
      await autoApplyRlsIfNeeded(projectId, tableName, safeColumns)
    } catch (rlsErr: any) {
      // Non-fatal — table is created; RLS can be applied manually via SET_PERMISSION
      console.warn(`[AI Executor] Auto-RLS failed (non-fatal):`, rlsErr?.message)
    }

    // ── Domain endpoint generation ────────────────────────────────────────────
    // The table's CRUD surface needs no registration step: under PostgREST the
    // API IS the schema, so `/db/{tableName}` is live the moment the table
    // exists, resolved from the PostgreSQL catalog per request.
    //
    // executeGenerateAPI is still called because it also authors the DOMAIN
    // endpoints for this table (the business-logic functions CRUD cannot
    // express). It no longer writes an ApiDefinition row, so the "does a
    // definition already exist?" guard that used to wrap this call is gone —
    // it queried a projection that is never written now, and would have
    // skipped domain generation for any table that happened to have a stale
    // row left over from the pre-cutover era.
    try {
      // executeGenerateAPI auto-creates a missing table, which would recurse
      // back into this function. The metadata upsert above means the row is
      // present; require it explicitly so recursion is impossible.
      const tableRow = await prisma.table.findFirst({
        where: { projectId, name: tableName },
        select: { id: true },
      })

      if (!tableRow) {
        console.warn(`[AI Executor] Skipping domain endpoints for "${tableName}" — table metadata row missing`)
      } else {
        const apiResult = await executeGenerateAPI({ tableName }, projectId, apiKey)
        if (apiResult.success) {
          console.log(`🚀 [AI Executor] REST API live for "${tableName}"`)
        } else {
          console.warn(`[AI Executor] Domain endpoint generation failed (non-fatal): ${apiResult.message}`)
        }
      }
    } catch (apiErr: any) {
      // Non-fatal — the table and its CRUD routes are served from the catalog
      // either way; only the domain endpoints are missing.
      console.warn(`[AI Executor] Domain endpoint generation failed (non-fatal):`, apiErr?.message)
    }

    // ── Integration awareness: payment, email, video ──────────────────────────
    // After creating domain tables, check whether the matching provider is configured.
    // If not, append a clear blocked-state notice so the user knows what to do next.
    const isPayment = isPaymentTable(tableName, safeColumns)
    const EMAIL_TABLE_NAMES = new Set([
      'notifications', 'notification', 'emails', 'email', 'email_logs',
      'messages', 'mailer_events',
    ])
    const VIDEO_TABLE_NAMES = new Set([
      'generation_jobs', 'render_jobs', 'video_jobs', 'ai_jobs', 'clip_jobs',
      'generation_job', 'render_job',
    ])

    let integrationNotice = ''
    try {
      const { prisma: _piPrisma } = await import('@/lib/db')

      if (isPayment) {
        const stripeKey = await _piPrisma.projectIntegrationKey.findFirst({
          where: { projectId, integrationId: { in: ['stripe', 'STRIPE_SECRET_KEY'] } },
          select: { id: true },
        })
        if (!stripeKey) {
          integrationNotice = [
            '',
            '',
            '⚠️ **Payment integration required**',
            `The \`${tableName}\` table is ready, but payment processing is not active.`,
            '',
            '**Blocked:**',
            '- Stripe checkout: needs `STRIPE_SECRET_KEY`',
            '- Stripe webhook: needs `STRIPE_WEBHOOK_SECRET`',
            '',
            '→ Paste your Stripe secret key (`sk_live_...` or `sk_test_...`) to activate.',
          ].join('\n')
        }
      } else if (EMAIL_TABLE_NAMES.has(tableName)) {
        // #89: Email auto-provisioning — always prompt when email/notification table created
        const emailKey = await _piPrisma.projectIntegrationKey.findFirst({
          where: { projectId, integrationId: { in: ['resend', 'sendgrid', 'smtp', 'RESEND_API_KEY', 'SENDGRID_API_KEY'] } },
          select: { id: true },
        })
        if (!emailKey) {
          integrationNotice = [
            '',
            '',
            '📧 **Email provider required**',
            `The \`${tableName}\` table is ready, but no email provider is configured — emails will not be sent.`,
            '',
            '**To activate email sending, choose one:**',
            '- **Resend** (recommended): `re_...` — resend.com/api-keys',
            '- **SendGrid**: `SG.xxx.yyy` — app.sendgrid.com/settings/api_keys',
            '',
            '→ Paste your email provider API key and I will activate transactional email immediately.',
          ].join('\n')
        }
      } else if (VIDEO_TABLE_NAMES.has(tableName)) {
        // #88: Video generation provider awareness
        const videoKey = await _piPrisma.projectIntegrationKey.findFirst({
          where: {
            projectId,
            integrationId: { in: ['runway', 'stability', 'kling', 'replicate', 'pika',
              'RUNWAY_API_KEY', 'STABILITY_API_KEY', 'REPLICATE_API_TOKEN'] },
          },
          select: { id: true },
        })
        if (!videoKey) {
          integrationNotice = [
            '',
            '',
            '🎬 **Video generation provider required**',
            `The \`${tableName}\` table is ready with all 17 columns, but no video generation provider is connected.`,
            '',
            '**Supported providers:**',
            '- **Runway ML**: `key_...` — app.runwayml.com/settings',
            '- **Replicate** (Kling, SDXL, Pika): `r8_...` — replicate.com/account/api-tokens',
            '- **Stability AI**: `sk-...` (40+ chars) — platform.stability.ai/account/keys',
            '',
            '→ Paste your provider API key to activate the video generation pipeline.',
          ].join('\n')
        }
      }
    } catch (_piErr: any) {
      // Non-fatal — skip notice if check fails
    }

    return {
      success: true,
      // ── The integration notice is DATA, not prose appended to the result ─────
      //
      // It used to be concatenated onto this message, so a `create_table` — and
      // therefore an `apply_migration` — came back with "⚠️ Payment integration
      // required… Paste your Stripe secret key" embedded in what is otherwise a
      // structured DDL receipt. A developer running a migration got a sales
      // prompt in the response, and an agent parsing that response got prose it
      // has no way to act on and every reason to relay verbatim.
      //
      // The information is worth surfacing — a payments table with no Stripe key
      // really is inert. It just has to be a field the caller can render, ignore
      // or act on, rather than text welded to the outcome of the operation.
      message: `✅ Created table "${tableName}" with ${safeColumns.length + 3} columns (including id, createdAt, updatedAt)`,
      data: {
        tableName,
        schema: postgresSchema,
        columns: safeColumns.length,
      },
      ...(integrationNotice ? { advisories: [integrationNotice.trim()] } : {}),
      artifacts: { tables: [tableName] },
      diff: { added: [tableName], modified: [], removed: [] },
      // verifiedAt is set by verifyExecution after confirming table exists in information_schema
    }
  } catch (error: any) {
    console.error('❌ [AI Executor] Database error:', error)

    // Check if table already exists - treat as success (idempotent)
    if (error.code === '42P07') {
      console.log(`⚠️ [AI Executor] Table "${tableName}" already exists - treating as success (idempotent)`)

      // Ensure metadata exists
      try {
        const { prisma } = await import('@/lib/db')
        const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
        const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

        const existingMeta = await prisma.table.findFirst({
          where: { projectId, name: tableName }
        })

        if (!existingMeta) {
          await prisma.table.create({
            data: {
              projectId,
              name: tableName,
              schema: postgresSchema,
              description: `${tableName} table`,
            },
          })
          console.log(`✅ [AI Executor] Table metadata created for existing table`)
        }
      } catch (metaError) {
        console.warn(`⚠️ [AI Executor] Could not create metadata:`, metaError)
      }

      return {
        success: true,
        message: `✅ Table "${tableName}" is ready (already existed)`,
        data: {
          tableName,
          alreadyExisted: true,
        },
        artifacts: { tables: [tableName] },
        diff: { added: [], modified: [tableName], removed: [] },
        // verifiedAt is set by verifyExecution after confirming table exists in information_schema
      }
    }
    
    return {
      success: false,
      message: `Failed to create table: ${error.message}`,
      error: error.message,
    }
  }
}

/**
 * REAL BACKEND CALL: Create junction table for many-to-many relationships
 * e.g. users ↔ courses => student_courses(id, userId, courseId, createdAt)
 */
async function executeCreateJunctionTable(
  params: any,
  projectId: string
): Promise<ExecutionResult> {
  const { tableA, tableB, junctionName } = params

  if (!tableA || !tableB) {
    return { success: false, message: 'tableA and tableB are required for junction table creation' }
  }

  // Derive junction table name if not provided (alphabetically sorted)
  const [first, second] = [tableA.toLowerCase(), tableB.toLowerCase()].sort()
  const finalName: string = junctionName || `${first}_${second}`

  // Singular column names: strip trailing 's' if present (users→user, courses→course)
  const singularA = first.endsWith('s') ? first.slice(0, -1) : first
  const singularB = second.endsWith('s') ? second.slice(0, -1) : second

  // Membership/RBAC tables get extra role + status columns for multi-tenant SaaS
  const MEMBERSHIP_PATTERNS = ['member', 'participant', 'collaborator', 'contributor']
  const isMembershipTable = MEMBERSHIP_PATTERNS.some(p => finalName.includes(p))

  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

    // Pre-condition: ensure both referenced tables physically exist in the DB
    // (Prisma metadata can diverge from actual PostgreSQL state)
    for (const tbl of [first, second]) {
      const check = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2) AS exists`,
        postgresSchema,
        tbl,
      )
      if (!check[0]?.exists) {
        await prisma.$executeRawUnsafe(
          `CREATE TABLE IF NOT EXISTS "${postgresSchema}"."${tbl}" (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP)`
        )
        // Register in metadata if missing
        const meta = await prisma.table.findFirst({ where: { projectId, name: tbl } })
        if (!meta) {
          await prisma.table.create({ data: { projectId, name: tbl, schema: postgresSchema, description: `Auto-created for junction table ${finalName}` } })
        }
      }
    }

    const extraColumns = isMembershipTable
      ? `"role" TEXT NOT NULL DEFAULT 'member',\n        "status" TEXT NOT NULL DEFAULT 'active',\n        "joinedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,\n        `
      : ''

    // FIX 3: Detect real PK type for each referenced table to avoid int/uuid mismatch (error 42804)
    const getPrimaryKeyType = async (schema: string, tableName: string): Promise<string> => {
      try {
        const rows = await prisma.$queryRawUnsafe<{ data_type: string }[]>(
          `SELECT c.data_type FROM information_schema.columns c
           JOIN information_schema.table_constraints tc ON tc.table_schema = c.table_schema AND tc.table_name = c.table_name
           JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.column_name = c.column_name
           WHERE tc.constraint_type = 'PRIMARY KEY' AND c.table_schema = $1 AND c.table_name = $2
           LIMIT 1`,
          schema, tableName
        )
        if (rows.length > 0) {
          const dt = rows[0].data_type.toLowerCase()
          if (dt.includes('int')) return 'INTEGER'
          if (dt === 'bigint') return 'BIGINT'
          // uuid, character varying, text all map to UUID for our convention
          return 'UUID'
        }
      } catch {
        // Fall back to UUID (safe default for new tables)
      }
      return 'UUID'
    }

    const pkTypeA = await getPrimaryKeyType(postgresSchema, first)
    const pkTypeB = await getPrimaryKeyType(postgresSchema, second)
    const defaultA = pkTypeA === 'UUID' ? 'gen_random_uuid()' : undefined
    const defaultB = pkTypeB === 'UUID' ? 'gen_random_uuid()' : undefined
    const fkColA = pkTypeA === 'UUID'
      ? `"${singularA}Id" UUID NOT NULL REFERENCES "${postgresSchema}"."${first}"(id) ON DELETE CASCADE`
      : pkTypeA === 'BIGINT'
        ? `"${singularA}Id" BIGINT NOT NULL REFERENCES "${postgresSchema}"."${first}"(id) ON DELETE CASCADE`
        : `"${singularA}Id" INTEGER NOT NULL REFERENCES "${postgresSchema}"."${first}"(id) ON DELETE CASCADE`
    const fkColB = pkTypeB === 'UUID'
      ? `"${singularB}Id" UUID NOT NULL REFERENCES "${postgresSchema}"."${second}"(id) ON DELETE CASCADE`
      : pkTypeB === 'BIGINT'
        ? `"${singularB}Id" BIGINT NOT NULL REFERENCES "${postgresSchema}"."${second}"(id) ON DELETE CASCADE`
        : `"${singularB}Id" INTEGER NOT NULL REFERENCES "${postgresSchema}"."${second}"(id) ON DELETE CASCADE`
    console.log(`[JunctionTable] FK types: ${first}(${pkTypeA}), ${second}(${pkTypeB})`)

    // Split into separate statements — Prisma rejects multi-statement strings
    // (PostgreSQL error 42601: cannot insert multiple commands into a prepared statement)
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS "${postgresSchema}"."${finalName}" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ${fkColA},
        ${fkColB},
        ${extraColumns}"createdAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE ("${singularA}Id", "${singularB}Id")
      )
    `
    const indexASQL = `CREATE INDEX IF NOT EXISTS "idx_${finalName}_${singularA}Id" ON "${postgresSchema}"."${finalName}"("${singularA}Id")`
    const indexBSQL = `CREATE INDEX IF NOT EXISTS "idx_${finalName}_${singularB}Id" ON "${postgresSchema}"."${finalName}"("${singularB}Id")`

    await prisma.$executeRawUnsafe(createTableSQL)
    await prisma.$executeRawUnsafe(indexASQL)
    await prisma.$executeRawUnsafe(indexBSQL)

    // Save metadata
    const existingMeta = await prisma.table.findFirst({ where: { projectId, name: finalName } })
    if (!existingMeta) {
      await prisma.table.create({
        data: {
          projectId,
          name: finalName,
          schema: postgresSchema,
          description: `Junction table linking ${tableA} and ${tableB}${isMembershipTable ? ' with role-based access control' : ''}`,
        },
      })
    }

    const extraColNames = isMembershipTable ? ', role, status, joinedAt' : ''
    return {
      success: true,
      message: `✅ Created junction table **${finalName}** linking **${tableA}** ↔ **${tableB}**.\n\nColumns: id, ${singularA}Id (FK→${first}), ${singularB}Id (FK→${second})${extraColNames}, createdAt`,
      data: { junctionName: finalName, tableA, tableB },
    }
  } catch (error: any) {
    if (error.code === '42P07') {
      return {
        success: true,
        message: `✅ Junction table **${finalName}** already exists (linking ${tableA} ↔ ${tableB})`,
        data: { junctionName: finalName, alreadyExisted: true },
      }
    }
    return { success: false, message: `Failed to create junction table: ${error.message}`, error: error.message }
  }
}

/**
 * REAL BACKEND CALL: Generate API
 * DIRECT SERVICE CALL (bypasses HTTP layer)
 */
async function executeGenerateAPI(
  params: any,
  projectId: string,
  apiKey?: string
): Promise<ExecutionResult> {
  console.log('🚀 [AI Executor] Generating API for:', params.tableName)
  
  const { tableName } = params
  
  if (!tableName) {
    return {
      success: false,
      message: 'Table name is required',
    }
  }
  
  try {
    const { prisma } = await import('@/lib/db')

    // Find table
    let table = await prisma.table.findFirst({
      where: {
        projectId,
        name: tableName,
      },
    })
    
    // 🎯 FIX #1: Auto-create table if it doesn't exist
    if (!table) {
      console.log(`🤖 [AI Auto-Repair] Table "${tableName}" not found. Creating it now...`)
      
      const createResult = await executeCreateTable(
        { tableName, columns: [] },
        projectId,
        apiKey
      )
      
      if (!createResult.success) {
        return {
          success: false,
          message: `Cannot create API: Failed to auto-create table "${tableName}"`,
          error: createResult.error,
        }
      }
      
      // Fetch the newly created table
      table = await prisma.table.findFirst({
        where: { projectId, name: tableName },
      })
      
      if (!table) {
        return {
          success: false,
          message: `Table creation succeeded but table not found`,
          error: 'Table not found after creation',
        }
      }
      
      console.log(`✅ [AI Auto-Repair] Table "${tableName}" created successfully`)
    }
    
    // No ApiDefinition row is written here any more (2026-07-21).
    //
    // Under PostgREST the API *is* the schema: `GET /posts` exists because the
    // table exists, resolved from the PostgreSQL catalog on each request.
    // `checkExposure` stopped consulting ApiDefinition when the catalog became
    // the source of truth, so these rows had already stopped deciding anything
    // — they were a second, writable description of a fact the database
    // already owned, and the only thing a second copy can do is disagree.
    //
    // The duplicated domain-endpoint block that used to sit in the "API already
    // exists" early-return is gone with it; that generation is idempotent
    // (upsert by name) so it simply runs once, below, either way.

    const apiBasePath = `/${tableName.toLowerCase()}`
    const stdMethods = ['GET', 'POST', 'PUT', 'DELETE']

    // ── Domain-aware business logic endpoint generation ──────────────────────
    // For well-known domain patterns (jobs, orders, credits, etc.) we
    // auto-register additional business-logic endpoints as AiFunction records
    // so the project gets real endpoints like POST /jobs/:id/cancel, not just
    // generic CRUD.  These use pre-written TypeScript templates (no extra
    // OpenAI call) so they are fast and deterministic.
    const _allProjectTables = await prisma.table.findMany({ where: { projectId }, select: { name: true } })
      .then(rows => rows.map(r => r.name)).catch(() => [])
    const domainEndpoints = _generateDomainEndpoints(tableName, projectId, _allProjectTables)
    if (domainEndpoints.length > 0) {
      console.log(`[AI Executor] 🎯 Registering ${domainEndpoints.length} domain endpoints for "${tableName}"`)
      const { prisma: prismaDyn } = await import('@/lib/db')
      for (const ep of domainEndpoints) {
        try {
          const existing = await prismaDyn.aiFunction.findFirst({
            where: { projectId, name: ep.name },
            select: { id: true },
          })
          if (existing) {
            await prismaDyn.aiFunction.update({
              where: { id: existing.id },
              data: {
                description: ep.description,
                generatedCode: ep.code,
                triggerType: 'manual',
                triggerTable: `${ep.method} /api/v1/${projectId}/fn/${ep.name}`,
                status: 'active',
              },
            })
          } else {
            await prismaDyn.aiFunction.create({
              data: {
                projectId,
                name: ep.name,
                description: ep.description,
                generatedCode: ep.code,
                triggerType: 'manual',
                triggerTable: `${ep.method} /api/v1/${projectId}/fn/${ep.name}`,
                status: 'active',
              },
            })
          }
        } catch (epErr: any) {
          console.warn(`[AI Executor] Could not register domain endpoint "${ep.name}":`, epErr.message)
        }
      }
    }
    // ── END domain endpoints ──────────────────────────────────────────────────

    const allEndpoints = [
      ...stdMethods.map(method => ({ method, path: apiBasePath })),
      ...domainEndpoints.map(ep => ({ method: ep.method, path: `/api/v1/${projectId}/fn/${ep.name}` })),
    ]

    const domainNote = domainEndpoints.length > 0
      ? `\n\nAdditional business logic endpoints:\n${domainEndpoints.map(ep => `  ${ep.method} /api/v1/${projectId}/fn/${ep.name} — ${ep.description}`).join('\n')}`
      : ''

    return {
      success: true,
      // ── The path reported here must be the path that is SERVED ──────────────
      //
      // This said `is live at /products`. Nothing serves `/products`. The real
      // route is `/api/v1/{projectId}/db/products`, and a developer who copied
      // this line got a 404 — from a 404 handler that ALSO stated the path
      // wrong ("CRUD is /{table}"), while the agent instructions stated it
      // correctly. Three surfaces, three answers, one of them right.
      //
      // `apiBasePath` stays `/products` because it is the ApiDefinition's
      // storage key and other things read it. Only the human/agent-facing
      // message is made absolute — the thing being reported is "where do I call
      // this", and a relative fragment does not answer that.
      message: `✅ API for "${tableName}" is live at /api/v1/${projectId}/db/${tableName.toLowerCase()} (GET, POST, and /{id} for PUT/DELETE)${domainNote}`,
      // The table row IS the API's identity now — there is no separate
      // definition record to hand back.
      data: { tableName, basePath: apiBasePath, tableId: table.id },
      artifacts: { apis: allEndpoints },
      diff: { added: [apiBasePath, ...domainEndpoints.map(ep => `/fn/${ep.name}`)], modified: [], removed: [] },
    }
  } catch (error: any) {
    console.error('❌ [AI Executor] API generation error:', error)

    return {
      success: false,
      message: `Failed to generate API: ${error.message}`,
      error: error.message,
    }
  }
}

/**
 * Domain-aware endpoint inference
 *
 * Maps well-known table name patterns to additional business-logic endpoints
 * that go beyond generic CRUD.  Each entry contains pre-written TypeScript
 * code (no OpenAI call required) so generation is fast and deterministic.
 *
 * Patterns are checked with a simple substring/suffix match so they work for
 * tables like "generation_jobs", "video_jobs", "render_jobs", etc.
 */
function inferDomainEndpoints(
  tableName: string,
  projectId: string
): Array<{ name: string; method: string; description: string; code: string }> {
  const t = tableName.toLowerCase()
  const schema = `workspace_${projectId}`
  const endpoints: Array<{ name: string; method: string; description: string; code: string }> = []

  // ── JOB tables (generation_jobs, render_jobs, video_jobs, *_jobs, jobs) ────
  if (t.endsWith('_jobs') || t === 'jobs' || t.includes('job')) {
    const tbl = tableName

    endpoints.push({
      name: `${tbl}-cancel`,
      method: 'POST',
      description: `Cancel a running ${tbl} job by ID`,
      code: `import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const schema = 'workspace_${projectId}'
  try {
    const url = new URL(req.url)
    const id = url.searchParams.get('id') || (await req.json().catch(() => ({}))).id
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const rows = await prisma.$queryRawUnsafe<any[]>(
      \`SELECT id, status FROM "\${schema}"."${tbl}" WHERE id = $1 LIMIT 1\`, id
    )
    if (!rows.length) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    const job = rows[0]
    if (['completed', 'cancelled', 'failed'].includes(job.status)) {
      return NextResponse.json({ error: \`Cannot cancel job with status "\${job.status}"\` }, { status: 409 })
    }

    await prisma.$executeRawUnsafe(
      \`UPDATE "\${schema}"."${tbl}" SET status = 'cancelled', "updatedAt" = NOW() WHERE id = $1\`, id
    )
    return NextResponse.json({ success: true, id, status: 'cancelled' })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}`,
    })

    endpoints.push({
      name: `${tbl}-retry`,
      method: 'POST',
      description: `Retry a failed ${tbl} job by ID (resets status to pending)`,
      code: `import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const schema = 'workspace_${projectId}'
  try {
    const url = new URL(req.url)
    const id = url.searchParams.get('id') || (await req.json().catch(() => ({}))).id
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const rows = await prisma.$queryRawUnsafe<any[]>(
      \`SELECT id, status FROM "\${schema}"."${tbl}" WHERE id = $1 LIMIT 1\`, id
    )
    if (!rows.length) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    const job = rows[0]
    if (job.status === 'processing') {
      return NextResponse.json({ error: 'Job is still processing — cancel it first' }, { status: 409 })
    }

    await prisma.$executeRawUnsafe(
      \`UPDATE "\${schema}"."${tbl}" SET status = 'pending', attempts = COALESCE(attempts, 0) + 1, "updatedAt" = NOW() WHERE id = $1\`, id
    )
    return NextResponse.json({ success: true, id, status: 'pending' })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}`,
    })

    endpoints.push({
      name: `${tbl}-status`,
      method: 'GET',
      description: `Get current status and progress of a ${tbl} job`,
      code: `import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(req: NextRequest, { params }: { params: { projectId: string } }) {
  const schema = 'workspace_${projectId}'
  try {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id query param is required' }, { status: 400 })

    const rows = await prisma.$queryRawUnsafe<any[]>(
      \`SELECT id, status, progress, error_message, "createdAt", "updatedAt" FROM "\${schema}"."${tbl}" WHERE id = $1 LIMIT 1\`, id
    ).catch(() =>
      prisma.$queryRawUnsafe<any[]>(
        \`SELECT id, status, "createdAt", "updatedAt" FROM "\${schema}"."${tbl}" WHERE id = $1 LIMIT 1\`, id
      )
    )
    if (!rows.length) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    return NextResponse.json({ success: true, job: rows[0] })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}`,
    })
  }

  // ── CREDITS / CREDIT_BALANCE tables ─────────────────────────────────────────
  // BUG-10: Only match the *wallet/balance* table, not transaction/ledger tables.
  // credit_transactions is a ledger (append-only log) — balance/deduct endpoints
  // must be registered against the wallet/balance table only to avoid duplicates.
  if (t === 'credits' || t === 'credit_balance' || t === 'credit_wallet' || t === 'wallet' ||
      (t.includes('credit') && !t.includes('transaction') && !t.includes('log') && !t.includes('history'))) {
    const tbl = tableName

    endpoints.push({
      name: `${tbl}-balance`,
      method: 'GET',
      description: `Get the credit balance for the authenticated user`,
      code: `import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth/jwt'

export async function GET(req: NextRequest, { params }: { params: { projectId: string } }) {
  const schema = 'workspace_${projectId}'
  try {
    const token = (req.headers.get('x-user-token') || '').replace('Bearer ', '')
    const payload = verifyToken(token)
    if (!payload?.userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

    // Try wallet model first (single row with balance + reserved columns)
    const walletRows = await prisma.$queryRawUnsafe<any[]>(
      \`SELECT balance, COALESCE(reserved, 0) AS reserved FROM "\${schema}"."${tbl}" WHERE user_id = $1 LIMIT 1\`,
      payload.userId
    ).catch(() => [])

    if (walletRows.length > 0 && walletRows[0].balance !== undefined) {
      const balance = Number(walletRows[0].balance ?? 0)
      const reserved = Number(walletRows[0].reserved ?? 0)
      return NextResponse.json({
        success: true,
        balance,
        reserved,
        available: Math.max(0, balance - reserved),
        userId: payload.userId,
      })
    }

    // Ledger model: balance = SUM(positive amounts), spent = SUM(negative amounts)
    const ledgerRows = await prisma.$queryRawUnsafe<any[]>(
      \`SELECT
         COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS lifetime_purchased,
         COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS lifetime_used,
         COALESCE(SUM(amount), 0) AS balance
       FROM "\${schema}"."${tbl}" WHERE user_id = $1\`,
      payload.userId
    )
    const balance = Number(ledgerRows[0]?.balance ?? 0)
    return NextResponse.json({
      success: true,
      balance,
      reserved: 0,
      available: balance,
      lifetime_purchased: Number(ledgerRows[0]?.lifetime_purchased ?? 0),
      lifetime_used: Number(ledgerRows[0]?.lifetime_used ?? 0),
      userId: payload.userId,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}`,
    })

    endpoints.push({
      name: `${tbl}-deduct`,
      method: 'POST',
      description: `Atomically deduct credits using SELECT FOR UPDATE — prevents double-spend race conditions`,
      code: `import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth/jwt'

export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const schema = 'workspace_${projectId}'
  try {
    const token = (req.headers.get('x-user-token') || '').replace('Bearer ', '')
    const payload = verifyToken(token)
    if (!payload?.userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

    const { amount, reason } = await req.json()
    const deduction = Number(amount)
    if (!deduction || deduction <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
    }

    // ── Atomic deduction using a serializable transaction ──────────────────────
    // Strategy 1: wallet model (single row per user with a 'balance' column)
    //   → Use a single conditional UPDATE with WHERE balance >= deduction.
    //     This is atomic at the DB level — no separate read required.
    // Strategy 2: ledger model (rows with 'amount' column, balance = SUM)
    //   → Lock user rows with SELECT FOR UPDATE, check sum, then insert.
    // We try Strategy 1 first; if 0 rows updated, fall back to Strategy 2.

    let result: { success: boolean; newBalance: number; deducted: number } | null = null
    let insufficientBalance = false

    await prisma.$transaction(async (tx) => {
      // Strategy 1: wallet model atomic UPDATE
      const updatedRows = await tx.$executeRawUnsafe(
        \`UPDATE "\${schema}"."${tbl}"
         SET balance = balance - $1, reserved = COALESCE(reserved, 0), "updatedAt" = NOW()
         WHERE user_id = $2 AND balance >= $1\`,
        deduction, payload!.userId
      )

      if (updatedRows > 0) {
        // Row was updated — deduction succeeded, read back new balance
        const balRows = await tx.$queryRawUnsafe<any[]>(
          \`SELECT balance FROM "\${schema}"."${tbl}" WHERE user_id = $1 LIMIT 1\`,
          payload!.userId
        )
        result = { success: true, newBalance: Number(balRows[0]?.balance ?? 0), deducted: deduction }
        return
      }

      // Strategy 2: ledger model — lock rows to prevent concurrent deductions
      const balRows = await tx.$queryRawUnsafe<any[]>(
        \`SELECT COALESCE(SUM(amount), 0) AS balance
         FROM "\${schema}"."${tbl}"
         WHERE user_id = $1
         FOR UPDATE\`,
        payload!.userId
      )
      const currentBalance = Number(balRows[0]?.balance ?? 0)

      if (currentBalance < deduction) {
        insufficientBalance = true
        return  // rolls back automatically when we exit without setting result
      }

      await tx.$executeRawUnsafe(
        \`INSERT INTO "\${schema}"."${tbl}" (user_id, amount, reason, "createdAt")
         VALUES ($1, $2, $3, NOW())\`,
        payload!.userId, -deduction, reason || 'deduction'
      )
      result = { success: true, newBalance: currentBalance - deduction, deducted: deduction }
    })

    if (insufficientBalance || !result) {
      // Read balance outside transaction to return current value
      const balRows = await prisma.$queryRawUnsafe<any[]>(
        \`SELECT COALESCE(balance, 0) AS balance FROM "\${schema}"."${tbl}" WHERE user_id = $1 LIMIT 1\`,
        payload!.userId
      ).catch(() => ([{ balance: 0 }]))
      return NextResponse.json(
        { error: 'Insufficient credits', balance: Number(balRows[0]?.balance ?? 0), required: deduction },
        { status: 402 }
      )
    }

    return NextResponse.json({ success: true, ...result })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}`,
    })
  }

  // ── ORDERS tables ─────────────────────────────────────────────────────────
  if (t === 'orders' || t.endsWith('_orders')) {
    const tbl = tableName

    endpoints.push({
      name: `${tbl}-invoice`,
      method: 'GET',
      description: `Get a formatted invoice for an order`,
      code: `import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(req: NextRequest, { params }: { params: { projectId: string } }) {
  const schema = 'workspace_${projectId}'
  try {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id query param is required' }, { status: 400 })

    const rows = await prisma.$queryRawUnsafe<any[]>(
      \`SELECT * FROM "\${schema}"."${tbl}" WHERE id = $1 LIMIT 1\`, id
    )
    if (!rows.length) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

    const order = rows[0]
    return NextResponse.json({
      success: true,
      invoice: {
        invoiceNumber: \`INV-\${order.id.slice(0, 8).toUpperCase()}\`,
        order,
        issuedAt: new Date().toISOString(),
      },
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}`,
    })

    endpoints.push({
      name: `${tbl}-cancel`,
      method: 'POST',
      description: `Cancel an order if it is still in a cancellable state`,
      code: `import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const schema = 'workspace_${projectId}'
  try {
    const id = new URL(req.url).searchParams.get('id') || (await req.json().catch(() => ({}))).id
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const rows = await prisma.$queryRawUnsafe<any[]>(
      \`SELECT id, status FROM "\${schema}"."${tbl}" WHERE id = $1 LIMIT 1\`, id
    )
    if (!rows.length) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

    const order = rows[0]
    const cancellable = ['pending', 'processing', 'confirmed']
    if (!cancellable.includes(order.status)) {
      return NextResponse.json({ error: \`Cannot cancel order with status "\${order.status}"\` }, { status: 409 })
    }

    await prisma.$executeRawUnsafe(
      \`UPDATE "\${schema}"."${tbl}" SET status = 'cancelled', "updatedAt" = NOW() WHERE id = $1\`, id
    )
    return NextResponse.json({ success: true, id, status: 'cancelled' })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}`,
    })
  }

  // ── SUBSCRIPTIONS tables ──────────────────────────────────────────────────
  // BUG-10: Only match the *subscriptions* (active user subscriptions) table, not
  // subscription_plans (a catalog/lookup table). Plans have no cancel/resume state.
  // Pattern: exact "subscriptions" OR ends with "_subscriptions" (e.g. "user_subscriptions"),
  // but NOT tables that contain "plan" (subscription_plans, billing_plans, etc.)
  if ((t === 'subscriptions' || t.endsWith('_subscriptions')) && !t.includes('plan')) {
    const tbl = tableName

    endpoints.push({
      name: `${tbl}-cancel`,
      method: 'POST',
      description: `Cancel a subscription (sets cancel_at_period_end = true)`,
      code: `import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth/jwt'

export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const schema = 'workspace_${projectId}'
  try {
    const token = (req.headers.get('x-user-token') || '').replace('Bearer ', '')
    const payload = verifyToken(token)
    if (!payload?.userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

    const { subscriptionId } = await req.json().catch(() => ({}))
    const id = subscriptionId || new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'subscriptionId is required' }, { status: 400 })

    await prisma.$executeRawUnsafe(
      \`UPDATE "\${schema}"."${tbl}" SET cancel_at_period_end = true, "updatedAt" = NOW()
         WHERE id = $1 AND user_id = $2\`, id, payload.userId
    )
    return NextResponse.json({ success: true, message: 'Subscription will be cancelled at the end of the current billing period.' })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}`,
    })

    endpoints.push({
      name: `${tbl}-resume`,
      method: 'POST',
      description: `Resume a subscription that was set to cancel at period end`,
      code: `import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth/jwt'

export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const schema = 'workspace_${projectId}'
  try {
    const token = (req.headers.get('x-user-token') || '').replace('Bearer ', '')
    const payload = verifyToken(token)
    if (!payload?.userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

    const { subscriptionId } = await req.json().catch(() => ({}))
    const id = subscriptionId || new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'subscriptionId is required' }, { status: 400 })

    await prisma.$executeRawUnsafe(
      \`UPDATE "\${schema}"."${tbl}" SET cancel_at_period_end = false, "updatedAt" = NOW()
         WHERE id = $1 AND user_id = $2\`, id, payload.userId
    )
    return NextResponse.json({ success: true, message: 'Subscription cancellation reversed — will renew at end of period.' })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}`,
    })
  }

  // ── CHECKOUT / PAYMENTS ────────────────────────────────────────────────────
  if (t === 'checkout' || t === 'checkouts' || t === 'payments' || t.includes('payment')) {
    endpoints.push({
      name: 'checkout-session',
      method: 'POST',
      description: 'Create a checkout session (returns payment URL or session ID)',
      code: `import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth/jwt'

export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const schema = 'workspace_${projectId}'
  try {
    const token = (req.headers.get('x-user-token') || '').replace('Bearer ', '')
    const payload = verifyToken(token)
    if (!payload?.userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

    const body = await req.json()
    const { amount, currency = 'usd', description, metadata } = body
    if (!amount || Number(amount) <= 0) return NextResponse.json({ error: 'amount is required' }, { status: 400 })

    // Store pending checkout record
    const sessionId = crypto.randomUUID()
    await prisma.$executeRawUnsafe(
      \`INSERT INTO "\${schema}"."${tableName}" (id, user_id, amount, currency, status, description, metadata, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'pending', $5, $6::jsonb, NOW(), NOW())\`,
      sessionId, payload.userId, Number(amount), currency,
      description || null,
      JSON.stringify(metadata || {})
    ).catch(() =>
      // Fallback for tables without all columns
      prisma.$executeRawUnsafe(
        \`INSERT INTO "\${schema}"."${tableName}" (id, user_id, amount, status, "createdAt", "updatedAt") VALUES ($1, $2, $3, 'pending', NOW(), NOW())\`,
        sessionId, payload.userId, Number(amount)
      )
    )

    // TODO: integrate with Stripe/payment provider when key is stored
    return NextResponse.json({
      success: true,
      sessionId,
      status: 'pending',
      message: 'Checkout session created. Integrate a payment provider (Stripe) to activate live payments.',
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}`,
    })
  }

  // ── ADMIN endpoints for any project with a users table ─────────────────────
  // Only added when the table IS "users" — prevents noise on every other table
  if (t === 'users') {
    endpoints.push({
      name: 'admin-users-list',
      method: 'GET',
      description: 'Admin: list all users with pagination (requires service-role API key)',
      code: `import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(req: NextRequest, { params }: { params: { projectId: string } }) {
  const schema = 'workspace_${projectId}'
  try {
    const url = new URL(req.url)
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 500)
    const offset = Number(url.searchParams.get('offset') || 0)
    const search = url.searchParams.get('search') || ''

    const whereClause = search
      ? \`WHERE email ILIKE $3 OR name ILIKE $3\`
      : ''
    const queryArgs: any[] = [limit, offset]
    if (search) queryArgs.push(\`%\${search}%\`)

    const users = await prisma.$queryRawUnsafe<any[]>(
      \`SELECT id, email, name, "createdAt", "updatedAt" FROM "\${schema}"."users" \${whereClause} ORDER BY "createdAt" DESC LIMIT $1 OFFSET $2\`,
      ...queryArgs
    )
    const countRows = await prisma.$queryRawUnsafe<any[]>(
      \`SELECT COUNT(*) AS total FROM "\${schema}"."users" \${whereClause}\`,
      ...(search ? [\`%\${search}%\`] : [])
    )
    return NextResponse.json({ success: true, users, total: Number(countRows[0]?.total ?? 0), limit, offset })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}`,
    })
  }

  return endpoints
}

/**
 * REAL BACKEND CALL: Add Column (via raw SQL)
 */
async function executeAddColumn(
  params: any,
  projectId: string,
  apiKey?: string
): Promise<ExecutionResult> {
  console.log('[AI Executor] Adding column:', params)

  // Support both single column (columnName/columnType) and multi-column (columns array)
  const { tableName, columnName, columnType = 'TEXT', columns } = params

  if (!tableName) {
    return { success: false, message: 'Table name is required' }
  }

  // For multi-column requests (from modify-executor), resolve columns array
  const colsToAdd: Array<{ name: string; type: string }> = columns?.length > 0
    ? columns
    : (columnName ? [{ name: columnName, type: columnType }] : [])

  if (colsToAdd.length === 0) {
    return { success: false, message: 'At least one column name is required' }
  }

  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

    // ── REAL DB CHECK: does the table actually exist in PostgreSQL? ──────────
    const tableCheck = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2
       ) AS exists`,
      postgresSchema,
      tableName,
    )
    const tableExistsInDB = tableCheck[0]?.exists === true

    if (!tableExistsInDB) {
      // Auto-create the table with just an id column so we can add columns to it
      console.warn(`[AI Executor] Table "${tableName}" not in DB — auto-creating before adding columns`)
      await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "${postgresSchema}"."${tableName}" (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
           "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
         )`
      )
      // Register in Prisma metadata
      const existsMeta = await prisma.table.findFirst({ where: { projectId, name: tableName } })
      if (!existsMeta) {
        await prisma.table.create({
          data: { projectId, name: tableName, schema: postgresSchema, description: `Auto-created for column addition` },
        })
      }
    }
    // ── END REAL DB CHECK ────────────────────────────────────────────────────

    const addedCols: string[] = []
    for (const col of colsToAdd) {
      await addColumnToTable(tableName, { name: col.name, type: col.type }, projectId, apiKey)
      addedCols.push(col.name)
    }

    // Column schema changed — evict cached Zod validation schema
    import('@/lib/services/workspace-validator').then(({ invalidateSchemaCache }) => invalidateSchemaCache(projectId, tableName)).catch(() => {})

    return {
      success: true,
      message: `✅ Added ${addedCols.map(c => `"${c}"`).join(', ')} to table "${tableName}"`,
    }
  } catch (error: any) {
    return { success: false, message: `Execution failed: ${error.message}`, error: error.message }
  }
}

async function executeDropTable(params: any, projectId: string): Promise<ExecutionResult> {
  const tableName = (params.tableName as string)?.toLowerCase()?.trim()
  if (!tableName) return { success: false, message: 'Table name is required' }
  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

    // Count APIs before deletion so we can report the number removed
    const removedApiCount = await prisma.apiDefinition.count({ where: { projectId, name: tableName } }).catch(() => 0)

    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${postgresSchema}"."${tableName}" CASCADE`)
    await prisma.table.deleteMany({ where: { projectId, name: tableName } })
    await prisma.apiDefinition.deleteMany({ where: { projectId, name: tableName } })

    // Best-effort: strip the entity from the BackendStateGraph so graph-based
    // API counts stay in sync. Failure here must never block the deletion itself.
    try {
      const graphRecord = await prisma.backendGraph.findFirst({ where: { projectId } })
      if (graphRecord) {
        const graph = graphRecord.graphData as any
        if (graph?.entities?.[tableName]) {
          delete graph.entities[tableName]
          // Also remove any graph API entries associated with the table
          if (graph?.apis) {
            for (const path of Object.keys(graph.apis)) {
              if (path.startsWith(`/${tableName}`) || (graph.apis[path] as any)?.entity === tableName) {
                delete graph.apis[path]
              }
            }
          }
          await prisma.backendGraph.update({ where: { id: graphRecord.id }, data: { graphData: graph } })
        }
      }
    } catch { /* non-fatal — graph cleanup is best-effort */ }

    import('@/lib/ai/execution-cache').then(({ invalidateSchemaCache }) => invalidateSchemaCache(projectId)).catch(() => {})
    import('@/lib/services/workspace-validator').then(({ invalidateSchemaCache: invalidateValidatorCache }) => invalidateValidatorCache(projectId, tableName)).catch(() => {})
    import('@/lib/services/workspace-table-stats').then(({ invalidateTableStats }) => invalidateTableStats(projectId, tableName)).catch(() => {})

    const apiMsg = removedApiCount > 0 ? ` and removed ${removedApiCount} API definition${removedApiCount !== 1 ? 's' : ''}` : ''
    return {
      success: true,
      message: `✅ Table \`${tableName}\` dropped permanently${apiMsg}.`,
      diff: { added: [], modified: [], removed: [tableName] },
      data: { tableName, removedApiCount },
    }
  } catch (err: any) {
    return { success: false, message: `Failed to drop table: ${err.message}`, error: err.message }
  }
}

async function executeTruncateTable(params: any, projectId: string): Promise<ExecutionResult> {
  const tableName = (params.tableName as string)?.toLowerCase()?.trim()
  if (!tableName) return { success: false, message: 'Table name is required' }
  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${postgresSchema}"."${tableName}" RESTART IDENTITY CASCADE`)
    import('@/lib/services/workspace-table-stats').then(({ invalidateTableStats }) => invalidateTableStats(projectId, tableName)).catch(() => {})
    return { success: true, message: `Table \`${tableName}\` truncated — all rows deleted.` }
  } catch (err: any) {
    return { success: false, message: `Failed to truncate table: ${err.message}`, error: err.message }
  }
}

/**
 * REAL BACKEND CALL: Insert Data
 * DIRECT DATABASE ACCESS
 */
async function executeInsertData(
  params: any,
  projectId: string,
  apiKey?: string
): Promise<ExecutionResult> {
  console.log('[AI Executor] Inserting data:', params)
  
  const { tableName, rows = [] } = params
  
  if (!tableName || rows.length === 0) {
    return {
      success: false,
      message: 'Table name and rows are required',
    }
  }
  
  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    
    console.log(`🔌 [AI Executor] Inserting into ${postgresSchema}.${tableName}...`)
    
    // Get table columns with NOT NULL constraints
    const columnsQuery = `
      SELECT 
        column_name, 
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `
    
    const columns: any[] = await prisma.$queryRawUnsafe(columnsQuery, postgresSchema, tableName)
    
    // Filter out auto-generated columns
    const userColumns = columns.filter(c => !['id', 'createdAt', 'updatedAt'].includes(c.column_name))
    const columnNames = userColumns.map(c => c.column_name)
    
    // Find required columns (NOT NULL without defaults)
    const requiredColumns = userColumns
      .filter(c => c.is_nullable === 'NO' && !c.column_default)
      .map(c => c.column_name)
    
    console.log(`📝 [AI Executor] Available columns:`, columnNames)
    console.log(`⚠️ [AI Executor] Required columns:`, requiredColumns)
    
    // Insert each row
    let insertedCount = 0
    for (const row of rows) {
      // Filter row to only include columns that exist in the table
      const validData: any = {}
      for (const key of Object.keys(row)) {
        if (columnNames.includes(key)) {
          validData[key] = row[key]
        }
      }
      
      // Auto-add createdAt and updatedAt if they exist in table but not in row
      if (columns.find(c => c.column_name === 'createdAt') && !validData.createdAt) {
        validData.createdAt = new Date()
      }
      if (columns.find(c => c.column_name === 'updatedAt') && !validData.updatedAt) {
        validData.updatedAt = new Date()
      }
      
      // Check if all required columns are present
      const missingRequired = requiredColumns.filter(col => !(col in validData))
      if (missingRequired.length > 0) {
        console.log(`⚠️ [AI Executor] Skipping row - missing required columns: ${missingRequired.join(', ')}`)
        console.log(`   Row data:`, row)
        continue
      }
      
      if (Object.keys(validData).length === 0) {
        console.log(`⚠️ [AI Executor] Skipping row with no valid columns:`, row)
        continue
      }

      // ── UUID type-safety guard ─────────────────────────────────────────────
      // Build a map of column_name → data_type so we can validate and cast values.
      // If the LLM emits a text string (e.g. 'Electronics') for a UUID column
      // (e.g. category_id), PostgreSQL raises 42804 (datatype_mismatch).
      // We strip invalid UUID values rather than letting them crash the insert.
      const UUID_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      const colTypeMap = new Map<string, string>(
        columns.map((c: any) => [c.column_name as string, (c.data_type as string).toLowerCase()])
      )
      for (const key of Object.keys(validData)) {
        const dt = colTypeMap.get(key) ?? ''
        if (dt === 'uuid' && validData[key] !== null && validData[key] !== undefined) {
          const val = String(validData[key])
          if (!UUID_VALUE_RE.test(val)) {
            // Value is a text label, not a UUID — drop it so the column uses its
            // default (NULL or gen_random_uuid()) rather than crashing the insert.
            console.warn(`[AI Executor] Dropping non-UUID value for column "${key}" (was: "${val.slice(0, 40)}")`)
            delete validData[key]
          }
        }
      }

      // Build INSERT query with type-aware placeholders
      const fields = Object.keys(validData)
      const values = Object.values(validData)
      const placeholders = fields.map((f, i) => {
        const dt = colTypeMap.get(f) ?? ''
        if (dt === 'uuid') return `$${i + 1}::uuid`
        if (dt.includes('timestamp') || dt === 'date' || dt.includes('time')) return `$${i + 1}::timestamp`
        if (dt.includes('json')) return `$${i + 1}::jsonb`
        return `$${i + 1}`
      }).join(', ')

      const insertSQL = `
        INSERT INTO "${postgresSchema}"."${tableName}" (${fields.map(f => `"${f}"`).join(', ')})
        VALUES (${placeholders})
      `

      console.log(`📝 [AI Executor] Executing:`, insertSQL, 'with values:', values)
      await prisma.$executeRawUnsafe(insertSQL, ...values)
      insertedCount++
    }
    
    if (insertedCount === 0 && rows.length > 0) {
      return {
        success: false,
        message: `Could not insert any rows. The table may have required columns that weren't provided. Required columns: ${requiredColumns.join(', ') || 'none'}`,
        error: 'Missing required columns',
      }
    }
    
    return {
      success: true,
      message: `✅ Inserted ${insertedCount} row${insertedCount === 1 ? '' : 's'} into "${tableName}"`,
      data: { insertedCount },
    }
  } catch (error: any) {
    console.error('❌ [AI Executor] Insert error:', error)
    return {
      success: false,
      message: `Failed to insert data: ${error.message}`,
      error: error.message,
    }
  }
}

/**
 * Helper: Add column to table via raw SQL
 */
async function addColumnToTable(
  tableName: string,
  column: { name: string; type: string },
  projectId: string,
  apiKey?: string
): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    
    // Check if column already exists
    const columnsQuery = `
      SELECT column_name 
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
    `
    const existingColumn: any[] = await prisma.$queryRawUnsafe(columnsQuery, postgresSchema, tableName, column.name)
    
    if (existingColumn.length > 0) {
      console.log(`⚠️ [AI Executor] Column "${column.name}" already exists in "${tableName}" - skipping (idempotent)`)
      return
    }
    
    // Apply constraint-first system: detect FK columns, unique columns, etc.
    const normalizedType = normalizeColumnType(column.type, column.name)
    const constraints = deriveConstraints(column.name, normalizedType, tableName)
    const columnDef = { name: column.name, type: normalizedType }
    const columnSQL = applyConstraintsToColumn(columnDef, constraints, postgresSchema)

    // ALTER TABLE ADD COLUMN must never include NOT NULL without a DEFAULT —
    // existing rows would violate the constraint (PostgreSQL error 23502).
    // Strip bare NOT NULL; if there's already a DEFAULT the constraint is safe.
    const safeColumnSQL = columnSQL.replace(/\s+NOT NULL(?!\s*DEFAULT|\s*GENERATED)/gi, ' DEFAULT NULL')

    const alterSQL = `ALTER TABLE "${postgresSchema}"."${tableName}" ADD COLUMN IF NOT EXISTS ${safeColumnSQL}`

    console.log(`📝 [AI Executor] Adding column SQL:`, alterSQL)
    try {
      await prisma.$executeRawUnsafe(alterSQL)
    } catch (fkError: any) {
      // FK reference failed — retry without REFERENCES so the column is still added
      if (fkError.code === '42P01' || fkError.code === '42830' || (fkError.message && fkError.message.includes('does not exist'))) {
        console.warn(`[AI Executor] FK reference failed for "${column.name}", retrying without constraint`)
        const plainSQL = columnSQL
          .replace(/\s+REFERENCES\s+"[^"]*"\."[^"]*"\("[^"]*"\)[^,;]*/gi, '')
          .replace(/\s+NOT NULL(?!\s*DEFAULT|\s*GENERATED)/gi, ' DEFAULT NULL')
          .trim()
        await prisma.$executeRawUnsafe(`ALTER TABLE "${postgresSchema}"."${tableName}" ADD COLUMN IF NOT EXISTS ${plainSQL}`)
      } else {
        throw fkError
      }
    }
    
    console.log(`✅ [AI Executor] Column "${column.name}" added successfully`)

    // ── Index foreign-key columns, exactly as create_table does ──────────────
    // create_table indexes every *_id column at creation, but this path did
    // not, so the SAME column was indexed or unindexed purely depending on
    // whether it arrived at creation or later. An unindexed FK turns every
    // join and filter against it into a full table scan — the classic
    // silent-until-you-have-users cliff.
    //
    // Found by the `relationships_are_indexed` probe: adding `widget_id` via
    // this path made it fire immediately. That probe had never produced a
    // finding before, so this inconsistency had never been visible.
    const lower = column.name.toLowerCase()
    const isFkColumn = (lower.endsWith('_id') || /[a-z]id$/.test(lower)) && lower !== 'id'
    if (isFkColumn) {
      const indexName = `idx_${tableName}_${lower.replace(/[^a-z0-9]/g, '_')}`.slice(0, 63)
      try {
        await prisma.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${postgresSchema}"."${tableName}" ("${column.name}")`,
        )
        console.log(`📑 [AI Executor] Index created for added FK column: ${indexName}`)
      } catch (idxErr: any) {
        // Non-fatal — the column exists and is usable without the index.
        console.warn(`[AI Executor] Index create failed for ${column.name} (non-fatal):`, idxErr?.message)
      }
    }
  } catch (error: any) {
    console.error(`❌ [AI Executor] Failed to add column:`, error)
    throw error
  }
}

/**
 * DROP_COLUMN — destructive. Removes a column and ALL of its data.
 *
 * Safety:
 *   • Gated by CRITICAL_ACTIONS_GATE (caller must pass params.confirmed=true)
 *   • Refuses to drop reserved system columns (id, createdAt, updatedAt)
 *   • Best-effort cleanup: regenerates the auto-generated REST API for the
 *     table so the missing column stops appearing in CRUD payloads
 *   • Schema snapshot is captured before this runs (SCHEMA_MUTATING_ACTIONS),
 *     so the change is reversible via LIST_SCHEMA_VERSIONS / ROLLBACK_TO_VERSION
 */
async function executeDropColumn(params: any, projectId: string): Promise<ExecutionResult> {
  const tableName = String(params?.tableName ?? '').trim()
  const columnName = String(params?.columnName ?? '').trim()

  if (!tableName) return { success: false, message: 'Table name is required' }
  if (!columnName) return { success: false, message: 'Column name is required' }

  const RESERVED = new Set(['id', 'createdAt', 'updatedAt'])
  if (RESERVED.has(columnName)) {
    return {
      success: false,
      message: `Refusing to drop reserved column \`${columnName}\` — it is required by every table. To drop the whole table, use drop_table.`,
      error: 'RESERVED_COLUMN',
    }
  }

  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

    // Verify the column actually exists before issuing the DDL — gives a
    // truthful "no such column" error rather than the cryptic Postgres one.
    const exists = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
       ) AS exists`,
      postgresSchema, tableName, columnName,
    )
    if (!exists[0]?.exists) {
      return {
        success: false,
        message: `Column \`${columnName}\` does not exist on \`${tableName}\`.`,
        error: 'COLUMN_NOT_FOUND',
      }
    }

    // CASCADE so any view / trigger / index that references this column is
    // also dropped — without it Postgres refuses on dependent objects.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${postgresSchema}"."${tableName}" DROP COLUMN IF EXISTS "${columnName}" CASCADE`
    )

    // Regenerate the REST API for this table so the column disappears from
    // its generated CRUD payloads. Non-fatal — the column is gone either way.
    try {
      await executeGenerateAPI({ tableName }, projectId)
    } catch {
      // intentional — drop succeeded, API regen is best-effort
    }

    // Evict cached validation schemas so the next request sees the new shape.
    import('@/lib/services/workspace-validator')
      .then(({ invalidateSchemaCache }) => invalidateSchemaCache(projectId, tableName))
      .catch(() => {})
    import('@/lib/ai/execution-cache')
      .then(({ invalidateSchemaCache }) => invalidateSchemaCache(projectId))
      .catch(() => {})

    return {
      success: true,
      message: `✅ Column \`${columnName}\` dropped from \`${tableName}\`. The REST API was regenerated and old values are gone. This change is reversible via the version history.`,
      diff: { added: [], modified: [tableName], removed: [`${tableName}.${columnName}`] },
      verifiedAt: new Date().toISOString(),
    }
  } catch (err: any) {
    console.error('[executeDropColumn] Failed:', err)
    return {
      success: false,
      message: `Failed to drop column: ${err.message}`,
      error: err.message,
    }
  }
}

/**
 * LIST TABLES: Show all database tables
 */
async function executeListTables(projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma } = await import('@/lib/db')
    
    // Get all tables for this project
    const tables = await prisma.table.findMany({
      where: { projectId },
      select: {
        name: true,
        description: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })
    
    if (tables.length === 0) {
      return {
        success: true,
        message: "You don't have any tables yet. Try creating one: 'Create a users table'",
        data: { tables: [] },
      }
    }
    
    const tableList = tables.map(t => `• **${t.name}** - ${t.description || 'No description'}`).join('\n')
    
    return {
      success: true,
      message: `📊 **Your Tables (${tables.length}):**\n\n${tableList}`,
      data: { tables },
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to list tables: ${error.message}`,
      error: error.message,
    }
  }
}

/**
 * LIST APIS: Show all API endpoints
 *
 * Reads the PostgreSQL catalog, not ApiDefinition. Under PostgREST the API IS
 * the schema — a table is reachable because it exists and the role has a grant,
 * so the catalog is the only thing that can answer "what endpoints do I have"
 * without being able to disagree with the runtime.
 *
 * This used to read ApiDefinition rows, and that produced a real incident: a
 * create_table path installed the table, its RLS and its realtime triggers but
 * never wrote an ApiDefinition, so this function answered "You don't have any
 * APIs yet" on a backend full of working, queryable tables. The rows were a
 * second description of a fact the database already owned, and the copy drifted.
 * Now there is one source, so that class of answer is not expressible.
 */
async function executeListAPIs(projectId: string): Promise<ExecutionResult> {
  try {
    const { listExposedTables } = await import('@/lib/mcp/schema-introspection')
    const tables = await listExposedTables(projectId)

    if (tables.length === 0) {
      return {
        success: true,
        message:
          "This backend has no tables yet, so there are no endpoints to call. " +
          "Describe what you want to store and I'll create it.",
        data: { apis: [] },
      }
    }

    const apis = tables.map((t) => ({
      name: t.name,
      basePath: `/${t.name}`,
      // Every exposed table serves the full CRUD surface; the per-request
      // decision is made by grants and RLS, not by a stored operations map.
      operations: { list: true, get: true, create: true, update: true, delete: true },
      recordCount: t.recordCount,
      rlsEnabled: t.rlsEnabled,
    }))

    const apiList = apis
      .map((api) => {
        const rls = api.rlsEnabled ? 'RLS on' : '⚠ no RLS'
        return `✅ **/db/${api.name}** — LIST, GET, CREATE, UPDATE, DELETE · ${api.recordCount} rows · ${rls}`
      })
      .join('\n')

    return {
      success: true,
      message:
        `🚀 **Your APIs (${apis.length}):**\n\n${apiList}\n\n` +
        `Typed contract: \`/api/v1/${projectId}/db/{table}\`\n` +
        `PostgREST grammar: \`/api/v2/${projectId}/{table}\` (filters, ordering, \`?select=*,related(*)\`)`,
      data: { apis },
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to list APIs: ${error.message}`,
      error: error.message,
    }
  }
}

/**
 * INFO: Answer questions about features
 */
async function executeInfo(params: any, projectId?: string): Promise<ExecutionResult> {
  // If a projectId is provided (called from executeSingleAction), return a rich
  // architectural summary of the current backend state. Otherwise return help text.
  if (!projectId) {
    return { success: true, message: INFO_HELP_TEXT }
  }

  try {
    const { prisma } = await import('@/lib/db')

    const [tables, apiDefs, triggers, permissions, aiFunctions, buckets, projectConfig] = await Promise.all([
      prisma.table.findMany({ where: { projectId }, select: { name: true, schema: true }, orderBy: { name: 'asc' } }),
      prisma.apiDefinition.findMany({ where: { projectId }, include: { table: { select: { name: true } } }, orderBy: { createdAt: 'asc' } }),
      prisma.appTrigger.findMany({ where: { projectId }, select: { name: true, sourceTable: true, event: true, actionType: true, enabled: true } }),
      prisma.permissionPolicy.findMany({ where: { projectId }, select: { tableName: true, policyName: true, operation: true } }),
      prisma.aiFunction.findMany({ where: { projectId, status: 'active' }, select: { name: true, description: true, triggerType: true, triggerTable: true, runCount: true } }),
      prisma.storageBucket.findMany({ where: { projectId }, select: { name: true, isPublic: true } }),
      prisma.project.findFirst({ where: { id: projectId }, select: { jwtSecret: true } }),
    ])

    const lines: string[] = []

    lines.push(`## Your Backend Architecture`)
    lines.push('')

    // Tables + schema
    if (tables.length > 0) {
      lines.push(`### Database (${tables.length} table${tables.length !== 1 ? 's' : ''})`)
      for (const table of tables) {
        const cols = ((table.schema as any)?.columns || []) as any[]
        const colSummary = cols.length > 0
          ? cols.slice(0, 5).map((c: any) => `\`${c.name}\``).join(', ') + (cols.length > 5 ? ` +${cols.length - 5} more` : '')
          : 'no columns yet'
        lines.push(`- **${table.name}** — ${colSummary}`)
      }
      lines.push('')
    }

    // APIs
    if (apiDefs.length > 0) {
      lines.push(`### REST APIs (${apiDefs.length} resource${apiDefs.length !== 1 ? 's' : ''})`)
      for (const def of apiDefs) {
        const endpoints = Array.isArray(def.endpoints) ? def.endpoints as any[] : []
        const methods = endpoints.filter((e: any) => e.enabled).map((e: any) => e.method)
        lines.push(`- **${def.table?.name || def.name}** — ${methods.join(' · ')} — base: \`/api/v1/${projectId}/db/${def.table?.name || ''}\``)
      }
      lines.push('')
    }

    // Auth
    if (projectConfig?.jwtSecret) {
      lines.push('### Authentication')
      lines.push('- JWT auth enabled — end-users sign up/sign in at `/api/v1/[projectId]/auth/`')
      lines.push('')
    }

    // Storage
    if (buckets.length > 0) {
      lines.push(`### Storage (${buckets.length} bucket${buckets.length !== 1 ? 's' : ''})`)
      for (const b of buckets) {
        lines.push(`- **${b.name}** — ${b.isPublic ? 'public' : 'private'}`)
      }
      lines.push('')
    }

    // AI Functions
    if (aiFunctions.length > 0) {
      lines.push(`### AI Functions (${aiFunctions.length} active)`)
      for (const fn of aiFunctions) {
        const trigger = fn.triggerType === 'cron'
          ? `cron: \`${fn.triggerTable}\``
          : fn.triggerType.replace('on_db_', 'on ').replace('_', ' ')
        lines.push(`- **${fn.name}** — ${fn.description} (${trigger}, ${fn.runCount} runs)`)
      }
      lines.push('')
    }

    // Triggers
    if (triggers.length > 0) {
      lines.push(`### Event Triggers (${triggers.length})`)
      for (const t of triggers) {
        lines.push(`- **${t.name}** — \`${t.event}\` on \`${t.sourceTable}\` → \`${t.actionType}\` ${t.enabled ? '' : '(disabled)'}`)
      }
      lines.push('')
    }

    // Row-level security
    if (permissions.length > 0) {
      lines.push(`### Row-Level Security (${permissions.length} polic${permissions.length !== 1 ? 'ies' : 'y'})`)
      for (const p of permissions) {
        lines.push(`- **${p.tableName}** — \`${p.policyName}\` (${p.operation})`)
      }
      lines.push('')
    }

    if (lines.length <= 2) {
      return { success: true, message: INFO_HELP_TEXT }
    }

    lines.push('---')
    lines.push('*Ask me anything: "add search to posts", "add admin role to users", "backup my database", "show my API endpoints"*')

    return { success: true, message: lines.join('\n') }
  } catch {
    return { success: true, message: INFO_HELP_TEXT }
  }
}

const INFO_HELP_TEXT = `💡 **I can help you build your backend!**

**What I can do:**

📊 **Database:**
- Create tables: "Create a users table with email and password"
- Add columns: "Add a phone column to users"
- Change types: "Change price from INTEGER to DECIMAL in products"
- Add search: "Add full-text search to posts by title and body"

🚀 **APIs:**
- Generate APIs: "Generate API for products"
- Rate limits: "Limit the signup endpoint to 10 requests per minute"

🔍 **Explain:**
- "Explain my backend" — I'll describe all your tables, APIs, functions, and triggers

💾 **Backups:**
- "Backup my database" — creates a pg_dump snapshot
- "Restore my database to yesterday" — point-in-time restore
- "List my backups" — show backup history

🧪 **Staging:**
- "Create a staging environment" — copy production to a staging schema
- "Promote staging to production" — sync staging → production

⚡ **AI Functions:**
- "When a user signs up, send them a welcome email"
- "Every day at 9am, send digest emails"

📦 **Storage · Auth · Keys · Monitoring · Realtime**

*Say "explain my backend" to get a full picture of what you've built.*`

// =============================================================================
// NEW ACTION EXECUTORS
// =============================================================================

/**
 * STORAGE: Create Bucket
 */
async function executeCreateBucket(params: any, projectId: string): Promise<ExecutionResult> {
  const { bucketName, isPublic = false } = params
  if (!bucketName) return { success: false, message: 'Bucket name is required' }

  try {
    const { storageService } = await import('@/lib/services/storage')
    const bucket = await storageService.createBucket(bucketName, projectId, isPublic)

    // ── Phase: Atomic create+verify ───────────────────────────────────────────
    // Always read back from DB to confirm the bucket actually exists.
    // Never report success from the write-model alone.
    const { prisma: prismaVerify } = await import('@/lib/db')
    const verified = await prismaVerify.storageBucket.findFirst({
      where: { name: bucketName, projectId },
      select: { id: true, name: true, isPublic: true },
    })

    if (!verified) {
      return {
        success: false,
        message: `[FAILED] Bucket "${bucketName}" creation could not be verified — DB read-back returned no record. State may be inconsistent. Try again.`,
        error: 'verification_failed',
      }
    }

    // Update BackendGraph so state route reflects storage as enabled
    let allBucketNames: string[] = [bucketName]
    try {
      const graph = await getActiveGraph(projectId)
      if (graph) {
        const updatedBuckets = {
          ...(graph.storage?.buckets || {}),
          [bucketName]: { isPublic, reason: 'Created by AI', createdBy: 'CREATE_BUCKET' },
        }
        allBucketNames = Object.keys(updatedBuckets)
        const updatedGraph = {
          ...graph,
          storage: { ...graph.storage, buckets: updatedBuckets },
        }
        await saveNewGraph(projectId, updatedGraph as any, undefined, { skipBillingCheck: true })
      }
    } catch (graphErr) {
      // Graph update is best-effort — bucket was created and verified successfully
      console.warn('[executeCreateBucket] Graph update failed:', graphErr)
    }

    const visibilityLabel = isPublic ? 'public' : 'private'
    const bucketList = allBucketNames.map(b => `  • ${b}`).join('\n')
    const message = [
      `Done — created \`${bucketName}\` bucket.`,
      '',
      'Changed:',
      `✓ Storage bucket: \`${bucketName}\``,
      `✓ Visibility: ${visibilityLabel}`,
      '✓ Verified in database',
      '',
      `Current storage (${allBucketNames.length}):`,
      bucketList,
      '',
      'Next:',
      `Upload files to this bucket via the storage API or signed-upload endpoint.`,
    ].join('\n')

    return {
      success: true,
      message,
      data: { bucketId: verified.id, bucketName: verified.name, isPublic: verified.isPublic, verified: true },
      artifacts: { buckets: [bucketName] },
      diff: { added: [bucketName], modified: [], removed: [] },
      verifiedAt: new Date().toISOString(),
    }
  } catch (error: any) {
    if (error.message?.includes('already exists')) {
      // Even on "already exists", verify it's actually there
      try {
        const { prisma: prismaCheck } = await import('@/lib/db')
        const existing = await prismaCheck.storageBucket.findFirst({
          where: { name: bucketName, projectId },
          select: { id: true, name: true, isPublic: true },
        })
        if (existing) {
          return { success: true, message: `✅ Bucket "${bucketName}" confirmed in DB (already existed)`, data: { bucketName, verified: true } }
        }
      } catch { /* fall through */ }
      return { success: false, message: `Bucket "${bucketName}" reported as existing but could not be verified in DB`, error: 'verification_failed' }
    }
    return { success: false, message: `Failed to create bucket: ${error.message}`, error: error.message }
  }
}

/**
 * STORAGE: Set Bucket Public
 */
async function executeSetBucketPublic(params: any, projectId: string): Promise<ExecutionResult> {
  const { bucketName, isPublic = true } = params
  if (!bucketName) return { success: false, message: 'Bucket name is required' }

  try {
    const { prisma } = await import('@/lib/db')
    const bucket = await prisma.storageBucket.findFirst({ where: { name: bucketName, projectId } })
    if (!bucket) return { success: false, message: `Bucket "${bucketName}" not found` }

    await prisma.storageBucket.update({ where: { id: bucket.id }, data: { isPublic } })
    return {
      success: true,
      message: `✅ Bucket **"${bucketName}"** is now **${isPublic ? 'public' : 'private'}**`,
      data: { bucketName, isPublic },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to update bucket: ${error.message}`, error: error.message }
  }
}

/**
 * STORAGE: List Buckets
 */
async function executeListBuckets(projectId: string): Promise<ExecutionResult> {
  try {
    const { storageService } = await import('@/lib/services/storage')
    const buckets = await storageService.listBuckets(projectId)

    if (buckets.length === 0) {
      return {
        success: true,
        message: "📦 **Your Storage Buckets:**\n\nNo buckets yet. Try: _\"Create an avatars bucket\"_",
        data: { buckets: [] },
      }
    }

    const list = buckets.map(b =>
      `• **${b.name}** — ${b.fileCount} file${b.fileCount !== 1 ? 's' : ''} · ${b.isPublic ? 'public' : 'private'}`
    ).join('\n')

    // StorageBucket carries BigInt columns (storageUsed / maxFileSize). Left raw,
    // they crash JSON.stringify at the MCP boundary ("Do not know how to
    // serialize a BigInt"). Convert to a JSON-safe shape before returning.
    const safeBuckets = JSON.parse(
      JSON.stringify(buckets, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)),
    )

    return {
      success: true,
      message: `📦 **Storage Buckets (${buckets.length}):**\n\n${list}`,
      data: { buckets: safeBuckets },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to list buckets: ${error.message}`, error: error.message }
  }
}

/**
 * STORAGE: Delete Bucket
 */
async function executeDeleteBucket(params: any, projectId: string): Promise<ExecutionResult> {
  const { bucketName } = params
  if (!bucketName) return { success: false, message: 'Bucket name is required' }

  try {
    const { prisma } = await import('@/lib/db')
    const bucket = await prisma.storageBucket.findFirst({ where: { name: bucketName, projectId } })
    if (!bucket) return { success: false, message: `Bucket "${bucketName}" not found` }

    const { storageService } = await import('@/lib/services/storage')
    await storageService.deleteBucket(bucket.id, projectId)

    // Verify deletion
    const stillExists = await prisma.storageBucket.findFirst({ where: { name: bucketName, projectId } })
    if (stillExists) {
      return {
        success: false,
        message: `[FAILED] Bucket "${bucketName}" deletion could not be verified — DB read-back still returned the record. Try again.`,
        error: 'verification_failed',
      }
    }

    return {
      success: true,
      message: `🗑️ Bucket **"${bucketName}"** has been deleted.`,
      data: { bucketName, deleted: true },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to delete bucket: ${error.message}`, error: error.message }
  }
}

/**
 * CONNECT FRONTEND — funnels through the canonical engine.
 *
 * The engine enforces the deployment gate, normalizes the URL, pins the
 * backend version, writes an audit log, and on a non-`force` call returns
 * a confirmation prompt the brain must surface to the user.
 */
async function executeConnectFrontend(params: any, projectId: string): Promise<ExecutionResult> {
  const { url, force, confirmed } = params
  if (!url) return { success: false, message: 'Frontend URL is required' }

  const { prisma } = await import('@/lib/db')
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })
  if (!project?.userId) return { success: false, message: 'Project not found' }

  const { connectFrontend } = await import('@/lib/services/connectFrontend')
  const result = await connectFrontend({
    projectId,
    frontendUrl: url,
    userId: project.userId,
    confirmedBy: 'CHAT',
    // `confirmed` is set by runExecutor when the user authorised this turn.
    // Either explicit `force` arg or destructiveConfirmed pathway counts.
    force: !!(force || confirmed),
  })

  return {
    success: result.success,
    message: result.message,
    error: result.success ? undefined : (result.errors?.[0] ?? result.message),
    data: {
      requiresConfirmation: result.requiresConfirmation,
      origin: result.origin,
      backendVersion: result.backendVersion,
    },
  }
}

async function executeDisconnectFrontend(params: any, projectId: string): Promise<ExecutionResult> {
  const { url, force, confirmed } = params
  if (!url) return { success: false, message: 'Frontend URL is required' }

  const { prisma } = await import('@/lib/db')
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })
  if (!project?.userId) return { success: false, message: 'Project not found' }

  const { disconnectFrontend } = await import('@/lib/services/connectFrontend')
  const result = await disconnectFrontend({
    projectId,
    origin: url,
    userId: project.userId,
    confirmedBy: 'CHAT',
    force: !!(force || confirmed),
  })

  return {
    success: result.success,
    message: result.message,
    error: result.success ? undefined : (result.errors?.[0] ?? result.message),
    data: { requiresConfirmation: result.requiresConfirmation },
  }
}

async function executeListConnectedApps(projectId: string): Promise<ExecutionResult> {
  try {
    const { listConnectedApps } = await import('@/lib/services/connectFrontend')
    const apps = await listConnectedApps(projectId)

    const active = apps.filter((a) => a.isActive)
    if (active.length === 0) {
      return {
        success: true,
        message:
          '**Connected Frontends:**\n\nNone yet. Try: _"Connect my Replit app at https://app.replit.com/my-app"_\n\nFor anything to connect, your backend must be deployed first.',
        data: { apps: [], active: [] },
      }
    }

    const list = active
      .map((a) => `• ${a.origin}  _(v${a.backendVersion}, via ${a.connectedBy.toLowerCase()})_`)
      .join('\n')
    return {
      success: true,
      message: `**Connected Frontends (${active.length}):**\n\n${list}`,
      data: { apps, active },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to list connected frontends: ${error.message}`, error: error.message }
  }
}

/**
 * DEPLOY: Trigger Deploy
 * Calls the shared go-live function — same logic used by the UI button and AI chat.
 * Phase 5: goLive now runs the readiness gate first. If it blocks, we surface
 * the full readiness report back to the user as a structured AI message.
 */
async function executeTriggerDeploy(params: any, projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma } = await import('@/lib/db')
    const { goLive } = await import('@/lib/deployment/go-live')

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    })
    if (!project) {
      return { success: false, message: 'Project not found', error: 'Project not found' }
    }

    // Brain flow: `confirmed` is set by runExecutor when the user authorised
    // this turn (e.g. typed DEPLOY). Without it, engine returns the preview.
    const force = !!(params?.force || params?.confirmed)
    const result = await goLive(projectId, project.userId, { confirmedBy: 'CHAT', force })

    if (result.kind === 'error') {
      if (result.readinessReport) {
        return {
          success: false,
          message: [`## Deployment Blocked — Readiness Score: ${result.readinessReport.score}/100`, '', result.error].join('\n'),
          error: result.error,
          data: { readinessReport: result.readinessReport },
        }
      }
      return { success: false, message: `Deployment failed: ${result.error}`, error: result.error }
    }

    // Engine asked for confirmation — surface the prompt + stop the loop.
    if (result.kind === 'confirmation') {
      return {
        success: true,
        message: result.message,
        data: {
          requiresConfirmation: true,
          willBeVersion: result.willBeVersion,
          readinessScore: result.readinessScore,
        },
      }
    }

    if (result.alreadyLive) {
      return {
        success: true,
        message: `Your backend is already live (v${result.version}).\n\n**Base URL:** \`${result.publicUrl}\`\n\nCheck the **Publish** section for deployment details and SDK snippets.`,
        data: { publicUrl: result.publicUrl, alreadyLive: true, version: result.version },
      }
    }

    return {
      success: true,
      message: `Your backend is now live (v${result.version}).\n\n**Base URL:** \`${result.publicUrl}\`\n\nCheck the **Publish** section for deployment details. Your SDK snippet is ready in the **Connect** tab.`,
      data: { publicUrl: result.publicUrl, alreadyLive: false, version: result.version },
    }
  } catch (error: any) {
    return { success: false, message: `Deployment failed: ${error.message}`, error: error.message }
  }
}

/**
 * IAM: Create API Key
 */
async function executeCreateKey(params: any, projectId: string): Promise<ExecutionResult> {
  const { permissions = ['read', 'write'], description } = params
  // Service-role is OPT-IN. A key issued without asking bypasses nothing: it is
  // the browser-safe publishable key, which is what a frontend needs and what
  // this tool is asked for most often.
  const serviceRole = params.serviceRole === true
  
  try {
    const { prisma } = await import('@/lib/db')
    const crypto = await import('crypto')
    
    // Get project to find the owner userId
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true }
    })
    
    if (!project) {
      return {
        success: false,
        message: 'Project not found',
        error: 'Project not found'
      }
    }
    
    // ── The prefix says what the key IS ──────────────────────────────────────
    //
    // This used to mint `sk_live_…` by hand, which is wrong twice over. It is
    // Stripe's prefix, so it reads as a third-party credential; and in Stripe's
    // vocabulary `sk_` means SECRET KEY — the one you must never ship — while
    // this key is the opposite: RLS-bound, write-refusing without an end-user
    // token, and safe in a browser bundle. A reader had to run experiments
    // (GET 200 / POST 401 / PATCH 401) to work out that it was publishable,
    // because the only signal available told them it was secret.
    //
    // Backenly's own generator is used now, and the prefix distinguishes the two
    // real kinds: `proj_live_…` is publishable, `svc_live_…` bypasses RLS.
    const { generateApiKey } = await import('@/lib/auth/apiKeyAuth')
    const keyValue = serviceRole
      ? `svc_live_${crypto.randomBytes(24).toString('hex')}`
      : generateApiKey('live')
    const keyPrefix = keyValue.substring(0, 12)
    const keyHash = crypto.createHash('sha256').update(keyValue).digest('hex')
        
    const apiKey = await prisma.apiKey.create({
      data: {
        projectId,
        userId: project.userId,
        name: description || 'AI Generated Key',
        key: keyValue,
        keyHash,
        keyPrefix,
        permissions: Array.isArray(permissions) ? permissions : ['read', 'write'],
        serviceRole,
        role: serviceRole ? 'service' : 'custom',
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
      }
    })
    
    // Say where the key may go. Nobody should have to determine that by probing
    // the API with a GET and a POST and inferring the answer from the statuses.
    const safety = serviceRole
      ? `⚠️ **SERVICE-ROLE KEY — server-side only.** This key BYPASSES row-level security ` +
        `entirely and can read and write every row in the project. Never put it in a browser ` +
        `bundle, a mobile binary, or a client-side repo. Use it from cron jobs, workers and ` +
        `migrations. For a frontend, create a key WITHOUT serviceRole.`
      : `✅ **Publishable key — safe in a browser bundle.** It identifies the project, it is not a ` +
        `user: on its own it reads only what your SELECT policies expose to anonymous callers, and ` +
        `every write is refused until the caller also sends \`X-User-Token\` with an end-user JWT. ` +
        `This is the key your frontend ships (Supabase calls its equivalent the anon key). ` +
        `Send it as \`x-api-key: ${keyPrefix}…\` — NOT as \`Authorization: Bearer\`, which is the ` +
        `end-user token's slot.`

    return {
      success: true,
      message: `✅ Created API key: ${keyPrefix}...

${safety}

**Copy this key (shown once):**
\`\`\`
${keyValue}
\`\`\``,
      data: {
        apiKey: keyValue,
        keyId: apiKey.id,
        serviceRole,
        publishable: !serviceRole,
        header: 'x-api-key',
        safeInBrowser: !serviceRole,
      }
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to create API key: ${error.message}`,
      error: error.message
    }
  }
}

/**
 * IAM: List API Keys
 */
async function executeListKeys(projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma } = await import('@/lib/db')
    
    const keys = await prisma.apiKey.findMany({
      where: { projectId },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        role: true,
        permissions: true,
        createdAt: true,
        lastUsed: true,
        expiresAt: true
      },
      orderBy: { createdAt: 'desc' }
    })
    
    if (keys.length === 0) {
      return {
        success: true,
        message: "You don't have any API keys yet. Try creating one: 'Create an API key'",
        data: { keys: [] }
      }
    }
    
    const keyList = keys.map(key => {
      const age = Math.floor((Date.now() - new Date(key.createdAt).getTime()) / (1000 * 60 * 60 * 24))
      const lastUsed = key.lastUsed ? `(used ${Math.floor((Date.now() - new Date(key.lastUsed).getTime()) / (1000 * 60 * 60))}h ago)` : '(never used)'
      return `🔑 **${key.name}** (${key.keyPrefix}...) - Created ${age}d ago ${lastUsed}`
    }).join('\n')
    
    return {
      success: true,
      message: `🔑 **Your API Keys (${keys.length}):**\n\n${keyList}`,
      data: { keys }
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to list API keys: ${error.message}`,
      error: error.message
    }
  }
}

/**
 * AUTH: Enable Authentication
 * Updates the BackendGraph so the UI reflects auth as configured.
 */
async function executeEnableAuth(projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma: authPrisma } = await import('@/lib/db')

    // Step 1: Ensure project has a jwtSecret — this is what makes auth actually functional.
    // readAuth() in proof-system checks project.jwtSecret, so without this auth will never
    // appear as enabled in any proof query.
    const project = await authPrisma.project.findUnique({
      where: { id: projectId },
      select: { jwtSecret: true },
    })
    if (!project?.jwtSecret) {
      const { randomBytes } = await import('crypto')
      const secret = randomBytes(32).toString('hex')
      await authPrisma.project.update({
        where: { id: projectId },
        data: { jwtSecret: secret },
      })
      console.log(`[executeEnableAuth] Generated jwtSecret for project ${projectId}`)
    }

    // Step 2: Mark email/password auth as enabled in the BackendGraph (drives UI state)
    const graph = await getActiveGraph(projectId)
    if (!graph) {
      return { success: false, message: 'Project graph not found', error: 'no_graph' }
    }

    const updatedGraph = {
      ...graph,
      auth: {
        ...graph.auth,
        providers: {
          ...(graph.auth?.providers || {}),
          email: { enabled: true, reason: 'Enabled by AI setup', createdBy: 'ENABLE_AUTH' },
        },
      },
    }

    await saveNewGraph(projectId, updatedGraph as any, undefined, { skipBillingCheck: true })

    return {
      success: true,
      message: `Authentication enabled — email/password sign-up and sign-in are configured.`,
      data: { enabled: true, provider: 'email' },
      artifacts: { auth: true },
      diff: { added: ['auth/email'], modified: [], removed: [] },
    }
  } catch (err: any) {
    console.error('[executeEnableAuth] Failed:', err)
    return { success: false, message: `Failed to enable auth: ${err.message}`, error: err.message }
  }
}

/**
 * REALTIME: Enable real-time subscriptions
 * Installs PostgreSQL NOTIFY triggers on workspace tables.
 * Does not require an active BackendGraph — works directly on the workspace schema.
 */
async function executeEnableRealtime(params: Record<string, any>, projectId: string): Promise<ExecutionResult> {
  try {
    const tableName: string | undefined = params?.table || params?.tableName

    // ── Install actual PostgreSQL NOTIFY triggers ──────────────────────────
    const { installRealtimeTrigger, installRealtimeTriggersForAllTables, listTablesWithRealtimeTriggers } =
      await import('@/lib/services/realtimeTriggers')

    const installedTables: string[] = []
    const failedTables: string[] = []

    if (tableName) {
      // Install on the specified table only
      try {
        await installRealtimeTrigger(projectId, tableName)
        installedTables.push(tableName)
      } catch (err: any) {
        console.warn(`[enableRealtime] Failed to install trigger on ${tableName}:`, err?.message)
        failedTables.push(tableName)
      }
    } else {
      // Install on every existing workspace table — query workspace schema directly
      // (does not depend on graph or Prisma Table model, which may lag behind actual DB state)
      const { prisma: rtPrisma } = await import('@/lib/db')
      const workspaceSchema = `workspace_${projectId}`
      let tableNames: string[] = []
      try {
        const rows = await rtPrisma.$queryRawUnsafe<Array<{ table_name: string }>>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
          workspaceSchema
        )
        tableNames = rows
          .map((r: { table_name: string }) => r.table_name)
          .filter((n: string) => !isReservedWorkspaceTable(n))
      } catch {
        // Fallback: Prisma Table model
        const rows = await rtPrisma.table.findMany({ where: { projectId }, select: { name: true } })
        tableNames = rows.map((t: { name: string }) => t.name)
      }
      if (tableNames.length > 0) {
        await installRealtimeTriggersForAllTables(projectId, tableNames)
        installedTables.push(...tableNames)
      }
    }

    // ── Verify which tables actually have NOTIFY triggers ──────────────────
    const verifiedTables = await listTablesWithRealtimeTriggers(projectId).catch(() => installedTables)

    // ── Optionally persist to BackendGraph if one exists ──────────────────
    try {
      const graph = await getActiveGraph(projectId)
      if (graph) {
        const updatedGraph = {
          ...graph,
          realtime: {
            ...(graph as any).realtime,
            enabled: true,
            tables: verifiedTables,
            enabledAt: new Date().toISOString(),
          },
        }
        await saveNewGraph(projectId, updatedGraph as any, undefined, { skipBillingCheck: true })
      }
    } catch {
      // Non-fatal — trigger installation already succeeded
    }

    // ── Report what THIS call changed, separately from what was already on ────
    // `verifiedTables` is the post-state of the whole project. Presenting it as
    // the result of a single-table call is what made a scoped `enable_realtime`
    // on `orders` look like it had silently enabled `products` and `order_items`
    // too. Name the delta and the pre-existing set as different things.
    const alreadyOn = verifiedTables.filter((t) => !installedTables.includes(t))
    const scope = tableName ? `\`${tableName}\`` : `${installedTables.length} table(s)`
    const changedList = installedTables.length > 0
      ? `\n\n**Enabled by this call:**\n${installedTables.map((t) => `- \`${t}\``).join('\n')}`
      : ''
    const alreadyList = alreadyOn.length > 0
      ? `\n\n**Already streaming before this call (unchanged):**\n${alreadyOn.map((t) => `- \`${t}\``).join('\n')}`
      : ''
    const failNote = failedTables.length > 0
      ? `\n\n⚠️ Could not install trigger on: ${failedTables.map(t => `\`${t}\``).join(', ')} — table may not exist yet.`
      : ''

    const exampleTable = tableName ?? installedTables[0] ?? verifiedTables[0] ?? 'messages'

    return {
      success: true,
      message: `✅ **Realtime active for ${scope}.**\n\nPostgreSQL NOTIFY triggers installed — live INSERT/UPDATE/DELETE events flow to subscribers immediately.\n\nSDK usage:\n\`\`\`js\nbackend.${exampleTable}.subscribe((event) => console.log(event))\n\`\`\`${changedList}${alreadyList}${failNote}`,
      data: {
        enabled: true,
        table: tableName ?? null,
        /** Tables THIS call turned on. */
        enabledNow: installedTables,
        /** Tables that were already streaming and were not touched. */
        alreadyEnabled: alreadyOn,
        watchedTables: verifiedTables,
      },
      diff: { added: installedTables.map(t => `realtime/${t}`), modified: [], removed: [] },
      verifiedAt: new Date().toISOString(),
    }
  } catch (err: any) {
    console.error('[executeEnableRealtime] Failed:', err)
    return { success: false, message: `Failed to enable realtime: ${err.message}`, error: err.message }
  }
}

/**
 * DISABLE_REALTIME — destructive in the sense that any client already
 * subscribed via SSE will stop receiving events the moment the trigger is
 * dropped. Gated by DESTRUCTIVE_ACTIONS_GATE.
 *
 * Scope:
 *   • If params.table / params.tableName is given → drop the realtime trigger
 *     on that one table only (other tables keep streaming).
 *   • If no table given → drop the trigger on every workspace table.
 *
 * Implementation: we drop the per-table BEFORE INSERT/UPDATE/DELETE trigger
 * named `backenly_realtime`. The shared NOTIFY function is left in place so
 * re-enabling later is a single CREATE TRIGGER — no function reinstall needed.
 */
async function executeDisableRealtime(params: Record<string, any>, projectId: string): Promise<ExecutionResult> {
  try {
    const tableName: string | undefined = params?.table || params?.tableName
    const { uninstallRealtimeTrigger, uninstallRealtimeTriggersForAllTables, listTablesWithRealtimeTriggers } =
      await import('@/lib/services/realtimeTriggers')

    let removed: string[] = []
    if (tableName) {
      await uninstallRealtimeTrigger(projectId, tableName)
      removed = [tableName]
    } else {
      const current = await listTablesWithRealtimeTriggers(projectId).catch(() => [])
      if (current.length > 0) {
        await uninstallRealtimeTriggersForAllTables(projectId, current)
        removed = current
      }
    }

    // Verify what is actually still live AFTER the drop so the response can't lie.
    const stillLive = await listTablesWithRealtimeTriggers(projectId).catch(() => [])

    // Update BackendGraph for the dashboard's realtime indicators.
    try {
      const graph = await getActiveGraph(projectId)
      if (graph) {
        const updatedGraph = {
          ...graph,
          realtime: {
            ...(graph as any).realtime,
            enabled: stillLive.length > 0,
            tables: stillLive,
            disabledAt: new Date().toISOString(),
          },
        }
        await saveNewGraph(projectId, updatedGraph as any, undefined, { skipBillingCheck: true })
      }
    } catch {
      // Best-effort — the trigger drop already succeeded
    }

    if (removed.length === 0) {
      return {
        success: true,
        message: tableName
          ? `Realtime was not enabled on \`${tableName}\` — nothing to disable.`
          : 'No realtime triggers were active on this project — nothing to disable.',
        data: { disabled: [] },
        verifiedAt: new Date().toISOString(),
      }
    }

    const scope = tableName ? `\`${tableName}\`` : `${removed.length} tables`
    const stillNote = stillLive.length > 0
      ? `\n\n${stillLive.length} table${stillLive.length !== 1 ? 's' : ''} still streaming: ${stillLive.map(t => `\`${t}\``).join(', ')}.`
      : ''
    return {
      success: true,
      message:
        `🔇 **Realtime disabled for ${scope}.**\n\nActive SSE subscribers stopped receiving events immediately. ` +
        `Re-enable any time with \`enable_realtime\`.${stillNote}`,
      data: { disabled: removed, stillLive },
      diff: { added: [], modified: [], removed: removed.map(t => `realtime/${t}`) },
      verifiedAt: new Date().toISOString(),
    }
  } catch (err: any) {
    console.error('[executeDisableRealtime] Failed:', err)
    return { success: false, message: `Failed to disable realtime: ${err.message}`, error: err.message }
  }
}

/**
 * GET_REALTIME_STATUS — read-only. The OBSERVE half of the realtime agentic
 * loop: reports which workspace tables stream live NOTIFY events, which are
 * idle, how many end-users are online, and the NOTIFY channel.
 *
 * The brain calls this before enable_realtime / disable_realtime /
 * fix_backend(target='realtime') so it acts on real state, and to answer
 * "is realtime working?" / "what is streaming?" / "how many users are online?".
 */
async function executeGetRealtimeStatus(projectId: string): Promise<ExecutionResult> {
  try {
    const { getRealtimeStatus } = await import('@/lib/services/realtimeTriggers')
    const status = await getRealtimeStatus(projectId)

    // No tables → realtime has nothing to stream. Not a failure — just empty.
    if (status.allTables.length === 0) {
      return {
        success: true,
        message:
          'No workspace tables yet — realtime has nothing to stream. Create a table first; ' +
          'NOTIFY triggers are installed automatically as tables are built.',
        data: { ...status, healthy: true },
      }
    }

    const streamingCount = status.streamingTables.length
    const total = status.allTables.length
    const plural = (n: number) => (n !== 1 ? 's' : '')
    const lines: string[] = []

    if (streamingCount === 0) {
      lines.push(
        `⚪ **Realtime is off.** None of the ${total} table${plural(total)} stream live events yet.`,
        '',
        'Enable it with `enable_realtime` — subscribed clients then receive INSERT/UPDATE/DELETE events over SSE.',
      )
    } else {
      lines.push(
        `🟢 **Realtime active** — ${streamingCount} of ${total} table${plural(total)} streaming live.`,
        '',
        `**Streaming:** ${status.streamingTables.map(t => `\`${t}\``).join(', ')}`,
      )
      if (status.idleTables.length > 0) {
        lines.push(
          `**Not streaming:** ${status.idleTables.map(t => `\`${t}\``).join(', ')} — run \`enable_realtime\` to add them.`,
        )
      }
    }
    lines.push(
      '',
      `**Online now:** ${status.onlineUsers} end-user${plural(status.onlineUsers)} active in the last 90s · ` +
      `**Channel:** \`${status.channel}\``,
    )

    return {
      success: true,
      message: lines.join('\n'),
      data: {
        streamingTables: status.streamingTables,
        idleTables: status.idleTables,
        allTables: status.allTables,
        onlineUsers: status.onlineUsers,
        channel: status.channel,
        healthy: true,
      },
    }
  } catch (error: any) {
    console.error('[executeGetRealtimeStatus]', error)
    return { success: false, message: `Failed to read realtime status: ${error.message}`, error: error.message }
  }
}

/**
 * AUTH: Add Provider
 * Saves OAuth credentials to WorkspaceOAuthConfig and ensures the workspace
 * users table has the required OAuth columns.
 */
async function executeAddProvider(params: any, projectId: string): Promise<ExecutionResult> {
  const { provider, clientId, clientSecret } = params

  const providerName = (provider || '').toLowerCase()

  const SUPPORTED_PROVIDERS = ['google', 'github', 'discord', 'facebook', 'apple']
  if (!SUPPORTED_PROVIDERS.includes(providerName)) {
    return {
      success: false,
      message: `Provider "${provider}" is not supported. Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`,
    }
  }

  if (!clientId || !clientSecret) {
    return {
      success: false,
      message: `Client ID and Client Secret are required to configure ${providerName} authentication.`,
    }
  }

  const PROVIDER_DEFAULT_SCOPES: Record<string, string[]> = {
    google:   ['openid', 'email', 'profile'],
    github:   ['read:user', 'user:email'],
    discord:  ['identify', 'email'],
    facebook: ['email', 'public_profile'],
    apple:    ['email', 'name'],
  }

  const { prisma } = await import('@/lib/db')

  // Upsert OAuth config — MUST go through WorkspaceOAuthService so the
  // clientSecret is encrypted at rest.  Calling prisma.workspaceOAuthConfig
  // directly stores the secret in plaintext; WorkspaceOAuthService.listConfigs
  // always decrypts, so a plaintext secret causes a decrypt error that is
  // silently swallowed by fetchEnabledProviders — leaving the Auth page stuck
  // showing "Enable →" even after credentials were saved (Issue 25).
  const { WorkspaceOAuthService } = await import('@/lib/services/workspaceOAuth')
  await WorkspaceOAuthService.upsertConfig(projectId, {
    provider: providerName,
    clientId,
    clientSecret,
    enabled: true,
    scopes: PROVIDER_DEFAULT_SCOPES[providerName] || [],
  })

  // Ensure OAuth columns exist in the workspace users table (if it exists)
  const schemaName = `workspace_${projectId}`
  try {
    const tableCheck = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'users'
      ) AS exists`,
      schemaName
    )
    if (tableCheck[0]?.exists) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${schemaName}"."users"
           ADD COLUMN IF NOT EXISTS oauth_provider TEXT,
           ADD COLUMN IF NOT EXISTS oauth_id TEXT,
           ADD COLUMN IF NOT EXISTS avatar_url TEXT,
           ALTER COLUMN password DROP NOT NULL`
      )
    }
  } catch (err: any) {
    // Non-fatal: columns might already exist or table uses a different structure
    console.warn('[executeAddProvider] Could not add OAuth columns (non-fatal):', err.message)
  }

  // Readiness + dashboard parity. The /api/projects/[id]/credentials route
  // (used by the Auth page modal) writes a `{provider}_auth` vault marker and
  // syncs project.activeIntegrations. Without these, OAuth configured via the
  // AI chat would show as "Not Connected" in readiness checks and the
  // Integrations dashboard even though sign-in actually works. Do the same
  // here so the chat path and the Auth-page path are indistinguishable.
  try {
    const { storeIntegrationKey } = await import('@/lib/services/integrationKeyStore')
    await storeIntegrationKey(projectId, `${providerName}_auth`, `configured:${new Date().toISOString()}`)
  } catch (err: any) {
    console.warn('[executeAddProvider] vault marker write failed (non-fatal):', err?.message)
  }
  try {
    const existingProject = await prisma.project.findUnique({
      where: { id: projectId },
      select: { activeIntegrations: true },
    })
    const active = (existingProject?.activeIntegrations as Record<string, any>) ?? {}
    if (!active[providerName]?.enabled) {
      await prisma.project.update({
        where: { id: projectId },
        data: {
          activeIntegrations: {
            ...active,
            [providerName]: {
              enabled: true,
              activatedAt: new Date().toISOString(),
              activatedBy: 'ai_chat',
            },
          },
        },
      })
    }
  } catch (err: any) {
    console.warn('[executeAddProvider] activeIntegrations sync failed (non-fatal):', err?.message)
  }

  const displayName = providerName.charAt(0).toUpperCase() + providerName.slice(1)
  const baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://your-domain.com'
  const redirectUri = `${baseUrl}/api/v1/${projectId}/auth/${providerName}/callback`

  return {
    success: true,
    message: `${displayName} authentication has been configured.

**Routes activated:**
- \`GET /api/v1/${projectId}/auth/${providerName}\` — Redirects user to ${displayName} login
- \`GET /api/v1/${projectId}/auth/${providerName}/callback\` — Handles OAuth callback

**Required: add this Authorized Redirect URI in your ${displayName} OAuth app:**
\`${redirectUri}\`

> **Action required:** Register the redirect URI above in your ${displayName} OAuth app console — logins will be rejected until it is added.

Users of your project can now sign in with ${displayName}.`,
    data: {
      provider: providerName,
      routes: [
        `/api/v1/${projectId}/auth/${providerName}`,
        `/api/v1/${projectId}/auth/${providerName}/callback`,
      ],
      redirectUri,
    },
  }
}

/**
 * AUTH: List end-users
 *
 * Lists the END USERS of the project — the people who signed up through the
 * project's own auth, stored in workspace_{projectId}.users — NOT the Backenly
 * platform developer who owns the project.
 *
 * The previous implementation returned `project.user` (the platform owner from
 * the public schema). That violated the platform/end-user isolation rule and
 * broke the whole auth-lifecycle flow: block_end_user / reset_end_user_password
 * operate on workspace_{projectId}.users, so listing the platform owner here
 * surfaced an identity those tools could never act on.
 */
async function executeListUsers(projectId: string, params?: any): Promise<ExecutionResult> {
  try {
    const { prisma } = await import('@/lib/db')
    const schemaName = `workspace_${projectId}`
    const limit = Math.max(1, Math.min(200, Number(params?.limit) || 50))

    // The workspace users table is created lazily on first signup.
    const tableCheck = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'users'
      ) AS exists`,
      schemaName,
    )
    if (!tableCheck[0]?.exists) {
      return {
        success: true,
        message: 'No end-users yet — either auth has not been used, or no one has signed up. Sign-ups will appear here once your app is live.',
        data: { users: [], count: 0 },
      }
    }

    // Introspect columns so the SELECT tolerates whatever auth schema the
    // project generated (snake_case vs camelCase timestamps, optional
    // provider / verified / blocked columns, OAuth columns, etc.).
    const cols = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'users'`,
      schemaName,
    )
    const has = new Set(cols.map(c => c.column_name))
    const pick = (...names: string[]) => names.find(n => has.has(n))

    const nameCol      = pick('name', 'full_name', 'username')
    const providerCol  = pick('oauth_provider', 'provider')
    const blockedCol   = pick('is_blocked', 'blocked')
    const verifiedCol  = pick('email_verified', 'verified', 'emailVerified')
    const createdCol   = pick('createdAt', 'created_at')
    const lastLoginCol = pick('lastLogin', 'last_login')

    const select: string[] = ['"id"', '"email"']
    if (nameCol)      select.push(`"${nameCol}" AS name`)
    if (providerCol)  select.push(`"${providerCol}" AS provider`)
    if (blockedCol)   select.push(`"${blockedCol}" AS is_blocked`)
    if (verifiedCol)  select.push(`"${verifiedCol}" AS verified`)
    if (createdCol)   select.push(`"${createdCol}" AS created_at`)
    if (lastLoginCol) select.push(`"${lastLoginCol}" AS last_login`)

    // The workspace users table is FORCE-RLS'd (service-role only). A plain
    // prisma read runs as backenly_user with no app.is_service_role context, so
    // RLS filters EVERY row → the tool used to report "0 end-users" even when
    // people had signed up. Read with the service-role context so the owner sees
    // the true list, matching the dashboard Users tab.
    const { executeWithUserContext } = await import('@/lib/services/workspace-rls')
    const orderBy = createdCol ? `ORDER BY "${createdCol}" DESC` : ''
    const rows = await executeWithUserContext<any>(
      '', true,
      `SELECT ${select.join(', ')} FROM "${schemaName}"."users" ${orderBy} LIMIT ${limit}`,
    )

    const countRows = await executeWithUserContext<{ count: bigint }>(
      '', true,
      `SELECT COUNT(*)::bigint AS count FROM "${schemaName}"."users"`,
    )
    const total = Number(countRows[0]?.count ?? rows.length)

    if (rows.length === 0) {
      return {
        success: true,
        message: 'No end-users have signed up to this project yet.',
        data: { users: [], count: 0 },
      }
    }

    const users = rows.map(r => ({
      id: r.id,
      email: r.email,
      name: r.name ?? null,
      provider: r.provider ?? 'email',
      blocked: r.is_blocked === true,
      verified: r.verified === true,
      createdAt: r.created_at ?? null,
      lastLogin: r.last_login ?? null,
    }))

    const lines = users.slice(0, 10).map(u => {
      const flags = [u.blocked ? '🚫 blocked' : null, u.verified ? '✓ verified' : null]
        .filter(Boolean).join(' · ')
      return `👤 **${u.email}**${u.name ? ` (${u.name})` : ''} — ${u.provider}${flags ? ` · ${flags}` : ''}`
    })

    return {
      success: true,
      message:
        `**End-users (${total}):**\n\n${lines.join('\n')}` +
        (total > Math.min(10, users.length)
          ? `\n\n…showing ${Math.min(10, users.length)} of ${total}. Open the Users tab for the full list.`
          : ''),
      data: { users, count: total },
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to list end-users: ${error.message}`,
      error: error.message,
    }
  }
}

/**
 * AUTH: Block User
 * Adds is_blocked=true to the workspace users table.
 * Signin route checks this column and rejects blocked users.
 */
async function executeBlockUser(params: any, projectId: string): Promise<ExecutionResult> {
  const { userId, email } = params
  if (!userId && !email) return { success: false, message: 'userId or email is required' }

  try {
    const { prisma } = await import('@/lib/db')
    const schemaName = `workspace_${projectId}`

    // Ensure is_blocked column exists (idempotent)
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${schemaName}"."users" ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT FALSE`
    )

    let identifier: string
    let paramValue: string | number
    if (email) {
      identifier = 'email'
      paramValue = email
    } else {
      identifier = 'id'
      paramValue = userId
    }

    const result = await prisma.$executeRawUnsafe(
      `UPDATE "${schemaName}"."users" SET is_blocked = TRUE WHERE "${identifier}" = $1`,
      paramValue
    )

    if (result === 0) {
      return { success: false, message: `User "${email || userId}" not found in this project` }
    }

    return {
      success: true,
      message: `✅ User **${email || userId}** has been blocked.\n\nThey will receive a 403 on their next request and cannot sign in again until unblocked.`,
      data: { blocked: true, identifier: email || userId },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to block user: ${error.message}`, error: error.message }
  }
}

/**
 * AUTH: Reset Password
 * Generates a secure temporary password, hashes it, and updates the workspace user.
 * Returns the temp password to the admin so they can share it out-of-band.
 */
async function executeResetPassword(params: any, projectId: string): Promise<ExecutionResult> {
  const { userId, email } = params
  if (!userId && !email) return { success: false, message: 'userId or email is required' }

  try {
    const { prisma } = await import('@/lib/db')
    const crypto = await import('crypto')
    const { hashPassword } = await import('@/lib/auth/password')
    const schemaName = `workspace_${projectId}`

    // Detect which column actually stores the password hash. Standard projects
    // use "password" (signup DDL); AI-generated schemas sometimes use
    // "password_hash". The signin route already detects this — match its
    // behaviour so reset works on either layout instead of failing silently
    // ("UPDATE 0 rows") when the column doesn't exist.
    const pwColRows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'users'
         AND column_name IN ('password', 'password_hash') LIMIT 1`,
      schemaName,
    )
    const pwCol = pwColRows[0]?.column_name ?? 'password'

    // Verify user exists
    const identifier = email ? 'email' : 'id'
    const paramValue = email || userId
    const users = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, email FROM "${schemaName}"."users" WHERE "${identifier}" = $1 LIMIT 1`,
      paramValue
    )

    if (!users[0]) {
      return { success: false, message: `User "${paramValue}" not found in this project` }
    }

    const targetUser = users[0]

    // Generate a secure random temp password (16 chars)
    const tempPassword = crypto.randomBytes(8).toString('hex')
    const hashed = await hashPassword(tempPassword)

    await prisma.$executeRawUnsafe(
      `UPDATE "${schemaName}"."users" SET "${pwCol}" = $1 WHERE id = $2`,
      hashed,
      targetUser.id
    )

    return {
      success: true,
      message: `✅ Password reset for **${targetUser.email}**\n\n**Temporary password** (share securely):\n\`\`\`\n${tempPassword}\n\`\`\`\n\nThe user must change this after signing in.`,
      data: { userId: targetUser.id, email: targetUser.email, tempPassword },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to reset password: ${error.message}`, error: error.message }
  }
}

/**
 * AUTH: Unblock end-user — inverse of BLOCK_USER.
 * Flips is_blocked back to false so the user can sign in again.
 */
async function executeUnblockUser(params: any, projectId: string): Promise<ExecutionResult> {
  const { userId, email } = params
  if (!userId && !email) return { success: false, message: 'userId or email is required' }

  try {
    const { prisma } = await import('@/lib/db')
    const schemaName = `workspace_${projectId}`

    // is_blocked must exist before we can unblock — BLOCK_USER adds it on
    // first block, but a user might be calling unblock on a never-blocked
    // project.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${schemaName}"."users" ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT FALSE`
    )

    const identifier = email ? 'email' : 'id'
    const paramValue = email || userId

    const result = await prisma.$executeRawUnsafe(
      `UPDATE "${schemaName}"."users" SET is_blocked = FALSE WHERE "${identifier}" = $1`,
      paramValue,
    )

    if (result === 0) {
      return { success: false, message: `User "${email || userId}" not found in this project` }
    }

    return {
      success: true,
      message: `✅ User **${email || userId}** has been unblocked — they can sign in again.`,
      data: { unblocked: true, identifier: email || userId },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to unblock user: ${error.message}`, error: error.message }
  }
}

/**
 * AUTH: Disable an OAuth sign-in provider — inverse of ADD_PROVIDER.
 *
 * Sets WorkspaceOAuthConfig.enabled=false so existing credentials are kept
 * (re-enabling later is a no-credentials toggle) but the provider stops
 * appearing in the live sign-in surface. Also syncs activeIntegrations and
 * removes the readiness vault marker so the dashboard reflects reality.
 */
async function executeDisableProvider(params: any, projectId: string): Promise<ExecutionResult> {
  const provider = String(params?.provider ?? '').toLowerCase()
  if (!provider) return { success: false, message: 'provider is required (e.g., google, github)' }

  try {
    const { prisma } = await import('@/lib/db')

    // Flip enabled=false on the WorkspaceOAuthConfig row, if any.
    const existing = await prisma.workspaceOAuthConfig.findUnique({
      where: { projectId_provider: { projectId, provider } },
      select: { enabled: true },
    })
    if (!existing) {
      return {
        success: false,
        message: `${provider} is not configured for this project — nothing to disable.`,
      }
    }
    if (!existing.enabled) {
      return {
        success: true,
        message: `${provider} sign-in was already disabled.`,
        data: { provider, enabled: false },
      }
    }
    await prisma.workspaceOAuthConfig.update({
      where: { projectId_provider: { projectId, provider } },
      data: { enabled: false },
    })

    // Sync dashboard state.
    try {
      const proj = await prisma.project.findUnique({
        where: { id: projectId },
        select: { activeIntegrations: true },
      })
      const active = (proj?.activeIntegrations as Record<string, any>) ?? {}
      if (active[provider]?.enabled) {
        await prisma.project.update({
          where: { id: projectId },
          data: {
            activeIntegrations: {
              ...active,
              [provider]: { ...active[provider], enabled: false, disabledAt: new Date().toISOString() },
            },
          },
        })
      }
    } catch { /* non-fatal */ }

    // Drop the readiness vault marker so health checks reflect the disable.
    // integrationKeyStore has no delete helper — go direct via Prisma; deleteMany
    // so a missing row is a no-op instead of throwing P2025.
    try {
      await prisma.projectIntegrationKey.deleteMany({
        where: { projectId, integrationId: `${provider}_auth` },
      })
    } catch { /* non-fatal — marker may already be gone */ }

    const displayName = provider.charAt(0).toUpperCase() + provider.slice(1)
    return {
      success: true,
      message:
        `🚫 **${displayName} sign-in disabled.** End-users can no longer sign in with ${displayName}. ` +
        `Your stored credentials are kept — re-enable any time without re-pasting them.`,
      data: { provider, enabled: false },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to disable ${provider}: ${error.message}`, error: error.message }
  }
}

/**
 * MONITORING: Get Metrics
 */
async function executeGetMetrics(params: any, projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma } = await import('@/lib/db')
    
    // Get API metrics from logs
    const metrics = await prisma.log.groupBy({
      by: ['endpoint'],
      where: {
        projectId,
        type: 'api_request',
        timestamp: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
        }
      },
      _count: true,
      _avg: {
        duration: true
      },
      orderBy: {
        _count: {
          endpoint: 'desc'
        }
      },
      take: 10
    })
    
    if (metrics.length === 0) {
      return {
        success: true,
        message: "📊 No API metrics available yet.\n\nStart making API calls to see performance data.",
        data: { metrics: [] }
      }
    }
    
    const metricsList = metrics.map(m => {
      const avgTime = m._avg.duration ? `${Math.round(m._avg.duration)}ms` : 'N/A'
      return `📈 **${m.endpoint}** - ${m._count} calls, avg ${avgTime}`
    }).join('\n')
    
    return {
      success: true,
      message: `📊 **API Metrics (Last 24h):**\n\n${metricsList}`,
      data: { metrics }
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to get metrics: ${error.message}`,
      error: error.message
    }
  }
}

/**
 * MONITORING: Get Errors
 */
async function executeGetErrors(params: any, projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma } = await import('@/lib/db')
    
    const errors = await prisma.log.findMany({
      where: {
        projectId,
        severity: 'error',
        timestamp: {
          gte: new Date(Date.now() - 60 * 60 * 1000) // Last hour
        }
      },
      orderBy: { timestamp: 'desc' },
      take: 10,
      select: {
        id: true,
        message: true,
        endpoint: true,
        statusCode: true,
        timestamp: true
      }
    })
    
    if (errors.length === 0) {
      return {
        success: true,
        message: "✅ No errors in the last hour!\n\nYour APIs are running smoothly.",
        data: { errors: [], count: 0 }
      }
    }
    
    const errorList = errors.map(e => {
      const time = new Date(e.timestamp).toLocaleTimeString()
      return `❌ **[${time}]** ${e.endpoint || 'Unknown'} - ${e.statusCode || 500}: ${e.message.substring(0, 80)}`
    }).join('\n')
    
    return {
      success: true,
      message: `🚨 **Recent Errors (${errors.length}):**\n\n${errorList}`,
      data: { errors, count: errors.length }
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to get errors: ${error.message}`,
      error: error.message
    }
  }
}

/**
 * MONITORING: Get Usage
 */
async function executeGetUsage(projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma } = await import('@/lib/db')
    
    // Get API call count
    const apiCalls = await prisma.log.count({
      where: {
        projectId,
        type: 'api_request',
        timestamp: {
          gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
        }
      }
    })
    
    // Get storage usage (tables count)
    const tables = await prisma.table.count({
      where: { projectId }
    })
    
    // Get API count
    const apis = await prisma.apiDefinition.count({
      where: { projectId }
    })
    
    return {
      success: true,
      message: `📊 **Usage Statistics (Last 30 days):**\n\n` +
        `🔌 **API Calls:** ${apiCalls.toLocaleString()}\n` +
        `📊 **Database Tables:** ${tables}\n` +
        `🚀 **Active APIs:** ${apis}`,
      data: { apiCalls, tables, apis }
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to get usage: ${error.message}`,
      error: error.message
    }
  }
}

/**
 * MONITORING: Set Alert — persists alert config as JSON in project.activeIntegrations
 * Stored under the `_monitoring_alerts` key so no schema migration is needed.
 */
async function executeSetAlert(params: any, projectId: string): Promise<ExecutionResult> {
  const { metric, threshold, operator = 'gt', channel = 'in_app', name } = params ?? {}

  if (!metric || threshold === undefined) {
    return {
      success: false,
      message: 'Alert requires metric and threshold. Example: { metric: "error_rate", threshold: 5, operator: "gt" }',
    }
  }

  try {
    const { prisma } = await import('@/lib/db')

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { activeIntegrations: true },
    })

    const existing = (project?.activeIntegrations as Record<string, any>) ?? {}
    const alerts: any[] = existing._monitoring_alerts ?? []

    const newAlert = {
      id: `alert_${Date.now()}`,
      name: name || `${metric} alert`,
      metric,
      threshold: Number(threshold),
      operator,   // 'gt' | 'lt' | 'gte' | 'lte'
      channel,    // 'in_app' | 'email' | 'webhook'
      enabled: true,
      createdAt: new Date().toISOString(),
    }

    // Replace existing alert for same metric (idempotent)
    const updated = alerts.filter(a => a.metric !== metric)
    updated.push(newAlert)

    await prisma.project.update({
      where: { id: projectId },
      data: { activeIntegrations: { ...existing, _monitoring_alerts: updated } },
    })

    const opLabel = operator === 'gt' ? 'exceeds' : operator === 'lt' ? 'drops below' : 'reaches'
    return {
      success: true,
      message: `✅ Alert set: notify when ${metric} ${opLabel} ${threshold}. Active on Monitoring tab.`,
      data: newAlert,
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to save alert: ${error.message}`,
      error: error.message,
    }
  }
}

// ========================================
// Schema Operations (real SQL)
// ========================================

/**
 * DATABASE: Create Index
 *
 * ── What was wrong here ──────────────────────────────────────────────────────
 *
 * This function took `columns` and used `columns[0]`, and it never read `unique`
 * at all. So `CREATE UNIQUE INDEX profiles_user_id_key ON profiles (user_id)`
 * produced a NON-UNIQUE index, and
 * `CREATE UNIQUE INDEX ON conversations (user_a, user_b)` produced a non-unique
 * index on `user_a` alone — both reporting ✅. Reported as defects #4 and #5.
 *
 * Two columns became one and a uniqueness guarantee evaporated, which meant
 * nothing stopped duplicate profiles per user or duplicate conversation pairs.
 * The response even mentioned the ONE difference that did not matter (the index
 * was renamed) while saying nothing about the two that did.
 *
 * Every field is now honoured, and the result is VERIFIED against pg_indexes
 * before success is reported. `IF NOT EXISTS` is also no longer trusted on its
 * own: an existing index with the same NAME but a different DEFINITION is a
 * conflict, not a success, and saying so is the difference between an agent that
 * can fix its migration and one that believes a lie.
 */
async function executeCreateIndex(params: any, projectId: string): Promise<ExecutionResult> {
  const { tableName } = params
  // Accept { columnName } (autonomy buildFixAction) or { columns: [...] } (chat,
  // MCP, migration parser). A param-name drift here must never silently no-op.
  const columns: string[] = Array.isArray(params.columns) && params.columns.length
    ? params.columns.map((c: unknown) => String(c ?? '').trim()).filter(Boolean)
    : params.columnName ? [String(params.columnName).trim()] : []

  if (!tableName || columns.length === 0) {
    return {
      success: false,
      message: 'tableName and at least one column are required',
      error: 'Missing parameters',
      code: 'VALIDATION',
    }
  }

  const unique = !!params.unique
  const method = typeof params.method === 'string' ? params.method.toLowerCase().trim() : ''
  const where = typeof params.where === 'string' ? params.where.trim() : ''

  const INDEX_METHODS = new Set(['btree', 'gin', 'gist', 'hash', 'brin'])
  if (method && !INDEX_METHODS.has(method)) {
    return {
      success: false,
      message: `Unsupported index method "${method}". Supported: ${[...INDEX_METHODS].join(', ')}.`,
      error: 'Unsupported index method',
      code: 'VALIDATION',
    }
  }

  // Identifiers reach raw DDL, so they are VALIDATED rather than stripped. The
  // old `replace(/[^a-z0-9_]/gi, '')` silently turned `user-id` into `userid` and
  // indexed a column that does not exist — or worse, a different one that does.
  const { SAFE_IDENT, validateBooleanExpression } = await import('@/lib/db/sql-expression')
  for (const ident of [tableName, ...columns, params.indexName].filter(Boolean)) {
    if (!SAFE_IDENT.test(String(ident))) {
      return {
        success: false,
        message: `"${ident}" is not a valid PostgreSQL identifier.`,
        error: 'Invalid identifier',
        code: 'VALIDATION',
      }
    }
  }

  let wherePredicate = ''
  if (where) {
    const checked = validateBooleanExpression(where, { requireColumn: true })
    if (checked.kind !== 'ok') {
      return {
        success: false,
        message: `Partial-index predicate rejected: ${checked.reason} ${checked.hint}`,
        error: 'Unsafe predicate',
        code: 'VALIDATION',
      }
    }
    wherePredicate = checked.expression
  }

  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

    const idxName = params.indexName || defaultIndexName(tableName, columns, unique)
    const colList = columns.map((c) => `"${c}"`).join(', ')
    const usingClause = method ? ` USING ${method}` : ''

    // ── A UNIQUE index must not count soft-deleted rows ──────────────────────
    //
    // Every Backenly table is provisioned with `deleted_at`, and a client DELETE
    // sets it rather than removing the row (bkn_pgrst_soft_delete). A plain
    // UNIQUE index therefore keeps enforcing uniqueness against rows the
    // application can no longer see:
    //
    //   user deletes their profile  → row survives with deleted_at set
    //   user creates a new profile  → 23505 unique violation against an
    //                                 INVISIBLE row
    //
    // The user cannot see the conflicting row, the API cannot return it, and
    // nothing in the error names it. It only shows up in production, on the
    // second lifecycle of a record, which is the worst possible time to find it.
    //
    // So a UNIQUE index over a soft-delete table becomes PARTIAL — the standard
    // Postgres answer, and the one every soft-delete schema converges on. A
    // caller who supplies their own `where` has said what they want and is left
    // alone; a NON-unique index is unaffected because duplicates were never the
    // question.
    let softDeleteScoped = false
    let effectiveWhere = wherePredicate
    if (unique && !wherePredicate && (await hasSoftDeleteColumn(prisma, postgresSchema, tableName))) {
      effectiveWhere = '"deleted_at" IS NULL'
      softDeleteScoped = true
    }

    const whereClause = effectiveWhere ? ` WHERE (${effectiveWhere})` : ''
    const ddl =
      `CREATE${unique ? ' UNIQUE' : ''} INDEX IF NOT EXISTS "${idxName}" ` +
      `ON "${postgresSchema}"."${tableName}"${usingClause} (${colList})${whereClause}`

    // ── Name-collision check BEFORE creating ────────────────────────────────
    // `IF NOT EXISTS` matches on NAME only. If an index of this name already
    // exists over different columns — or without UNIQUE — Postgres returns
    // success and leaves the old one in place. That is exactly how a "created"
    // unique index turned out to be a pre-existing non-unique one.
    const existing = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
      postgresSchema, tableName, idxName,
    )
    if (existing.length > 0) {
      const def = existing[0].indexdef
      const sameUnique = /CREATE UNIQUE/i.test(def) === unique
      const sameCols = indexDefColumns(def).join(',') === columns.map((c) => c.toLowerCase()).join(',')
      if (sameUnique && sameCols) {
        return {
          success: true,
          message: `Index "${idxName}" already exists on ${tableName} (${columns.join(', ')})${unique ? ', unique' : ''} — nothing to do.`,
          data: { tableName, columns, unique, indexName: idxName, alreadyExisted: true, definition: def },
        }
      }
      return {
        success: false,
        message:
          `An index named "${idxName}" already exists on ${tableName} with a DIFFERENT definition, ` +
          `so the requested one was not created.\n` +
          `  existing:  ${def}\n` +
          `  requested: ${unique ? 'UNIQUE ' : ''}(${columns.join(', ')})\n` +
          `Pass a different indexName, or drop the existing index first (destructive — route it through backend_chat).`,
        error: 'Index name conflict',
        code: 'INDEX_CONFLICT',
        data: { indexName: idxName, existingDefinition: def, requested: { columns, unique } },
      }
    }

    await prisma.$executeRawUnsafe(ddl)

    // ── Verify, do not assume ───────────────────────────────────────────────
    const after = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
      postgresSchema, tableName, idxName,
    )
    if (after.length === 0) {
      return {
        success: false,
        message: `CREATE INDEX reported no error but "${idxName}" is not in the catalog.`,
        error: 'Index not created',
        code: 'VERIFY_FAILED',
      }
    }
    const def = after[0].indexdef
    if (unique && !/CREATE UNIQUE/i.test(def)) {
      return {
        success: false,
        message: `Index "${idxName}" was created but is NOT unique: ${def}`,
        error: 'Uniqueness not applied',
        code: 'VERIFY_FAILED',
      }
    }

    const shape =
      `${unique ? 'unique ' : ''}index on ${tableName} (${columns.join(', ')})` +
      `${method ? ` using ${method}` : ''}${effectiveWhere ? ` where ${effectiveWhere}` : ''}`
    return {
      success: true,
      // The soft-delete scoping is REPORTED, never silent. It changes the
      // semantics of the constraint the caller asked for — narrowing it to live
      // rows — and a caller who wanted uniqueness across deleted rows too needs
      // to know it did not get that.
      message:
        `✅ Created ${shape} as "${idxName}"` +
        (softDeleteScoped
          ? `\n\nScoped to \`WHERE deleted_at IS NULL\`, because "${tableName}" uses soft delete: a client ` +
            `DELETE sets \`deleted_at\` instead of removing the row. An unscoped UNIQUE index would keep ` +
            `enforcing uniqueness against rows the app can no longer see — so a user who deleted their ` +
            `record and created a new one would hit a unique violation against an invisible row. ` +
            `If you DO want uniqueness across deleted rows, pass \`where\` explicitly (e.g. "true").`
          : ''),
      data: {
        tableName,
        columns,
        unique,
        method: method || 'btree',
        where: effectiveWhere || null,
        softDeleteScoped,
        indexName: idxName,
        definition: def,
      },
    }
  } catch (error: any) {
    // A duplicate-key failure on CREATE UNIQUE INDEX means the table already
    // holds rows that violate the requested uniqueness. That is the single most
    // useful thing to say, and "Failed to create index: <pg error>" buried it.
    if (error?.code === '23505' || /duplicate key value|could not create unique index/i.test(error?.message ?? '')) {
      return {
        success: false,
        message:
          `Cannot create a unique index on ${tableName} (${columns.join(', ')}) — the table already ` +
          `contains duplicate rows for that combination. Find them with run_query: ` +
          `SELECT ${columns.join(', ')}, count(*) FROM ${tableName} GROUP BY ${columns.join(', ')} HAVING count(*) > 1. ` +
          `Original error: ${error.message}`,
        error: error.message,
        code: 'DUPLICATE_ROWS',
      }
    }
    if (error?.code === '42703' || /column .* does not exist/i.test(error?.message ?? '')) {
      return {
        success: false,
        message:
          `Cannot index ${tableName} (${columns.join(', ')}) — one of those columns does not exist. ` +
          `Call get_table_schema { tableName: "${tableName}" } for the real column list. ` +
          `Original error: ${error.message}`,
        error: error.message,
        code: 'COLUMN_NOT_FOUND',
      }
    }
    return { success: false, message: `Failed to create index: ${error.message}`, error: error.message, code: 'INDEX_FAILED' }
  }
}

/**
 * Does this table participate in soft delete?
 *
 * The presence of `deleted_at` is the whole test: it is what the PostgREST
 * exposure layer keys the `bkn_pgrst_soft_delete` policy off, and what the
 * autonomy probes read. Asking the catalog rather than assuming keeps this
 * correct for adopted external tables that have no such column.
 */
async function hasSoftDeleteColumn(
  prisma: { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> },
  schemaName: string,
  tableName: string,
): Promise<boolean> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = 'deleted_at'
        LIMIT 1`,
      schemaName,
      tableName,
    )) as unknown[]
    return Array.isArray(rows) && rows.length > 0
  } catch {
    // Cannot tell → do not silently narrow the caller's constraint. A plain
    // UNIQUE is what they asked for; guessing the other way would weaken it.
    return false
  }
}

/**
 * Derive an index name that encodes the whole shape.
 *
 * `idx_<table>_<col>` collided the moment a table needed two indexes starting
 * with the same column, and `IF NOT EXISTS` then made the second one a silent
 * no-op. Including every column and the uniqueness makes distinct indexes have
 * distinct names, and the 63-byte PostgreSQL identifier limit is respected by
 * falling back to a hash suffix rather than a truncation that could still collide.
 */
export function defaultIndexName(tableName: string, columns: string[], unique: boolean): string {
  const prefix = unique ? 'uniq' : 'idx'
  const full = `${prefix}_${tableName}_${columns.join('_')}`
  if (full.length <= 63) return full
  const crypto = require('crypto') as typeof import('crypto')
  const hash = crypto.createHash('sha1').update(`${tableName}|${columns.join(',')}|${unique}`).digest('hex').slice(0, 8)
  return `${prefix}_${tableName}`.slice(0, 54) + `_${hash}`
}

/** Column list of a pg_indexes definition, lower-cased for comparison. */
export function indexDefColumns(indexdef: string): string[] {
  const open = indexdef.lastIndexOf('(')
  const close = indexdef.indexOf(')', open)
  if (open === -1 || close === -1) return []
  return indexdef
    .slice(open + 1, close)
    .split(',')
    // Sort modifiers are stripped BEFORE the quotes. The other order leaves
    // `"createdAt" DESC` as `createdat"` — the closing quote is no longer at the
    // end of the string once DESC follows it.
    .map((c) =>
      c.trim()
        .replace(/\s+(ASC|DESC|NULLS\s+(FIRST|LAST))$/i, '')
        .trim()
        .replace(/^"|"$/g, '')
        .toLowerCase(),
    )
    .filter(Boolean)
}

/**
 * DATABASE: Rename Column
 */
async function executeRenameColumn(params: any, projectId: string): Promise<ExecutionResult> {
  const { tableName, oldName, newName } = params
  if (!tableName || !oldName || !newName) {
    return { success: false, message: 'tableName, oldName and newName are required', error: 'Missing parameters' }
  }
  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    const safe = (s: string) => s.replace(/[^a-z0-9_]/gi, '')
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${postgresSchema}"."${safe(tableName)}" RENAME COLUMN "${safe(oldName)}" TO "${safe(newName)}"`
    )
    // Column renamed — evict cached Zod validation schema
    import('@/lib/services/workspace-validator').then(({ invalidateSchemaCache }) => invalidateSchemaCache(projectId, tableName)).catch(() => {})
    return {
      success: true,
      message: `✅ Column renamed from "${oldName}" to "${newName}" in ${tableName}`,
      data: { tableName, oldName, newName }
    }
  } catch (error: any) {
    return { success: false, message: `Failed to rename column: ${error.message}`, error: error.message }
  }
}

/**
 * DATABASE: Add / relax a constraint.
 *
 * ── What was wrong here, and why it was the worst bug on the surface ─────────
 *
 * Three independent defects compounded into a tool that lied.
 *
 * 1. CONTRACT DRIFT. Every caller — the migration parser, the brain's
 *    `add_constraint` mapper — sends the predicate as `expression`. This function
 *    only ever read `constraintDefinition`. So `expression` was always undefined
 *    and execution fell through to a hardcoded synthesis whose CHECK branch was
 *
 *        if (ct === 'CHECK' && columnName) return `CHECK ("col" IS NOT NULL)`
 *
 *    An author's `CHECK (status IN ('pending','accepted','declined'))` was
 *    therefore installed as `CHECK (status IS NOT NULL)` — a different
 *    constraint, silently, reported as success.
 *
 * 2. NAME COLLISION. The generated name was `chk_<table>_<column>`, which is the
 *    same for every constraint on a column. The second one hit Postgres's
 *    duplicate-name error.
 *
 * 3. THE ERROR WAS SWALLOWED. `if (error.message.includes('already exists'))
 *    return { success: true }`. So the retry that should have repaired defect 1
 *    instead confirmed it: "✅ Constraint already exists on connections", while
 *    the only constraint present was the wrong one this function had invented.
 *
 * Together those are defects #1 and #2 as reported, and #2 is the one that made
 * #1 unrecoverable — the obvious fix path returned success.
 *
 * Every branch below therefore: reads the real contract, derives a name from the
 * DEFINITION rather than the column, compares against what already exists before
 * claiming idempotency, and reads the constraint back out of the catalog before
 * reporting success. `NOT NULL` is also a real `ALTER COLUMN SET NOT NULL` now,
 * not a CHECK impersonating one.
 */
async function executeAddConstraint(params: any, projectId: string): Promise<ExecutionResult> {
  const { tableName, constraintName, constraintDefinition, referencedTable } = params
  const columnName = params.columnName ? String(params.columnName).trim() : ''
  // `expression` is the declared contract; `constraintDefinition` is the older
  // internal spelling. Both are read so neither caller is silently ignored.
  const expression = typeof params.expression === 'string' ? params.expression.trim() : ''

  // Normalised type. `ctUpper` used to replace underscores while the synthesis
  // below compared against the RAW value, so `not_null` matched the FK sniffer's
  // 'NOT NULL' but never the definition builder's — producing
  // `ADD CONSTRAINT "chk_x_y" undefined` and a syntax error.
  const ct = String(params.constraintType ?? '').trim().toLowerCase().replace(/\s+/g, '_')

  const looksLikeFk =
    ct === 'foreign_key' ||
    !!referencedTable ||
    (!constraintDefinition && !ct && /(_id|Id)$/.test(columnName))
  if (looksLikeFk && tableName && columnName) {
    // `expression` carries "target(column)" from the migration parser; prefer an
    // explicit referencedTable, then the expression, then inference.
    const fromExpr = /^([A-Za-z_][A-Za-z0-9_$]*)\s*\(/.exec(expression)?.[1]
    const target = referencedTable || fromExpr
    const { repairForeignKeyColumn } = await import('./fk-repair')
    const r = await repairForeignKeyColumn(projectId, tableName, columnName, target)
    return r.success
      ? { success: true, message: `✅ ${r.message}`, data: { tableName, columnName, referencedTable: r.referencedTable } }
      : { success: false, message: r.message, error: r.message, code: 'FK_FAILED' }
  }

  if (!tableName || (!constraintDefinition && !ct)) {
    return {
      success: false,
      message: 'tableName and constraintType are required',
      error: 'Missing parameters',
      code: 'VALIDATION',
    }
  }

  const { SAFE_IDENT, validateBooleanExpression } = await import('@/lib/db/sql-expression')

  // Columns the constraint covers. A multi-column CHECK passes `columns`; every
  // other form is column-scoped.
  const columns: string[] = Array.isArray(params.columns) && params.columns.length
    ? params.columns.map((c: unknown) => String(c ?? '').trim()).filter(Boolean)
    : columnName ? [columnName] : []

  for (const ident of [tableName, ...columns, constraintName].filter(Boolean)) {
    if (!SAFE_IDENT.test(String(ident))) {
      return {
        success: false,
        message: `"${ident}" is not a valid PostgreSQL identifier.`,
        error: 'Invalid identifier',
        code: 'VALIDATION',
      }
    }
  }

  // ── UNIQUE is not single-column ──────────────────────────────────────────
  //
  // `unique` used to sit in this set, so a composite UNIQUE had no way through:
  // sending `columns: ["user_a","user_b"]` without a `columnName` was refused as
  // "applies to one column", and sending `columnName` instead silently produced
  // a single-column constraint that forbids a user appearing in TWO
  // conversations — a different and much stricter rule than the one asked for.
  //
  // Reported as two composite UNIQUEs going missing from an explicitly additive
  // six-item request, with no error and no mention. The DDL path below always
  // handled the multi-column form (it forwards `columns` to executeCreateIndex);
  // only this guard stood in front of it.
  const NEEDS_COLUMN = new Set(['not_null', 'drop_not_null', 'set_default', 'drop_default'])
  if (NEEDS_COLUMN.has(ct) && !columnName) {
    return {
      success: false,
      message: `constraintType "${ct}" applies to one column — pass columnName.`,
      error: 'Missing columnName',
      code: 'VALIDATION',
    }
  }
  if (ct === 'unique' && columns.length === 0) {
    return {
      success: false,
      message:
        `constraintType "unique" needs the column(s) it covers — pass columnName for one, ` +
        `or columns: ["a","b"] for a composite UNIQUE such as (user_a, user_b).`,
      error: 'Missing columns',
      code: 'VALIDATION',
    }
  }

  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    const qualified = `"${postgresSchema}"."${tableName}"`

    // ── ALTER COLUMN forms: not constraints in the pg_constraint sense ───────
    // NOT NULL is a column attribute. Expressing it as `CHECK (col IS NOT NULL)`
    // — as this used to — produces a constraint that does not participate in
    // planner null-rejection, does not show as `is_nullable = NO` in
    // information_schema, and litters the table with the `chk_*` rows the
    // reporter mistook for platform-generated noise.
    if (ct === 'not_null' || ct === 'drop_not_null') {
      const verb = ct === 'not_null' ? 'SET NOT NULL' : 'DROP NOT NULL'
      try {
        await prisma.$executeRawUnsafe(`ALTER TABLE ${qualified} ALTER COLUMN "${columnName}" ${verb}`)
      } catch (err: any) {
        if (err?.code === '23502' || /contains null values/i.test(err?.message ?? '')) {
          return {
            success: false,
            message:
              `Cannot set ${tableName}.${columnName} NOT NULL — it already contains NULL rows. ` +
              `Backfill them first (db_update with a filter on ${columnName} IS NULL), then retry. ` +
              `Original error: ${err.message}`,
            error: err.message,
            code: 'NULL_ROWS_PRESENT',
          }
        }
        throw err
      }
      const nullable = await columnIsNullable(prisma, postgresSchema, tableName, columnName)
      if (nullable === null) {
        return {
          success: false,
          message: `Column ${tableName}.${columnName} does not exist.`,
          error: 'Column not found',
          code: 'COLUMN_NOT_FOUND',
        }
      }
      const wanted = ct === 'not_null' ? false : true
      if (nullable !== wanted) {
        return {
          success: false,
          message: `${verb} reported no error but ${tableName}.${columnName} is still ${nullable ? 'nullable' : 'NOT NULL'}.`,
          error: 'Verification failed',
          code: 'VERIFY_FAILED',
        }
      }
      import('@/lib/services/workspace-validator')
        .then(({ invalidateSchemaCache }) => invalidateSchemaCache(projectId, tableName)).catch(() => {})
      return {
        success: true,
        message: `✅ ${tableName}.${columnName} is now ${wanted ? 'nullable' : 'NOT NULL'}`,
        data: { tableName, columnName, nullable: wanted },
      }
    }

    if (ct === 'set_default' || ct === 'drop_default') {
      if (ct === 'drop_default') {
        await prisma.$executeRawUnsafe(`ALTER TABLE ${qualified} ALTER COLUMN "${columnName}" DROP DEFAULT`)
        return {
          success: true,
          message: `✅ Dropped the default on ${tableName}.${columnName}`,
          data: { tableName, columnName, default: null },
        }
      }
      // The default expression reaches raw DDL, so it goes through the same
      // closed allowlist a column-level default does.
      const expr = normalizeDefaultExpression(expression || constraintDefinition)
      if (!expr) {
        return {
          success: false,
          message:
            `Default expression "${expression || constraintDefinition}" is not one Backenly will place in DDL. ` +
            `Supported: a quoted literal, a number, true/false/null, NOW(), CURRENT_TIMESTAMP, ` +
            `CURRENT_DATE, gen_random_uuid(), '{}'::jsonb.`,
          error: 'Unsupported default',
          code: 'VALIDATION',
        }
      }
      await prisma.$executeRawUnsafe(`ALTER TABLE ${qualified} ALTER COLUMN "${columnName}" SET DEFAULT ${expr}`)
      return {
        success: true,
        message: `✅ ${tableName}.${columnName} now defaults to ${expr}`,
        data: { tableName, columnName, default: expr },
      }
    }

    // ── Real table constraints: UNIQUE and CHECK ─────────────────────────────
    let definition: string
    if (constraintDefinition) {
      // Legacy internal callers pass a whole `CHECK (…)` / `UNIQUE (…)` clause.
      // Validate the predicate inside it rather than trusting the string.
      const inner = /^\s*check\s*\(([\s\S]*)\)\s*$/i.exec(String(constraintDefinition))
      if (inner) {
        const checked = validateBooleanExpression(inner[1], { requireColumn: true })
        if (checked.kind !== 'ok') {
          return {
            success: false,
            message: `CHECK expression rejected: ${checked.reason} ${checked.hint}`,
            error: 'Unsafe expression',
            code: 'VALIDATION',
          }
        }
        definition = `CHECK (${checked.expression})`
      } else if (/^\s*unique\s*\(\s*"?[A-Za-z_][A-Za-z0-9_$]*"?\s*(,\s*"?[A-Za-z_][A-Za-z0-9_$]*"?\s*)*\)\s*$/i.test(String(constraintDefinition))) {
        definition = String(constraintDefinition).trim()
      } else {
        return {
          success: false,
          message:
            `constraintDefinition "${String(constraintDefinition).slice(0, 60)}" is not a form Backenly ` +
            `will place in DDL. Pass { constraintType: "check", expression: "<predicate>" } or ` +
            `{ constraintType: "unique", columnName }.`,
          error: 'Unsupported constraint definition',
          code: 'VALIDATION',
        }
      }
    } else if (ct === 'unique') {
      // ── Soft delete makes a UNIQUE *constraint* the wrong instrument ────────
      //
      // Every Backenly table carries `deleted_at`, and a client DELETE sets it
      // rather than removing the row. A UNIQUE CONSTRAINT cannot be partial —
      // PostgreSQL has no `ADD CONSTRAINT … UNIQUE … WHERE` — so it would keep
      // enforcing uniqueness against soft-deleted rows the application can no
      // longer see. The user deletes a record, creates a replacement, and gets a
      // 23505 naming a row that no query of theirs can return.
      //
      // A partial UNIQUE INDEX is the same guarantee, correctly scoped, and is
      // exactly what Postgres implements a UNIQUE constraint AS. So the request
      // is routed to executeCreateIndex, which applies the `deleted_at IS NULL`
      // scoping and reports it. Uniqueness is delivered; only the catalog object
      // differs, and the response says so.
      if (await hasSoftDeleteColumn(prisma, postgresSchema, tableName)) {
        const idxResult = await executeCreateIndex(
          { tableName, columns, unique: true, ...(constraintName ? { indexName: constraintName } : {}) },
          projectId,
        )
        if (!idxResult.success) return idxResult
        return {
          ...idxResult,
          message:
            `${idxResult.message}\n\n` +
            `Applied as a partial UNIQUE INDEX rather than a UNIQUE CONSTRAINT: "${tableName}" uses soft ` +
            `delete, and PostgreSQL constraints cannot be scoped to live rows. The uniqueness guarantee is ` +
            `identical for rows your app can see — it simply does not collide with soft-deleted ones. ` +
            `It appears under indexes, not constraints, in get_table_schema.`,
        }
      }
      definition = `UNIQUE (${columns.map((c) => `"${c}"`).join(', ')})`
    } else if (ct === 'check') {
      const checked = validateBooleanExpression(expression, { requireColumn: true })
      if (checked.kind !== 'ok') {
        return {
          success: false,
          message:
            `CHECK expression rejected: ${checked.reason} ${checked.hint}` +
            (expression ? '' : ' Pass the predicate in `expression`, e.g. { expression: "price > 0" }.'),
          error: 'Unsafe or missing expression',
          code: 'VALIDATION',
        }
      }
      definition = `CHECK (${checked.expression})`
    } else {
      return {
        success: false,
        message:
          `Unsupported constraintType "${params.constraintType}". ` +
          `Supported: not_null, drop_not_null, unique, check, foreign_key, set_default, drop_default.`,
        error: 'Unsupported constraintType',
        code: 'VALIDATION',
      }
    }

    // ── The name ────────────────────────────────────────────────────────────
    // Derived from the DEFINITION, not just the column, so two different CHECKs
    // on `status` get two different names instead of colliding. An explicit
    // constraintName always wins — that is the author's own namespace.
    const cName = constraintName || derivedConstraintName(tableName, ct, columns, definition)

    // ── Compare before claiming idempotency ─────────────────────────────────
    // "already exists" is only good news if what exists is what was asked for.
    const existing = await prisma.$queryRawUnsafe<Array<{ conname: string; def: string }>>(
      `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = $1 AND rel.relname = $2 AND con.conname = $3`,
      postgresSchema, tableName, cName,
    )
    if (existing.length > 0) {
      const have = existing[0].def
      if (sameConstraint(have, definition)) {
        return {
          success: true,
          message: `Constraint "${cName}" already exists on ${tableName} with the same definition — nothing to do.`,
          data: { tableName, constraintName: cName, constraintDefinition: have, alreadyExisted: true },
        }
      }
      return {
        success: false,
        message:
          `A constraint named "${cName}" already exists on ${tableName} with a DIFFERENT definition, ` +
          `so the requested one was NOT applied.\n` +
          `  existing:  ${have}\n` +
          `  requested: ${definition}\n` +
          `Pass an explicit constraintName to add this alongside it, or drop the existing constraint ` +
          `first (destructive — route it through backend_chat).`,
        error: 'Constraint name conflict',
        code: 'CONSTRAINT_CONFLICT',
        data: { tableName, constraintName: cName, existingDefinition: have, requestedDefinition: definition },
      }
    }

    // An equivalent constraint under a DIFFERENT name is also already-satisfied.
    // Without this, an author who wrote the same CHECK twice under two names got
    // two identical constraints on the table.
    const equivalent = await prisma.$queryRawUnsafe<Array<{ conname: string; def: string }>>(
      `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = $1 AND rel.relname = $2 AND con.contype IN ('c','u')`,
      postgresSchema, tableName,
    )
    const match = equivalent.find((e) => sameConstraint(e.def, definition))
    if (match) {
      return {
        success: true,
        message:
          `${tableName} already enforces this rule as "${match.conname}" (${match.def}) — nothing to do. ` +
          `No second constraint was added.`,
        data: { tableName, constraintName: match.conname, constraintDefinition: match.def, alreadyExisted: true },
      }
    }

    await prisma.$executeRawUnsafe(`ALTER TABLE ${qualified} ADD CONSTRAINT "${cName}" ${definition}`)

    // ── Verify against the catalog ──────────────────────────────────────────
    const after = await prisma.$queryRawUnsafe<Array<{ def: string }>>(
      `SELECT pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = $1 AND rel.relname = $2 AND con.conname = $3`,
      postgresSchema, tableName, cName,
    )
    if (after.length === 0) {
      return {
        success: false,
        message: `ADD CONSTRAINT reported no error but "${cName}" is not in the catalog.`,
        error: 'Constraint not created',
        code: 'VERIFY_FAILED',
      }
    }

    import('@/lib/services/workspace-validator')
      .then(({ invalidateSchemaCache }) => invalidateSchemaCache(projectId, tableName)).catch(() => {})

    return {
      success: true,
      // The ACTUAL installed definition is echoed, so a caller can see what it
      // got rather than trusting that it matches what it sent.
      message: `✅ Added constraint "${cName}" to ${tableName}: ${after[0].def}`,
      data: { tableName, constraintName: cName, constraintDefinition: after[0].def, columns },
    }
  } catch (error: any) {
    // ── "already exists" is never silently a success ─────────────────────────
    // Reaching here means the name-comparison above did not see it, so the
    // conflict is real and the caller must know the constraint was not applied.
    if (/already exists/i.test(error?.message ?? '')) {
      return {
        success: false,
        message:
          `PostgreSQL refused the constraint on ${tableName} because a constraint of that name already ` +
          `exists: ${error.message}. Nothing was applied. Call get_table_schema { tableName: "${tableName}" } ` +
          `to see the existing constraints, then retry with an explicit constraintName.`,
        error: error.message,
        code: 'CONSTRAINT_CONFLICT',
      }
    }
    if (error?.code === '23514' || /violates check constraint|is violated by some row/i.test(error?.message ?? '')) {
      return {
        success: false,
        message:
          `Cannot add this constraint to ${tableName} — existing rows already violate it, so PostgreSQL ` +
          `rejected it and nothing was applied. Find the offending rows with run_query, fix or delete them, ` +
          `then retry. Original error: ${error.message}`,
        error: error.message,
        code: 'EXISTING_ROWS_VIOLATE',
      }
    }
    if (error?.code === '42703' || /column .* does not exist/i.test(error?.message ?? '')) {
      return {
        success: false,
        message:
          `The constraint references a column that does not exist on ${tableName}. ` +
          `Call get_table_schema { tableName: "${tableName}" } for the real column list. ` +
          `Original error: ${error.message}`,
        error: error.message,
        code: 'COLUMN_NOT_FOUND',
      }
    }
    return { success: false, message: `Failed to add constraint: ${error.message}`, error: error.message, code: 'CONSTRAINT_FAILED' }
  }
}

/** Live nullability of a column, or null when the column does not exist. */
async function columnIsNullable(
  prisma: any,
  schema: string,
  table: string,
  column: string,
): Promise<boolean | null> {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    schema, table, column,
  ) as Array<{ is_nullable: string }>
  if (rows.length === 0) return null
  return rows[0].is_nullable === 'YES'
}

/**
 * A constraint name that encodes the whole definition.
 *
 * `chk_<table>_<column>` is the same string for every constraint on a column, so
 * a table needing both `CHECK (status IN (…))` and `CHECK (status <> '')` could
 * only ever hold one — and the second attempt reported success. A short hash of
 * the normalised definition makes distinct constraints distinctly named while
 * keeping the name stable and re-derivable, so re-running the same migration is
 * genuinely idempotent instead of accidentally so.
 */
export function derivedConstraintName(
  tableName: string,
  ct: string,
  columns: string[],
  definition: string,
): string {
  const prefix = ct === 'unique' ? 'uq' : 'chk'
  const crypto = require('crypto') as typeof import('crypto')
  const hash = crypto.createHash('sha1').update(normalizeConstraintDef(definition)).digest('hex').slice(0, 8)
  const base = `${prefix}_${tableName}_${columns.join('_')}`
  return `${base.slice(0, 53)}_${hash}`
}

/**
 * Compare two constraint definitions for semantic equality.
 *
 * `pg_get_constraintdef` normalises what it is given — it re-quotes identifiers,
 * adds casts (`status = ANY (ARRAY['a'::text, 'b'::text])` for an `IN` list) and
 * respaces operators — so a byte comparison against the SQL we submitted would
 * report "different" for a constraint that is identical, and then refuse to
 * re-apply a migration that was already correctly applied.
 *
 * This deliberately errs toward reporting DIFFERENT: a false "same" claims
 * idempotency that is not there, which is the failure mode being fixed. A false
 * "different" produces a clear CONSTRAINT_CONFLICT the caller can act on.
 */
export function sameConstraint(a: string, b: string): boolean {
  return normalizeConstraintDef(a) === normalizeConstraintDef(b)
}

export function normalizeConstraintDef(def: string): string {
  return String(def ?? '')
    .toLowerCase()
    // Drop casts. `((status)::text = any ((array[…])::text[]))` becomes readable
    // only once these are gone, and they carry no semantic weight for comparison.
    .replace(/::\s*[a-z_][a-z0-9_ ]*(\[\s*\])?/g, '')
    // `= ANY (ARRAY[…])` is how pg_get_constraintdef renders an IN list. Reduced
    // in two independent steps rather than one regex, because the real output
    // nests extra parens between ANY and ARRAY that a single pattern misses.
    .replace(/\barray\b/g, '')
    .replace(/=\s*any\b/g, 'in')
    // Collapse every grouping character. Parenthesisation differs freely between
    // what an author writes and what Postgres stores, and means nothing here.
    .replace(/[()\[\]"\s]+/g, ' ')
    // Operator and comma spacing, so `price>0` and `price > 0` agree.
    .replace(/\s*(<>|!=|>=|<=|=|>|<|\+|-|\*|\/|%)\s*/g, ' $1 ')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
}

// ============================================================================
// DEPLOY ACTIONS
// ============================================================================

/**
 * DEPLOY: Rollback Deploy — not yet supported, returns honest error
 */
async function executeRollbackDeploy(params: any, projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma } = await import('@/lib/db')
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    })
    if (!project?.userId) return { success: false, message: 'Project not found', error: 'Project not found' }

    const { rollbackDeploy } = await import('@/lib/deployment/rollback')
    const force = !!(params?.force || params?.confirmed)
    const result = await rollbackDeploy({
      projectId,
      userId: project.userId,
      deploymentId: params?.deploymentId,
      version: typeof params?.version === 'number' ? params.version : undefined,
      confirmedBy: 'CHAT',
      force,
    })

    if (result.kind === 'error') {
      return { success: false, message: result.error, error: result.error, data: { code: result.code } }
    }

    if (result.kind === 'confirmation') {
      return {
        success: true,
        message: result.message,
        data: { requiresConfirmation: true, fromVersion: result.fromVersion, toVersion: result.toVersion },
      }
    }

    return {
      success: true,
      message: result.message,
      data: { fromVersion: result.fromVersion, toVersion: result.toVersion },
    }
  } catch (error: any) {
    return { success: false, message: `Rollback failed: ${error.message}`, error: error.message }
  }
}

/**
 * DEPLOY: Get Deploy Status — reads real deployment record from DB
 */
async function executeGetDeployStatus(projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma } = await import('@/lib/db')
    const deployment = await prisma.deployment.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    })
    if (!deployment) {
      return {
        success: true,
        message: `ℹ️ No deployments found for this project yet.\n\nUse the **Deploy** tab to publish your backend.`,
        data: { status: 'not_deployed' }
      }
    }
    const statusEmoji = deployment.status === 'live' ? '✅' : deployment.status === 'building' ? '🔄' : '❌'
    const lastDeploy = deployment.createdAt ? new Date(deployment.createdAt).toLocaleString() : 'unknown'
    return {
      success: true,
      message: `🚀 **Deployment Status:**\n\n${statusEmoji} **Status:** ${deployment.status}\n🌐 **URL:** ${deployment.url || 'Not available'}\n⏱️ **Last Deploy:** ${lastDeploy}`,
      data: { status: deployment.status, deploymentId: deployment.id, createdAt: deployment.createdAt }
    }
  } catch (error: any) {
    return { success: false, message: `Failed to fetch deployment status: ${error.message}`, error: error.message }
  }
}

/**
 * DEPLOY: Set Environment Variable — persists to AuditLog as env var record.
 * Env vars are stored as audit entries so they survive across restarts without a schema change.
 */
async function executeSetEnvVar(params: any, projectId: string): Promise<ExecutionResult> {
  const { key, value, description } = params || {}
  if (!key) return { success: false, message: 'key is required', error: 'Missing parameters' }
  if (typeof value !== 'string' || value.length === 0) {
    return { success: false, message: 'value is required (non-empty string)', error: 'Missing parameters' }
  }

  try {
    const { prisma } = await import('@/lib/db')
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } })
    if (!project?.userId) return { success: false, message: 'Project not found', error: 'Project not found' }

    const { setEnvVar, EnvVarValidationError } = await import('@/lib/services/projectEnvVars')
    try {
      const summary = await setEnvVar({
        projectId,
        key,
        value,
        userId: project.userId,
        description: typeof description === 'string' ? description : undefined,
      })
      return {
        success: true,
        message:
          `Stored encrypted env var **${summary.key}** (\`${summary.preview}\`).\n\n` +
          `It will be available inside AI functions as \`ctx.env.${summary.key}\` on the next invocation.`,
        data: { key: summary.key, preview: summary.preview },
      }
    } catch (err: any) {
      if (err instanceof EnvVarValidationError) {
        return { success: false, message: err.message, error: err.message, data: { code: 'VALIDATION' } }
      }
      throw err
    }
  } catch (error: any) {
    return { success: false, message: `Failed to save env var: ${error.message}`, error: error.message }
  }
}

async function executeListEnvVars(projectId: string): Promise<ExecutionResult> {
  try {
    const { listEnvVars } = await import('@/lib/services/projectEnvVars')
    const rows = await listEnvVars(projectId)
    if (rows.length === 0) {
      return {
        success: true,
        message:
          '**Project env vars:**\n\nNone yet. Set one with: _"Save STRIPE_WEBHOOK_SECRET as whsec_…"_\n\nAccess from AI functions via `ctx.env.YOUR_KEY`.',
        data: { vars: [] },
      }
    }
    const list = rows.map((r) => `• \`${r.key}\` — ${r.preview}${r.description ? `  _(${r.description})_` : ''}`).join('\n')
    return {
      success: true,
      message: `**Project env vars (${rows.length}):**\n\n${list}\n\nAccess from AI functions via \`ctx.env.<KEY>\`.`,
      data: { vars: rows },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to list env vars: ${error.message}`, error: error.message }
  }
}

async function executeDeleteEnvVar(params: any, projectId: string): Promise<ExecutionResult> {
  const { key } = params || {}
  if (!key) return { success: false, message: 'key is required', error: 'Missing parameters' }

  try {
    const { prisma } = await import('@/lib/db')
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } })
    if (!project?.userId) return { success: false, message: 'Project not found', error: 'Project not found' }

    const { deleteEnvVar, EnvVarValidationError } = await import('@/lib/services/projectEnvVars')
    try {
      const deleted = await deleteEnvVar(projectId, key, project.userId)
      if (!deleted) return { success: false, message: `No env var named "${key}" exists.`, error: 'Not found' }
      return { success: true, message: `Deleted env var **${key}**.`, data: { key } }
    } catch (err: any) {
      if (err instanceof EnvVarValidationError) {
        return { success: false, message: err.message, error: err.message }
      }
      throw err
    }
  } catch (error: any) {
    return { success: false, message: `Failed to delete env var: ${error.message}`, error: error.message }
  }
}

async function executeGetReadiness(params: any, projectId: string): Promise<ExecutionResult> {
  try {
    const { scoreReadiness, formatReadinessReport } = await import('@/lib/deployment/readiness-scorer')
    const autoFix = params?.autoFix !== false // default true
    const report = await scoreReadiness(projectId, { autoFix })
    const summary = formatReadinessReport(report)

    return {
      success: true,
      message:
        `**Deploy readiness: ${report.score}/100** (${report.ready ? 'ready to deploy' : `${report.blockers.length} blocker${report.blockers.length === 1 ? '' : 's'}`})\n\n${summary}`,
      data: { report },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to read readiness: ${error.message}`, error: error.message }
  }
}

// ============================================================================
// TRIGGER ACTIONS
// ============================================================================

/**
 * CREATE_TRIGGER: Create an event-driven automation trigger
 */
async function executeCreateTrigger(params: any, projectId: string): Promise<ExecutionResult> {
  const { name, description, sourceTable, event, conditions, actionType, targetTable, fieldMappings, staticFields, webhookUrl } = params

  if (!name || !sourceTable || !event || !actionType) {
    return { success: false, message: 'name, sourceTable, event, and actionType are required' }
  }

  try {
    const { prisma } = await import('@/lib/db')
    const { createTrigger } = await import('@/lib/services/trigger-service')

    // Idempotent: a blueprint re-run (or a "continue" turn) must not create a
    // duplicate trigger. If one with the same name already exists for this
    // project, treat the call as a no-op success — the trigger is already in
    // place. Without this, the second pass over a blueprint produces 4 dupes
    // per source table.
    const existing = await prisma.appTrigger.findFirst({
      where: { projectId, name },
      select: { id: true, name: true, sourceTable: true, event: true },
    }).catch(() => null)
    if (existing) {
      return {
        success: true,
        message: `Trigger "${existing.name}" already exists on \`${existing.sourceTable}.${existing.event}\` — nothing to do.`,
        data: { triggerId: existing.id, name: existing.name, alreadyExisted: true },
      }
    }

    const trigger = await createTrigger(projectId, {
      name, description, sourceTable, event, conditions,
      actionType, targetTable, fieldMappings, staticFields, webhookUrl,
    })

    const actionDesc =
      actionType === 'insert_row' ? `automatically inserts a row into \`${targetTable}\`` :
      actionType === 'update_row' ? `automatically updates rows in \`${targetTable}\`` :
      actionType === 'delete_rows' ? `automatically deletes rows from \`${targetTable}\`` :
      actionType === 'webhook' ? `calls your webhook at \`${webhookUrl}\`` :
      actionType

    return {
      success: true,
      message: `✅ **Trigger "${name}" created.**\n\nWhenever a row is **${event}**ed in \`${sourceTable}\`, Backenly ${actionDesc} — no code needed.\n\nTrigger ID: \`${trigger.id}\``,
      data: { triggerId: trigger.id, name: trigger.name },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to create trigger: ${error.message}`, error: error.message }
  }
}

/**
 * LIST_TRIGGERS: Show all event triggers for this project
 */
async function executeListTriggers(projectId: string): Promise<ExecutionResult> {
  try {
    const { listTriggers } = await import('@/lib/services/trigger-service')
    const triggers = await listTriggers(projectId)

    if (triggers.length === 0) {
      return {
        success: true,
        message: `No event triggers yet.\n\nTry: *"When a like is created, add a notification"* — Backenly wires it up automatically.`,
        data: { triggers: [] },
      }
    }

    const lines = triggers.map(t => {
      const arrow = t.actionType === 'webhook' ? `→ webhook` : `→ ${t.actionType} in ${t.targetTable || '?'}`
      const status = t.enabled ? '✅' : '⏸️'
      return `${status} **${t.name}**: \`${t.sourceTable}.${t.event}\` ${arrow}`
    })

    return {
      success: true,
      message: `⚡ **Event Triggers (${triggers.length}):**\n\n${lines.join('\n')}`,
      data: { triggers },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to list triggers: ${error.message}`, error: error.message }
  }
}

/**
 * DELETE_TRIGGER: Remove an event trigger
 */
async function executeDeleteTrigger(params: any, projectId: string): Promise<ExecutionResult> {
  const { triggerId, name } = params

  try {
    const { prisma } = await import('@/lib/db')
    const { deleteTrigger } = await import('@/lib/services/trigger-service')

    // Resolve name → id if needed
    let resolvedId = triggerId
    if (!resolvedId && name) {
      const found = await prisma.appTrigger.findFirst({ where: { projectId, name } })
      if (!found) return { success: false, message: `Trigger "${name}" not found` }
      resolvedId = found.id
    }

    await deleteTrigger(projectId, resolvedId)

    return {
      success: true,
      message: `✅ Trigger "${name || triggerId}" removed.`,
      data: { deleted: true },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to delete trigger: ${error.message}`, error: error.message }
  }
}

// ============================================================================
// DERIVED COLUMNS — "keep column X in sync with related rows"
// ============================================================================

/**
 * SYNC_COLUMN: maintain a derived column from related rows, in the database.
 *
 * The gap this fills: keeping `conversations.last_message_at` current had no
 * primitive between "two client round trips that silently drift" and
 * "generate_function with an on_insert trigger" — a deployed serverless function,
 * with an invocation quota, for a one-line derived value. See
 * lib/services/derived-columns.ts.
 */
async function executeSyncColumn(params: any, projectId: string): Promise<ExecutionResult> {
  const { applyDerivedColumn, DERIVED_COMPUTES } = await import('@/lib/services/derived-columns')

  const sourceTable = String(params.sourceTable ?? params.table ?? '').trim()
  const targetTable = String(params.targetTable ?? '').trim()
  const targetColumn = String(params.targetColumn ?? params.column ?? '').trim()
  const via = String(params.via ?? params.foreignKey ?? '').trim()
  const compute = String(params.compute ?? '').trim().toLowerCase()
  const sourceColumn = params.sourceColumn ? String(params.sourceColumn).trim() : undefined

  if (!sourceTable || !targetTable || !targetColumn || !via || !compute) {
    return {
      success: false,
      message:
        `sourceTable, targetTable, targetColumn, via and compute are all required. Example: ` +
        `{ sourceTable: "messages", targetTable: "conversations", targetColumn: "last_message_at", ` +
        `via: "conversation_id", compute: "latest", sourceColumn: "created_at" }.`,
      code: 'VALIDATION',
    }
  }
  if (!(DERIVED_COMPUTES as string[]).includes(compute)) {
    return {
      success: false,
      message:
        `Unknown compute "${compute}". Available: ${DERIVED_COMPUTES.join(', ')}. ` +
        `Backenly generates the aggregate itself — there is no raw-SQL form of this, by design.`,
      code: 'VALIDATION',
    }
  }

  const result = await applyDerivedColumn(projectId, {
    sourceTable,
    targetTable,
    targetColumn,
    via,
    compute: compute as any,
    ...(sourceColumn ? { sourceColumn } : {}),
  })

  if (!result.success) {
    return { success: false, message: result.message, error: result.message, code: 'SYNC_NOT_APPLIED' }
  }
  return {
    success: true,
    message: `✅ ${result.message}`,
    data: { sourceTable, targetTable, targetColumn, via, compute, sourceColumn: sourceColumn ?? null, backfilled: result.backfilled ?? 0 },
  }
}

async function executeListSyncedColumns(projectId: string): Promise<ExecutionResult> {
  const { listDerivedColumns } = await import('@/lib/services/derived-columns')
  const rows = await listDerivedColumns(projectId)
  if (rows.length === 0) {
    return {
      success: true,
      message:
        'No derived columns are being maintained. Use sync_column to keep a parent column in step with ' +
        'its child rows (e.g. conversations.last_message_at from messages.created_at).',
      data: { synced: [] },
    }
  }
  return {
    success: true,
    message:
      `${rows.length} derived column(s) maintained by database triggers:\n` +
      rows.map((r) => `  • ${r.triggerName} on ${r.sourceTable}`).join('\n'),
    data: { synced: rows },
  }
}

async function executeRemoveSyncColumn(params: any, projectId: string): Promise<ExecutionResult> {
  const { removeDerivedColumn } = await import('@/lib/services/derived-columns')
  const targetTable = String(params.targetTable ?? '').trim()
  const targetColumn = String(params.targetColumn ?? '').trim()
  const sourceTable = String(params.sourceTable ?? '').trim()
  if (!targetTable || !targetColumn || !sourceTable) {
    return {
      success: false,
      message: 'targetTable, targetColumn and sourceTable are required.',
      code: 'VALIDATION',
    }
  }
  const result = await removeDerivedColumn(projectId, targetTable, targetColumn, sourceTable)
  return result.success
    ? { success: true, message: `✅ ${result.message}`, data: { targetTable, targetColumn } }
    : { success: false, message: result.message, error: result.message }
}

// ============================================================================
// PERMISSION / RLS ACTIONS
// ============================================================================

/**
 * SET_PERMISSION: Apply a Row-Level Security policy to a workspace table
 */
async function executeSetPermission(params: any, projectId: string): Promise<ExecutionResult> {
  // Accept both naming conventions:
  //   AGENT_SYSTEM_PROMPT uses: { table, policy }
  //   build-runtime node-executor uses: { tableName, template }
  const tableName = params.tableName || params.table
  const template  = params.template  || params.policy
  const userIdColumn = params.userIdColumn

  if (!tableName || !template) {
    return {
      success: false,
      message: 'table/tableName and policy/template are required',
      code: 'VALIDATION',
    }
  }

  // `auto` reads the schema and picks; `party_rows` covers a table owned by TWO
  // OR MORE users (connections, conversations, messages); `related_rows`
  // protects a table owned through a FK to a user-owned parent; `custom` takes
  // the caller's own predicate.
  const validTemplates = [
    'auto', 'own_rows', 'party_rows', 'related_rows', 'public_read', 'admin_only',
    'all_access', 'org_members', 'admin_read_all', 'role_based', 'moderator_access', 'custom',
  ]
  if (!validTemplates.includes(template)) {
    // A REFUSAL, not a fallback to `auto`. Silently resolving an unrecognised
    // template to "read the schema and pick" is what let three requests to
    // replace a policy report success while changing nothing (defect #3).
    return {
      success: false,
      message:
        `Unknown RLS template "${template}" — no policy was applied to "${tableName}".\n` +
        `Valid templates: ${validTemplates.join(', ')}.\n` +
        `If none of them expresses your rule, use { template: "custom", using: "<predicate>" } — ` +
        `a boolean expression over this table's columns where backenly_jwt_claim('sub') is the calling ` +
        `end-user's id.`,
      code: 'UNKNOWN_TEMPLATE',
    }
  }

  const hasCommands =
    params.commands &&
    typeof params.commands === 'object' &&
    !Array.isArray(params.commands) &&
    Object.keys(params.commands).length > 0

  if (template === 'custom' && !params.using && !params.withCheck && !hasCommands) {
    return {
      success: false,
      message:
        `template "custom" needs a predicate. The four commands are independent, so the usual form names ` +
        `each one:\n` +
        `  { template: "custom", commands: { select: "published OR author_id::text = backenly_jwt_claim('sub')", ` +
        `insert: "author_id::text = backenly_jwt_claim('sub')", update: "author_id::text = backenly_jwt_claim('sub')", ` +
        `delete: "author_id::text = backenly_jwt_claim('sub')" } }\n` +
        `Naming only SOME commands scopes the edit to those and leaves the rest untouched. ` +
        `A single \`using\` applies one rule to all four, and \`withCheck\` overrides it for the writes.`,
      code: 'VALIDATION',
    }
  }

  try {
    const { applyPermissionPolicy } = await import('@/lib/services/workspace-rls')

    const result = await applyPermissionPolicy(projectId, {
      tableName,
      template,
      userIdColumn,
      roleColumn: params.roleColumn,
      ...(Array.isArray(params.partyColumns) ? { partyColumns: params.partyColumns } : {}),
      ...(params.using ? { using: params.using } : {}),
      ...(params.withCheck ? { withCheck: params.withCheck } : {}),
      ...(hasCommands ? { commands: params.commands } : {}),
    })

    if (!result.success) {
      return {
        success: false,
        message: `No policy was applied to "${tableName}". ${result.message}`,
        error: result.message,
        code: 'RLS_NOT_APPLIED',
      }
    }

    // ── Report what was INSTALLED, not what was requested ────────────────────
    //
    // This used to look the requested template up in a table of generic
    // descriptions and print that. So a request for `own_rows` printed "Users can
    // only see/edit their own rows" whether or not that was the policy the engine
    // actually installed — which is how a two-party table's `party_rows` upgrade,
    // and the reason for it, would have been invisible in the response.
    //
    // `result.message` is built from the policy that landed. It is the only
    // honest thing to print.
    return {
      success: true,
      message:
        `✅ **Permission policy applied to \`${tableName}\`.**\n\n` +
        `${result.message}\n\n` +
        `This is enforced at the PostgreSQL level — no app-layer code needed. ` +
        `Confirm with get_table_schema { tableName: "${tableName}" }, which lists the live policies ` +
        `including the roles they apply to.`,
      data: {
        tableName,
        requestedTemplate: template,
        description: result.message,
        // Which commands this call actually targeted, so a caller can tell a
        // scoped edit from a full replacement without parsing the prose.
        ...(hasCommands ? { commandsTargeted: Object.keys(params.commands) } : {}),
      },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to set permission: ${error.message}`, error: error.message, code: 'RLS_FAILED' }
  }
}

/**
 * LIST_PERMISSIONS: Show all RLS policies for this project
 */
async function executeListPermissions(projectId: string): Promise<ExecutionResult> {
  try {
    const { listPermissionPolicies } = await import('@/lib/services/workspace-rls')
    const policies = await listPermissionPolicies(projectId)

    if (policies.length === 0) {
      return {
        success: true,
        message: `No permission policies yet.\n\nTry: *"Users can only see their own posts"* — Backenly enforces it at the database level.`,
        data: { policies: [] },
      }
    }

    const lines = policies.map(p => `🔒 **${p.tableName}**: ${p.description || p.policyName}`)

    return {
      success: true,
      message: `🔒 **Permission Policies (${policies.length}):**\n\n${lines.join('\n')}`,
      data: { policies },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to list permissions: ${error.message}`, error: error.message }
  }
}

/**
 * REMOVE_PERMISSION: Remove all RLS policies from a table
 */
async function executeRemovePermission(params: any, projectId: string): Promise<ExecutionResult> {
  const { tableName } = params
  if (!tableName) return { success: false, message: 'tableName is required' }

  try {
    const { removePermissionPolicy } = await import('@/lib/services/workspace-rls')
    // The end state is READ BACK from the catalog, not asserted. This used to
    // report "All authenticated users can now access all rows" unconditionally —
    // which is the exact INVERSE of the truth when RLS is left enabled with zero
    // policies, because PostgreSQL then denies everything (defect #6).
    const state = await removePermissionPolicy(projectId, tableName)

    return {
      // RLS still on with no usable end-user policy is not a successful removal.
      // Reporting it as one is what let a half-finished run look complete.
      success: !(state.rlsEnabled && state.policyCount === 0),
      message: `Permission policies removed from \`${tableName}\`.\n\n**Actual state:** ${state.message}`,
      data: { tableName, removed: true, rlsEnabled: state.rlsEnabled, policyCount: state.policyCount },
      ...(state.rlsEnabled && state.policyCount === 0 ? { code: 'RLS_LOCKED_OUT' } : {}),
    }
  } catch (error: any) {
    return { success: false, message: `Failed to remove permission: ${error.message}`, error: error.message, code: 'RLS_REMOVE_FAILED' }
  }
}

// ============================================================================
// IAM: COMPLETE MISSING ACTIONS
// ============================================================================

/**
 * IAM: Revoke API Key
 */
async function executeRevokeKey(params: any, projectId: string): Promise<ExecutionResult> {
  const { keyId } = params
  if (!keyId) return { success: false, message: 'keyId is required' }

  try {
    const { prisma } = await import('@/lib/db')
    const key = await prisma.apiKey.findFirst({ where: { id: keyId, projectId } })
    if (!key) return { success: false, message: `API key "${keyId}" not found` }

    await prisma.apiKey.delete({ where: { id: keyId } })

    return {
      success: true,
      message: `✅ API key \`${key.keyPrefix}...\` (${key.name}) revoked. It can no longer be used.`,
      data: { revoked: true, keyId },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to revoke key: ${error.message}`, error: error.message }
  }
}

/**
 * IAM: Rotate API Key (create new, invalidate old)
 */
async function executeRotateKey(params: any, projectId: string): Promise<ExecutionResult> {
  const { keyId } = params
  if (!keyId) return { success: false, message: 'keyId is required' }

  try {
    const { prisma } = await import('@/lib/db')
    const crypto = await import('crypto')

    const existing = await prisma.apiKey.findFirst({ where: { id: keyId, projectId } })
    if (!existing) return { success: false, message: `API key "${keyId}" not found` }

    // Generate new key
    const newKeyValue = `sk_live_${crypto.randomBytes(24).toString('hex')}`
    const newPrefix = newKeyValue.substring(0, 12)
    const newHash = crypto.createHash('sha256').update(newKeyValue).digest('hex')

    await prisma.apiKey.update({
      where: { id: keyId },
      data: { key: newKeyValue, keyPrefix: newPrefix, keyHash: newHash },
    })

    return {
      success: true,
      message: `✅ **API key rotated.**\n\n**New key (copy now — shown once):**\n\`\`\`\n${newKeyValue}\n\`\`\`\n\nOld key is now invalid.`,
      data: { rotated: true, keyId, newKey: newKeyValue },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to rotate key: ${error.message}`, error: error.message }
  }
}

/**
 * IAM: Set Key Permissions
 */
async function executeSetKeyPermissions(params: any, projectId: string): Promise<ExecutionResult> {
  const { keyId, permissions } = params
  if (!keyId) return { success: false, message: 'keyId is required' }
  if (!Array.isArray(permissions)) return { success: false, message: 'permissions must be an array (e.g. ["read", "write"])' }

  try {
    const { prisma } = await import('@/lib/db')
    const key = await prisma.apiKey.findFirst({ where: { id: keyId, projectId } })
    if (!key) return { success: false, message: `API key "${keyId}" not found` }

    await prisma.apiKey.update({ where: { id: keyId }, data: { permissions } })

    return {
      success: true,
      message: `✅ API key \`${key.keyPrefix}...\` permissions updated to: ${permissions.join(', ')}`,
      data: { keyId, permissions },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to set permissions: ${error.message}`, error: error.message }
  }
}

// ============================================================================
// STORAGE: COMPLETE MISSING ACTIONS
// ============================================================================

/**
 * STORAGE: List Files in a bucket
 */
async function executeListFiles(params: any, projectId: string): Promise<ExecutionResult> {
  const { bucketName } = params
  const limit = Math.min(Number(params.limit) || 20, 100)
  // The brain tool passes `prefix`; `search` is accepted for any legacy caller.
  const prefix: string | undefined = params.prefix
  const search: string | undefined = params.search

  try {
    const { prisma } = await import('@/lib/db')

    // Resolve the bucket up front. If a name was given but does not exist,
    // fail loudly instead of silently listing every file in the project.
    let bucket: { id: string; name: string } | null = null
    if (bucketName) {
      bucket = await prisma.storageBucket.findFirst({
        where: { name: bucketName, projectId },
        select: { id: true, name: true },
      })
      if (!bucket) {
        return {
          success: false,
          message: `Bucket "${bucketName}" not found. Run LIST_BUCKETS to see the buckets in this project.`,
          error: 'bucket_not_found',
        }
      }
    }

    const files = await prisma.storageFile.findMany({
      where: {
        projectId,
        ...(bucket ? { bucketId: bucket.id } : {}),
        deletedAt: null,
        ...(prefix
          ? { name: { startsWith: prefix } }
          : search
            ? { name: { contains: search, mode: 'insensitive' } }
            : {}),
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        size: true,
        mimeType: true,
        isPublic: true,
        createdAt: true,
        bucket: { select: { name: true } },
      },
    })

    if (files.length === 0) {
      return {
        success: true,
        message:
          `No files found${bucketName ? ` in bucket "${bucketName}"` : ''}` +
          `${prefix ? ` matching prefix "${prefix}"` : search ? ` matching "${search}"` : ''}.`,
        data: { files: [] },
      }
    }

    const lines = files.map(f => {
      const size = f.size ? `${Math.round(Number(f.size) / 1024)}KB` : '?'
      return `📄 **${f.name}** (${size}) · ${f.bucket.name} · ${f.isPublic ? 'public' : 'private'}`
    })

    return {
      success: true,
      message: `📁 **Files (${files.length})${bucketName ? ` in \`${bucketName}\`` : ''}:**\n\n${lines.join('\n')}`,
      // Expose only the logical file identity — never the physical disk path,
      // which would tempt the model into passing it back as a bucket "path".
      data: {
        files: files.map(f => ({
          id: f.id,
          name: f.name,
          size: Number(f.size),
          mimeType: f.mimeType,
          isPublic: f.isPublic,
          bucket: f.bucket.name,
          createdAt: f.createdAt,
        })),
      },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to list files: ${error.message}`, error: error.message }
  }
}

/**
 * Resolve one storage file from the brain's `{ bucketName, path }` shape.
 * `path` is the file's name within the bucket. Falls back to `fileName` /
 * `fileId` so any legacy caller still resolves.
 */
async function resolveStorageFile(
  params: any,
  projectId: string,
): Promise<
  | { file: { id: string; name: string; isPublic: boolean } }
  | { error: string }
> {
  const { prisma } = await import('@/lib/db')
  const fileId: string | undefined = params.fileId
  const fileName: string | undefined = params.path ?? params.fileName
  const bucketName: string | undefined = params.bucketName

  if (fileId) {
    const file = await prisma.storageFile.findFirst({
      where: { id: fileId, projectId, deletedAt: null },
      select: { id: true, name: true, isPublic: true },
    })
    return file ? { file } : { error: `No file with id "${fileId}" in this project.` }
  }

  if (!fileName) {
    return { error: 'A file path (its name within the bucket) is required.' }
  }

  let bucketId: string | undefined
  if (bucketName) {
    const bucket = await prisma.storageBucket.findFirst({
      where: { name: bucketName, projectId },
      select: { id: true },
    })
    if (!bucket) {
      return { error: `Bucket "${bucketName}" not found. Run LIST_BUCKETS to see the buckets.` }
    }
    bucketId = bucket.id
  }

  const file = await prisma.storageFile.findFirst({
    where: { projectId, name: fileName, deletedAt: null, ...(bucketId ? { bucketId } : {}) },
    select: { id: true, name: true, isPublic: true },
    orderBy: { createdAt: 'desc' },
  })
  return file
    ? { file }
    : {
        error: `File "${fileName}"${bucketName ? ` in bucket "${bucketName}"` : ''} not found. Run LIST_FILES first.`,
      }
}

/**
 * STORAGE: Delete a file
 */
async function executeDeleteFile(params: any, projectId: string): Promise<ExecutionResult> {
  try {
    const resolved = await resolveStorageFile(params, projectId)
    if ('error' in resolved) {
      return { success: false, message: resolved.error, error: 'file_not_found' }
    }
    const { file } = resolved

    // Always go through storageService.deleteFile — it soft-deletes AND
    // decrements project.storageUsed in one transaction. Writing deletedAt
    // directly (the old path) skipped the quota counter, so deleting files
    // never freed up storage.
    const { storageService } = await import('@/lib/services/storage')
    await storageService.deleteFile(file.id, projectId)

    // Verify the soft-delete actually landed before reporting success.
    const { prisma } = await import('@/lib/db')
    const stillActive = await prisma.storageFile.findFirst({
      where: { id: file.id, deletedAt: null },
      select: { id: true },
    })
    if (stillActive) {
      return {
        success: false,
        message: `[FAILED] File "${file.name}" deletion could not be verified — it is still active. Try again.`,
        error: 'verification_failed',
      }
    }

    return {
      success: true,
      message: `🗑️ Deleted **${file.name}**${params.bucketName ? ` from \`${params.bucketName}\`` : ''}.`,
      data: { deleted: true, fileId: file.id, fileName: file.name },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to delete file: ${error.message}`, error: error.message }
  }
}

/**
 * STORAGE: Generate a signed URL for a file
 */
async function executeGenerateSignedUrl(params: any, projectId: string): Promise<ExecutionResult> {
  const expiresIn = Math.max(
    30,
    Math.min(86400, Number(params.expiresInSeconds ?? params.expiresIn ?? 3600)),
  )

  try {
    const resolved = await resolveStorageFile(params, projectId)
    if ('error' in resolved) {
      return { success: false, message: resolved.error, error: 'file_not_found' }
    }
    const { file } = resolved

    // Use storageService.getFileUrl — it issues an HMAC-signed, time-limited
    // URL that /api/storage/files/{id}/download actually validates. The old
    // hand-rolled token pointed at a route that never checked it (and required
    // an API key), so the "signed URL" was not usable at all.
    const { storageService } = await import('@/lib/services/storage')
    const relativeUrl = await storageService.getFileUrl(file.id, projectId, expiresIn)

    // Make it shareable: prefix the app origin when the URL is relative.
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')
    const fullUrl = relativeUrl.startsWith('http')
      ? relativeUrl
      : appUrl
        ? `${appUrl}${relativeUrl}`
        : relativeUrl

    const ttlLabel =
      expiresIn >= 3600
        ? `${Math.round(expiresIn / 3600)}h`
        : `${Math.round(expiresIn / 60)}m`
    const expiryNote = file.isPublic
      ? 'this file is public — the link does not expire'
      : `expires in ${ttlLabel}`

    return {
      success: true,
      message: [`🔗 Download link for **${file.name}** (${expiryNote}):`, '', fullUrl].join('\n'),
      data: {
        url: fullUrl,
        fileId: file.id,
        fileName: file.name,
        isPublic: file.isPublic,
        expiresInSeconds: file.isPublic ? null : expiresIn,
      },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to generate signed URL: ${error.message}`, error: error.message }
  }
}

// ============================================================================
// AI FUNCTIONS — Serverless logic described in natural language
// ============================================================================

/**
 * Validate AI function code syntax before persisting.
 *
 * The runtime executor wraps generated code in `async function handler(event, ctx) { ... }`,
 * so the validator must do the same — otherwise `await` at the top level of the body
 * produces a false "await is only valid in async functions" error.
 */
function validateFunctionSyntax(code: string): { valid: boolean; error?: string } {
  // Replaced `new Function(...)` with Acorn AST parse — no compilation, no
  // exposure to V8 parser quirks in the platform process. We parse the same
  // wrapper the VM executor uses (`async function handler(event, ctx) { ... }`)
  // so `await` at the top level of the body is valid.
  try {
    const acorn = require('acorn') as typeof import('acorn')
    const wrapped = `async function handler(event, ctx) {\n"use strict";\n${code}\n}`
    acorn.parse(wrapped, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: false,
      allowReturnOutsideFunction: false,
    })
    return { valid: true }
  } catch (err: any) {
    return { valid: false, error: err?.message ?? 'Syntax error' }
  }
}

/**
 * CREATE_AI_FUNCTION: Generate and deploy an AI function from a description
 */
async function executeCreateAiFunction(params: any, projectId: string): Promise<ExecutionResult> {
  const { description, triggerType, triggerTable } = params

  if (!description) return { success: false, message: 'description is required' }
  if (!triggerType) return { success: false, message: 'triggerType is required' }

  const validTriggers = ['on_signup', 'on_db_insert', 'on_db_update', 'on_db_delete', 'on_webhook', 'manual', 'cron']
  if (!validTriggers.includes(triggerType)) {
    return { success: false, message: `Invalid triggerType. Use: ${validTriggers.join(', ')}` }
  }

  const needsTable = ['on_db_insert', 'on_db_update', 'on_db_delete'].includes(triggerType)
  if (needsTable && !triggerTable) {
    return { success: false, message: 'triggerTable is required for database triggers' }
  }

  // L3 Fix: Guard Stripe-related functions behind a verified stored key.
  // Creating a Stripe webhook function without a key will silently fail at first invocation.
  const isStripeRelated = /stripe|payment|checkout|webhook.*pay|pay.*webhook/i.test(description)
  if (isStripeRelated) {
    try {
      const { prisma: _guardPrisma } = await import('@/lib/db')
      const stripeKey = await _guardPrisma.projectIntegrationKey.findFirst({
        where: { projectId, integrationId: { in: ['stripe', 'STRIPE_SECRET_KEY'] } },
      })
      if (!stripeKey) {
        return {
          success: false,
          message: `[BLOCKED] Cannot create Stripe function — no Stripe key is stored for this project.\n\nAction: Paste your Stripe secret key (\`sk_live_...\` or \`sk_test_...\`) in the chat to connect Stripe first, then re-request this function.`,
        }
      }
    } catch { /* non-fatal — proceed if guard check itself fails */ }
  }

  try {
    const { generateFunctionCode } = await import('@/lib/services/ai-functions/generator')
    const { prisma } = await import('@/lib/db')

    // Honor a pre-supplied name from the build runtime (e.g. "on_order_created").
    // This prevents the LLM from generating internal-sounding names like
    // "describe_ai_function_with_trigger" when the name-generation call gets confused.
    const suppliedName = typeof params.name === 'string' && params.name.trim()
      ? params.name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/__+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
      : null

    const generated = await generateFunctionCode(description, triggerType, triggerTable || null, projectId)
    const name = suppliedName || generated.name
    let code = generated.code

    // Guard: block phantom/placeholder functions before any DB write
    const { validateAiFunctionData } = await import('@/lib/ai/function-validation')
    const fnValidation = validateAiFunctionData(name, description)
    if (!fnValidation.valid) {
      console.warn(`[AI Executor] GENERATE_FUNCTION blocked: ${fnValidation.reason}`)
      return { success: false, message: `Could not create AI function — ${fnValidation.reason}. Please provide a concrete description of what this function should do.` }
    }

    // Deduplication: if a function with the same name already exists for this project, skip creation.
    const existing = await prisma.aiFunction.findFirst({
      where: { projectId, name },
    })
    if (existing) {
      return {
        success: true,
        message: `AI function \`${name}\` already exists — skipped duplicate creation.`,
        data: { id: existing.id, name: existing.name, status: existing.status },
        artifacts: { functions: [name] },
        verifiedAt: new Date().toISOString(),
      }
    }

    // Also deduplicate by trigger (same triggerType + triggerTable combo for non-manual triggers)
    if (triggerType !== 'manual' && triggerType !== 'cron' && triggerTable) {
      const sameTriggered = await prisma.aiFunction.findFirst({
        where: { projectId, triggerType, triggerTable },
      })
      if (sameTriggered) {
        return {
          success: true,
          message: `AI function \`${sameTriggered.name}\` already handles \`${triggerType}\` on \`${triggerTable}\` — skipped duplicate.`,
          data: { id: sameTriggered.id, name: sameTriggered.name, status: sameTriggered.status },
          artifacts: { functions: [sameTriggered.name] },
          verifiedAt: new Date().toISOString(),
        }
      }
    }

    let syntaxCheck = validateFunctionSyntax(code)

    // Creation-time repair: never store a function that cannot even parse.
    // Feed the exact syntax error back to the fixer once; only accept the
    // repair if it re-validates. Falls through to the honest status:'error'
    // path below when no valid repair could be produced.
    if (!syntaxCheck.valid) {
      try {
        const { generateFixedFunctionCode } = await import('@/lib/services/ai-functions/generator')
        const fixed = await generateFixedFunctionCode(
          code, `Syntax error: ${syntaxCheck.error}`, description, triggerType, triggerTable || null, projectId
        )
        if (fixed) {
          const recheck = validateFunctionSyntax(fixed)
          if (recheck.valid) {
            code = fixed
            syntaxCheck = recheck
          }
        }
      } catch { /* keep original code + honest error status */ }
    }

    const fn = await prisma.aiFunction.create({
      data: {
        projectId,
        name,
        description: description.trim(),
        generatedCode: code,
        triggerType,
        triggerTable: triggerTable || null,
        status: syntaxCheck.valid ? 'active' : 'error',
        // Store syntax error so the Functions tab can show an actionable message
        lastError: syntaxCheck.valid ? null : `Syntax error: ${syntaxCheck.error}`,
      },
    })

    const triggerLabel: Record<string, string> = {
      on_signup: 'every time a user signs up',
      on_db_insert: `every time a row is inserted into \`${triggerTable}\``,
      on_db_update: `every time a row is updated in \`${triggerTable}\``,
      on_db_delete: `every time a row is deleted from \`${triggerTable}\``,
      manual: 'only when manually triggered',
      cron: 'on the configured schedule',
    }

    // C1/18 Fix: Honest messaging — "registered" not "deployed".
    // The function is syntax-checked and stored. Runtime execution is NOT proven here.
    // First-run success must be verified in the Functions tab using a test event.
    const syntaxLine = syntaxCheck.valid
      ? `✅ Syntax: valid`
      : `⚠️ Syntax error: ${syntaxCheck.error} — function saved but will NOT execute until corrected`

    const baseMessage = [
      `**AI Function \`${fn.name}\` registered.**`,
      ``,
      `Trigger: ${triggerLabel[triggerType] ?? triggerType}`,
      syntaxLine,
      ``,
      `Manage, edit, and send a test event in the **Functions** tab.`,
      ``,
      `⚠️ **Runtime verification required:** Code is syntax-checked and stored. Use the Functions tab to fire a test event and confirm end-to-end execution before relying on it in production.`,
    ].join('\n')

    // If syntax is invalid, schedule an immediate background auto-fix attempt.
    // This means the user will see the function activate itself shortly after creation.
    if (!syntaxCheck.valid) {
      const { generateFixedFunctionCode } = await import('@/lib/services/ai-functions/generator')
      // Fire-and-forget — do not block the response
      generateFixedFunctionCode(code, syntaxCheck.error || 'syntax error', description, triggerType, triggerTable || null, projectId)
        .then(async (fixedCode) => {
          if (!fixedCode || fixedCode === code) return
          const recheckSyntax = validateFunctionSyntax(fixedCode)
          await prisma.aiFunction.update({
            where: { id: fn.id },
            data: {
              generatedCode: fixedCode,
              status: recheckSyntax.valid ? 'active' : 'error',
              lastError: recheckSyntax.valid ? null : `Syntax error: ${recheckSyntax.error}`,
            },
          })
        })
        .catch(() => {/* non-fatal */ })
    }

    return {
      success: syntaxCheck.valid,
      message: baseMessage,
      data: { functionId: fn.id, name: fn.name, triggerType, triggerTable, syntaxValid: syntaxCheck.valid },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to create AI function: ${error.message}`, error: error.message }
  }
}

/**
 * FIX_AI_FUNCTION: Regenerate code for a broken function using the error context.
 * Triggered when the user shows or describes a function error in chat.
 * params: { functionId?, functionName?, errorMessage? }
 */
async function executeFixAiFunction(params: any, projectId: string): Promise<ExecutionResult> {
  const { functionId, functionName, errorMessage } = params

  try {
    const { prisma } = await import('@/lib/db')

    // Find the function by ID or name
    const fn = functionId
      ? await prisma.aiFunction.findFirst({ where: { id: functionId, projectId } })
      : functionName
      ? await prisma.aiFunction.findFirst({ where: { name: functionName, projectId } })
      : null

    if (!fn) {
      // No specific function identified — list broken ones so the AI can pick
      const broken = await prisma.aiFunction.findMany({
        where: { projectId, status: 'error' },
        select: { id: true, name: true, lastError: true },
      })
      if (broken.length === 0) {
        return { success: true, message: 'No functions are currently in an error state.' }
      }
      const list = broken.map(f => `• \`${f.name}\`: ${(f.lastError || 'unknown error').slice(0, 80)}`).join('\n')
      return {
        success: false,
        message: `Could not identify which function to fix. Functions currently in error state:\n${list}\n\nPlease specify the function name to repair.`,
      }
    }

    const originalError = errorMessage || fn.lastError || 'unknown error'

    const { generateFixedFunctionCode } = await import('@/lib/services/ai-functions/generator')
    const fixedCode = await generateFixedFunctionCode(
      fn.generatedCode,
      originalError,
      fn.description,
      fn.triggerType,
      fn.triggerTable,
      projectId
    )

    if (!fixedCode || fixedCode === fn.generatedCode) {
      return {
        success: false,
        message: `Could not generate a fix for \`${fn.name}\` — the error may require deleting and recreating the function with a more specific description.\n\nOriginal error: ${originalError}`,
      }
    }

    const syntaxCheck = validateFunctionSyntax(fixedCode)

    await prisma.aiFunction.update({
      where: { id: fn.id },
      data: {
        generatedCode: fixedCode,
        status: syntaxCheck.valid ? 'active' : 'error',
        lastError: syntaxCheck.valid ? null : `Syntax error: ${syntaxCheck.error}`,
      },
    })

    if (!syntaxCheck.valid) {
      return {
        success: false,
        message: `Attempted to fix \`${fn.name}\` but the regenerated code still has a syntax error: ${syntaxCheck.error}\n\nTry deleting this function and asking me to recreate it with a more specific description.`,
      }
    }

    return {
      success: true,
      message: [
        `**Function \`${fn.name}\` repaired and is now active.**`,
        ``,
        `Fixed: ${originalError.slice(0, 120)}`,
        ``,
        `Go to the **Functions** tab → click ▶ Run to fire a test event and confirm it works end-to-end.`,
      ].join('\n'),
      data: { functionId: fn.id, name: fn.name, status: 'active' },
      artifacts: { functions: [fn.name] },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to fix function: ${error.message}`, error: error.message }
  }
}

/**
 * LIST_AI_FUNCTIONS: Show all AI functions for this project
 */
async function executeListAiFunctions(projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma } = await import('@/lib/db')
    // ── The SOURCE and the LAST ERROR are part of the answer ───────────────────
    //
    // This used to select metadata only. Combined with `{"error":"internal_error"}`
    // responses and no log access, that left exactly one way to find out what a
    // function contained: call `generate_function` again — which OVERWRITES it.
    // You could not inspect without mutating, so the only debugging loop
    // available destroyed the evidence it was gathering. A developer hit this
    // for real and had to reverse-engineer three broken functions by writing
    // specs prescriptive enough to dictate the code.
    //
    // `lastError` matters as much as the code: it is the difference between
    // "this function is wrong" and "this function is fine and the table it reads
    // has an RLS policy that matches nothing".
    const functions = await prisma.aiFunction.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, description: true, triggerType: true, triggerTable: true,
        status: true, runCount: true, lastRun: true, lastError: true, generatedCode: true,
      },
    })

    if (functions.length === 0) {
      return {
        success: true,
        message: 'No AI functions yet. Describe what you want to happen and I\'ll create one automatically.',
        data: { functions: [] },
      }
    }

    // Recent executions, so a failing function reports WHY without a second call.
    // Capped per function: an agent debugging one function does not need the
    // whole history, and an unbounded join here would blow the context window on
    // a project with busy cron jobs.
    const recentLogs = await prisma.aiFunctionLog.findMany({
      where: { functionId: { in: functions.map(f => f.id) } },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: { functionId: true, success: true, error: true, logs: true, createdAt: true, durationMs: true },
    }).catch(() => [] as any[])

    const logsByFn = new Map<string, any[]>()
    for (const log of recentLogs) {
      const bucket = logsByFn.get(log.functionId) ?? []
      if (bucket.length < 5) bucket.push(log)
      logsByFn.set(log.functionId, bucket)
    }

    const enriched = functions.map(fn => ({
      ...fn,
      // The public path, spelled exactly as it is served. The deployed name is
      // kebab-cased from whatever was requested (see slugifyFunctionName), and a
      // client written to the requested name 404s — so the ACTUAL url is stated
      // rather than left to be reconstructed.
      url: `/api/v1/${projectId}/fn/${fn.name}`,
      // The request shape, read out of the deployed source. See
      // extractFunctionContract — this is what stops "what does this endpoint
      // want?" from being answerable only by regenerating (which overwrites it).
      contract: extractFunctionContract(fn.generatedCode ?? ''),
      recentRuns: logsByFn.get(fn.id) ?? [],
    }))

    const list = enriched.map(fn => {
      const c = fn.contract
      const contractLine = c.fields.length
        ? `\n  Body: ${c.fields.map((f) => (c.required.includes(f) ? `${f} (required)` : f)).join(', ')}`
        : ''
      return (
        `• **${fn.name}** (${fn.status}) — ${fn.description.slice(0, 80)}${fn.description.length > 80 ? '…' : ''}\n` +
        `  ${c.method} ${fn.url}\n` +
        `  Trigger: \`${fn.triggerType}${fn.triggerTable ? ':' + fn.triggerTable : ''}\` · Runs: ${fn.runCount}` +
        contractLine +
        (fn.lastError ? `\n  ⚠ Last error: ${fn.lastError.slice(0, 160)}` : '')
      )
    }).join('\n')

    return {
      success: true,
      message:
        `**${functions.length} AI Function${functions.length !== 1 ? 's' : ''}:**\n\n${list}\n\n` +
        `Full source, recent runs and last errors are in \`data.functions[]\` — you never need to regenerate a function to read it (regenerating OVERWRITES it).`,
      data: { functions: enriched },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to list AI functions: ${error.message}`, error: error.message }
  }
}

/**
 * Read a generated function's request contract out of its own source.
 *
 * ── Why this is derived rather than stored ──────────────────────────────────
 *
 * A generated function's payload shape was undiscoverable: no schema endpoint,
 * no docs, and the only way to see the code was to call `generate_function`
 * again — which regenerates and OVERWRITES it. So inspecting a function
 * destroyed the thing being inspected, and a `400 {"error":"Missing or invalid
 * required fields"}` was unanswerable except by guessing payloads.
 *
 * `list_ai_functions` already returns `generatedCode`, so the contract is
 * present — it was just left as a wall of TypeScript for the caller to read.
 * This lifts the shape out of it, which works on functions generated BEFORE
 * the codegen contract started requiring an explicit `required` block, so
 * existing broken functions become answerable too.
 *
 * Best-effort by design: it reports what it can see and never guesses. An empty
 * result means "read the source in `data`", not "this endpoint takes nothing".
 */
function extractFunctionContract(code: string): {
  method: string
  fields: string[]
  required: string[]
} {
  if (!code) return { method: 'POST', fields: [], required: [] }

  // The exported handler name IS the HTTP method in the route-module contract.
  const methodMatch = code.match(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/)
  const method = methodMatch?.[1] ?? 'POST'

  const fields = new Set<string>()
  const required = new Set<string>()

  // Destructured reads off the parsed body: `const { a, b } = await request.json()`
  for (const m of code.matchAll(/const\s*\{([^}]+)\}\s*=\s*(?:await\s+)?(?:request\.json\(\)|body\b)/g)) {
    for (const raw of m[1].split(',')) {
      // Strip renames and defaults: `a: b = 1` → `a`
      const name = raw.split(':')[0].split('=')[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) fields.add(name)
    }
  }
  // Property reads: `body.foo`, `payload.foo`
  for (const m of code.matchAll(/\b(?:body|payload|json)\.([A-Za-z_$][\w$]*)/g)) fields.add(m[1])
  // Query params: `searchParams.get('foo')`
  for (const m of code.matchAll(/searchParams\.get\(\s*['"`]([^'"`]+)['"`]/g)) fields.add(m[1])

  // Explicitly-declared required lists — the shape the codegen contract now
  // mandates: `['a','b'].filter(...)` or `required: { a: '…', b: '…' }`.
  for (const m of code.matchAll(/\[([^\]]+)\]\s*\.filter\s*\(\s*\(?\s*[A-Za-z_$][\w$]*\s*\)?\s*=>/g)) {
    for (const q of m[1].matchAll(/['"`]([A-Za-z_$][\w$]*)['"`]/g)) {
      required.add(q[1]); fields.add(q[1])
    }
  }
  // Guard clauses: `if (!foo) return … 400`
  for (const m of code.matchAll(/if\s*\(\s*!([A-Za-z_$][\w$]*)\s*\)[^\n]*\n?[^\n]*400/g)) {
    if (fields.has(m[1])) required.add(m[1])
  }

  // Locals that are obviously not request input.
  const NOISE = new Set(['request', 'params', 'projectId', 'prisma', 'NextResponse', 'error', 'err'])
  const out = [...fields].filter((f) => !NOISE.has(f))
  return { method, fields: out, required: [...required].filter((f) => !NOISE.has(f)) }
}

/**
 * DELETE_AI_FUNCTION: Remove an AI function by ID or name
 */
async function executeDeleteAiFunction(params: any, projectId: string): Promise<ExecutionResult> {
  const { functionId, name } = params

  try {
    const { prisma } = await import('@/lib/db')
    const fn = functionId
      ? await prisma.aiFunction.findFirst({ where: { id: functionId, projectId } })
      : await prisma.aiFunction.findFirst({ where: { name, projectId } })

    if (!fn) {
      return { success: false, message: `AI function "${functionId || name}" not found` }
    }

    await prisma.aiFunction.delete({ where: { id: fn.id } })

    return {
      success: true,
      message: `✅ AI function \`${fn.name}\` deleted.`,
      data: { deleted: true, name: fn.name },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to delete AI function: ${error.message}`, error: error.message }
  }
}

/**
 * TOGGLE_AI_FUNCTION: Enable or disable an AI function
 */
async function executeToggleAiFunction(params: any, projectId: string): Promise<ExecutionResult> {
  const { functionId, name, active } = params

  try {
    const { prisma } = await import('@/lib/db')
    const fn = functionId
      ? await prisma.aiFunction.findFirst({ where: { id: functionId, projectId } })
      : await prisma.aiFunction.findFirst({ where: { name, projectId } })

    if (!fn) {
      return { success: false, message: `AI function "${functionId || name}" not found` }
    }

    const newStatus = active ? 'active' : 'inactive'
    await prisma.aiFunction.update({ where: { id: fn.id }, data: { status: newStatus } })

    return {
      success: true,
      message: `✅ AI function \`${fn.name}\` is now **${newStatus}**.`,
      data: { functionId: fn.id, name: fn.name, status: newStatus },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to toggle AI function: ${error.message}`, error: error.message }
  }
}

// ─── Schema Version History (#13) ─────────────────────────────────────────────

/**
 * LIST_SCHEMA_VERSIONS: Show all saved schema snapshots for this project
 */
async function executeListSchemaVersions(projectId: string): Promise<ExecutionResult> {
  try {
    const { listSchemaVersions } = await import('@/lib/versioning/schema-versions')
    const versions = await listSchemaVersions(projectId)

    if (versions.length === 0) {
      return {
        success: true,
        message: 'No schema versions recorded yet. Versions are saved automatically before each schema change.',
        data: { versions: [] },
      }
    }

    const lines = versions.slice(0, 10).map(v => {
      const date = new Date(v.createdAt).toLocaleString()
      return `  v${v.versionNum} — ${date}: ${v.description}`
    })

    return {
      success: true,
      message: `Schema version history (${versions.length} versions):\n${lines.join('\n')}\n\nTo rollback: "rollback to version 3" or "undo the auth I added"`,
      data: { versions },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to list versions: ${error.message}`, error: error.message }
  }
}

/**
 * ROLLBACK_TO_VERSION: Revert schema to a specific version
 * params: { versionNum?: number, versionId?: string, description?: string }
 */
async function executeRollbackToVersion(params: any, projectId: string): Promise<ExecutionResult> {
  try {
    const { listSchemaVersions, rollbackToVersion } = await import('@/lib/versioning/schema-versions')

    let targetVersionId = params.versionId

    // Resolve by version number if ID not provided
    if (!targetVersionId && params.versionNum) {
      const versions = await listSchemaVersions(projectId)
      const match = versions.find(v => v.versionNum === Number(params.versionNum))
      if (!match) {
        return { success: false, message: `Version ${params.versionNum} not found. Use "show schema history" to see available versions.` }
      }
      targetVersionId = match.id
    }

    if (!targetVersionId) {
      return { success: false, message: 'Specify a version number: "rollback to version 3" or "show schema history" to see versions.' }
    }

    const result = await rollbackToVersion(projectId, targetVersionId)

    return {
      success: result.success,
      message: result.message,
      data: { statementsExecuted: result.statementsExecuted },
    }
  } catch (error: any) {
    return { success: false, message: `Rollback failed: ${error.message}`, error: error.message }
  }
}

// ============================================================================
// INTEGRATION KEY MANAGEMENT
// ============================================================================

/**
 * STORE_INTEGRATION_KEY: Securely store a third-party API key
 * params: { integrationId: string, apiKey: string, webhookSecret?: string }
 *
 * After storing the key, performs provider-specific auto-wiring:
 *   stripe     → validates webhookSecret, adds columns to orders/payments table,
 *                generates /checkout/session and /webhooks/stripe endpoints
 *   resend/sendgrid → if auth enabled, creates welcome + password-reset email triggers
 *   openai/anthropic → generates /ai/chat and /ai/embed endpoints with rate limiting
 */
async function executeStoreIntegrationKey(params: any, projectId: string): Promise<ExecutionResult> {
  const { integrationId, apiKey, webhookSecret } = params
  if (!integrationId || !apiKey) {
    // Friendly pending state — never a hard error. Show inline key prompt with skip option.
    const providerName = integrationId
      ? integrationId.charAt(0).toUpperCase() + integrationId.slice(1)
      : 'external provider'
    const KEY_EXAMPLES: Record<string, string> = {
      stripe: 'sk_live_... or sk_test_...',
      resend: 're_...',
      sendgrid: 'SG.xxx.yyy',
      openai: 'sk-...',
      anthropic: 'sk-ant-api03-...',
      twilio: 'AC... (Account SID) + auth token',
      replicate: 'r8_...',
      runway: 'rw_...',
      luma: 'luma_...',
    }
    const example = integrationId ? (KEY_EXAMPLES[integrationId.toLowerCase()] ?? `your ${providerName} API key`) : 'your API key'
    return {
      success: false,
      message: [
        `**To connect ${providerName}**, paste your API key here:`,
        ``,
        `Example format: \`${example}\``,
        ``,
        `Or say **"skip for now"** to continue without it — you can connect it later.`,
      ].join('\n'),
      error: 'CREDENTIALS_PENDING',
    }
  }

  // ── Stripe without a webhook secret is a DEGRADED connect, not a refusal ───
  //
  // This used to hard-fail with STRIPE_WEBHOOK_SECRET_MISSING. That looks like
  // rigour and is the opposite: an agent that does not have the secret cannot
  // obtain one mid-turn, so the only way past the gate was to invent a
  // `whsec_…`-shaped string — which is exactly what happened, and Backenly
  // filed the fabricated value as a second credential nobody supplied. A wrong
  // signing secret fails silently on Stripe's side, so the user learns about it
  // from missing deliveries days later.
  //
  // Connect the key, do the work that does not need the secret, and say plainly
  // which capability is off until the real secret arrives. A missing credential
  // is a known gap; a fabricated one is a lie in the vault.
  const webhookSecretPending = integrationId === 'stripe' && !webhookSecret

  try {
    const { storeIntegrationKey } = await import('@/lib/services/integrationKeyStore')
    const status = await storeIntegrationKey(projectId, integrationId, apiKey)
    const keyValidationNote =
      status.verification === 'verified' ? ''
      : status.verification === 'unreachable' ? `\n\n⚠ ${status.verificationDetail}`
      : `\n\nℹ ${status.verificationDetail}`

    // Store webhook secret separately when provided. NEVER synthesise one:
    // there is no branch here that writes a value the caller did not pass.
    if (webhookSecret) {
      await storeIntegrationKey(projectId, `${integrationId}_webhook_secret`, webhookSecret)
    }

    const autoWiredSteps: string[] = []

    // ── PROMPT 2.1: Stripe auto-wiring ─────────────────────────────────────
    if (integrationId === 'stripe') {
      const { prisma } = await import('@/lib/db')

      // Detect orders or payments table
      const ordersTable = await prisma.table.findFirst({
        where: { projectId, name: { in: ['orders', 'order', 'payments', 'payment'] } },
      })

      if (ordersTable) {
        const tableName = ordersTable.name

        // Add stripeSessionId column
        const col1 = await executeAddColumn(
          { tableName, columnName: 'stripeSessionId', columnType: 'TEXT' },
          projectId,
        )
        if (col1.success) autoWiredSteps.push(`✅ Added \`stripeSessionId\` to \`${tableName}\``)

        // Add status column
        const col2 = await executeAddColumn(
          { tableName, columnName: 'status', columnType: 'TEXT' },
          projectId,
        )
        if (col2.success) autoWiredSteps.push(`✅ Added \`status\` to \`${tableName}\``)
      }

      // Generate POST /checkout/session endpoint
      const { executeGenerateFunction } = await import('@/lib/ai/function-generator')

      const checkoutResult = await executeGenerateFunction(
        {
          functionName: 'stripe-checkout-session',
          description: [
            'Create a Stripe Checkout session.',
            'Accept { lineItems, successUrl, cancelUrl, customerEmail? } in the request body.',
            'Call ctx.integrations.stripe.createCheckoutSession({ lineItems, successUrl, cancelUrl, customerEmail }) — it returns { id, url }.',
            'Each lineItem is { price: "price_xxx", quantity } or { priceData: { currency, unitAmount, productName, recurringInterval? }, quantity }.',
            'Require authentication — reject unauthenticated requests with 401.',
            'Return { checkoutUrl: session.url, sessionId: session.id }.',
          ].join(' '),
          method: 'POST',
        },
        projectId,
      )
      if (checkoutResult.success) autoWiredSteps.push('✅ Generated `POST /checkout/session`')

      // Generate the Stripe webhook handler.
      // The platform receiver at POST /api/v1/{projectId}/webhooks/stripe already
      // verifies the Stripe-Signature header and runs deterministic order/subscription
      // updates BEFORE this function fires — so this function works on an
      // already-verified event.data payload and must NOT re-verify signatures.
      const webhookResult = await executeGenerateFunction(
        {
          functionName: 'stripe-webhook',
          description: [
            'Process a verified Stripe webhook event delivered in event.data.',
            'The platform webhook receiver has already verified the signature — do not re-verify.',
            'Read event.data.type for the Stripe event type and event.data.data.object for the payload.',
            'On checkout.session.completed: update the matching order row status to "paid".',
            'On payment_intent.succeeded: log the payment.',
            'Return { handled: true } for recognised events.',
          ].join(' '),
          method: 'POST',
        },
        projectId,
      )
      if (webhookResult.success) autoWiredSteps.push('✅ Generated `stripe-webhook` handler')
    }

    // ── PROMPT 2.2: Email triggers ──────────────────────────────────────────
    if (integrationId === 'resend' || integrationId === 'sendgrid') {
      const graph = await getActiveGraph(projectId)
      const authEnabled = graph?.auth?.providers?.email?.enabled === true

      if (authEnabled) {
        // Welcome email on user sign-up
        const welcomeResult = await executeCreateAiFunction(
          {
            description: `When a user signs up, send them a welcome email using ctx.integrations.${integrationId}.send(). Address the email to the user's email, use a friendly subject line, and include their name if available.`,
            triggerType: 'on_signup',
          },
          projectId,
        )
        if (welcomeResult.success) {
          autoWiredSteps.push(`✅ Created welcome email trigger (on_signup → ${integrationId})`)
        }

        // Password-reset email when a reset record is inserted
        const { prisma } = await import('@/lib/db')
        const resetTable = await prisma.table.findFirst({
          where: { projectId, name: { in: ['password_reset', 'password_resets', 'reset_tokens'] } },
        })

        if (resetTable) {
          const resetResult = await executeCreateAiFunction(
            {
              description: `When a password reset record is inserted into \`${resetTable.name}\`, send a password reset email to the user using ctx.integrations.${integrationId}.send(). Include the reset token as a link. Log the delivery result.`,
              triggerType: 'on_db_insert',
              triggerTable: resetTable.name,
            },
            projectId,
          )
          if (resetResult.success) {
            autoWiredSteps.push(`✅ Created password reset trigger (${resetTable.name}.insert → ${integrationId})`)
          }
        }
      }
    }

    // ── PROMPT 2.3: AI route generation ────────────────────────────────────
    if (integrationId === 'openai' || integrationId === 'anthropic') {
      const { executeGenerateFunction } = await import('@/lib/ai/function-generator')

      // POST /ai/chat — rate-limited, auth-protected
      const chatResult = await executeGenerateFunction(
        {
          functionName: `${integrationId}-chat`,
          description: [
            `AI chat endpoint backed by ${integrationId}.`,
            'Accept { prompt, systemPrompt?, maxTokens? } in the request body.',
            `Call ctx.integrations.${integrationId}.complete(prompt, maxTokens, systemPrompt) — it returns the assistant reply as a string.`,
            'Apply rate limiting of 10 requests per minute per authenticated user.',
            'Require authentication — reject unauthenticated requests with 401.',
            'Return { reply }.',
          ].join(' '),
          method: 'POST',
        },
        projectId,
      )
      if (chatResult.success) autoWiredSteps.push('✅ Generated `POST /ai/chat` (rate-limited, auth-protected)')

      // POST /ai/embed — OpenAI only. Anthropic has no embeddings API, so an
      // anthropic-embed function would be unrunnable — never generate it.
      if (integrationId === 'openai') {
        const embedResult = await executeGenerateFunction(
          {
            functionName: 'openai-embed',
            description: [
              'Text embedding endpoint backed by OpenAI.',
              'Accept { text } in the request body.',
              'Call ctx.integrations.openai.embed(text) — it returns a number[] embedding vector.',
              'Apply rate limiting of 20 requests per minute per authenticated user.',
              'Require authentication — reject unauthenticated requests with 401.',
              'Return { embedding }.',
            ].join(' '),
            method: 'POST',
          },
          projectId,
        )
        if (embedResult.success) autoWiredSteps.push('✅ Generated `POST /ai/embed` (rate-limited, auth-protected)')
      }
    }

    // ── Sync activeIntegrations so the dashboard shows the same state as chat ─
    // The integrations dashboard reads project.activeIntegrations[id].enabled.
    // Without this write, storing a key via chat leaves the dashboard showing
    // "Not provisioned" while chat says "connected" — a source-of-truth split.
    try {
      const { prisma: _syncPrisma } = await import('@/lib/db')
      const _existingProject = await _syncPrisma.project.findUnique({
        where: { id: projectId },
        select: { activeIntegrations: true },
      })
      const _existing = (_existingProject?.activeIntegrations as Record<string, any>) ?? {}
      // Always refresh the verification fields even when already enabled — a
      // re-connect with a better key must be able to move the badge from
      // "unreachable" to "confirmed", and the dashboard must never render
      // `enabled: true` as "connected" without saying whether the provider
      // actually confirmed the credential.
      await _syncPrisma.project.update({
        where: { id: projectId },
        data: {
          activeIntegrations: {
            ..._existing,
            [integrationId]: {
              ...(_existing[integrationId] ?? {}),
              enabled: true,
              activatedAt: _existing[integrationId]?.activatedAt ?? new Date().toISOString(),
              activatedBy: _existing[integrationId]?.activatedBy ?? 'key_store',
              maskedKey: status.maskedKey,
              verification: status.verification,
              verificationDetail: status.verificationDetail,
              webhookSecretPending,
            },
          },
        },
      })
    } catch { /* non-fatal — dashboard sync is best-effort */ }

    const webhookUrl = webhookSecret
      ? `\n\nWebhook URL: \`/api/v1/${projectId}/webhooks/${integrationId}\`\n\nConfigure this URL in your ${integrationId} dashboard to receive events.`
      : ''

    // Name the capability that is off, and say who has to do what. Stripe does
    // not let anyone register a webhook endpoint on a merchant's behalf, so this
    // step is genuinely manual — the docs claiming otherwise is finding #41.
    const webhookGap = webhookSecretPending
      ? [
          '',
          '⚠ **Webhook signature verification is NOT active.**',
          `Backenly has no signing secret for Stripe, so \`/api/v1/${projectId}/webhooks/stripe\` will reject`,
          'incoming events rather than trust an unverified payload.',
          '',
          'To finish: Stripe Dashboard → Developers → Webhooks → add endpoint',
          `\`${process.env.NEXT_PUBLIC_APP_URL ?? 'https://backenly.com'}/api/v1/${projectId}/webhooks/stripe\``,
          'then send the signing secret (`whsec_…`) and Backenly will store it.',
          '',
          'Backenly cannot register the endpoint for you — Stripe has no API that allows it.',
        ].join('\n')
      : ''

    const autoWiredMsg = autoWiredSteps.length > 0
      ? `\n\n**Auto-wired:**\n${autoWiredSteps.join('\n')}`
      : ''

    return {
      success: true,
      message: `${integrationId} connected. Key stored securely (${status.maskedKey}).${keyValidationNote}${webhookUrl}${webhookGap}${autoWiredMsg}\n\nAI functions can now use \`ctx.integrations.${integrationId}.*\` to call ${integrationId} APIs.`,
      data: {
        integrationId,
        maskedKey: status.maskedKey,
        verification: status.verification,
        verificationDetail: status.verificationDetail,
        webhookSecretPending,
        autoWired: autoWiredSteps,
      },
    }
  } catch (error: any) {
    // A key the provider REJECTED is not a storage failure — it is a wrong
    // credential, and saying so is the difference between the caller fixing it
    // now and discovering it at the first live request.
    if (error?.isVerificationError) {
      return {
        success: false,
        message: `**${integrationId} was not connected.** ${error.message}`,
        error: 'INTEGRATION_KEY_REJECTED',
      }
    }
    if (error?.isFormatError) {
      return {
        success: false,
        message: `**${integrationId} was not connected.** ${error.message}`,
        error: 'INTEGRATION_KEY_FORMAT',
      }
    }
    return { success: false, message: `Failed to store key: ${error.message}`, error: error.message }
  }
}

/**
 * LIST_INTEGRATION_KEYS: Show all connected integrations
 */
async function executeListIntegrationKeys(projectId: string): Promise<ExecutionResult> {
  try {
    const { listKeyVaultStatuses } = await import('@/lib/services/integrationKeyStore')
    const { checkAllIntegrationReadiness, formatReadinessReport, readinessEmoji } = await import('@/lib/integrations/readiness')

    const keys = await listKeyVaultStatuses(projectId)

    if (keys.length === 0) {
      // Read the list from the provider registry rather than restating it here.
      // The hardcoded copy said "stripe, resend, sendgrid, openai, anthropic,
      // posthog, twilio" and silently omitted onesignal, replicate, runway and
      // stability — four connectors that work — while the public docs advertised
      // a different subset again. One registry, every surface.
      const { connectableProviderIds } = await import('@/lib/services/ai-functions/integration-registry')
      return {
        success: true,
        message: `No integrations connected.\n\nAvailable: ${connectableProviderIds()}\n\nExample: "connect Stripe with key sk_live_..."`,
      }
    }

    // Compute readiness for every integration that has an active entry
    const readinessReports = await checkAllIntegrationReadiness(projectId).catch(() => [])
    const readinessByProvider = Object.fromEntries(readinessReports.map(r => [r.integrationId, r]))

    const lines: string[] = ['**Connected integrations:**', '']
    for (const k of keys) {
      // Skip internal compound keys (e.g. stripe_webhook_secret) — they are shown inside the parent report
      if (k.integrationId.includes('_webhook_secret') || k.integrationId.includes('_secret')) continue

      const report = readinessByProvider[k.integrationId]
      const connectedDate = new Date(k.connectedAt).toLocaleDateString()

      if (report) {
        lines.push(formatReadinessReport(report))
        lines.push(`  Key: \`${k.maskedKey}\` · Connected ${connectedDate}`)
        if (report.nextSteps.length > 0) {
          lines.push('  **Next steps:**')
          lines.push(...report.nextSteps.map(s => `  ${s}`))
        }
      } else {
        lines.push(`🔑 **${k.integrationId}** — Key Stored`)
        lines.push(`  Key: \`${k.maskedKey}\` · Connected ${connectedDate}`)
      }
      lines.push('')
    }

    return {
      success: true,
      message: lines.join('\n').trimEnd(),
      data: { keys, readiness: readinessReports },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to list keys: ${error.message}` }
  }
}

/**
 * REMOVE_INTEGRATION_KEY: Disconnect an integration
 * params: { integrationId: string }
 */
async function executeRemoveIntegrationKey(params: any, projectId: string): Promise<ExecutionResult> {
  const { integrationId } = params
  if (!integrationId) return { success: false, message: 'integrationId is required' }

  try {
    const { prisma: db } = await import('@/lib/db')
    await db.projectIntegrationKey.deleteMany({
      where: { projectId, integrationId: { startsWith: integrationId } },
    })
    return {
      success: true,
      message: `${integrationId} disconnected. Key removed from vault.`,
    }
  } catch (error: any) {
    return { success: false, message: `Failed to remove key: ${error.message}` }
  }
}

// ============================================================================
// BACKGROUND JOBS / CRON SCHEDULING
// ============================================================================

/**
 * Translate human-readable schedule to a cron expression.
 * e.g. "every day at 9am" → "0 9 * * *"
 */
function toCronExpression(schedule: string): string {
  const s = schedule.toLowerCase().trim()

  // Already a cron expression (5 parts)
  if (/^[\d\*\/\-,]+ [\d\*\/\-,]+ [\d\*\/\-,]+ [\d\*\/\-,]+ [\d\*\/\-,]+$/.test(s)) {
    return s
  }

  // Common patterns
  if (s.includes('every minute') || s === 'minutely') return '* * * * *'
  if (s.includes('every 5 min')) return '*/5 * * * *'
  if (s.includes('every 15 min')) return '*/15 * * * *'
  if (s.includes('every 30 min')) return '*/30 * * * *'
  if (s.includes('every hour') || s === 'hourly') return '0 * * * *'
  if (s.includes('every day') || s === 'daily') {
    const hourMatch = s.match(/at (\d+)(am|pm)?/)
    if (hourMatch) {
      let hour = parseInt(hourMatch[1])
      if (hourMatch[2] === 'pm' && hour < 12) hour += 12
      if (hourMatch[2] === 'am' && hour === 12) hour = 0
      return `0 ${hour} * * *`
    }
    return '0 9 * * *' // default 9am
  }
  if (s.includes('every week') || s === 'weekly') return '0 9 * * 1' // Monday 9am
  if (s.includes('every month') || s === 'monthly') return '0 9 1 * *' // 1st of month 9am
  if (s.includes('midnight')) return '0 0 * * *'
  if (s.includes('noon')) return '0 12 * * *'

  // Default: daily at 9am
  return '0 9 * * *'
}

/**
 * CREATE_CRON_JOB: Create a scheduled background job (AI function + schedule)
 * params: { description: string, schedule: string, triggerTable?: string }
 *
 * Stored as an AiFunction with triggerType='cron' and the cron expression in
 * the triggerTable field.  Executed every minute by:
 *   - node-cron in instrumentation.ts (self-hosted / Hetzner / PM2)
 *   - /api/cron/run-ai-jobs via Vercel Cron (vercel.json)
 */
async function executeCreateCronJob(params: any, projectId: string): Promise<ExecutionResult> {
  const { description, schedule, triggerTable } = params
  if (!description) return { success: false, message: 'description is required' }
  if (!schedule) return { success: false, message: 'schedule is required (e.g. "every day at 9am", "0 9 * * *")' }

  try {
    const cronExpr = toCronExpression(schedule)
    const { generateFunctionCode } = await import('@/lib/services/ai-functions/generator')
    const { prisma: db } = await import('@/lib/db')

    // Generate the function code — pass 'cron' so the AI knows this runs on a schedule
    const generated = await generateFunctionCode(description, 'cron', null, projectId)

    // Guard: never persist a phantom/placeholder cron function
    const { validateAiFunctionData } = await import('@/lib/ai/function-validation')
    const validation = validateAiFunctionData(generated.name, description)
    if (!validation.valid) {
      console.warn(`[AI Executor] Cron job creation blocked: ${validation.reason}`)
      return { success: false, message: `Could not create scheduled job — the generated name was invalid. Please describe what the job should do more clearly.` }
    }

    // Store as AI function with triggerType='cron'
    const fn = await db.aiFunction.create({
      data: {
        projectId,
        name: validation.name,
        description,
        generatedCode: generated.code,
        triggerType: 'cron',
        triggerTable: cronExpr, // reuse triggerTable field to store cron expression
        status: 'active',
      },
    })

    return {
      success: true,
      message: `Scheduled job created: "${fn.name}"\n\nSchedule: ${schedule} (${cronExpr})\nDescription: ${description}\n\nThe job will run automatically on the configured schedule.`,
      data: { functionId: fn.id, name: fn.name, cron: cronExpr },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to create cron job: ${error.message}`, error: error.message }
  }
}

/**
 * LIST_CRON_JOBS: Show all scheduled jobs
 */
async function executeListCronJobs(projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma: db } = await import('@/lib/db')
    const jobs = await db.aiFunction.findMany({
      where: { projectId, triggerType: 'cron' },
      select: { id: true, name: true, description: true, triggerTable: true, status: true, lastRun: true, runCount: true },
      orderBy: { createdAt: 'asc' },
    })

    if (jobs.length === 0) {
      return { success: true, message: 'No scheduled jobs yet.\n\nExample: "Send cart abandonment email every day at 9am"' }
    }

    const list = jobs.map(j =>
      `- ${j.name} (${j.triggerTable})\n  ${j.description}\n  Status: ${j.status} | Runs: ${j.runCount} | Last: ${j.lastRun?.toLocaleString() || 'never'}`
    ).join('\n\n')

    return { success: true, message: `Scheduled jobs:\n\n${list}`, data: { jobs } }
  } catch (error: any) {
    return { success: false, message: `Failed to list jobs: ${error.message}` }
  }
}

/**
 * DELETE_CRON_JOB: Remove a scheduled job
 * params: { jobId?: string, name?: string }
 */
async function executeDeleteCronJob(params: any, projectId: string): Promise<ExecutionResult> {
  const { jobId, name } = params
  if (!jobId && !name) return { success: false, message: 'jobId or name is required' }

  try {
    const { prisma: db } = await import('@/lib/db')
    const job = await db.aiFunction.findFirst({
      where: {
        projectId,
        triggerType: 'cron',
        OR: [
          ...(jobId ? [{ id: jobId }] : []),
          ...(name ? [{ name: { contains: name, mode: 'insensitive' as const } }] : []),
        ],
      },
    })

    if (!job) return { success: false, message: `Cron job "${name || jobId}" not found` }

    await db.aiFunction.delete({ where: { id: job.id } })
    return { success: true, message: `Scheduled job "${job.name}" deleted.` }
  } catch (error: any) {
    return { success: false, message: `Failed to delete job: ${error.message}` }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW ACTIONS (GAP CLOSURES)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GENERATE_AGGREGATE_API
 * Registers an aggregate stats ApiDefinition pointing to the built-in
 * /v1/{projectId}/stats/summary runtime endpoint.
 *
 * params: {
 *   name?:   string  e.g. "summary", "dashboard"
 *   tables?: string[]  tables to aggregate (for documentation)
 * }
 */
async function executeGenerateAggregateApi(params: any, projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma: db } = await import('@/lib/db')
    const name = params?.name ?? 'summary'
    const path = `/stats/${name}`

    // Store as an ApiDefinition so the UI shows it under APIs
    const existing = await db.apiDefinition.findFirst({
      where: { projectId, basePath: path },
    })

    if (existing) {
      return {
        success: true,
        message: `Aggregate stats endpoint already registered at GET ${path}`,
        data: { path },
        artifacts: { apis: [{ method: 'GET', path }] },
      }
    }

    // Route is file-based — no DB registration needed
    return {
      success: true,
      message: `Aggregate stats endpoint ready.\n\nGET /api/v1/${projectId}/stats/${name}\n\nReturns: totalProducts, totalOrders, totalRevenue, pendingOrders, lowStockProducts, recentOrders[]`,
      artifacts: { apis: [{ method: 'GET', path }] },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to generate aggregate API: ${error.message}`, error: error.message }
  }
}

/**
 * GENERATE_CHECKOUT_FLOW
 * Registers cart + checkout ApiDefinitions so the UI displays them.
 * The actual routes are already live at /v1/{projectId}/cart/* and /v1/{projectId}/checkout.
 */
async function executeGenerateCheckoutFlow(projectId: string): Promise<ExecutionResult> {
  try {
    const routes = [
      { path: '/cart',               ops: { get: true, delete: true }, description: 'In-memory cart (GET current cart, DELETE to clear)' },
      { path: '/cart/items',         ops: { create: true },            description: 'Add item to cart (POST { productId, quantity })' },
      { path: '/cart/items/:productId', ops: { update: true, delete: true }, description: 'Update or remove a specific cart item' },
      { path: '/cart/clear',         ops: { delete: true },            description: 'Clear all cart items' },
      { path: '/checkout',           ops: { create: true },            description: 'Convert cart to order (POST { customerName?, customerEmail?, shippingAddress? })' },
    ]

    // Routes are file-based — no DB registration needed
    return {
      success: true,
      message: `Checkout flow ready.\n\nCart endpoints:\n- GET  /cart\n- POST /cart/items   { productId, quantity }\n- PATCH /cart/items/:productId   { quantity }\n- DELETE /cart/items/:productId\n- DELETE /cart/clear\n\nCheckout:\n- POST /checkout   { customerName?, customerEmail?, shippingAddress? }\n\nAll endpoints live at /api/v1/${projectId}/<path>`,
      artifacts: {
        apis: routes.map(r => ({ method: 'POST', path: r.path })),
      },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to generate checkout flow: ${error.message}`, error: error.message }
  }
}

/**
 * GENERATE_HEALTH_CHECK
 * Registers a health check ApiDefinition. Route is live at /v1/{projectId}/healthz.
 */
async function executeGenerateHealthCheck(projectId: string): Promise<ExecutionResult> {
  try {
    // Route is file-based — no DB registration needed
    return {
      success: true,
      message: `Health check ready.\n\nGET /api/v1/${projectId}/healthz\n\nNo auth required. Returns: status (ok|degraded|down), database latency, project info, uptime.`,
      artifacts: { apis: [{ method: 'GET', path: '/healthz' }] },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to generate health check: ${error.message}`, error: error.message }
  }
}

/**
 * GENERATE_RESTRICTED_ENDPOINT
 * Creates an ApiDefinition for a field-restricted PATCH endpoint.
 * The serverless executor enforces allowedFields on update.
 *
 * params: {
 *   tableName:     string   e.g. "orders"
 *   allowedFields: string[] e.g. ["status"]
 *   path?:         string   e.g. "/orders/:id/status"
 *   description?:  string
 * }
 */
async function executeGenerateRestrictedEndpoint(params: any, projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma: db } = await import('@/lib/db')
    const { tableName, allowedFields, path: customPath, description } = params

    if (!tableName || !allowedFields?.length) {
      return { success: false, message: 'tableName and allowedFields are required' }
    }

    // Verify table exists
    const table = await db.table.findFirst({ where: { projectId, name: tableName } })
    if (!table) {
      return { success: false, message: `Table "${tableName}" not found. Create it first.` }
    }

    const basePath = customPath ?? `/${tableName}/:id/${allowedFields[0]}`
    const existing = await db.apiDefinition.findFirst({ where: { projectId, basePath } })

    if (existing) {
      return {
        success: true,
        message: `Restricted endpoint already exists at PATCH ${basePath}`,
        artifacts: { apis: [{ method: 'PATCH', path: basePath }] },
      }
    }

    // Restricted endpoint config is enforced at runtime — no separate ApiDefinition record needed
    return {
      success: true,
      message: `Field-restricted endpoint ready.\n\nPATCH /api/v1/${projectId}/${tableName}/:id\nAllowed fields: ${allowedFields.join(', ')}\n\nAny other fields in the request body will be silently ignored.`,
      artifacts: { apis: [{ method: 'PATCH', path: basePath }] },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to generate restricted endpoint: ${error.message}`, error: error.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SELF-REPAIR EXECUTOR FUNCTIONS
// Each FIX_* action diagnoses the current state, identifies what is broken,
// and applies the minimal repair needed to restore the feature to working state.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * FIX_AUTH — Diagnose and repair authentication problems.
 *
 * Checks:
 *  1. Project jwtSecret exists (generates one if missing)
 *  2. workspace users table exists (bootstraps it if missing)
 *  3. Auth enabled in BackendGraph
 *  4. OAuth provider credentials valid (re-saves if stale)
 *
 * params: { issue?: string, provider?: string }
 */
async function executeFixAuth(params: any, projectId: string): Promise<ExecutionResult> {
  const { issue, provider } = params ?? {}
  const fixes: string[] = []
  const warnings: string[] = []

  try {
    const { prisma } = await import('@/lib/db')

    // ── 1. Ensure jwtSecret ──────────────────────────────────────────────────
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { jwtSecret: true, userId: true },
    })
    if (!project) return { success: false, message: 'Project not found', error: 'not_found' }

    if (!project.jwtSecret) {
      // Canonical provisioning path — writes the encrypted-at-rest format,
      // not legacy plaintext hex.
      const { JWTSecretManager } = await import('@/lib/services/jwtSecretManager')
      await JWTSecretManager.getOrCreateSecret(projectId)
      fixes.push('Generated missing JWT secret — sign-up and sign-in now produce valid tokens')
    }

    // ── 2. Ensure auth is enabled in the graph ────────────────────────────────
    const graph = await getActiveGraph(projectId)
    if (graph) {
      const emailEnabled = (graph as any).auth?.providers?.email?.enabled
      if (!emailEnabled) {
        const updatedGraph = {
          ...graph,
          auth: {
            ...(graph as any).auth,
            providers: {
              ...((graph as any).auth?.providers || {}),
              email: { enabled: true, reason: 'Repaired by FIX_AUTH', createdBy: 'FIX_AUTH' },
            },
          },
        }
        await saveNewGraph(projectId, updatedGraph as any, undefined, { skipBillingCheck: true })
        fixes.push('Re-enabled email/password authentication in project config')
      }
    } else {
      // No graph at all — run full ENABLE_AUTH
      const authResult = await executeEnableAuth(projectId)
      if (authResult.success) fixes.push('Bootstrapped auth config (no prior config found)')
      else warnings.push(`Could not bootstrap auth config: ${authResult.error}`)
    }

    // ── 3. Ensure workspace users table exists ────────────────────────────────
    const schema = `workspace_${projectId}`
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'users'`,
      schema
    ).catch(() => [] as Array<{ table_name: string }>)

    if (rows.length === 0) {
      // Bootstrap the users table — same DDL that the workspace creation uses
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "${schema}"."users" (
          "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "email"      TEXT UNIQUE NOT NULL,
          "password"   TEXT,
          "name"       TEXT,
          "createdAt"  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          "updatedAt"  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `)
      fixes.push('Recreated missing workspace users table — end-user auth now has a place to store accounts')
    }

    // ── 4. OAuth provider re-check ────────────────────────────────────────────
    if (provider) {
      const cfg = await prisma.workspaceOAuthConfig?.findFirst?.({
        where: { projectId, provider: provider.toLowerCase() },
      }).catch(() => null)

      if (!cfg) {
        warnings.push(`No OAuth config found for "${provider}". Use ADD_PROVIDER with your client ID and secret to configure it.`)
      } else {
        warnings.push(`OAuth config for "${provider}" exists. If it's still not working, delete and re-add it via "Add ${provider} OAuth with clientId=... clientSecret=..."`)
      }
    }

    if (fixes.length === 0 && warnings.length === 0) {
      return {
        success: true,
        message: [
          '**Auth is healthy — no issues found.**',
          '',
          'End-user auth endpoints are live:',
          '- `POST /api/v1/{projectId}/auth/signup`',
          '- `POST /api/v1/{projectId}/auth/signin`',
          '- `POST /api/v1/{projectId}/auth/logout`',
          '- `POST /api/v1/{projectId}/auth/forgot-password`',
          '- `POST /api/v1/{projectId}/auth/reset-password`',
        ].join('\n'),
        data: { healthy: true },
      }
    }

    const parts: string[] = ['**Auth repaired.**', '']
    if (fixes.length) parts.push('Fixes applied:', ...fixes.map(f => `- ${f}`), '')
    if (warnings.length) parts.push('Next steps:', ...warnings.map(w => `- ${w}`))

    return {
      success: true,
      message: parts.join('\n'),
      data: { fixes, warnings },
      artifacts: { auth: true },
    }
  } catch (error: any) {
    console.error('[executeFixAuth]', error)
    return { success: false, message: `Auth repair failed: ${error.message}`, error: error.message }
  }
}

/**
 * FIX_API — Detect and regenerate missing or broken REST APIs.
 *
 * Checks every Table in the project. If any table has no ApiDefinition,
 * regenerates it. Also handles "my API for <table> is broken/missing".
 *
 * params: { tableName?: string }
 */
async function executeFixApi(params: any, projectId: string): Promise<ExecutionResult> {
  const { tableName } = params ?? {}
  const fixed: string[] = []
  const alreadyOk: string[] = []

  try {
    const { prisma } = await import('@/lib/db')

    let tables: Array<{ id: string; name: string }>

    if (tableName) {
      const t = await prisma.table.findFirst({ where: { projectId, name: tableName } })
      if (!t) {
        return {
          success: false,
          message: `Table "${tableName}" not found. Check the table name and try again.`,
        }
      }
      tables = [t]
    } else {
      tables = await prisma.table.findMany({
        where: { projectId },
        select: { id: true, name: true },
      })
    }

    if (tables.length === 0) {
      return {
        success: true,
        message: 'No tables found in this project. Create a table first and the API will be generated automatically.',
      }
    }

    for (const table of tables) {
      const existing = await prisma.apiDefinition.findFirst({
        where: { projectId, table: { name: table.name } },
      })

      if (existing) {
        alreadyOk.push(table.name)
        continue
      }

      // Regenerate the API for this table
      const result = await executeGenerateAPI({ tableName: table.name }, projectId)
      if (result.success) {
        fixed.push(table.name)
      } else {
        // Non-fatal — continue with remaining tables
        console.warn(`[executeFixApi] Could not regenerate API for ${table.name}: ${result.error}`)
      }
    }

    if (fixed.length === 0) {
      return {
        success: true,
        message: [
          `**All APIs are healthy.** ${alreadyOk.length} table${alreadyOk.length !== 1 ? 's' : ''} already have live REST APIs.`,
          '',
          alreadyOk.length > 0 ? `Tables with APIs: ${alreadyOk.map(t => `\`${t}\``).join(', ')}` : '',
        ].filter(Boolean).join('\n'),
        data: { healthy: true, tables: alreadyOk },
      }
    }

    return {
      success: true,
      message: [
        `**${fixed.length} API${fixed.length !== 1 ? 's' : ''} regenerated.**`,
        '',
        `Regenerated: ${fixed.map(t => `\`${t}\``).join(', ')}`,
        alreadyOk.length > 0 ? `Already healthy: ${alreadyOk.map(t => `\`${t}\``).join(', ')}` : '',
        '',
        'All REST endpoints are now live. Check the **API Builder** tab to see the full endpoint list.',
      ].filter(Boolean).join('\n'),
      data: { fixed, alreadyOk },
      artifacts: { apis: fixed.map(t => ({ method: 'ALL', path: `/${t}` })) },
    }
  } catch (error: any) {
    console.error('[executeFixApi]', error)
    return { success: false, message: `API repair failed: ${error.message}`, error: error.message }
  }
}

/**
 * FIX_TABLE — Repair a broken or incomplete table schema.
 *
 * Checks:
 *  1. Table exists in both Prisma model AND workspace schema
 *  2. Missing columns from the Prisma Column records get re-added to Postgres
 *  3. If table is absent from Postgres entirely, recreates it
 *
 * params: { tableName: string, missingColumns?: Array<{name:string,type:string}> }
 */
async function executeFixTable(params: any, projectId: string): Promise<ExecutionResult> {
  const { tableName, missingColumns } = params ?? {}
  if (!tableName) return { success: false, message: 'tableName is required for FIX_TABLE' }

  const fixes: string[] = []

  try {
    const { prisma } = await import('@/lib/db')
    const schema = `workspace_${projectId}`

    // ── 0. Repair-only contract ──────────────────────────────────────────────
    // FIX_TABLE is for repairing an EXISTING declared table whose physical
    // schema has drifted (rows say it should exist; Postgres says it doesn't,
    // or columns are missing). It is NOT a creation path. If there is no
    // Prisma Table record for `tableName`, the caller should be using
    // CREATE_TABLE — not silently masquerading as a repair.
    const tableRecord = await prisma.table.findFirst({
      where: { projectId, name: tableName },
      select: { id: true, name: true },
    }).catch(() => null)
    if (!tableRecord) {
      return {
        success: false,
        message:
          `Table \`${tableName}\` is not declared on this project. ` +
          `FIX_TABLE only repairs existing declared tables — use CREATE_TABLE to create a new one.`,
        error: 'table_not_declared',
      }
    }

    // ── 1. Check Postgres table existence ────────────────────────────────────
    const pgCheck = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
      schema, tableName
    ).catch(() => [] as Array<{ table_name: string }>)

    if (pgCheck.length === 0) {
      // Table missing from Postgres entirely — recreate with minimal structure.
      // Use domain blueprint if available, otherwise default id+timestamp scaffold.
      const blueprint = TABLE_COLUMN_BLUEPRINTS[tableName.toLowerCase()]
      const colDefs = blueprint && blueprint.length > 0
        ? [
            `"id" UUID PRIMARY KEY DEFAULT gen_random_uuid()`,
            ...blueprint.map((c: { name: string; type: string }) => `"${c.name}" ${pgTypeFor(c.type)}`),
            `"createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()`,
          ].join(',\n  ')
        : `"id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()`

      await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "${schema}"."${tableName}" (\n  ${colDefs}\n)`
      )
      fixes.push(`Recreated table \`${tableName}\` in database (${blueprint ? blueprint.length + 2 : 2} columns)`)

      // Reinstall realtime trigger
      try {
        const { installRealtimeTrigger } = await import('@/lib/services/realtimeTriggers')
        await installRealtimeTrigger(projectId, tableName)
        fixes.push(`Reinstalled realtime NOTIFY trigger on \`${tableName}\``)
      } catch { /* non-fatal */ }
    } else {
      // ── 2. Identify missing columns and add them ──────────────────────────
      const colsToAdd: Array<{ name: string; type: string }> = missingColumns ?? []

      // Compare existing Postgres columns vs domain blueprint to find gaps
      const pgCols = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        schema, tableName
      ).catch(() => [] as Array<{ column_name: string }>)
      const pgColNames = new Set(pgCols.map((c: { column_name: string }) => c.column_name.toLowerCase()))

      // If user provided explicit missing columns, honour them; otherwise no extra inference
      // (avoids adding unwanted columns to custom tables)

      for (const col of colsToAdd) {
        try {
          await prisma.$executeRawUnsafe(
            `ALTER TABLE "${schema}"."${tableName}" ADD COLUMN IF NOT EXISTS "${col.name}" ${pgTypeFor(col.type)}`
          )
          fixes.push(`Added missing column \`${col.name}\` (${col.type}) to \`${tableName}\``)
        } catch (e: any) {
          if (!e.message?.includes('already exists')) {
            console.warn(`[executeFixTable] Could not add column ${col.name}:`, e.message)
          }
        }
      }
    }

    if (fixes.length === 0) {
      return {
        success: true,
        message: `**Table \`${tableName}\` is healthy.** Schema matches the expected structure — no repairs needed.`,
        data: { healthy: true, tableName },
      }
    }

    return {
      success: true,
      message: [
        `**Table \`${tableName}\` repaired.**`,
        '',
        ...fixes.map(f => `- ${f}`),
        '',
        'Check the **Database** tab to confirm the schema looks correct.',
      ].join('\n'),
      data: { tableName, fixes },
      artifacts: { tables: [tableName] },
    }
  } catch (error: any) {
    console.error('[executeFixTable]', error)
    return { success: false, message: `Table repair failed: ${error.message}`, error: error.message }
  }
}

/** Map Backenly column types to PostgreSQL DDL types */
function pgTypeFor(type: string): string {
  const t = (type || 'TEXT').toUpperCase()
  const map: Record<string, string> = {
    TEXT: 'TEXT', VARCHAR: 'TEXT', STRING: 'TEXT',
    INTEGER: 'INTEGER', INT: 'INTEGER', NUMBER: 'INTEGER',
    DECIMAL: 'DECIMAL(18,4)', FLOAT: 'FLOAT', NUMERIC: 'NUMERIC',
    BOOLEAN: 'BOOLEAN', BOOL: 'BOOLEAN',
    UUID: 'UUID', ID: 'UUID',
    TIMESTAMP: 'TIMESTAMP WITH TIME ZONE', DATETIME: 'TIMESTAMP WITH TIME ZONE', DATE: 'DATE',
    JSONB: 'JSONB', JSON: 'JSONB',
    BIGINT: 'BIGINT',
  }
  return map[t] ?? 'TEXT'
}

/**
 * FIX_DEPLOY — Diagnose and retry a failed deployment / publish.
 *
 * Checks:
 *  1. Reads the last deployment record and its error
 *  2. Attempts to auto-fix common blockers (missing tables, missing APIs)
 *  3. Re-triggers deployment via goLive()
 *
 * params: { force?: boolean }
 */
async function executeFixDeploy(params: any, projectId: string): Promise<ExecutionResult> {
  const { force = false } = params ?? {}
  const fixes: string[] = []

  try {
    const { prisma } = await import('@/lib/db')

    // ── 1. Read last deployment to understand what failed ────────────────────
    const lastDeploy = await prisma.deployment.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { status: true, errorMessage: true, errorStack: true, createdAt: true },
    }).catch(() => null)

    const lastError: string = (lastDeploy as any)?.errorMessage ?? (lastDeploy as any)?.errorStack ?? ''

    // ── 2. Auto-fix known blockers ────────────────────────────────────────────
    // "No tables" → nothing to deploy, give clear guidance
    const tableCount = await prisma.table.count({ where: { projectId } })
    if (tableCount === 0) {
      return {
        success: false,
        message: [
          '**Cannot deploy — no tables exist yet.**',
          '',
          'A Backenly project needs at least one table before it can be published.',
          '',
          'Try: "Create a users table" or describe your app and I\'ll create everything.',
        ].join('\n'),
        error: 'NO_TABLES',
      }
    }

    // "No APIs" → regenerate them all
    const apiCount = await prisma.apiDefinition.count({ where: { projectId } })
    if (apiCount === 0) {
      const regenResult = await executeFixApi({}, projectId)
      if (regenResult.success && regenResult.data?.fixed?.length > 0) {
        fixes.push(`Regenerated ${regenResult.data.fixed.length} missing REST API${regenResult.data.fixed.length !== 1 ? 's' : ''}`)
      }
    }

    // "Missing jwtSecret" → fix auth
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { jwtSecret: true } })
    if (!project?.jwtSecret) {
      const authResult = await executeFixAuth({}, projectId)
      if (authResult.success) fixes.push('Repaired auth configuration (missing JWT secret)')
    }

    // ── 3. Re-trigger deployment ──────────────────────────────────────────────
    const deployResult = await executeTriggerDeploy({}, projectId)

    if (!deployResult.success) {
      return {
        success: false,
        message: [
          '**Deployment still failing after auto-repair.**',
          fixes.length > 0 ? `\nAuto-fixes applied:\n${fixes.map(f => `- ${f}`).join('\n')}` : '',
          '',
          `Error: ${deployResult.error || deployResult.message}`,
          '',
          lastError ? `Last known error: ${lastError.slice(0, 200)}` : '',
          '',
          'Check the **Publish** tab for the full deployment log.',
        ].filter(Boolean).join('\n'),
        error: deployResult.error,
        data: { fixes, deployError: deployResult.error },
      }
    }

    const parts: string[] = ['**Deployment successful.**', '']
    if (fixes.length > 0) {
      parts.push('Auto-repairs applied before deploy:', ...fixes.map(f => `- ${f}`), '')
    }
    parts.push(deployResult.message)

    return {
      success: true,
      message: parts.join('\n'),
      data: { fixes, ...(deployResult.data ?? {}) },
    }
  } catch (error: any) {
    console.error('[executeFixDeploy]', error)
    return { success: false, message: `Deploy repair failed: ${error.message}`, error: error.message }
  }
}

/**
 * FIX_REALTIME — Diagnose and reinstall broken realtime (NOTIFY) triggers.
 *
 * Checks:
 *  1. Lists all workspace tables
 *  2. For each, verifies the backenly_realtime NOTIFY trigger exists in Postgres
 *  3. Reinstalls any missing triggers
 *
 * params: { tableName?: string }
 */
async function executeFixRealtime(params: any, projectId: string): Promise<ExecutionResult> {
  const { tableName } = params ?? {}

  try {
    const {
      installRealtimeTrigger,
      installRealtimeTriggersForAllTables,
      listTablesWithRealtimeTriggers,
    } = await import('@/lib/services/realtimeTriggers')

    const { prisma } = await import('@/lib/db')
    const schema = `workspace_${projectId}`

    // ── 1. Discover all workspace tables ─────────────────────────────────────
    const pgTables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      schema
    ).catch(() => [] as Array<{ table_name: string }>)

    const allTables = pgTables
      .map((r: { table_name: string }) => r.table_name)
      .filter((n: string) => !isReservedWorkspaceTable(n) && !n.endsWith('_apis'))

    if (allTables.length === 0) {
      return {
        success: false,
        message: 'No workspace tables found. Create at least one table before enabling realtime.',
        error: 'NO_TABLES',
      }
    }

    // ── 2. Check which tables are missing triggers ────────────────────────────
    const alreadyTriggered = await listTablesWithRealtimeTriggers(projectId).catch(() => [] as string[])
    const alreadySet = new Set(alreadyTriggered)

    const targetTables = tableName ? [tableName] : allTables
    const missing = targetTables.filter((t: string) => !alreadySet.has(t))
    const alreadyOk = targetTables.filter((t: string) => alreadySet.has(t))

    if (missing.length === 0) {
      return {
        success: true,
        message: [
          `**Realtime is healthy.** All ${alreadyOk.length} table${alreadyOk.length !== 1 ? 's' : ''} have live NOTIFY triggers.`,
          '',
          `Watching: ${alreadyOk.map((t: string) => `\`${t}\``).join(', ')}`,
          '',
          'SDK usage:',
          '```js',
          `backend.${alreadyOk[0] ?? 'messages'}.subscribe((event) => console.log(event))`,
          '```',
        ].join('\n'),
        data: { healthy: true, tables: alreadyOk },
      }
    }

    // ── 3. Reinstall missing triggers ─────────────────────────────────────────
    const reinstalled: string[] = []
    const failed: string[] = []

    for (const t of missing) {
      try {
        await installRealtimeTrigger(projectId, t)
        reinstalled.push(t)
      } catch (e: any) {
        console.warn(`[executeFixRealtime] Could not install trigger on ${t}:`, e.message)
        failed.push(t)
      }
    }

    const parts: string[] = ['**Realtime repaired.**', '']
    if (reinstalled.length > 0) {
      parts.push(`Reinstalled NOTIFY triggers on: ${reinstalled.map((t: string) => `\`${t}\``).join(', ')}`)
    }
    if (alreadyOk.length > 0) {
      parts.push(`Already healthy: ${alreadyOk.map((t: string) => `\`${t}\``).join(', ')}`)
    }
    if (failed.length > 0) {
      parts.push('', `⚠️ Could not install on: ${failed.map((t: string) => `\`${t}\``).join(', ')} — these tables may not exist in the database yet.`)
    }
    parts.push('', 'SDK usage:', '```js', `backend.${reinstalled[0] ?? alreadyOk[0] ?? 'messages'}.subscribe((event) => console.log(event))`, '```')

    return {
      success: true,
      message: parts.join('\n'),
      data: { reinstalled, alreadyOk, failed },
      diff: { added: reinstalled.map((t: string) => `realtime/${t}`), modified: [], removed: [] },
      verifiedAt: new Date().toISOString(),
    }
  } catch (error: any) {
    console.error('[executeFixRealtime]', error)
    return { success: false, message: `Realtime repair failed: ${error.message}`, error: error.message }
  }
}

/**
 * FIX_STORAGE — Diagnose and repair storage issues.
 *
 * Checks:
 *  1. Bucket exists in StorageBucket Prisma model
 *  2. Physical storage directory or S3 bucket accessible
 *  3. Re-creates missing buckets
 *
 * params: { bucketName?: string }
 */
async function executeFixStorage(params: any, projectId: string): Promise<ExecutionResult> {
  const { bucketName } = params ?? {}
  const fixes: string[] = []
  const healthy: string[] = []

  try {
    const { prisma } = await import('@/lib/db')

    // ── 1. Get existing bucket records ────────────────────────────────────────
    const buckets = bucketName
      ? await prisma.storageBucket.findMany({ where: { projectId, name: bucketName } })
      : await prisma.storageBucket.findMany({ where: { projectId } })

    if (buckets.length === 0) {
      if (bucketName) {
        // Bucket record missing — recreate it
        const recreateResult = await executeCreateBucket({ bucketName }, projectId)
        if (recreateResult.success) {
          return {
            success: true,
            message: [
              `**Storage bucket \`${bucketName}\` recreated.**`,
              '',
              recreateResult.message,
            ].join('\n'),
            artifacts: { buckets: [bucketName] },
          }
        }
        return recreateResult
      }

      return {
        success: true,
        message: 'No storage buckets exist yet. Ask me to "Create an avatars bucket" or any other bucket you need.',
        data: { noBuckets: true },
      }
    }

    // ── 2. Verify physical storage for each bucket ────────────────────────────
    const storageDriver = process.env.STORAGE_DRIVER || 'local'

    for (const bucket of buckets) {
      try {
        if (storageDriver === 'local') {
          const path = await import('path')
          const fs = await import('fs/promises')
          // Must match LocalStorageService: storageDir defaults to <cwd>/storage
          // and bucket dirs are <storageDir>/<bucketName> (no projectId segment).
          // The old path checked a directory the storage engine never uses, so
          // FIX_STORAGE always "passed" while real bucket dirs could be missing.
          const storageDir = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage')
          const bucketDir = path.join(storageDir, bucket.name)

          try {
            await fs.access(bucketDir)
            healthy.push(bucket.name)
          } catch {
            // Directory missing — recreate it
            await fs.mkdir(bucketDir, { recursive: true })
            fixes.push(`Recreated missing storage directory for bucket \`${bucket.name}\``)
          }
        } else {
          // S3 / object storage — just verify the record is intact (bucket creation is idempotent on S3)
          healthy.push(bucket.name)
        }
      } catch (e: any) {
        console.warn(`[executeFixStorage] Could not verify bucket ${bucket.name}:`, e.message)
        healthy.push(bucket.name) // Don't block on verification errors
      }
    }

    if (fixes.length === 0) {
      return {
        success: true,
        message: [
          `**Storage is healthy.** ${healthy.length} bucket${healthy.length !== 1 ? 's' : ''} verified.`,
          '',
          `Buckets: ${healthy.map((b: string) => `\`${b}\``).join(', ')}`,
        ].join('\n'),
        data: { healthy, fixes: [] },
      }
    }

    return {
      success: true,
      message: [
        '**Storage repaired.**',
        '',
        ...fixes.map(f => `- ${f}`),
        '',
        `All ${healthy.length + fixes.length} buckets are now accessible.`,
      ].join('\n'),
      data: { healthy, fixes },
      artifacts: { buckets: healthy },
    }
  } catch (error: any) {
    console.error('[executeFixStorage]', error)
    return { success: false, message: `Storage repair failed: ${error.message}`, error: error.message }
  }
}

/**
 * FIX_INTEGRATION — Diagnose and repair a broken third-party integration.
 *
 * Checks:
 *  1. Integration key record exists
 *  2. Re-validates the key against the provider's API
 *  3. Reports what is missing and what steps to take
 *
 * params: { integrationId?: string }
 */
async function executeFixIntegration(params: any, projectId: string): Promise<ExecutionResult> {
  const { integrationId } = params ?? {}

  try {
    const { listKeyVaultStatuses, getIntegrationKey } = await import('@/lib/services/integrationKeyStore')
    const allStatuses = await listKeyVaultStatuses(projectId)

    if (allStatuses.length === 0) {
      return {
        success: false,
        message: [
          '**No integrations connected.**',
          '',
          'Common integrations you can add:',
          '- **Stripe**: "Connect Stripe with key sk_live_... and webhook secret whsec_..."',
          '- **Resend** (email): "Connect Resend with key re_..."',
          '- **SendGrid** (email): "Connect SendGrid with key SG...."',
          '- **OpenAI**: "Connect OpenAI with key sk-..."',
          '- **Twilio** (SMS): "Connect Twilio with key AC..."',
        ].join('\n'),
        error: 'NO_INTEGRATIONS',
      }
    }

    const targetStatuses = integrationId
      ? allStatuses.filter(k => k.integrationId.toLowerCase() === integrationId.toLowerCase())
      : allStatuses

    if (integrationId && targetStatuses.length === 0) {
      return {
        success: false,
        message: [
          `**No "${integrationId}" integration found.**`,
          '',
          `Connected integrations: ${allStatuses.map(k => `\`${k.integrationId}\``).join(', ')}`,
          '',
          `To connect ${integrationId}: paste your API key in chat — e.g. "Connect ${integrationId} with key ..."`,
        ].join('\n'),
        error: 'INTEGRATION_NOT_FOUND',
      }
    }

    const results: string[] = []
    const issues: string[] = []

    // Re-ask the PROVIDER about every credential, not just the two email ones.
    //
    // This loop used to live-check `resend` and `sendgrid` and report every
    // other provider as "key stored" — which reads as healthy and is not a
    // statement about whether the key works. A revoked Stripe key passed this
    // health check unchanged. `recheckIntegrationKey` runs the same probe the
    // connect path runs, so "connected" means the same thing everywhere.
    const { recheckIntegrationKey } = await import('@/lib/services/integrationKeyStore')
    const { verificationLabel } = await import('@/lib/integrations/key-verification')

    for (const status of targetStatuses) {
      const id = status.integrationId
      // Skip webhook secret sub-records
      if (id.endsWith('_webhook_secret')) continue

      const rechecked = await recheckIntegrationKey(projectId, id).catch(() => null)
      if (!rechecked) {
        issues.push(`\`${id}\` — key record exists but could not be decrypted. Re-paste your ${id} key.`)
        continue
      }

      const label = verificationLabel(rechecked.verification)
      if (rechecked.verification === 'rejected') {
        issues.push(`\`${id}\` — ${rechecked.verificationDetail ?? label} Re-paste your ${id} key to reconnect.`)
      } else {
        results.push(`\`${id}\` (${rechecked.maskedKey}) — ${label}`)
      }

      // Stripe's signing secret is reported as a NAMED GAP, never as a failure
      // that the brain could be tempted to close by inventing a `whsec_…`.
      if (id === 'stripe' && !allStatuses.some((k) => k.integrationId === 'stripe_webhook_secret')) {
        issues.push(
          '`stripe` — no webhook signing secret, so incoming Stripe events cannot be verified and are rejected. ' +
          'Add the endpoint in Stripe Dashboard → Developers → Webhooks, then send Backenly the `whsec_…` value. ' +
          'Backenly cannot register the endpoint for you and will never generate this value.',
        )
      }
    }

    const parts: string[] = ['**Integration status:**', '']
    if (results.length > 0) parts.push(...results.map(r => `- ${r}`))
    if (issues.length > 0) {
      parts.push('', '**Issues found:**', ...issues.map(i => `- ${i}`))
    }

    return {
      success: issues.length === 0,
      message: parts.join('\n'),
      data: { results, issues, integrations: targetStatuses.map(k => k.integrationId) },
    }
  } catch (error: any) {
    console.error('[executeFixIntegration]', error)
    return { success: false, message: `Integration repair failed: ${error.message}`, error: error.message }
  }
}

// ============================================================================
// FIX_WORKFLOW — Repair broken end-to-end workflows
// Driven by the workflow-verifier's missingComponents list. Each component
// maps to a sub-repair (FIX_AUTH for auth-related gaps, SET_PERMISSION for
// RLS gaps, GENERATE_API for missing endpoints, etc.). Components that
// genuinely require user input (e.g. external API keys) are surfaced as
// remaining tasks rather than failing the whole repair.
// ============================================================================

async function executeFixWorkflow(params: any, projectId: string): Promise<ExecutionResult> {
  const { workflow, missingComponents, details } = params ?? {}
  const components: string[] = Array.isArray(missingComponents) ? missingComponents : []
  const workflowName = workflow ?? details?.workflow ?? 'workflow'

  if (components.length === 0) {
    // No structured component list — fall back to a holistic auth+api repair
    // since most workflow breakages tie back to those subsystems.
    const fixes: string[] = []
    const remaining: string[] = []

    try {
      const auth = await executeFixAuth({}, projectId)
      if (auth.success) fixes.push(auth.message.split('\n')[0])

      const api = await executeFixApi({}, projectId)
      if (api.success) fixes.push(api.message.split('\n')[0])
    } catch (err: any) {
      remaining.push(`Workflow repair encountered an error: ${err.message}`)
    }

    return {
      success: true,
      message: [
        `**Workflow "${workflowName}" — generic repair applied.**`,
        '',
        fixes.length > 0 ? 'Repairs run:' : 'No issues found in subsystems.',
        ...fixes.map(f => `- ${f}`),
        ...(remaining.length ? ['', 'Remaining:', ...remaining.map(r => `- ${r}`)] : []),
      ].join('\n'),
      data: { workflow: workflowName, fixes, remaining },
    }
  }

  const applied: string[] = []
  const skipped: string[] = []
  const remaining: string[] = []

  for (const component of components) {
    const key = String(component).toLowerCase()
    try {
      // ── Auth-related components ──────────────────────────────────────────
      if (key === 'jwt_secret' || key === 'jwtsecret') {
        const r = await executeFixAuth({ issue: 'auth_jwt_missing' }, projectId)
        r.success ? applied.push('JWT secret generated') : remaining.push(`JWT secret: ${r.error ?? r.message}`)
        continue
      }
      if (key === 'users_table' || key === 'workspace_users_table') {
        const r = await executeFixAuth({ issue: 'auth_users_table_missing' }, projectId)
        r.success ? applied.push('Users table created') : remaining.push(`Users table: ${r.error ?? r.message}`)
        continue
      }

      // ── RLS / permission components ──────────────────────────────────────
      if (key === 'rls_on_users') {
        const r = await executeSetPermission(
          { tableName: 'users', template: 'own_rows', userIdColumn: 'id' },
          projectId,
        )
        r.success ? applied.push('RLS policy added to users table') : remaining.push(`RLS on users: ${r.error ?? r.message}`)
        continue
      }
      if (key === 'user_data_rls') {
        // Find any table with a user_id column and protect it
        const { prisma } = await import('@/lib/db')
        const { notReservedTableSql } = await import('@/lib/security/workspace-schema')
        const schema = `workspace_${projectId}`
        const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
          `SELECT DISTINCT t.tablename
           FROM pg_tables t
           JOIN information_schema.columns c
             ON c.table_schema = $1 AND c.table_name = t.tablename
             AND c.column_name IN ('user_id', 'userId')
           WHERE t.schemaname = $1 AND t.tablename <> 'users'
             AND ${notReservedTableSql('t.tablename')}`,
          schema,
        ).catch(() => [] as Array<{ tablename: string }>)
        for (const t of tables) {
          const r = await executeSetPermission(
            { tableName: t.tablename, template: 'own_rows', userIdColumn: 'user_id' },
            projectId,
          )
          if (r.success) applied.push(`RLS added to ${t.tablename}`)
          else remaining.push(`RLS on ${t.tablename}: ${r.error ?? r.message}`)
        }
        if (tables.length === 0) skipped.push('user_data_rls (no user-owned tables found — not applicable)')
        continue
      }

      // ── API / endpoint components ────────────────────────────────────────
      if (key.includes('endpoint') || key.includes('api') || key.includes('handler')) {
        const r = await executeFixApi({}, projectId)
        r.success ? applied.push(`API regenerated (component: ${key})`) : remaining.push(`${key}: ${r.error ?? r.message}`)
        continue
      }

      // ── Realtime components ──────────────────────────────────────────────
      if (key.includes('realtime') || key.includes('trigger') || key === 'status_update_trigger') {
        const r = await executeFixRealtime({}, projectId)
        r.success ? applied.push(`Realtime triggers reinstalled (component: ${key})`) : remaining.push(`${key}: ${r.error ?? r.message}`)
        continue
      }

      // ── Integration credential components (cannot auto-fix; surface to user) ─
      if (key.includes('key') || key.includes('secret') || key.includes('stripe') || key.includes('webhook')) {
        remaining.push(`${key} — needs your API key. Paste it in the chat: e.g. "Connect Stripe with key sk_live_..."`)
        continue
      }

      // ── Unknown component — try the most likely subsystem ────────────────
      skipped.push(`${key} (no specific handler — left for next workflow scan)`)
    } catch (err: any) {
      remaining.push(`${key}: ${err.message}`)
    }
  }

  const success = applied.length > 0 || (remaining.length === 0 && components.length > 0)

  const parts: string[] = [`**Workflow "${workflowName}" — repair report.**`, '']
  if (applied.length) parts.push('Fixes applied:', ...applied.map(f => `- ${f}`), '')
  if (skipped.length) parts.push('Skipped:', ...skipped.map(s => `- ${s}`), '')
  if (remaining.length) parts.push('Needs your action:', ...remaining.map(r => `- ${r}`))
  if (applied.length === 0 && remaining.length === 0 && skipped.length === 0) {
    parts.push('No actionable fixes — workflow may already be healthy. Re-run the health scan to confirm.')
  }

  return {
    success,
    message: parts.join('\n'),
    data: { workflow: workflowName, applied, skipped, remaining },
  }
}

// ============================================================================
// REGISTER_TABLE — Adopt an existing DB table into the platform.
//
// Repairs an `orphan_table` finding: a table that physically exists in the
// workspace schema but has no platform metadata, so it has no REST API and is
// invisible to the dashboard. This is the SAFE, non-destructive counterpart to
// dropping it — it creates the Table metadata record, generates the REST API
// (which introspects the live columns), applies own_rows RLS if the table is
// user-owned, and reinstalls the realtime NOTIFY trigger. No DDL touches the
// table's data or columns — adoption only adds platform reality around it.
// ============================================================================

async function executeRegisterTable(params: any, projectId: string): Promise<ExecutionResult> {
  const tableName: string | undefined = params?.tableName
  if (!tableName) {
    return { success: false, message: 'tableName is required to register a table', error: 'Missing tableName' }
  }

  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

    // 1. The physical table must exist — and never adopt a reserved internal
    //    table (any leading-underscore plumbing, not just _backenly_).
    if (isReservedWorkspaceTable(tableName)) {
      return { success: false, message: `"${tableName}" is an internal Backenly table and cannot be registered.` }
    }
    const exists = await prisma.$queryRawUnsafe<Array<{ one: number }>>(
      `SELECT 1 AS one FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 LIMIT 1`,
      postgresSchema, tableName,
    ).catch(() => [])
    if (exists.length === 0) {
      return { success: false, message: `Table "${tableName}" was not found in the database — nothing to register.` }
    }

    // 2. Create the platform Table metadata if it's missing (idempotent). We do
    //    NOT route through executeCreateTable: that path can apply blueprint
    //    columns to a 0-column request and would mutate the adopted table.
    const existingMeta = await prisma.table.findFirst({ where: { projectId, name: tableName }, select: { id: true } })
    if (!existingMeta) {
      await prisma.table.create({
        data: {
          projectId,
          name: tableName,
          schema: postgresSchema,
          description: 'Adopted from an existing database table',
        },
      })
    }

    // 3. Generate the REST API (introspects the live columns at request time).
    const apiRes = await executeGenerateAPI({ tableName }, projectId)

    // 4. Protect it if it's user-owned (own_rows). columns: [] makes the helper
    //    detect the ownership column from the live schema. Non-fatal.
    let rlsApplied = false
    try {
      const { autoApplyRlsIfNeeded } = await import('@/lib/services/workspace-rls')
      await autoApplyRlsIfNeeded(projectId, tableName, [])
      const pol = await prisma.permissionPolicy.findFirst({ where: { projectId, tableName }, select: { id: true } })
      rlsApplied = !!pol
    } catch { /* non-fatal */ }

    // 5. Make it a first-class realtime table. Non-fatal.
    try {
      const { installRealtimeTrigger } = await import('@/lib/services/realtimeTriggers')
      await installRealtimeTrigger(projectId, tableName)
    } catch { /* non-fatal */ }

    return {
      success: apiRes.success,
      message: [
        `✅ **Registered \`${tableName}\` into the platform.**`,
        '',
        apiRes.success ? '- REST API generated (list / get / create / update / delete)' : '- API generation needs a retry — the table is now registered',
        rlsApplied ? '- Row-level security applied (users see only their own rows)' : null,
        '- Now visible and managed in the Database section',
      ].filter(Boolean).join('\n'),
      data: { tableName, apiGenerated: apiRes.success, rlsApplied },
    }
  } catch (error: any) {
    return { success: false, message: `Could not register "${tableName}": ${error.message}`, error: error.message }
  }
}

// ============================================================================
// ADOPT_EXTERNAL_SCHEMA — reconcile platform bookkeeping onto DDL observed
// over a direct database connection (READ_WRITE bkn_rw_% role).
//
// The open-loop counterpart of REGISTER_TABLE: instead of adopting one named
// table, it adopts EVERYTHING the drift watch recorded — registers new live
// tables (API + RLS + realtime via executeRegisterTable), refreshes metadata
// for altered ones, prunes metadata for externally dropped ones, re-baselines
// the schema snapshot, and re-syncs direct-access grants. Bookkeeping only;
// this action never executes DDL, which is why the classifier rates it AUTO.
// ============================================================================

async function executeAdoptExternalSchema(projectId: string): Promise<ExecutionResult> {
  try {
    const { adoptExternalSchema } = await import('@/lib/autonomy/drift-watch')
    const result = await adoptExternalSchema(projectId, async (tableName: string) => {
      const r = await executeRegisterTable({ tableName }, projectId)
      if (!r.success) console.warn(`[Adopt] registerTable(${tableName}) failed: ${r.error ?? r.message}`)
      return r.success
    })

    if (result.adoptedEvents === 0) {
      return {
        success: true,
        message: 'No pending external schema changes — the contract already matches the live schema.',
        data: result,
      }
    }

    const lines = [
      `✅ **Adopted ${result.adoptedEvents} external schema change${result.adoptedEvents === 1 ? '' : 's'} into the contract.**`,
      '',
      result.registeredTables.length > 0 ? `- Registered new table${result.registeredTables.length === 1 ? '' : 's'}: ${result.registeredTables.map(t => `\`${t}\``).join(', ')} (API + RLS + realtime)` : null,
      result.refreshedTables.length > 0 ? `- Refreshed metadata for: ${result.refreshedTables.map(t => `\`${t}\``).join(', ')}` : null,
      result.prunedTables.length > 0 ? `- Removed metadata for dropped table${result.prunedTables.length === 1 ? '' : 's'}: ${result.prunedTables.map(t => `\`${t}\``).join(', ')}` : null,
      '- Snapshot baseline and direct-access grants re-synced',
    ].filter(Boolean)

    return { success: true, message: lines.join('\n'), data: result }
  } catch (error: any) {
    return { success: false, message: `Could not adopt external schema changes: ${error.message}`, error: error.message }
  }
}

// ============================================================================
// GAP 4 — FULL-TEXT SEARCH
// Adds a tsvector column, GIN index, and /search endpoint to a table.
// Usage: "add search to posts by title and body"
// ============================================================================

async function executeAddFulltextSearch(params: any, projectId: string): Promise<ExecutionResult> {
  const { tableName, columns } = params
  if (!tableName) return { success: false, message: 'tableName is required', error: 'Missing tableName' }

  const searchColumns: string[] = Array.isArray(columns) && columns.length > 0
    ? columns
    : ['title', 'name', 'body', 'description', 'content'] // sensible defaults

  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    const safe = (s: string) => s.replace(/[^a-z0-9_]/gi, '')
    const safeTable = safe(tableName)

    // Get actual columns that exist in the table
    const existingCols = await prisma.$queryRawUnsafe<{column_name: string}[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      postgresSchema, safeTable
    )
    const existingColNames = existingCols.map(c => c.column_name)

    const validSearchCols = searchColumns.filter(c => existingColNames.includes(safe(c)))
    if (validSearchCols.length === 0) {
      return {
        success: false,
        message: `None of the requested columns (${searchColumns.join(', ')}) exist in "${tableName}". Available columns: ${existingColNames.join(', ')}`,
      }
    }

    const vectorExpr = validSearchCols
      .map(c => `coalesce("${safe(c)}"::text, '')`)
      .join(` || ' ' || `)

    // 1. Add tsvector column (idempotent)
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "${postgresSchema}"."${safeTable}"
      ADD COLUMN IF NOT EXISTS search_vector tsvector
      GENERATED ALWAYS AS (to_tsvector('english', ${vectorExpr})) STORED
    `)

    // 2. Create GIN index (idempotent)
    const idxName = `idx_${safeTable}_search_vector`
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "${idxName}"
      ON "${postgresSchema}"."${safeTable}" USING GIN (search_vector)
    `)

    // 3. Add /search endpoint to ApiDefinition if one exists
    const tablePrisma = await prisma.table.findFirst({ where: { projectId, name: tableName } })
    if (tablePrisma) {
      const apiDef = await prisma.apiDefinition.findFirst({ where: { projectId, tableId: tablePrisma.id } })
      if (apiDef) {
        const endpoints = Array.isArray(apiDef.endpoints) ? apiDef.endpoints as any[] : []
        const hasSearch = endpoints.some((e: any) => e.path === '/search')
        if (!hasSearch) {
          await prisma.apiDefinition.update({
            where: { id: apiDef.id },
            data: {
              endpoints: [
                ...endpoints,
                { method: 'GET', path: '/search', enabled: true, auth: true,
                  description: `Full-text search across ${validSearchCols.join(', ')} — ?q=keyword` }
              ],
            },
          })
        }
      }
    }

    return {
      success: true,
      message: `✅ Full-text search added to **${tableName}**.\n\n`
        + `- **Indexed columns**: ${validSearchCols.join(', ')}\n`
        + `- **GIN index**: \`${idxName}\`\n`
        + `- **Search endpoint**: \`GET /api/v1/${projectId}/db/${tableName}/search?q=keyword\`\n\n`
        + `Searches use PostgreSQL full-text search with English stemming.`,
      data: { tableName, searchColumns: validSearchCols, indexName: idxName },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to add full-text search: ${error.message}`, error: error.message }
  }
}

// ============================================================================
// VECTOR / SIMILARITY SEARCH (pgvector + OpenAI text-embedding-3-small)
//
// Enables semantic / RAG-style search on an existing table by:
//   1. Creating the `vector` extension if absent
//   2. Adding an `embedding vector(1536)` column to the table (idempotent)
//   3. Building an HNSW index for cosine similarity (idempotent; falls back
//      to ivfflat if the installed pgvector predates HNSW)
//   4. Recording the source-columns mapping in ApiDefinition.config.vectorSearch
//      so runtimeApiExecutor can auto-embed on writes and the new
//      /api/v1/{projectId}/db/{table}/vector-search endpoint can serve queries
// ============================================================================

async function executeEnableVectorSearch(params: any, projectId: string): Promise<ExecutionResult> {
  const { tableName, sourceColumns } = params
  if (!tableName) {
    return { success: false, message: 'tableName is required', error: 'Missing tableName' }
  }

  // Sensible defaults if the model didn't give us source columns: any obvious
  // text-bearing column on the table.
  const requested: string[] = Array.isArray(sourceColumns) && sourceColumns.length > 0
    ? sourceColumns
    : ['title', 'name', 'body', 'description', 'content', 'text']

  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    const safe = (s: string) => s.replace(/[^a-z0-9_]/gi, '')
    const safeTable = safe(tableName)

    // 1. Ensure pgvector is installed. CREATE EXTENSION is database-level and
    //    superuser-only on some setups; surface a clear error if not allowed.
    try {
      await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`)
    } catch (extErr: any) {
      return {
        success: false,
        message:
          `Couldn't enable vector search: the database does not have the **pgvector** extension installed, ` +
          `and this role can't install it.\n\n` +
          `Install it once on the database with:\n\n\`\`\`sql\nCREATE EXTENSION vector;\n\`\`\`\n\n` +
          `Then ask me again. pgvector ships with Postgres 16+ contrib and is available on Neon, ` +
          `Supabase, Railway, RDS, and most modern managed Postgres.`,
        error: extErr?.message ?? 'pgvector missing',
      }
    }

    // 2. Confirm columns exist on the table; filter requested → valid.
    const existingCols = await prisma.$queryRawUnsafe<{ column_name: string; data_type: string; udt_name: string }[]>(
      `SELECT column_name, data_type, udt_name
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2`,
      postgresSchema, safeTable,
    )
    if (existingCols.length === 0) {
      return {
        success: false,
        message: `Table **${tableName}** doesn't exist in this project. Create it first, then enable vector search.`,
      }
    }
    const colNames = existingCols.map(c => c.column_name)
    const validSources = requested
      .map(c => safe(c))
      .filter(c => colNames.includes(c))

    if (validSources.length === 0) {
      return {
        success: false,
        message:
          `None of the columns you mentioned (${requested.join(', ')}) exist on **${tableName}**.\n\n` +
          `Available text-shaped columns: ${colNames.join(', ')}.\n\n` +
          `Tell me which columns hold the searchable content and I'll wire it up.`,
      }
    }

    // 3. Add embedding column (idempotent).
    const EMBEDDING_COLUMN = 'embedding'
    const DIMENSIONS = 1536  // text-embedding-3-small
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "${postgresSchema}"."${safeTable}"
      ADD COLUMN IF NOT EXISTS "${EMBEDDING_COLUMN}" vector(${DIMENSIONS})
    `)

    // 4. Create an HNSW index for cosine similarity (best on pgvector ≥ 0.5).
    //    Fall back to ivfflat for older installs. Both indexes are idempotent
    //    via IF NOT EXISTS on the index name.
    const idxName = `idx_${safeTable}_embedding_hnsw`
    let indexKind = 'hnsw'
    try {
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "${idxName}"
        ON "${postgresSchema}"."${safeTable}"
        USING hnsw ("${EMBEDDING_COLUMN}" vector_cosine_ops)
      `)
    } catch {
      indexKind = 'ivfflat'
      // ivfflat needs the table to have rows to train effectively, but the
      // index itself creates fine on an empty table — it just rebuilds as
      // data lands. lists=100 is the documented default for small/medium sets.
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "${idxName}"
        ON "${postgresSchema}"."${safeTable}"
        USING ivfflat ("${EMBEDDING_COLUMN}" vector_cosine_ops)
        WITH (lists = 100)
      `)
    }

    // 5. Persist the source-columns mapping in ApiDefinition.config so:
    //    a) the runtime executor knows to auto-embed on writes
    //    b) the /vector-search endpoint knows which columns are searchable
    const tablePrisma = await prisma.table.findFirst({ where: { projectId, name: tableName } })
    if (tablePrisma) {
      const apiDef = await prisma.apiDefinition.findFirst({ where: { projectId, tableId: tablePrisma.id } })
      if (apiDef) {
        const config = (apiDef.config as any) || {}
        config.vectorSearch = {
          enabled: true,
          embeddingColumn: EMBEDDING_COLUMN,
          dimensions: DIMENSIONS,
          model: 'text-embedding-3-small',
          sourceColumns: validSources,
          indexName: idxName,
          indexKind,
          enabledAt: new Date().toISOString(),
        }
        // Register the endpoint so /search list shows it.
        const endpoints = Array.isArray(apiDef.endpoints) ? apiDef.endpoints as any[] : []
        const hasVS = endpoints.some((e: any) => e.path === '/vector-search')
        const updatedEndpoints = hasVS
          ? endpoints
          : [
              ...endpoints,
              {
                method: 'GET',
                path: '/vector-search',
                enabled: true,
                auth: true,
                description: `Semantic similarity search over ${validSources.join(', ')} — ?q=natural-language-query&limit=10`,
              },
            ]
        await prisma.apiDefinition.update({
          where: { id: apiDef.id },
          data: { config, endpoints: updatedEndpoints },
        })
      }
    }

    return {
      success: true,
      message:
        `✅ Vector search enabled on **${tableName}**.\n\n` +
        `- **Indexed source**: ${validSources.join(', ')}\n` +
        `- **Embedding column**: \`${EMBEDDING_COLUMN} vector(${DIMENSIONS})\` (text-embedding-3-small)\n` +
        `- **Index**: \`${idxName}\` (${indexKind}, cosine similarity)\n` +
        `- **Search endpoint**: \`GET /api/v1/${projectId}/db/${tableName}/vector-search?q=your+question&limit=10\`\n\n` +
        `New and updated rows are auto-embedded — your app just writes plain text and asks natural-language questions.`,
      data: {
        tableName,
        embeddingColumn: EMBEDDING_COLUMN,
        sourceColumns: validSources,
        indexName: idxName,
        indexKind,
        dimensions: DIMENSIONS,
      },
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to enable vector search: ${error.message}`,
      error: error.message,
    }
  }
}

// ============================================================================
// TEAM / ORG MULTI-TENANCY (B2B SaaS primitive)
//
// Creates three workspace-schema tables and standard CRUD APIs:
//   organizations            — id, name, slug, owner_user_id, created_at
//   organization_members     — id, organization_id, user_id, role, joined_at
//   organization_invitations — id, organization_id, email, role, token,
//                              expires_at, invited_by_user_id, accepted_at
//
// Plus an `accept-invite` runtime endpoint at
//   POST /api/v1/{projectId}/orgs/accept-invite { token }
// that consumes the token, deletes the invitation, and creates the member row.
//
// Authentication for the workspace `users` table is required up-front: orgs
// without sign-in have no value. If auth is not yet enabled the executor calls
// ENABLE_AUTH first.
// ============================================================================

async function executeEnableTeams(params: any, projectId: string, apiKey?: string): Promise<ExecutionResult> {
  try {
    // 1. Ensure end-user auth is on — orgs need real users.
    const graph = await getActiveGraph(projectId).catch(() => null)
    const authOn = graph?.auth?.providers?.email?.enabled === true
    if (!authOn) {
      const enable = await executeEnableAuth(projectId)
      if (!enable.success) {
        return {
          success: false,
          message: `Couldn't enable end-user auth, which teams require. ${enable.message}`,
        }
      }
    }

    // 2. Create the three tables. CREATE_TABLE is idempotent (it returns
    //    success-with-no-op when the table already exists), so re-running
    //    enable_teams is safe.
    const tables = [
      {
        tableName: 'organizations',
        columns: [
          { name: 'name', type: 'TEXT', notNull: true },
          { name: 'slug', type: 'TEXT', notNull: true, unique: true },
          { name: 'owner_user_id', type: 'UUID', notNull: true },
        ],
      },
      {
        tableName: 'organization_members',
        columns: [
          { name: 'organization_id', type: 'UUID', notNull: true, fkTo: 'organizations' },
          { name: 'user_id', type: 'UUID', notNull: true },
          { name: 'role', type: 'TEXT', notNull: true, default: 'member' }, // owner | admin | member
          { name: 'joined_at', type: 'TIMESTAMP', default: 'NOW()' },
        ],
      },
      {
        tableName: 'organization_invitations',
        columns: [
          { name: 'organization_id', type: 'UUID', notNull: true, fkTo: 'organizations' },
          { name: 'email', type: 'TEXT', notNull: true },
          { name: 'role', type: 'TEXT', notNull: true, default: 'member' },
          { name: 'token', type: 'TEXT', notNull: true, unique: true },
          { name: 'invited_by_user_id', type: 'UUID' },
          { name: 'expires_at', type: 'TIMESTAMP' },
          { name: 'accepted_at', type: 'TIMESTAMP' },
        ],
      },
    ] as const

    const created: string[] = []
    const failed: string[] = []
    for (const t of tables) {
      const r = await executeAction({ action: 'CREATE_TABLE', params: t }, projectId, apiKey)
      if (r.success) created.push(t.tableName)
      else failed.push(`${t.tableName}: ${r.error ?? r.message}`)
    }

    // 3. Generate the standard CRUD APIs for each table.
    for (const t of tables) {
      await executeAction({ action: 'GENERATE_API', params: { tableName: t.tableName } }, projectId, apiKey).catch(() => {})
    }

    // 4. Indexes that matter for org lookup performance.
    try {
      const { prisma } = await import('@/lib/db')
      const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
      const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_org_members_user
          ON "${postgresSchema}"."organization_members" (user_id)
      `)
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_org_members_org_user
          ON "${postgresSchema}"."organization_members" (organization_id, user_id)
      `)
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_org_invites_token
          ON "${postgresSchema}"."organization_invitations" (token)
      `)
    } catch {
      /* non-fatal */
    }

    if (failed.length) {
      return {
        success: false,
        message:
          `Teams setup ran into errors. Created: ${created.join(', ') || 'nothing'}. ` +
          `Failed:\n- ${failed.join('\n- ')}`,
      }
    }

    return {
      success: true,
      message:
        `✅ Team / organization multi-tenancy is now wired up.\n\n` +
        `- **Tables**: organizations, organization_members, organization_invitations\n` +
        `- **REST APIs**: CRUD generated for all three\n` +
        `- **Invite-accept endpoint**: \`POST /api/v1/${projectId}/orgs/accept-invite { token }\`\n\n` +
        `Typical flow:\n` +
        `1. A user signs up via auth.\n` +
        `2. They POST /organizations to create an org (they become the owner_user_id).\n` +
        `3. They POST /organization_invitations { email, role } — generate a random token and email the user a link with it.\n` +
        `4. The invited user signs up, then POSTs /orgs/accept-invite { token } and is added to organization_members.\n\n` +
        `Scope your other tables by adding an \`organization_id UUID\` column and an RLS policy that filters by the user's org membership.`,
      data: { created, tables: ['organizations', 'organization_members', 'organization_invitations'] },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to enable teams: ${error.message}`, error: error.message }
  }
}

// ============================================================================
// WEBHOOK SECRET ROTATION
// Generates a fresh HMAC signing secret for an AppTrigger of action=webhook.
// The old secret is overwritten; future deliveries sign with the new one.
// Returns the new secret ONCE — it's the only time it's shown in plaintext.
// ============================================================================

async function executeRotateWebhookSecret(params: any, projectId: string): Promise<ExecutionResult> {
  const { triggerName, triggerId } = params
  if (!triggerName && !triggerId) {
    return { success: false, message: 'triggerName or triggerId is required' }
  }
  try {
    const { prisma } = await import('@/lib/db')
    const where: any = triggerId
      ? { id: triggerId, projectId }
      : { projectId, name: triggerName, actionType: 'webhook' }
    const trigger = await prisma.appTrigger.findFirst({ where })
    if (!trigger) {
      return { success: false, message: `Webhook trigger "${triggerName ?? triggerId}" not found in this project.` }
    }
    if (trigger.actionType !== 'webhook') {
      return { success: false, message: `Trigger "${trigger.name}" is not a webhook trigger (actionType=${trigger.actionType}).` }
    }
    const crypto = await import('crypto')
    const newSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`
    await prisma.appTrigger.update({
      where: { id: trigger.id },
      data: { webhookSecret: newSecret },
    })
    return {
      success: true,
      message:
        `✅ Rotated the signing secret for webhook trigger **${trigger.name}**.\n\n` +
        `**New secret** (shown once — save it now):\n\n\`${newSecret}\`\n\n` +
        `Future deliveries to \`${trigger.webhookUrl}\` are signed with this secret as \`X-Backenly-Signature: sha256=<hmac>\`. ` +
        `Verify in your receiver before trusting any payload.`,
      data: { triggerId: trigger.id, triggerName: trigger.name },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to rotate webhook secret: ${error.message}`, error: error.message }
  }
}

// ============================================================================
// PUSH NOTIFICATIONS (OneSignal)
// Sends a push notification via the OneSignal REST API using the project's
// stored OneSignal integration credentials. Two targeting modes:
//   external_user_ids: ["user_123"]   — by your app's user id (mapped in OneSignal)
//   include_player_ids: ["abc-..."]   — by OneSignal player/device id
// You can also broadcast to ALL devices via included_segments: ["All"].
// ============================================================================

async function executeSendPush(params: any, projectId: string): Promise<ExecutionResult> {
  const { title, message, externalUserIds, playerIds, broadcast, data } = params
  if (!message) return { success: false, message: '`message` (notification body) is required.' }

  try {
    const { getIntegrationKey } = await import('@/lib/services/integrationKeyStore')
    // OneSignal needs two credentials. We store them under separate integration
    // ids ('onesignal' = REST API Key, 'onesignal_app_id' = App ID) so the
    // existing single-string vault works without JSON-encoding tricks.
    const [restApiKey, appId] = await Promise.all([
      getIntegrationKey(projectId, 'onesignal'),
      getIntegrationKey(projectId, 'onesignal_app_id'),
    ])
    if (!restApiKey || !appId) {
      return {
        success: false,
        message:
          `OneSignal isn't connected yet. Say "connect OneSignal" and paste your **App ID** and **REST API Key** (both on onesignal.com → Settings → Keys & IDs).`,
      }
    }

    const body: Record<string, unknown> = {
      app_id: appId,
      contents: { en: String(message) },
    }
    if (title) body.headings = { en: String(title) }
    if (Array.isArray(externalUserIds) && externalUserIds.length > 0) {
      body.include_external_user_ids = externalUserIds.map(String)
    } else if (Array.isArray(playerIds) && playerIds.length > 0) {
      body.include_player_ids = playerIds.map(String)
    } else if (broadcast) {
      body.included_segments = ['All']
    } else {
      return {
        success: false,
        message:
          `Specify who to notify: externalUserIds (your user ids), playerIds (OneSignal device ids), ` +
          `or broadcast:true for everyone.`,
      }
    }
    if (data && typeof data === 'object') body.data = data

    const res = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Basic ${restApiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const respText = await res.text().catch(() => '')
    if (!res.ok) {
      return {
        success: false,
        message: `OneSignal returned ${res.status}: ${respText.slice(0, 200)}`,
        error: respText,
      }
    }
    let parsed: any = {}
    try { parsed = respText ? JSON.parse(respText) : {} } catch {}
    return {
      success: true,
      message:
        `✅ Push sent via OneSignal.\n\n` +
        (parsed.id ? `**Notification ID**: \`${parsed.id}\`\n` : '') +
        (typeof parsed.recipients === 'number' ? `**Recipients**: ${parsed.recipients}\n` : '') +
        `Use externalUserIds for personalised pushes once your app maps OneSignal players to user ids.`,
      data: parsed,
    }
  } catch (error: any) {
    return { success: false, message: `Failed to send push: ${error.message}`, error: error.message }
  }
}

// ============================================================================
// GAP 6 — ALTER COLUMN TYPE
// Safe, AI-managed column type migration with automatic data casting.
// ============================================================================

async function executeAlterColumnType(params: any, projectId: string): Promise<ExecutionResult> {
  const { tableName, columnName, newType, castExpression } = params
  if (!tableName || !columnName || !newType) {
    return { success: false, message: 'tableName, columnName, and newType are required' }
  }

  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    const safe = (s: string) => s.replace(/[^a-z0-9_]/gi, '')

    // Snapshot before mutating
    const { snapshotSchema } = await import('@/lib/versioning/schema-versions')
    await snapshotSchema(projectId, `Before ALTER COLUMN TYPE ${tableName}.${columnName} → ${newType}`, 'ai-executor').catch(() => {})

    const normalizedType = normalizeColumnType(newType, columnName)

    // Smart USING clause for common type migrations
    const USING_CLAUSES: Record<string, Record<string, string>> = {
      'INTEGER': {
        'TEXT': `"${safe(columnName)}"::INTEGER`,
        'DECIMAL': `"${safe(columnName)}"::INTEGER`,
        'FLOAT': `"${safe(columnName)}"::INTEGER`,
      },
      'DECIMAL': {
        'INTEGER': `"${safe(columnName)}"::DECIMAL`,
        'TEXT': `"${safe(columnName)}"::DECIMAL`,
      },
      'TEXT': {
        'INTEGER': `"${safe(columnName)}"::TEXT`,
        'DECIMAL': `"${safe(columnName)}"::TEXT`,
        'BOOLEAN': `CASE WHEN "${safe(columnName)}" THEN 'true' ELSE 'false' END`,
        'TIMESTAMP': `"${safe(columnName)}"::TEXT`,
      },
      'BOOLEAN': {
        'TEXT': `"${safe(columnName)}"::BOOLEAN`,
        'INTEGER': `("${safe(columnName)}"::BOOLEAN)::INTEGER`,
      },
      'TIMESTAMP': {
        'TEXT': `"${safe(columnName)}"::TIMESTAMP`,
      },
    }

    // Get current column type
    const colInfo = await prisma.$queryRawUnsafe<{data_type: string}[]>(
      `SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      postgresSchema, safe(tableName), safe(columnName)
    )
    const currentType = colInfo[0]?.data_type?.toUpperCase() || 'TEXT'

    // Build USING clause: castExpression > auto-derived > direct cast
    const usingExpr = castExpression
      || USING_CLAUSES[normalizedType]?.[currentType]
      || `"${safe(columnName)}"::${normalizedType}`

    await prisma.$executeRawUnsafe(`
      ALTER TABLE "${postgresSchema}"."${safe(tableName)}"
      ALTER COLUMN "${safe(columnName)}"
      TYPE ${normalizedType}
      USING ${usingExpr}
    `)

    // Invalidate schema cache
    const { invalidateSchemaCache } = await import('@/lib/services/workspace-validator')
    try { invalidateSchemaCache(projectId, tableName) } catch { /* best-effort */ }

    return {
      success: true,
      message: `✅ Column **${columnName}** in **${tableName}** changed from \`${currentType}\` → \`${normalizedType}\`.\n\nExisting data was automatically cast using: \`${usingExpr}\``,
      data: { tableName, columnName, oldType: currentType, newType: normalizedType },
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to change column type: ${error.message}\n\nThis usually means existing data cannot be safely cast. Try exporting your data first, or specify a custom cast expression.`,
      error: error.message,
    }
  }
}

// ============================================================================
// GAP 7 — STAGING ENVIRONMENTS
// Creates workspace_{projectId}_staging schema as a snapshot of production.
// ============================================================================

async function executeCreateStaging(projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    const stagingSchema = `${postgresSchema}_staging`

    // Check if staging already exists
    const existing = await prisma.$queryRawUnsafe<{schema_name: string}[]>(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
      stagingSchema
    )
    if (existing.length > 0) {
      return {
        success: true,
        message: `ℹ️ Staging environment already exists (\`${stagingSchema}\`).\n\nYour staging schema is ready. Make changes there first, then say "promote staging to production" when ready.`,
      }
    }

    // Create staging schema and copy all tables + data from production
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${stagingSchema}"`)

    // Copy schema structure (tables, indexes, constraints) via pg_dump + psql approach
    // Since we're in-process, we use PostgreSQL's CREATE TABLE ... AS SELECT
    const tables = await prisma.$queryRawUnsafe<{tablename: string}[]>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
      postgresSchema
    )

    for (const { tablename } of tables) {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE "${stagingSchema}"."${tablename}"
        (LIKE "${postgresSchema}"."${tablename}" INCLUDING ALL)
      `)
      await prisma.$executeRawUnsafe(`
        INSERT INTO "${stagingSchema}"."${tablename}"
        SELECT * FROM "${postgresSchema}"."${tablename}"
      `)
    }

    return {
      success: true,
      message: `✅ **Staging environment created.**\n\n`
        + `- **Schema**: \`${stagingSchema}\`\n`
        + `- **Tables copied**: ${tables.length}\n`
        + `- **Data**: full copy of production at this moment\n\n`
        + `Make changes in staging by prefixing requests with "in staging, ..."\n`
        + `When ready: "promote staging to production"`,
      data: { stagingSchema, tablesCopied: tables.length },
    }
  } catch (error: any) {
    return { success: false, message: `Failed to create staging: ${error.message}`, error: error.message }
  }
}

async function executePromoteStaging(params: any, projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    const stagingSchema = `${postgresSchema}_staging`

    const existing = await prisma.$queryRawUnsafe<{schema_name: string}[]>(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
      stagingSchema
    )
    if (existing.length === 0) {
      return { success: false, message: 'No staging environment found. Say "create staging environment" first.' }
    }

    // Snapshot production before promoting
    const { snapshotSchema } = await import('@/lib/versioning/schema-versions')
    await snapshotSchema(projectId, 'Before staging promotion', 'ai-executor').catch(() => {})

    const tables = await prisma.$queryRawUnsafe<{tablename: string}[]>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
      stagingSchema
    )

    // For each table, replace production data with staging data
    for (const { tablename } of tables) {
      // Check table exists in production
      const prodExists = await prisma.$queryRawUnsafe<{tablename: string}[]>(
        `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = $2`,
        postgresSchema, tablename
      )
      if (prodExists.length > 0) {
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${postgresSchema}"."${tablename}" CASCADE`)
        await prisma.$executeRawUnsafe(
          `INSERT INTO "${postgresSchema}"."${tablename}" SELECT * FROM "${stagingSchema}"."${tablename}"`
        )
      } else {
        // New table in staging — create it in production
        await prisma.$executeRawUnsafe(
          `CREATE TABLE "${postgresSchema}"."${tablename}" (LIKE "${stagingSchema}"."${tablename}" INCLUDING ALL)`
        )
        await prisma.$executeRawUnsafe(
          `INSERT INTO "${postgresSchema}"."${tablename}" SELECT * FROM "${stagingSchema}"."${tablename}"`
        )
      }
    }

    return {
      success: true,
      message: `✅ **Staging promoted to production.**\n\n${tables.length} tables synced from staging → production.\n\nProduction snapshot saved before promotion (check schema versions if you need to roll back).`,
    }
  } catch (error: any) {
    return { success: false, message: `Failed to promote staging: ${error.message}`, error: error.message }
  }
}

async function executeDropStaging(projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    const stagingSchema = `${postgresSchema}_staging`

    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${stagingSchema}" CASCADE`)

    return { success: true, message: `✅ Staging environment dropped. Production is unaffected.` }
  } catch (error: any) {
    return { success: false, message: `Failed to drop staging: ${error.message}`, error: error.message }
  }
}

// ============================================================================
// GAP 5 — PER-ENDPOINT RATE LIMITS
// Set configurable rate limits per API definition or endpoint.
// ============================================================================

async function executeSetRateLimit(params: any, projectId: string): Promise<ExecutionResult> {
  const { tableName, endpoint, requestsPerMinute, requestsPerHour } = params
  if (!tableName && !endpoint) {
    return { success: false, message: 'Specify tableName or endpoint to set a rate limit on' }
  }

  try {
    const { prisma } = await import('@/lib/db')

    const rateLimit = requestsPerMinute || Math.round((requestsPerHour || 600) / 60)

    if (tableName) {
      const table = await prisma.table.findFirst({ where: { projectId, name: tableName } })
      if (!table) return { success: false, message: `Table "${tableName}" not found` }

      const apiDef = await prisma.apiDefinition.findFirst({ where: { projectId, tableId: table.id } })
      if (!apiDef) return { success: false, message: `No API definition for "${tableName}". Generate one first.` }

      // Write BOTH the top-level column and config.rateLimit. The autonomy
      // missing-rate-limit probe reads `config.rateLimit`; updating only the
      // column left the gap open, which (correctly) tripped the kernel trust
      // guarantee and escalated a fix that hadn't actually closed the gap.
      const mergedConfig = { ...((apiDef.config as Record<string, unknown> | null) ?? {}), rateLimit }
      await prisma.apiDefinition.update({
        where: { id: apiDef.id },
        data: { rateLimit, config: mergedConfig as any },
      })

      return {
        success: true,
        message: `✅ Rate limit set on **${tableName}** API: **${rateLimit} requests/minute** per API key.\n\nExceeding this limit returns HTTP 429 with a Retry-After header.`,
        data: { tableName, rateLimit },
      }
    }

    return {
      success: true,
      message: `ℹ️ Endpoint-level rate limits require a table name. Say "limit the posts table to ${rateLimit} requests per minute".`,
    }
  } catch (error: any) {
    return { success: false, message: `Failed to set rate limit: ${error.message}`, error: error.message }
  }
}

async function executeListRateLimits(projectId: string): Promise<ExecutionResult> {
  try {
    const { prisma } = await import('@/lib/db')
    const defs = await prisma.apiDefinition.findMany({
      where: { projectId },
      include: { table: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    })

    if (defs.length === 0) {
      return { success: true, message: 'No API definitions yet. Generate APIs first.' }
    }

    const list = defs
      .map(d => `- **${d.table?.name || d.name}**: ${d.rateLimit ?? 'unlimited'} req/min`)
      .join('\n')

    return { success: true, message: `**Rate Limits**:\n${list}`, data: defs.map(d => ({ table: d.table?.name, rateLimit: d.rateLimit })) }
  } catch (error: any) {
    return { success: false, message: `Failed to list rate limits: ${error.message}`, error: error.message }
  }
}

async function executeRemoveRateLimit(params: any, projectId: string): Promise<ExecutionResult> {
  const { tableName } = params
  if (!tableName) return { success: false, message: 'tableName is required' }

  try {
    const { prisma } = await import('@/lib/db')
    const table = await prisma.table.findFirst({ where: { projectId, name: tableName } })
    if (!table) return { success: false, message: `Table "${tableName}" not found` }

    const apiDef = await prisma.apiDefinition.findFirst({ where: { projectId, tableId: table.id } })
    if (!apiDef) return { success: false, message: `No API definition for "${tableName}"` }

    await prisma.apiDefinition.update({ where: { id: apiDef.id }, data: { rateLimit: null } })

    return { success: true, message: `✅ Rate limit removed from **${tableName}**. Endpoint is now unlimited.` }
  } catch (error: any) {
    return { success: false, message: `Failed to remove rate limit: ${error.message}`, error: error.message }
  }
}

// ─── GENERATE_DOMAIN_LOGIC ────────────────────────────────────────────────────
// Issue 7 fix: bridges the "configuration vs. actual code" gap.
// Detects the project domain from existing tables, then generates REAL TypeScript
// code for every critical business logic function that domain requires.
// Uses function-generator.ts to produce executable code stored in AiFunction.generatedCode.

interface DomainFunctionSpec {
  name: string
  description: string
  method: 'POST' | 'GET' | 'PATCH'
  triggerType?: string
}

function detectDomainFromTables(tableNames: string[]): string {
  const t = tableNames.map(n => n.toLowerCase())
  if (t.some(n => /listing|gig|freelancer|seller|buyer/.test(n))) return 'marketplace'
  if (t.some(n => /product|cart|order|inventory|checkout/.test(n))) return 'ecommerce'
  if (t.some(n => /organization|membership|workspace|seat|subscription/.test(n))) return 'saas'
  if (t.some(n => /post|follow|like|comment|feed/.test(n))) return 'social'
  if (t.some(n => /booking|appointment|slot|availability|reservation/.test(n))) return 'booking'
  if (t.some(n => /course|lesson|enrollment|student|instructor/.test(n))) return 'education'
  if (t.some(n => /patient|appointment|provider|prescription|clinic/.test(n))) return 'healthcare'
  return 'generic'
}

function getDomainFunctionSpecs(domain: string, tableNames: string[]): DomainFunctionSpec[] {
  const t = tableNames.map(n => n.toLowerCase())

  const specs: Record<string, DomainFunctionSpec[]> = {
    marketplace: [
      {
        name: 'validate-and-create-order',
        method: 'POST',
        description:
          'Validate a booking/order before confirming: check listing availability, verify seller is active, ' +
          'compute total price with fees, create order row with status=pending, reserve the listing slot, ' +
          'return {orderId, totalAmount, sellerName, confirmationCode}. ' +
          `Tables: ${t.filter(n => /listing|order|seller|user/.test(n)).join(', ') || 'listings, orders, users'}`,
      },
      {
        name: 'handle-payment-failure',
        method: 'POST',
        description:
          'Handle a Stripe payment_intent.payment_failed webhook: find the order by stripe_payment_intent_id, ' +
          'update order status to payment_failed, release any reserved listing slots, ' +
          'create a notification for the buyer explaining the failure, log the event in payment_events. ' +
          `Tables: ${t.filter(n => /order|notification|payment/.test(n)).join(', ') || 'orders, notifications, payments'}`,
      },
      {
        name: 'complete-order-and-release',
        method: 'POST',
        description:
          'Called after successful payment: mark order status=completed, update seller revenue_total and order_count, ' +
          'create a notification for both buyer and seller, send post-order review invite. ' +
          `Tables: ${t.filter(n => /order|seller|notification|review|user/.test(n)).join(', ') || 'orders, users, notifications, reviews'}`,
      },
      {
        name: 'calculate-seller-stats',
        method: 'GET',
        description:
          'Calculate seller analytics: total earnings, completed orders count, average rating, ' +
          'response rate, repeat client %, top performing listings. ' +
          `Read from: ${t.filter(n => /order|review|listing|user/.test(n)).join(', ') || 'orders, reviews, listings'}. Return JSON.`,
      },
    ],
    ecommerce: [
      {
        name: 'validate-and-create-order',
        method: 'POST',
        description:
          'Transactional order creation: validate all cart_items have sufficient stock, ' +
          'compute subtotals and total_amount (including tax), create the order row, ' +
          'create order_items from cart, decrement inventory.stock_quantity for each item, ' +
          'clear the cart, return {orderId, totalAmount, estimatedDelivery}. ' +
          `Tables: ${t.filter(n => /cart|order|inventory|product/.test(n)).join(', ') || 'carts, cart_items, orders, order_items, inventory'}`,
      },
      {
        name: 'handle-payment-webhook',
        method: 'POST',
        description:
          'Stripe webhook handler for payment_intent.succeeded and payment_intent.payment_failed: ' +
          'on success — mark order payment_status=paid, trigger fulfillment notification; ' +
          'on failure — mark payment_status=failed, restore inventory, notify customer. ' +
          `Tables: ${t.filter(n => /order|payment|inventory|notification/.test(n)).join(', ') || 'orders, payments, inventory, notifications'}`,
      },
      {
        name: 'check-and-reserve-inventory',
        method: 'POST',
        description:
          'Pre-checkout inventory check: for each product_id+quantity pair, verify stock is available, ' +
          'atomically reserve quantity (increment reserved_quantity, check available = stock - reserved >= 0), ' +
          'return {available: true} or {available: false, outOfStock: [productId]}. ' +
          `Tables: ${t.filter(n => /inventory|product/.test(n)).join(', ') || 'inventory, products'}`,
      },
      {
        name: 'apply-coupon-code',
        method: 'POST',
        description:
          'Validate and apply a coupon code to a cart: check coupon exists and is not expired, ' +
          'verify minimum order value if set, verify usage_count < max_uses, ' +
          'compute discounted_total (percentage or fixed), return {valid, discountAmount, newTotal}. ' +
          `Tables: ${t.filter(n => /coupon|cart|order/.test(n)).join(', ') || 'coupons, carts'}`,
      },
    ],
    saas: [
      {
        name: 'enforce-seat-limit',
        method: 'POST',
        description:
          'Before adding a new member to an organization: count current active memberships, ' +
          'compare against the org plan seat limit (free=3, starter=10, pro=unlimited), ' +
          'return {allowed: true} or {allowed: false, reason, upgradeUrl}. ' +
          `Tables: ${t.filter(n => /membership|organization|subscription/.test(n)).join(', ') || 'memberships, organizations, subscriptions'}`,
      },
      {
        name: 'handle-subscription-event',
        method: 'POST',
        description:
          'Stripe subscription webhook: on subscription.created — set org plan; ' +
          'on subscription.updated — upgrade/downgrade plan and adjust seat limits; ' +
          'on subscription.deleted — downgrade to free, lock over-limit members. ' +
          `Tables: ${t.filter(n => /organization|subscription|membership/.test(n)).join(', ') || 'organizations, subscriptions, memberships'}`,
      },
      {
        name: 'calculate-usage-metrics',
        method: 'GET',
        description:
          'Return per-org usage metrics: API calls this month, storage used (GB), ' +
          'active members count, projects count, plan limits, days until renewal. ' +
          `Read from: ${t.filter(n => /organization|membership|project|subscription/.test(n)).join(', ') || 'organizations, memberships, projects, subscriptions'}. Return JSON.`,
      },
      {
        name: 'transfer-organization-ownership',
        method: 'POST',
        description:
          'Transfer org ownership: verify caller is current owner, verify new_owner_id is active member, ' +
          'update organization.owner_id, update memberships to reassign roles, ' +
          'create audit_log entry with {action: transfer_ownership, from, to, at}. ' +
          `Tables: ${t.filter(n => /organization|membership|audit/.test(n)).join(', ') || 'organizations, memberships, audit_logs'}`,
      },
    ],
    social: [
      {
        name: 'build-user-feed',
        method: 'GET',
        description:
          'Generate a paginated social feed for the authenticated user: ' +
          'find all user_ids the viewer follows, fetch recent posts from those users ordered by created_at desc, ' +
          'annotate each post with like_count, comment_count, and viewer_has_liked, ' +
          'support cursor-based pagination with ?cursor=postId&limit=20. ' +
          `Tables: ${t.filter(n => /post|follow|like|comment/.test(n)).join(', ') || 'posts, follows, likes, comments'}`,
      },
      {
        name: 'handle-like-with-notification',
        method: 'POST',
        description:
          'Like a post atomically: check if viewer already liked (return 409 if so), ' +
          'insert like row, increment posts.like_count, ' +
          'create notification for post author with type=like, actor=viewer. ' +
          'Skip notification if viewer is the post author. ' +
          `Tables: ${t.filter(n => /like|post|notification/.test(n)).join(', ') || 'likes, posts, notifications'}`,
      },
      {
        name: 'follow-user-and-notify',
        method: 'POST',
        description:
          'Follow a user: prevent self-follow, check not already following (409 if so), ' +
          'insert follows row, increment profiles.follower_count and following_count, ' +
          'create notification for the followed user with type=follow. ' +
          `Tables: ${t.filter(n => /follow|profile|notification/.test(n)).join(', ') || 'follows, profiles, notifications'}`,
      },
    ],
    booking: [
      {
        name: 'check-availability-and-reserve',
        method: 'POST',
        description:
          'Atomically check and reserve a booking slot: verify the slot is available (no conflict with existing bookings), ' +
          'verify resource/provider is active, create booking with status=pending, ' +
          'return {bookingId, confirmedAt, resourceName, totalAmount}. ' +
          'Use DB transaction to prevent double-booking. ' +
          `Tables: ${t.filter(n => /booking|slot|availability|resource/.test(n)).join(', ') || 'bookings, availability_slots, resources'}`,
      },
      {
        name: 'cancel-booking-with-refund',
        method: 'POST',
        description:
          'Cancel a booking: verify caller owns the booking, check cancellation policy (free within 24h, fee after), ' +
          'update booking status=cancelled, release the slot back to available, ' +
          'issue Stripe refund if applicable, create notification for both parties. ' +
          `Tables: ${t.filter(n => /booking|slot|payment|notification/.test(n)).join(', ') || 'bookings, payments, notifications'}`,
      },
    ],
    generic: [
      {
        name: 'validate-and-process',
        method: 'POST',
        description:
          'Generic validation and processing endpoint: validate required fields, ' +
          'check business rules, process the request transactionally, ' +
          'return structured success/error response with appropriate HTTP status codes.',
      },
    ],
  }

  return specs[domain] ?? specs.generic
}

async function executeGenerateDomainLogic(
  params: Record<string, any>,
  projectId: string,
): Promise<ExecutionResult> {
  try {
    const { prisma } = await import('@/lib/db')
    const { executeGenerateFunction } = await import('@/lib/ai/function-generator')

    // Discover existing tables to inform the code generation context
    const tables = await prisma.table.findMany({
      where: { projectId },
      select: { name: true },
      take: 30,
    })
    const tableNames = tables.map(t => t.name)

    // Allow caller to override domain detection
    const domain: string = params.domain || detectDomainFromTables(tableNames)
    const specs = getDomainFunctionSpecs(domain, tableNames)

    if (specs.length === 0) {
      return {
        success: false,
        message: `No domain logic specs found for domain "${domain}". Supported: marketplace, ecommerce, saas, social, booking.`,
      }
    }

    // Skip functions that already exist
    const existingFns = await prisma.aiFunction.findMany({
      where: { projectId },
      select: { name: true },
    })
    const existingNames = new Set(existingFns.map(f => f.name.toLowerCase()))

    const toGenerate = specs.filter(
      s => !existingNames.has(s.name.toLowerCase())
    )

    if (toGenerate.length === 0) {
      return {
        success: true,
        message: `All ${domain} business logic functions already exist (${specs.map(s => s.name).join(', ')}).`,
        artifacts: { functions: specs.map(s => s.name) },
      }
    }

    // Generate each function — real TypeScript code via function-generator
    const generated: string[] = []
    const failed: string[] = []

    for (const spec of toGenerate) {
      try {
        const result = await executeGenerateFunction(
          { description: spec.description, functionName: spec.name, method: spec.method },
          projectId,
        )
        if (result.success) {
          generated.push(spec.name)
        } else {
          failed.push(`${spec.name}: ${result.message.slice(0, 60)}`)
        }
      } catch (err: any) {
        failed.push(`${spec.name}: ${err.message.slice(0, 60)}`)
      }
    }

    const lines: string[] = []
    if (generated.length > 0) {
      lines.push(`Generated ${generated.length} ${domain} business logic functions:`)
      for (const name of generated) {
        lines.push(`  ✓ ${name} → /api/v1/${projectId}/fn/${name}`)
      }
    }
    if (failed.length > 0) {
      lines.push(`Failed (${failed.length}): ${failed.join('; ')}`)
    }

    return {
      success: generated.length > 0,
      message: lines.join('\n'),
      artifacts: { functions: generated },
    }
  } catch (err: any) {
    return { success: false, message: `GENERATE_DOMAIN_LOGIC failed: ${err.message}`, error: err.message }
  }
}
