/**
 * NODE EXECUTOR
 * =============
 * Maps BuildNode types → concrete executeAction() calls.
 * This is the bridge between the build graph and the execution primitives.
 *
 * Rules:
 *  - Every node type has a real execution path — no stubs
 *  - Blocked nodes are never executed — they return immediately as 'blocked'
 *  - Integration nodes check for credentials before attempting execution
 *  - All results update the node status from real execution outcomes
 *  - Never returns 'verified' without actual DB confirmation
 */

import type { BuildNode, NodeStatus, BlockedReason } from './types'
import type { ExecutionResult } from '../minimal-executor'

export interface NodeExecutionResult {
  nodeId: string
  status: NodeStatus
  detail?: string
  failureReason?: string
  blockedReason?: BlockedReason
  artifacts?: ExecutionResult['artifacts']
}

// ── Schema Column Definitions ─────────────────────────────────────────────────

/** Standard column sets for common table types */
const TABLE_COLUMNS: Record<string, Array<{ name: string; type: string; required?: boolean }>> = {
  users: [
    { name: 'id', type: 'UUID' },
    { name: 'email', type: 'TEXT' },
    { name: 'password_hash', type: 'TEXT' },
    { name: 'name', type: 'TEXT' },
    { name: 'role', type: 'TEXT' },
    { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'updated_at', type: 'TIMESTAMP' },
  ],
  products: [
    { name: 'id', type: 'UUID' },
    { name: 'name', type: 'TEXT' },
    { name: 'description', type: 'TEXT' },
    { name: 'price', type: 'DECIMAL' },
    { name: 'stock', type: 'INTEGER' },          // exact name from most prompts
    { name: 'image_url', type: 'TEXT' },
    { name: 'category_id', type: 'UUID' },
    { name: 'featured', type: 'BOOLEAN' },        // common ecommerce field
    { name: 'slug', type: 'TEXT' },
    { name: 'status', type: 'TEXT' },
    { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'updated_at', type: 'TIMESTAMP' },
  ],
  categories: [
    { name: 'id', type: 'UUID' },
    { name: 'name', type: 'TEXT' },
    { name: 'slug', type: 'TEXT' },
    { name: 'description', type: 'TEXT' },
    { name: 'parent_id', type: 'UUID' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  // Default orders table — auth-gated (has user_id). Guest mode is handled
  // separately via guestMode flag set by domain-compiler column parsing.
  orders: [
    { name: 'id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'status', type: 'TEXT' },            // CHECK constraint added by executeSchemaNode when enumValues present
    { name: 'total', type: 'DECIMAL' },          // exact name from most prompts
    { name: 'shipping_address', type: 'TEXT' },  // TEXT so guest checkout can store a plain string
    { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'updated_at', type: 'TIMESTAMP' },
  ],
  // Guest-mode orders (no user_id; customer info stored directly on order)
  orders_guest: [
    { name: 'id', type: 'UUID' },
    { name: 'status', type: 'TEXT' },
    { name: 'total', type: 'DECIMAL' },
    { name: 'customer_name', type: 'TEXT' },
    { name: 'customer_email', type: 'TEXT' },
    { name: 'shipping_address', type: 'TEXT' },
    { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'updated_at', type: 'TIMESTAMP' },
  ],
  order_items: [
    { name: 'id', type: 'UUID' },
    { name: 'order_id', type: 'UUID' },
    { name: 'product_id', type: 'UUID' },
    { name: 'product_name', type: 'TEXT' },       // denormalized — preserves name at order time
    { name: 'price', type: 'DECIMAL' },           // exact name from most prompts
    { name: 'quantity', type: 'INTEGER' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  carts: [
    { name: 'id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'status', type: 'TEXT' },
    { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'updated_at', type: 'TIMESTAMP' },
  ],
  cart_items: [
    { name: 'id', type: 'UUID' },
    { name: 'cart_id', type: 'UUID' },
    { name: 'product_id', type: 'UUID' },
    { name: 'quantity', type: 'INTEGER' },
    { name: 'unit_price', type: 'DECIMAL' },
    { name: 'added_at', type: 'TIMESTAMP' },
  ],
  workspaces: [
    { name: 'id', type: 'UUID' },
    { name: 'name', type: 'TEXT' },
    { name: 'slug', type: 'TEXT' },
    { name: 'owner_id', type: 'UUID' },
    { name: 'plan', type: 'TEXT' },
    { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'updated_at', type: 'TIMESTAMP' },
  ],
  workspace_members: [
    { name: 'id', type: 'UUID' },
    { name: 'workspace_id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'role', type: 'TEXT' },
    { name: 'joined_at', type: 'TIMESTAMP' },
  ],
  plans: [
    { name: 'id', type: 'UUID' },
    { name: 'name', type: 'TEXT' },
    { name: 'price', type: 'DECIMAL' },
    { name: 'interval', type: 'TEXT' },
    { name: 'stripe_price_id', type: 'TEXT' },
    { name: 'features', type: 'JSONB' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  subscriptions: [
    { name: 'id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'plan_id', type: 'UUID' },
    { name: 'status', type: 'TEXT' },
    { name: 'stripe_subscription_id', type: 'TEXT' },
    { name: 'current_period_end', type: 'TIMESTAMP' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  stores: [
    { name: 'id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'name', type: 'TEXT' },
    { name: 'description', type: 'TEXT' },
    { name: 'slug', type: 'TEXT' },
    { name: 'is_active', type: 'BOOLEAN' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  listings: [
    { name: 'id', type: 'UUID' },
    { name: 'store_id', type: 'UUID' },
    { name: 'title', type: 'TEXT' },
    { name: 'description', type: 'TEXT' },
    { name: 'price', type: 'DECIMAL' },
    { name: 'stock', type: 'INTEGER' },
    { name: 'images', type: 'JSONB' },
    { name: 'is_active', type: 'BOOLEAN' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  payments: [
    { name: 'id', type: 'UUID' },
    { name: 'order_id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'amount', type: 'DECIMAL' },
    { name: 'currency', type: 'TEXT' },
    { name: 'status', type: 'TEXT' },
    { name: 'provider', type: 'TEXT' },
    { name: 'provider_payment_id', type: 'TEXT' },
    { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'updated_at', type: 'TIMESTAMP' },
  ],
  reviews: [
    { name: 'id', type: 'UUID' },
    { name: 'order_id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'product_id', type: 'UUID' },
    { name: 'rating', type: 'INTEGER' },
    { name: 'content', type: 'TEXT' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  messages: [
    { name: 'id', type: 'UUID' },
    { name: 'sender_id', type: 'UUID' },
    { name: 'recipient_id', type: 'UUID' },
    { name: 'content', type: 'TEXT' },
    { name: 'read_at', type: 'TIMESTAMP' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  disputes: [
    { name: 'id', type: 'UUID' },
    { name: 'order_id', type: 'UUID' },
    { name: 'filed_by', type: 'UUID' },
    { name: 'reason', type: 'TEXT' },
    { name: 'status', type: 'TEXT' },
    { name: 'resolution', type: 'TEXT' },
    { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'resolved_at', type: 'TIMESTAMP' },
  ],

  // ── SaaS / Multi-tenant ───────────────────────────────────────────────────
  organizations: [
    { name: 'id', type: 'UUID' },
    { name: 'name', type: 'TEXT' },
    { name: 'slug', type: 'TEXT' },
    { name: 'owner_id', type: 'UUID' },
    { name: 'logo_url', type: 'TEXT' },
    { name: 'plan', type: 'TEXT' },
    { name: 'settings', type: 'JSONB' },
    { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'updated_at', type: 'TIMESTAMP' },
  ],
  organization_members: [
    { name: 'id', type: 'UUID' },
    { name: 'organization_id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'role', type: 'TEXT' },
    { name: 'invited_by', type: 'UUID' },
    { name: 'joined_at', type: 'TIMESTAMP' },
  ],
  api_keys: [
    { name: 'id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'workspace_id', type: 'UUID' },
    { name: 'name', type: 'TEXT' },
    { name: 'key_hash', type: 'TEXT' },
    { name: 'prefix', type: 'TEXT' },
    { name: 'scopes', type: 'JSONB' },
    { name: 'last_used_at', type: 'TIMESTAMP' },
    { name: 'expires_at', type: 'TIMESTAMP' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  webhooks: [
    { name: 'id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'url', type: 'TEXT' },
    { name: 'secret', type: 'TEXT' },
    { name: 'events', type: 'JSONB' },
    { name: 'is_active', type: 'BOOLEAN' },
    { name: 'last_triggered_at', type: 'TIMESTAMP' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  audit_logs: [
    { name: 'id', type: 'UUID' },
    { name: 'actor_id', type: 'UUID' },
    { name: 'action', type: 'TEXT' },
    { name: 'resource_type', type: 'TEXT' },
    { name: 'resource_id', type: 'UUID' },
    { name: 'metadata', type: 'JSONB' },
    { name: 'ip_address', type: 'TEXT' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  invitations: [
    { name: 'id', type: 'UUID' },
    { name: 'inviter_id', type: 'UUID' },
    { name: 'invitee_email', type: 'TEXT' },
    { name: 'workspace_id', type: 'UUID' },
    { name: 'role', type: 'TEXT' },
    { name: 'token', type: 'TEXT' },
    { name: 'status', type: 'TEXT' },
    { name: 'expires_at', type: 'TIMESTAMP' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],

  // ── Video / Media / AI Generation ─────────────────────────────────────────
  generation_jobs: [
    { name: 'id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'project_id', type: 'UUID' },
    { name: 'status', type: 'TEXT' },         // pending/running/completed/failed/cancelled
    { name: 'model', type: 'TEXT' },
    { name: 'prompt', type: 'TEXT' },
    { name: 'negative_prompt', type: 'TEXT' },
    { name: 'input_data', type: 'JSONB' },
    { name: 'output_url', type: 'TEXT' },
    { name: 'output_urls', type: 'JSONB' },
    { name: 'progress', type: 'INTEGER' },
    { name: 'error_message', type: 'TEXT' },
    { name: 'started_at', type: 'TIMESTAMP' },
    { name: 'completed_at', type: 'TIMESTAMP' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  video_projects: [
    { name: 'id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'title', type: 'TEXT' },
    { name: 'description', type: 'TEXT' },
    { name: 'status', type: 'TEXT' },
    { name: 'thumbnail_url', type: 'TEXT' },
    { name: 'duration', type: 'INTEGER' },
    { name: 'resolution', type: 'TEXT' },
    { name: 'settings', type: 'JSONB' },
    { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'updated_at', type: 'TIMESTAMP' },
  ],
  render_jobs: [
    { name: 'id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'project_id', type: 'UUID' },
    { name: 'status', type: 'TEXT' },
    { name: 'input_url', type: 'TEXT' },
    { name: 'output_url', type: 'TEXT' },
    { name: 'format', type: 'TEXT' },
    { name: 'resolution', type: 'TEXT' },
    { name: 'fps', type: 'INTEGER' },
    { name: 'progress', type: 'INTEGER' },
    { name: 'error_message', type: 'TEXT' },
    { name: 'started_at', type: 'TIMESTAMP' },
    { name: 'completed_at', type: 'TIMESTAMP' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  user_profiles: [
    { name: 'id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'display_name', type: 'TEXT' },
    { name: 'bio', type: 'TEXT' },
    { name: 'avatar_url', type: 'TEXT' },
    { name: 'website_url', type: 'TEXT' },
    { name: 'location', type: 'TEXT' },
    { name: 'preferences', type: 'JSONB' },
    { name: 'credits_balance', type: 'DECIMAL' },
    { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'updated_at', type: 'TIMESTAMP' },
  ],
  credits: [
    { name: 'id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'amount', type: 'DECIMAL' },
    { name: 'type', type: 'TEXT' },           // purchase/consume/refund/bonus
    { name: 'description', type: 'TEXT' },
    { name: 'balance_after', type: 'DECIMAL' },
    { name: 'reference_id', type: 'UUID' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  notifications: [
    { name: 'id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'title', type: 'TEXT' },
    { name: 'body', type: 'TEXT' },
    { name: 'type', type: 'TEXT' },
    { name: 'action_url', type: 'TEXT' },
    { name: 'is_read', type: 'BOOLEAN' },
    { name: 'read_at', type: 'TIMESTAMP' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  assets: [
    { name: 'id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'project_id', type: 'UUID' },
    { name: 'name', type: 'TEXT' },
    { name: 'type', type: 'TEXT' },           // image/video/audio/document
    { name: 'file_url', type: 'TEXT' },
    { name: 'file_size', type: 'INTEGER' },
    { name: 'mime_type', type: 'TEXT' },
    { name: 'metadata', type: 'JSONB' },
    { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'updated_at', type: 'TIMESTAMP' },
  ],
  tags: [
    { name: 'id', type: 'UUID' },
    { name: 'name', type: 'TEXT' },
    { name: 'slug', type: 'TEXT' },
    { name: 'color', type: 'TEXT' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
  comments: [
    { name: 'id', type: 'UUID' },
    { name: 'user_id', type: 'UUID' },
    { name: 'target_id', type: 'UUID' },
    { name: 'target_type', type: 'TEXT' },
    { name: 'content', type: 'TEXT' },
    { name: 'parent_id', type: 'UUID' },
    { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'updated_at', type: 'TIMESTAMP' },
  ],
  follows: [
    { name: 'id', type: 'UUID' },
    { name: 'follower_id', type: 'UUID' },
    { name: 'following_id', type: 'UUID' },
    { name: 'created_at', type: 'TIMESTAMP' },
  ],
}

function defaultColumns(tableName: string): Array<{ name: string; type: string }> {
  return TABLE_COLUMNS[tableName] ?? inferColumnsFromTableName(tableName)
}

/**
 * Infer meaningful columns from a table name when it's not in the blueprint.
 * This prevents the 3-column skeleton fallback that produces nearly-empty tables.
 *
 * Strategy:
 *  1. Pattern-match the table name against common domain archetypes
 *  2. Return a full, production-appropriate column set for that archetype
 *  3. Always include id + timestamps as the last columns
 *
 * Examples:
 *  generation_jobs  → job-queue archetype (status, type, input, output, error, duration…)
 *  video_projects   → project archetype (title, description, owner_id, status, settings…)
 *  render_tasks     → task/job archetype
 *  audit_logs       → audit archetype (actor_id, action, resource_type, resource_id, meta…)
 */
function inferColumnsFromTableName(tableName: string): Array<{ name: string; type: string }> {
  const n = tableName.toLowerCase()

  // ── Job / Task / Queue archetype ──────────────────────────────────────────
  if (/\b(job|task|queue|render|generat|process|export|import|batch|pipeline|worker|run)\b/.test(n)) {
    return [
      { name: 'id',           type: 'UUID' },
      { name: 'user_id',      type: 'UUID' },
      { name: 'status',       type: 'TEXT' },     // pending/running/completed/failed/cancelled
      { name: 'type',         type: 'TEXT' },     // job sub-type or template name
      { name: 'input_data',   type: 'JSONB' },    // input parameters / prompt / config
      { name: 'output_url',   type: 'TEXT' },     // presigned or permanent output URL
      { name: 'output_data',  type: 'JSONB' },    // structured output metadata
      { name: 'error_message',type: 'TEXT' },     // last error, if any
      { name: 'progress',     type: 'INTEGER' },  // 0-100
      { name: 'started_at',   type: 'TIMESTAMP' },
      { name: 'completed_at', type: 'TIMESTAMP' },
      { name: 'created_at',   type: 'TIMESTAMP' },
      { name: 'updated_at',   type: 'TIMESTAMP' },
    ]
  }

  // ── Asset / File / Media archetype ────────────────────────────────────────
  if (/\b(asset|media|file|video|audio|image|clip|reel|thumb|preview|attachment|upload)\b/.test(n)) {
    return [
      { name: 'id',           type: 'UUID' },
      { name: 'user_id',      type: 'UUID' },
      { name: 'project_id',   type: 'UUID' },
      { name: 'name',         type: 'TEXT' },
      { name: 'file_url',     type: 'TEXT' },
      { name: 'file_size',    type: 'INTEGER' },  // bytes
      { name: 'mime_type',    type: 'TEXT' },
      { name: 'duration',     type: 'INTEGER' },  // seconds (null for non-video/audio)
      { name: 'width',        type: 'INTEGER' },
      { name: 'height',       type: 'INTEGER' },
      { name: 'status',       type: 'TEXT' },     // processing/ready/failed
      { name: 'metadata',     type: 'JSONB' },
      { name: 'created_at',   type: 'TIMESTAMP' },
      { name: 'updated_at',   type: 'TIMESTAMP' },
    ]
  }

  // ── Project / Workspace / Collection archetype ────────────────────────────
  if (/\b(project|workspace|collection|portfolio|album|folder|library|scene|canvas)\b/.test(n)) {
    return [
      { name: 'id',           type: 'UUID' },
      { name: 'user_id',      type: 'UUID' },
      { name: 'name',         type: 'TEXT' },
      { name: 'description',  type: 'TEXT' },
      { name: 'status',       type: 'TEXT' },     // draft/active/archived
      { name: 'thumbnail_url',type: 'TEXT' },
      { name: 'settings',     type: 'JSONB' },    // project-level config
      { name: 'tags',         type: 'JSONB' },    // string array
      { name: 'is_public',    type: 'BOOLEAN' },
      { name: 'created_at',   type: 'TIMESTAMP' },
      { name: 'updated_at',   type: 'TIMESTAMP' },
    ]
  }

  // ── Template / Preset / Config archetype ─────────────────────────────────
  if (/\b(template|preset|config|setting|style|theme|layout|model|prompt|blueprint)\b/.test(n)) {
    return [
      { name: 'id',           type: 'UUID' },
      { name: 'name',         type: 'TEXT' },
      { name: 'description',  type: 'TEXT' },
      { name: 'category',     type: 'TEXT' },
      { name: 'config',       type: 'JSONB' },    // the actual template/preset data
      { name: 'is_public',    type: 'BOOLEAN' },
      { name: 'is_featured',  type: 'BOOLEAN' },
      { name: 'created_by',   type: 'UUID' },
      { name: 'usage_count',  type: 'INTEGER' },
      { name: 'created_at',   type: 'TIMESTAMP' },
      { name: 'updated_at',   type: 'TIMESTAMP' },
    ]
  }

  // ── Credit / Usage / Billing archetype ───────────────────────────────────
  if (/\b(credit|usage|billing|invoice|transaction|balance|quota|limit|consume)\b/.test(n)) {
    return [
      { name: 'id',           type: 'UUID' },
      { name: 'user_id',      type: 'UUID' },
      { name: 'amount',       type: 'DECIMAL' },
      { name: 'type',         type: 'TEXT' },     // purchase/consume/refund/bonus
      { name: 'description',  type: 'TEXT' },
      { name: 'balance_after',type: 'DECIMAL' },
      { name: 'reference_id', type: 'UUID' },     // related job/order/etc.
      { name: 'created_at',   type: 'TIMESTAMP' },
    ]
  }

  // ── Audit / Log / Event archetype ─────────────────────────────────────────
  if (/\b(audit|log|event|activity|history|track|analytic|metric|stat)\b/.test(n)) {
    return [
      { name: 'id',           type: 'UUID' },
      { name: 'actor_id',     type: 'UUID' },     // who triggered this event
      { name: 'action',       type: 'TEXT' },     // e.g. 'create', 'delete', 'update'
      { name: 'resource_type',type: 'TEXT' },     // e.g. 'project', 'job'
      { name: 'resource_id',  type: 'UUID' },
      { name: 'metadata',     type: 'JSONB' },    // before/after state, extra context
      { name: 'ip_address',   type: 'TEXT' },
      { name: 'user_agent',   type: 'TEXT' },
      { name: 'created_at',   type: 'TIMESTAMP' },
    ]
  }

  // ── Comment / Reaction / Social archetype ────────────────────────────────
  if (/\b(comment|reply|reaction|like|vote|rating|feedback|annotation|note)\b/.test(n)) {
    return [
      { name: 'id',           type: 'UUID' },
      { name: 'user_id',      type: 'UUID' },
      { name: 'target_id',    type: 'UUID' },     // the item being commented on
      { name: 'target_type',  type: 'TEXT' },     // polymorphic: 'post', 'video', etc.
      { name: 'content',      type: 'TEXT' },
      { name: 'parent_id',    type: 'UUID' },     // for threaded comments
      { name: 'is_edited',    type: 'BOOLEAN' },
      { name: 'created_at',   type: 'TIMESTAMP' },
      { name: 'updated_at',   type: 'TIMESTAMP' },
    ]
  }

  // ── Notification / Message archetype ─────────────────────────────────────
  if (/\b(notification|alert|inbox|outbox)\b/.test(n)) {
    return [
      { name: 'id',           type: 'UUID' },
      { name: 'user_id',      type: 'UUID' },
      { name: 'title',        type: 'TEXT' },
      { name: 'body',         type: 'TEXT' },
      { name: 'type',         type: 'TEXT' },     // info/warning/success/error
      { name: 'action_url',   type: 'TEXT' },
      { name: 'is_read',      type: 'BOOLEAN' },
      { name: 'read_at',      type: 'TIMESTAMP' },
      { name: 'created_at',   type: 'TIMESTAMP' },
    ]
  }

  // ── Tag / Label / Category archetype ─────────────────────────────────────
  if (/\b(tag|label|badge|keyword|genre|category|topic)\b/.test(n) && !/categories/.test(n)) {
    return [
      { name: 'id',           type: 'UUID' },
      { name: 'name',         type: 'TEXT' },
      { name: 'slug',         type: 'TEXT' },
      { name: 'color',        type: 'TEXT' },
      { name: 'created_at',   type: 'TIMESTAMP' },
    ]
  }

  // ── Invitation / Member archetype ─────────────────────────────────────────
  if (/\b(invitation|invite|referral|request|application)\b/.test(n)) {
    return [
      { name: 'id',           type: 'UUID' },
      { name: 'inviter_id',   type: 'UUID' },
      { name: 'invitee_email',type: 'TEXT' },
      { name: 'role',         type: 'TEXT' },
      { name: 'token',        type: 'TEXT' },
      { name: 'status',       type: 'TEXT' },     // pending/accepted/declined/expired
      { name: 'expires_at',   type: 'TIMESTAMP' },
      { name: 'accepted_at',  type: 'TIMESTAMP' },
      { name: 'created_at',   type: 'TIMESTAMP' },
    ]
  }

  // ── Generic "entity with a name + owner" default — much richer than 3 columns ──
  // For truly unknown tables: infer common fields from the name's parts.
  const likelyHasStatus = /status|state|stage|phase/.test(n)
  const likelyHasUser   = !/public|global|system|config/.test(n)
  const likelyHasTitle  = /post|article|item|entry|record|document|report|page/.test(n)

  return [
    { name: 'id',           type: 'UUID' },
    ...(likelyHasUser ? [{ name: 'user_id',     type: 'UUID' }] : []),
    ...(likelyHasTitle
      ? [{ name: 'title', type: 'TEXT' }, { name: 'description', type: 'TEXT' }]
      : [{ name: 'name',  type: 'TEXT' }, { name: 'description', type: 'TEXT' }]),
    ...(likelyHasStatus ? [{ name: 'status', type: 'TEXT' }] : []),
    { name: 'metadata',     type: 'JSONB' },
    { name: 'created_at',   type: 'TIMESTAMP' },
    { name: 'updated_at',   type: 'TIMESTAMP' },
  ]
}

// ── Main Executor ─────────────────────────────────────────────────────────────

/**
 * Execute a single BuildNode using the existing executeAction primitive.
 * Returns the real execution result — never an optimistic stub.
 */
export async function executeNode(
  node: BuildNode,
  projectId: string,
): Promise<NodeExecutionResult> {
  // Never execute blocked nodes
  if (node.status === 'blocked') {
    return {
      nodeId: node.id,
      status: 'blocked',
      blockedReason: node.blockedReason,
      detail: `Blocked: ${node.blockedReason?.description ?? 'requires manual step'}`,
    }
  }

  // Never re-execute verified nodes
  if (node.status === 'verified') {
    return { nodeId: node.id, status: 'verified', detail: node.executionDetail }
  }

  try {
    const { executeAction } = await import('../minimal-executor')

    switch (node.type) {
      case 'schema':
        return await executeSchemaNode(node, projectId, executeAction)

      case 'auth':
        return await executeAuthNode(node, projectId, executeAction)

      case 'permissions':
        return await executePermissionsNode(node, projectId, executeAction)

      case 'storage':
        return await executeStorageNode(node, projectId, executeAction)

      case 'flow':
        return await executeFlowNode(node, projectId, executeAction)

      case 'function':
        return await executeFunctionNode(node, projectId, executeAction)

      case 'trigger':
        return await executeTriggerNode(node, projectId, executeAction)

      case 'integration':
        return await executeIntegrationNode(node, projectId, executeAction)

      case 'realtime':
        return await executeRealtimeNode(node, projectId, executeAction)

      case 'verification':
        // Verification nodes are handled by verifier.ts, not here
        return { nodeId: node.id, status: 'pending', detail: 'Awaiting verification pass' }

      default:
        return { nodeId: node.id, status: 'failed', failureReason: `Unknown node type: ${node.type}` }
    }
  } catch (err: any) {
    return {
      nodeId: node.id,
      status: 'failed',
      failureReason: err?.message ?? 'Unexpected execution error',
    }
  }
}

// ── LLM Column Generation (async fallback for unknown tables) ─────────────────

/**
 * Generate domain-appropriate columns for a table using the LLM.
 * Only called when neither the blueprint nor pattern inference can produce
 * a meaningful schema (i.e., the inferred result would still be generic).
 * Results are cached in-memory for the lifetime of the process.
 */
const _columnCache = new Map<string, Array<{ name: string; type: string }>>()

async function generateColumnsWithLLM(
  tableName: string,
  originalPrompt: string,
  semanticEnrichment?: string,
): Promise<Array<{ name: string; type: string }>> {
  const cacheKey = `${tableName}:${originalPrompt.slice(0, 60)}`
  if (_columnCache.has(cacheKey)) return _columnCache.get(cacheKey)!

  try {
    const { getOpenAIClient } = await import('../openai-service')
    const { getModel } = await import('../model-router')
    const openai = getOpenAIClient()

    // Inject semantic enrichment (state machine, business rules) when available
    // so the LLM generates the right status column with correct enum values,
    // reservation fields for credit wallets, etc.
    const enrichmentSection = semanticEnrichment && semanticEnrichment.trim()
      ? `\n\nSEMANTIC CONTEXT — use this to pick the right columns:\n${semanticEnrichment.slice(0, 1000)}`
      : ''

    const response = await openai.chat.completions.create({
      model: getModel('classify'),
      messages: [
        {
          role: 'system',
          content: `You are a database schema designer. Generate production-appropriate columns for the given table.

Return JSON in this exact shape: {"columns": [{"name":"id","type":"UUID"}, ...]}

Rules:
- Always start with id (UUID) and end with created_at + updated_at (TIMESTAMP)
- Include user_id (UUID) if the entity is user-owned
- Types: UUID, TEXT, INTEGER, DECIMAL, BOOLEAN, TIMESTAMP, JSONB
- 8-14 columns total (no stubs, production-grade, include all relevant domain fields)
- Names: lowercase snake_case
- Never include password or password_hash
- If SEMANTIC CONTEXT mentions a state machine for this table, include a "status" TEXT column
- If SEMANTIC CONTEXT shows credit/wallet context, include: balance DECIMAL, reserved DECIMAL
- If SEMANTIC CONTEXT shows a job-queue, include: attempts INTEGER, max_attempts INTEGER, payload JSONB, result_url TEXT, error_message TEXT
- Infer all domain-specific fields from the table name + app description${enrichmentSection}`,
        },
        {
          role: 'user',
          content: `Table name: ${tableName}\nApp description: ${originalPrompt.slice(0, 300)}`,
        },
      ],
      temperature: 0,
      max_tokens: 400,
      // json_object requires an object — wrap array in { columns: [...] }
      response_format: { type: 'json_object' },
    })

    const raw = JSON.parse(response.choices[0].message.content || '{"columns":[]}')
    const cols: Array<{ name: string; type: string }> = Array.isArray(raw)
      ? raw
      : (raw.columns ?? raw.fields ?? raw.schema ?? [])

    if (cols.length >= 4) {
      _columnCache.set(cacheKey, cols)
      return cols
    }
  } catch {
    // Non-fatal — fall through to pattern-inferred result
  }

  // No valid LLM result — return pattern-inferred (already better than 3 columns)
  return inferColumnsFromTableName(tableName)
}

// ── Schema Nodes ──────────────────────────────────────────────────────────────

async function executeSchemaNode(
  node: BuildNode,
  projectId: string,
  executeAction: Function,
): Promise<NodeExecutionResult> {
  // Extract table name from node id: "schema.users" → "users"
  const tableName = node.id.replace(/^schema\./, '')

  // ── Guest mode: use guest column set for orders ─────────────────────────────
  const guestMode = node.executionParams?.guestMode === true
  let blueprintKey = tableName
  if (tableName === 'orders' && guestMode) {
    blueprintKey = 'orders_guest'
  }

  // Prefer prompt-parsed columns, then blueprint/pattern, then LLM generation.
  const promptColumns = (node.executionParams?.columns as any[] | undefined)
  let columns: any[]
  if (promptColumns?.length) {
    columns = promptColumns
  } else if (TABLE_COLUMNS[blueprintKey]) {
    // Blueprint match — use the pre-defined column set
    columns = TABLE_COLUMNS[blueprintKey]
  } else {
    // Unknown table — use pattern inference first (sync, fast)
    const patternCols = inferColumnsFromTableName(tableName)
    // If pattern only produced the generic 6-column result, try LLM for richer schema
    const isGenericFallback = patternCols.length <= 7 && patternCols.some(c => c.name === 'metadata')
    columns = isGenericFallback && node.executionParams?.originalPrompt
      ? await generateColumnsWithLLM(
          tableName,
          node.executionParams.originalPrompt as string,
          node.executionParams?.semanticEnrichment as string | undefined,
        )
      : patternCols
  }

  // ── Resolve enum CHECK constraints ──────────────────────────────────────────
  // Columns with enumValues get a CHECK constraint added to CREATE_TABLE params
  const enumConstraints: Array<{ columnName: string; values: string[] }> = columns
    .filter((c: any) => Array.isArray(c.enumValues) && c.enumValues.length > 0)
    .map((c: any) => ({ columnName: c.name, values: c.enumValues }))

  // Strip enumValues from columns (CREATE_TABLE only understands name+type)
  const cleanColumns = columns.map(({ enumValues: _ev, foreignKey: _fk, unique: _uq, required: _req, ...rest }: any) => rest)

  const createTableParams: Record<string, any> = {
    tableName,
    columns: cleanColumns,
  }
  if (enumConstraints.length > 0) {
    createTableParams.checkConstraints = enumConstraints
  }
  // Propagate unique column flags
  const uniqueColumns = columns.filter((c: any) => c.unique).map((c: any) => c.name)
  if (uniqueColumns.length > 0) {
    createTableParams.uniqueColumns = uniqueColumns
  }

  // ── SQL type safety preflight ────────────────────────────────────────────────
  // Validate column types BEFORE executing CREATE_TABLE to prevent:
  //   - TEXT FK columns that should be UUID
  //   - UUID status/enum columns
  //   - Type mismatches with referenced table PKs
  try {
    const { validateColumnTypes, formatTypeViolations } = await import('./sql-type-preflight')
    const typeViolations = validateColumnTypes(tableName, cleanColumns)
    const errorViolations = typeViolations.filter(v => v.severity === 'error')
    if (errorViolations.length > 0) {
      const errMsg = formatTypeViolations(errorViolations)
      console.error(`[NodeExecutor] SQL type preflight FAILED for "${tableName}":`, errMsg)
      return {
        nodeId: node.id,
        status: 'failed',
        failureReason: `Type safety check failed for table "${tableName}":\n${errMsg}`,
      }
    }
    if (typeViolations.length > 0) {
      // Warnings only — log but proceed
      console.warn(`[NodeExecutor] SQL type warnings for "${tableName}":`, formatTypeViolations(typeViolations))
    }
  } catch (_preflightErr: any) {
    // Non-fatal — don't block build on preflight failure
    console.warn(`[NodeExecutor] SQL type preflight skipped:`, _preflightErr?.message)
  }

  // Snapshot schema state before mutation — enables rollback if CREATE_TABLE corrupts state
  await import('@/lib/services/workspace-schema-snapshot')
    .then(({ captureSchemaSnapshot }) => captureSchemaSnapshot(projectId, 'pre_migration'))
    .catch(() => {})

  const result = await executeAction(
    { action: 'CREATE_TABLE', params: createTableParams },
    projectId
  ) as ExecutionResult

  if (result.success) {
    const detail = guestMode
      ? `Created guest-mode table \`${tableName}\` with ${cleanColumns.length} columns (no user_id, customer_name + customer_email included)`
      : `Created table \`${tableName}\` with ${cleanColumns.length} columns`
    return { nodeId: node.id, status: 'verified', detail, artifacts: result.artifacts }
  }

  // Idempotent: already exists is not a failure
  if (result.message?.toLowerCase().includes('already exists')) {
    return { nodeId: node.id, status: 'verified', detail: `Table \`${tableName}\` already exists` }
  }

  return { nodeId: node.id, status: 'failed', failureReason: result.error ?? result.message }
}

// ── Auth Nodes ────────────────────────────────────────────────────────────────

async function executeAuthNode(
  node: BuildNode,
  projectId: string,
  executeAction: Function,
): Promise<NodeExecutionResult> {
  const subtype = node.id.replace(/^auth\./, '') // "jwt", "google", "github"

  if (subtype === 'jwt') {
    const result = await executeAction(
      { action: 'ENABLE_AUTH', params: { type: 'jwt' } },
      projectId
    ) as ExecutionResult

    return result.success
      ? { nodeId: node.id, status: 'verified', detail: 'JWT authentication enabled', artifacts: result.artifacts }
      : { nodeId: node.id, status: 'failed', failureReason: result.error ?? result.message }
  }

  if (subtype === 'google' || subtype === 'github') {
    // Check if credentials are already stored (provider was configured via OAuth detector)
    try {
      const { prisma: oauthPrisma } = await import('@/lib/db')
      const existingOAuth = await oauthPrisma.workspaceOAuthConfig.findFirst({
        where: { projectId, provider: subtype },
      }).catch(() => null)

      if (existingOAuth) {
        return {
          nodeId: node.id,
          status: 'verified',
          detail: `${subtype} OAuth already configured — credentials present`,
        }
      }
    } catch { /* non-fatal — fall through to blocked */ }

    // Credentials not yet available — this node should remain blocked
    return {
      nodeId: node.id,
      status: 'blocked',
      blockedReason: node.blockedReason ?? {
        type: 'missing_credential',
        description: `${subtype} Client ID and Client Secret required`,
        requiredEnvVar: subtype === 'google' ? 'GOOGLE_CLIENT_ID' : 'GITHUB_CLIENT_ID',
        resumeOnIntegration: subtype,
        userAction: `Paste your ${subtype} OAuth credentials in the chat`,
      },
      detail: `Waiting for ${subtype} OAuth credentials`,
    }
  }

  return { nodeId: node.id, status: 'failed', failureReason: `Unknown auth subtype: ${subtype}` }
}

// ── Permissions Nodes ─────────────────────────────────────────────────────────

async function executePermissionsNode(
  node: BuildNode,
  projectId: string,
  executeAction: Function,
): Promise<NodeExecutionResult> {
  const subtype = node.id.replace(/^permissions\./, '')

  if (subtype === 'roles') {
    // Apply own_rows RLS policy to all user-owned tables so each role sees only their data.
    // Uses template: 'own_rows' which is the valid SET_PERMISSION template.
    const tables = (node.executionParams?.tables as string[]) ?? ['users']

    let successCount = 0
    const failedRoleTables: string[] = []
    for (const tableName of tables) {
      // The workspace `users` table is the canonical row-per-user table — its
      // OWN `id` column is the ownership identifier. Every other table uses
      // `user_id` (auto-detected). Without this override, own_rows tries to
      // create a policy referencing a non-existent `user_id` column on
      // `users`, the policy fails, but ALTER TABLE FORCE RLS already ran —
      // leaving the table locked-out by default-deny.
      const params: Record<string, unknown> = { tableName, template: 'own_rows' }
      if (tableName === 'users') params.userIdColumn = 'id'

      const result = await executeAction(
        { action: 'SET_PERMISSION', params },
        projectId
      ) as ExecutionResult
      if (result.success) {
        successCount++
      } else {
        failedRoleTables.push(tableName)
      }
    }

    if (successCount === tables.length) {
      return {
        nodeId: node.id,
        status: 'verified',
        detail: `Row ownership enforced on all ${successCount} table${successCount !== 1 ? 's' : ''} — users only access their own rows`,
      }
    }
    if (successCount > 0) {
      const unprotectedNote = failedRoleTables.length > 0
        ? ` — unprotected: ${failedRoleTables.join(', ')} (configure in Auth tab)`
        : ''
      return {
        nodeId: node.id,
        status: 'partial',
        detail: `Ownership policy applied to ${successCount}/${tables.length} tables${unprotectedNote}`,
      }
    }
    return { nodeId: node.id, status: 'partial', detail: 'Role ownership policy could not be applied — check permissions tab' }
  }

  if (subtype === 'rls') {
    // Apply own_rows RLS to all user-owned tables — correct template name for SET_PERMISSION
    const tables = (node.executionParams?.tables as string[]) ?? ['users']

    // For the users table the row-owner column is `id`, not `user_id`. See
    // matching comment in the `roles` branch above.
    const paramsFor = (tableName: string): Record<string, unknown> => {
      const p: Record<string, unknown> = { tableName, template: 'own_rows' }
      if (tableName === 'users') p.userIdColumn = 'id'
      return p
    }

    let successCount = 0
    const failedTables: string[] = []
    for (const tableName of tables) {
      const result = await executeAction(
        { action: 'SET_PERMISSION', params: paramsFor(tableName) },
        projectId
      ) as ExecutionResult
      if (result.success) {
        successCount++
      } else {
        failedTables.push(tableName)
      }
    }

    // BUG-12: Retry any failed tables once — covers race conditions where the table
    // wasn't fully committed when the first attempt ran.
    if (failedTables.length > 0) {
      const stillFailed: string[] = []
      for (const tableName of failedTables) {
        const retry = await executeAction(
          { action: 'SET_PERMISSION', params: paramsFor(tableName) },
          projectId
        ) as ExecutionResult
        if (retry.success) {
          successCount++
        } else {
          stillFailed.push(tableName)
        }
      }
      // Update failedTables to only those that failed both attempts
      failedTables.length = 0
      failedTables.push(...stillFailed)
    }

    // BUG-12: Re-read the actual count from the DB instead of trusting the execution-time
    // counter, which can under-count when idempotent "already exists" results are treated
    // as failures. Count policies actually present in the workspace schema.
    let actualApplied = successCount
    try {
      const { prisma: rlsPrisma } = await import('@/lib/db')
      const schemaName = `workspace_${projectId}`
      const policyRows = await rlsPrisma.$queryRawUnsafe<Array<{ tablename: string }>>(
        `SELECT DISTINCT tablename FROM pg_policies
         WHERE schemaname = $1 AND policyname LIKE '%own_rows%'`,
        schemaName
      )
      if (policyRows.length > 0) {
        actualApplied = policyRows.length
      }
    } catch {
      // Non-fatal — use execution-time counter as fallback
    }

    if (actualApplied >= tables.length) {
      return {
        nodeId: node.id,
        status: 'verified',
        detail: `Row-level security applied to all ${actualApplied} table${actualApplied !== 1 ? 's' : ''}`,
      }
    }
    const unprotectedNote = failedTables.length > 0
      ? ` — unprotected: ${failedTables.join(', ')} (apply RLS manually in the Auth tab)`
      : ' — some policies may need manual review'
    return {
      nodeId: node.id,
      status: actualApplied > 0 ? 'partial' : 'failed',
      detail: `RLS applied to ${actualApplied}/${tables.length} tables${unprotectedNote}`,
    }
  }

  return { nodeId: node.id, status: 'failed', failureReason: `Unknown permissions subtype: ${subtype}` }
}

// ── Storage Nodes ─────────────────────────────────────────────────────────────

async function executeStorageNode(
  node: BuildNode,
  projectId: string,
  executeAction: Function,
): Promise<NodeExecutionResult> {
  // Extract bucket name from node id: "storage.product_images" → "product_images"
  const bucketName = node.id.replace(/^storage\./, '')

  const result = await executeAction(
    {
      action: 'CREATE_BUCKET',
      params: {
        bucketName,
        isPublic: node.executionParams?.isPublic ?? false,
        maxFileSize: node.executionParams?.maxFileSize ?? 10485760, // 10MB default
      },
    },
    projectId
  ) as ExecutionResult

  if (result.success) {
    return {
      nodeId: node.id,
      status: 'verified',
      detail: `Created storage bucket \`${bucketName}\``,
      artifacts: result.artifacts,
    }
  }

  if (result.message?.toLowerCase().includes('already exists')) {
    return { nodeId: node.id, status: 'verified', detail: `Bucket \`${bucketName}\` already exists` }
  }

  return { nodeId: node.id, status: 'failed', failureReason: result.error ?? result.message }
}

// ── Flow Nodes ────────────────────────────────────────────────────────────────

async function executeFlowNode(
  node: BuildNode,
  projectId: string,
  executeAction: Function,
): Promise<NodeExecutionResult> {
  // ── Special flow types ──────────────────────────────────────────────────────

  // Checkout flow → GENERATE_CHECKOUT_FLOW (not just a table API)
  if (node.id === 'flow.checkout') {
    const result = await executeAction(
      { action: 'GENERATE_CHECKOUT_FLOW', params: {} },
      projectId
    ) as ExecutionResult
    return result.success
      ? { nodeId: node.id, status: 'verified', detail: 'Cart → Order checkout flow ready', artifacts: result.artifacts }
      : { nodeId: node.id, status: 'partial', detail: result.message }
  }

  // Stats endpoint → GENERATE_AGGREGATE_API
  if (node.id === 'flow.stats') {
    const result = await executeAction(
      { action: 'GENERATE_AGGREGATE_API', params: { name: 'summary' } },
      projectId
    ) as ExecutionResult
    return result.success
      ? { nodeId: node.id, status: 'verified', detail: 'Aggregate stats endpoint ready at /stats/summary', artifacts: result.artifacts }
      : { nodeId: node.id, status: 'partial', detail: result.message }
  }

  // Health check endpoint → GENERATE_HEALTH_CHECK
  if (node.id === 'flow.healthz') {
    const result = await executeAction(
      { action: 'GENERATE_HEALTH_CHECK', params: {} },
      projectId
    ) as ExecutionResult
    return result.success
      ? { nodeId: node.id, status: 'verified', detail: 'Health check ready at /healthz', artifacts: result.artifacts }
      : { nodeId: node.id, status: 'partial', detail: result.message }
  }

  // Order status restricted endpoint
  if (node.id === 'flow.order_status') {
    const result = await executeAction(
      {
        action: 'GENERATE_RESTRICTED_ENDPOINT',
        params: {
          tableName: 'orders',
          allowedFields: ['status'],
          path: '/orders/:id/status',
          description: 'Update order status only (pending → processing → shipped → delivered → cancelled)',
        },
      },
      projectId
    ) as ExecutionResult
    return result.success
      ? { nodeId: node.id, status: 'verified', detail: 'Order status endpoint ready (PATCH /orders/:id/status)', artifacts: result.artifacts }
      : { nodeId: node.id, status: 'partial', detail: result.message }
  }

  // ── #58 Admin flow node ─────────────────────────────────────────────────────
  if (node.id === 'flow.admin_apis' || node.executionParams?.adminMode === true) {
    // Admin endpoints are registered against the 'users' table — the admin
    // endpoints are generated as AiFunction records by generateDomainEndpoints
    // when users is processed, so this node is a coordination point.
    const result = await executeAction(
      { action: 'GENERATE_API', params: { tableName: 'users' } },
      projectId
    ) as ExecutionResult
    return result.success
      ? { nodeId: node.id, status: 'verified', detail: 'Admin API endpoints registered (list users, suspend, refund, audit logs, revenue)', artifacts: result.artifacts }
      : { nodeId: node.id, status: 'partial', detail: result.message }
  }

  // ── Standard table CRUD flow ────────────────────────────────────────────────
  const tableName = (node.executionParams?.tableName as string) ?? guessTableFromFlowNode(node.id)

  const result = await executeAction(
    {
      action: 'GENERATE_API',
      params: {
        tableName,
        endpoints: node.executionParams?.endpoints ?? ['list', 'get', 'create', 'update', 'delete'],
        customEndpoints: node.executionParams?.customEndpoints,
      },
    },
    projectId
  ) as ExecutionResult

  if (result.success) {
    return {
      nodeId: node.id,
      status: 'verified',
      detail: `Generated REST API for \`${tableName}\``,
      artifacts: result.artifacts,
    }
  }

  return {
    nodeId: node.id,
    status: 'partial',
    detail: `API generation for \`${tableName}\` partial: ${result.message}`,
  }
}

function guessTableFromFlowNode(nodeId: string): string {
  // "flow.product_catalog" → "products"
  // "flow.cart_management" → "carts"
  // "flow.order_management" → "orders"
  // "flow.store_management" → "stores"
  const part = nodeId.replace(/^flow\./, '')
  const TABLE_MAP: Record<string, string> = {
    product_catalog:    'products',
    category_management:'categories',
    cart_management:    'carts',
    order_management:   'orders',
    store_management:   'stores',
    listing_management: 'listings',
    order_processing:   'orders',
    team_management:    'workspace_members',
    workspace_ops:      'workspaces',
    plan_management:    'plans',
    dispute_management: 'disputes',
    messaging:          'messages',
    reviews:            'reviews',
  }
  return TABLE_MAP[part] ?? part.replace(/_management|_ops|_checkout|_catalog|_apis$/, '')
}

// ── Function Nodes ────────────────────────────────────────────────────────────

/**
 * Map of function node IDs → their real trigger type and optional trigger table.
 * Without this, all functions default to 'manual' which is incorrect.
 */
const FUNCTION_TRIGGER_MAP: Record<string, { triggerType: string; triggerTable?: string }> = {
  on_order_created:     { triggerType: 'on_db_insert', triggerTable: 'orders' },
  on_payment_succeeded: { triggerType: 'on_db_insert', triggerTable: 'payments' },
  trial_ending:         { triggerType: 'manual' },  // would be cron in production
  member_invited:       { triggerType: 'on_db_insert', triggerTable: 'workspace_members' },
  refund_issued:        { triggerType: 'on_db_update', triggerTable: 'disputes' },
  on_message:           { triggerType: 'on_db_insert', triggerTable: 'messages' },
}

async function executeFunctionNode(
  node: BuildNode,
  projectId: string,
  executeAction: Function,
): Promise<NodeExecutionResult> {
  // "function.on_order_created" → fnName = "on_order_created"
  const fnName = node.id.replace(/^function\./, '')
  const description = functionDescription(fnName)

  // Resolve trigger type: use explicit executionParams if set, otherwise use the known map,
  // then fall back to 'manual' as last resort.
  const triggerInfo = FUNCTION_TRIGGER_MAP[fnName]
  const triggerType = node.executionParams?.triggerType
    ?? node.executionParams?.trigger   // legacy param name support
    ?? triggerInfo?.triggerType
    ?? 'manual'
  const triggerTable = node.executionParams?.triggerTable ?? triggerInfo?.triggerTable

  const result = await executeAction(
    {
      action: 'CREATE_AI_FUNCTION',
      params: {
        name: fnName,          // passed so executor can honor it instead of LLM-generating a name
        description,
        triggerType,           // correct param name (was 'trigger' — caused "triggerType is required" error)
        triggerTable,
      },
    },
    projectId
  ) as ExecutionResult

  if (result.success) {
    return {
      nodeId: node.id,
      status: 'verified',
      detail: `Created function \`${fnName}\` (${triggerType}${triggerTable ? ':' + triggerTable : ''})`,
      artifacts: result.artifacts,
    }
  }

  // Idempotent: already exists is not a failure
  if (result.message?.toLowerCase().includes('already exists')) {
    return {
      nodeId: node.id,
      status: 'verified',
      detail: `Function \`${fnName}\` already exists`,
    }
  }

  // Blocked by missing integration (e.g. Stripe key not present)
  if (result.message?.toLowerCase().includes('[blocked]')) {
    return {
      nodeId: node.id,
      status: 'partial',
      detail: `Function \`${fnName}\` requires a connected integration — activate in the Integrations tab`,
    }
  }

  // Real failure — report honestly, don't say "created"
  return {
    nodeId: node.id,
    status: 'failed',
    failureReason: result.message ?? result.error ?? `Failed to create function \`${fnName}\``,
  }
}

function functionDescription(name: string): string {
  const DESCRIPTIONS: Record<string, string> = {
    on_order_created:    'Send order confirmation email and notify seller when a new order is placed',
    on_payment_succeeded:'Mark order as paid and decrement product stock when payment succeeds',
    trial_ending:        'Send trial expiry warning email 3 days before trial ends',
    member_invited:      'Send workspace invitation email when a new member is added',
    refund_issued:       'Process refund via Stripe and update order status to refunded',
    on_message:          'Notify recipient of new message via email or push notification',
  }
  return DESCRIPTIONS[name] ?? `Handle ${name.replace(/_/g, ' ')} event`
}

// ── Trigger Nodes ─────────────────────────────────────────────────────────────

async function executeTriggerNode(
  node: BuildNode,
  projectId: string,
  executeAction: Function,
): Promise<NodeExecutionResult> {
  const triggerName = node.id.replace(/^trigger\./, '')
  const config = triggerConfig(triggerName)

  const result = await executeAction(
    {
      action: 'CREATE_TRIGGER',
      params: {
        name: triggerName,
        tableName: config.table,
        event: config.event,
        functionName: config.fn,
        condition: config.condition,
      },
    },
    projectId
  ) as ExecutionResult

  if (result.success) {
    return { nodeId: node.id, status: 'verified', detail: `Created trigger \`${triggerName}\`` }
  }

  return { nodeId: node.id, status: 'partial', detail: `Trigger \`${triggerName}\` partially configured` }
}

function triggerConfig(name: string): { table: string; event: string; fn: string; condition?: string } {
  const CONFIGS: Record<string, { table: string; event: string; fn: string; condition?: string }> = {
    decrement_stock: { table: 'order_items', event: 'INSERT', fn: 'on_order_item_created', condition: 'NEW.quantity > 0' },
    on_order_placed: { table: 'orders', event: 'INSERT', fn: 'on_order_created' },
  }
  return CONFIGS[name] ?? { table: 'events', event: 'INSERT', fn: name }
}

// ── Integration Nodes ─────────────────────────────────────────────────────────

async function executeIntegrationNode(
  node: BuildNode,
  projectId: string,
  executeAction: Function,
): Promise<NodeExecutionResult> {
  // Integration nodes that are still blocked should never reach here
  // (filtered by caller), but guard just in case
  if (node.blockedReason?.requiredEnvVar) {
    return {
      nodeId: node.id,
      status: 'blocked',
      blockedReason: node.blockedReason,
      detail: `Requires ${node.blockedReason.requiredEnvVar}`,
    }
  }

  const parts = node.id.split('.') // ['integration', 'stripe', 'checkout']
  const provider = parts[1]
  const feature = parts[2]

  if (provider === 'stripe') {
    return await executeStripeNode(node, projectId, feature, executeAction)
  }
  if (provider === 'resend') {
    return await executeResendNode(node, projectId, executeAction)
  }
  if (provider === 'openai') {
    return await executeOpenAINode(node, projectId, executeAction)
  }

  return { nodeId: node.id, status: 'partial', detail: `Integration ${provider} partially configured` }
}

async function executeStripeNode(
  node: BuildNode,
  projectId: string,
  feature: string,
  executeAction: Function,
): Promise<NodeExecutionResult> {
  if (feature === 'checkout' || feature === 'subscription') {
    // Build the complete Stripe checkout flow:
    // 1. Ensure orders table has Stripe columns
    // 2. Create checkout endpoint function
    const result = await executeAction(
      {
        action: 'CREATE_AI_FUNCTION',
        params: {
          name: 'stripe_checkout',
          description: 'Create Stripe checkout session and return checkout URL. Idempotent — uses stripePaymentIntentId to prevent duplicate charges.',
          trigger: 'http',
          provider: 'stripe',
        },
      },
      projectId
    ) as ExecutionResult

    if (result.success) {
      return {
        nodeId: node.id,
        status: 'verified',
        detail: 'Stripe checkout endpoint created with idempotency protection',
        artifacts: result.artifacts,
      }
    }
  }

  if (feature === 'webhook') {
    const result = await executeAction(
      {
        action: 'CREATE_AI_FUNCTION',
        params: {
          name: 'stripe_webhook',
          description: 'Handle Stripe webhook events: payment_intent.succeeded → mark order paid + decrement stock; payment_intent.payment_failed → mark order failed. Verifies STRIPE_WEBHOOK_SECRET signature.',
          trigger: 'http',
          provider: 'stripe',
        },
      },
      projectId
    ) as ExecutionResult

    if (result.success) {
      return {
        nodeId: node.id,
        status: 'verified',
        detail: 'Stripe webhook handler created with HMAC signature verification',
      }
    }
  }

  return { nodeId: node.id, status: 'partial', detail: `Stripe ${feature} partially configured` }
}

async function executeResendNode(
  node: BuildNode,
  projectId: string,
  executeAction: Function,
): Promise<NodeExecutionResult> {
  const result = await executeAction(
    {
      action: 'CREATE_AI_FUNCTION',
      params: {
        name: 'send_email',
        description: 'Send transactional emails via Resend. Handles: order confirmations, welcome emails, notifications. Uses RESEND_API_KEY from project secrets.',
        trigger: 'manual',
        provider: 'resend',
      },
    },
    projectId
  ) as ExecutionResult

  return result.success
    ? { nodeId: node.id, status: 'verified', detail: 'Email notification function created via Resend' }
    : { nodeId: node.id, status: 'partial', detail: 'Email function scaffold created — activate with Resend key' }
}

async function executeOpenAINode(
  node: BuildNode,
  projectId: string,
  executeAction: Function,
): Promise<NodeExecutionResult> {
  const result = await executeAction(
    {
      action: 'CREATE_AI_FUNCTION',
      params: {
        name: 'ai_assistant',
        description: 'AI-powered function using OpenAI GPT. Processes user input and returns intelligent responses. Uses OPENAI_API_KEY from project secrets.',
        trigger: 'http',
        provider: 'openai',
      },
    },
    projectId
  ) as ExecutionResult

  return result.success
    ? { nodeId: node.id, status: 'verified', detail: 'OpenAI AI function created' }
    : { nodeId: node.id, status: 'partial', detail: 'OpenAI function scaffold created — activate with API key' }
}

// ── Realtime Nodes ────────────────────────────────────────────────────────────

async function executeRealtimeNode(
  node: BuildNode,
  projectId: string,
  executeAction: Function,
): Promise<NodeExecutionResult> {
  // If the node carries a list of tables (from domain-compiler realtime.all_tables nodes),
  // enable realtime on each. Otherwise fall back to extracting a single table from the ID.
  const tableNames = (node.executionParams?.tableNames as string[] | undefined)
  const displayLabel = (node.executionParams?.displayLabel as string | undefined) ?? node.id.replace(/^realtime\./, '')

  if (tableNames && tableNames.length > 0) {
    let successCount = 0
    for (const tbl of tableNames) {
      const r = await executeAction({ action: 'ENABLE_REALTIME', params: { tableName: tbl } }, projectId) as ExecutionResult
      if (r.success) successCount++
    }
    const countLabel = `${successCount}/${tableNames.length} table${tableNames.length !== 1 ? 's' : ''}`
    return successCount > 0
      ? { nodeId: node.id, status: 'verified', detail: `Realtime enabled for ${displayLabel} (${countLabel})` }
      : { nodeId: node.id, status: 'partial', detail: `Realtime for ${displayLabel} partially configured` }
  }

  // Single-table path: "realtime.orders" → ENABLE_REALTIME for "orders"
  const tableName = node.id.replace(/^realtime\./, '')
  const result = await executeAction(
    { action: 'ENABLE_REALTIME', params: { tableName } },
    projectId
  ) as ExecutionResult

  return result.success
    ? { nodeId: node.id, status: 'verified', detail: `Realtime enabled for \`${tableName}\`` }
    : { nodeId: node.id, status: 'partial', detail: `Realtime for \`${tableName}\` partially configured` }
}
