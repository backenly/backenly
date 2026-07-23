/**
 * DOMAIN-AWARE API GENERATOR — Phase 6 (shadow mode)
 * ==================================================
 * Reads the full Phase 1–5 output set (ProductUnderstanding, WorkflowsReport,
 * BusinessRulesReport, StateMachinesReport, PlanValidationReport) and emits a
 * structured DomainApiPlanReport describing the *planned* domain endpoints
 * that this product needs.
 *
 * Phase 6 is the first phase that produces something resembling real API
 * surface (paths, methods, auth requirements, rule wiring), but it stays in
 * STRICT SHADOW MODE:
 *
 *   • No routes are mounted.
 *   • No handler code is generated.
 *   • No DB / schema writes occur.
 *   • Production behaviour is unchanged when the flag is off.
 *
 * Phase 7 will run the behaviour verifier against these plans and Phase 8
 * will eventually generate the actual handler code from them.
 *
 * The generator is strictly deterministic — no LLM, no DB, no network. It
 * walks a registry of ApiTemplate entries, asks each whether the inputs
 * satisfy its trigger conditions, and assembles the matching DomainApiPlan
 * records.
 */

import type { ProductUnderstanding, CriticalCapability } from '../understanding/types'
import type {
  WorkflowsReport,
  BusinessRulesReport,
  StateMachinesReport,
  PlanValidationReport,
  DomainApiPlan,
  DomainApiPlanReport,
  DomainApiCategory,
  DomainApiMethod,
  DomainApiRequiredRole,
} from '../planning/types'

// ─── Inputs ───────────────────────────────────────────────────────────────────

export interface DomainApiGeneratorInput {
  prompt: string
  understanding: ProductUnderstanding
  workflows: WorkflowsReport
  rules: BusinessRulesReport
  machines: StateMachinesReport
  /** Optional — Phase 5 validator output. Used for warnings only. */
  validation?: PlanValidationReport
  /** Optional — IntentGraph entity names (for table inference) */
  entityNames?: string[]
}

// ─── Helpers / context ────────────────────────────────────────────────────────

interface Ctx {
  prompt: string
  promptLower: string
  understanding: ProductUnderstanding
  capabilities: Set<CriticalCapability>
  patterns: Set<string>
  primaryDomain: string
  workflows: WorkflowsReport['workflows']
  workflowIds: Set<string>
  workflowsList: WorkflowsReport['workflows']
  rules: BusinessRulesReport['rules']
  ruleIds: Set<string>
  machines: StateMachinesReport['plans']
  machineById: Map<string, StateMachinesReport['plans'][number]>
  entityNames: Set<string>
}

function inferJobTable(ctx: Ctx): string {
  if (ctx.capabilities.has('video_generation_jobs') || ctx.entityNames.has('generation_jobs')) {
    return 'generation_jobs'
  }
  for (const e of ctx.entityNames) if (/(_jobs|_tasks|_queue)$/.test(e)) return e
  return 'jobs'
}

function inferAssetTable(ctx: Ctx): string {
  for (const candidate of ['assets', 'uploads', 'files', 'media', 'images', 'videos']) {
    if (ctx.entityNames.has(candidate)) return candidate
  }
  return 'assets'
}

function inferOrderTable(ctx: Ctx): string {
  for (const candidate of ['orders', 'purchases', 'carts', 'checkouts']) {
    if (ctx.entityNames.has(candidate)) return candidate
  }
  return 'orders'
}

function inferAppointmentTable(ctx: Ctx): string {
  for (const candidate of ['appointments', 'bookings', 'reservations']) {
    if (ctx.entityNames.has(candidate)) return candidate
  }
  return 'appointments'
}

function pickPaymentIntegration(ctx: Ctx): string {
  const p = ctx.promptLower
  if (/\bpaddle\b/.test(p)) return 'paddle'
  if (/\bpaypal\b/.test(p)) return 'paypal'
  return 'stripe'
}

function pickAiProvider(ctx: Ctx): string {
  const p = ctx.promptLower
  if (/\brunway\b/.test(p)) return 'runway'
  if (/\bstability\b|\bstable\s+diffusion\b/.test(p)) return 'stability'
  if (/\bkling\b/.test(p)) return 'kling'
  if (/\bpika\b/.test(p)) return 'pika'
  if (/\banthropic\b|\bclaude\b/.test(p)) return 'anthropic'
  if (/\bgemini\b/.test(p)) return 'gemini'
  if (/\bopenai\b|\bgpt\b/.test(p)) return 'openai'
  return 'openai'
}

function isHospitalDomain(ctx: Ctx): boolean {
  return (
    ctx.understanding.primaryDomain === 'hospital_booking_app' ||
    ctx.understanding.primaryDomain === 'healthcare_app' ||
    ctx.entityNames.has('appointments') ||
    /\b(hospital|clinic|patient|doctor|appointment)\b/i.test(ctx.prompt)
  )
}

function isLearningDomain(ctx: Ctx): boolean {
  return (
    ctx.understanding.primaryDomain === 'learning_platform' ||
    ctx.entityNames.has('courses') ||
    ctx.entityNames.has('lessons') ||
    /\b(course|lesson|enroll|student|learning)\b/i.test(ctx.prompt)
  )
}

function isCrmDomain(ctx: Ctx): boolean {
  return (
    ctx.understanding.primaryDomain === 'internal_crm' ||
    ctx.patterns.has('crm') ||
    /\b(crm|ticket|helpdesk|support|issue tracker)\b/i.test(ctx.prompt)
  )
}

function isFoodDeliveryDomain(ctx: Ctx): boolean {
  return (
    ctx.understanding.primaryDomain === 'food_delivery_app' ||
    /\b(food delivery|restaurant|menu|driver)\b/i.test(ctx.prompt)
  )
}

// ─── Template definition ──────────────────────────────────────────────────────

type ApiBuilder = (ctx: Ctx) => Omit<DomainApiPlan, 'shadowMode'> | null

interface ApiTemplate {
  id: string
  shouldFire: (ctx: Ctx) => boolean
  build: ApiBuilder
}

// Helper that fills sensible defaults for the runtime / pagination / rate-limit
// flags so each template can stay terse.
function api(args: {
  id: string
  method: DomainApiMethod
  path: string
  name: string
  category: DomainApiCategory
  purpose: string
  workflowIds?: string[]
  businessRuleIds?: string[]
  stateMachineIds?: string[]
  requiredAuth?: boolean
  requiredRole?: DomainApiRequiredRole
  inputSchemaRequired?: boolean
  paginationRequired?: boolean
  rateLimitRequired?: boolean
  idempotencyRequired?: boolean
  transactionRequired?: boolean
  runtimeRequired?: string[]
  integrationsRequired?: string[]
  verificationScenarios?: string[]
  implementationHint: string
}): Omit<DomainApiPlan, 'shadowMode'> {
  const isMutating = args.method !== 'GET'
  const isAdmin = args.requiredRole === 'admin' || /\/admin\//.test(args.path)
  const isList = args.method === 'GET' && /^\/[a-z0-9_\-]+(\/[a-z0-9_\-]+)?$/i.test(args.path) && !args.path.includes(':')
  return {
    id: args.id,
    method: args.method,
    path: args.path,
    name: args.name,
    category: args.category,
    purpose: args.purpose,
    workflowIds: args.workflowIds ?? [],
    businessRuleIds: args.businessRuleIds ?? [],
    stateMachineIds: args.stateMachineIds ?? [],
    requiredAuth: args.requiredAuth ?? true,
    requiredRole: args.requiredRole,
    inputSchemaRequired: args.inputSchemaRequired ?? isMutating,
    paginationRequired: args.paginationRequired ?? isList,
    rateLimitRequired: args.rateLimitRequired ?? (isMutating || isAdmin),
    idempotencyRequired: args.idempotencyRequired,
    transactionRequired: args.transactionRequired,
    runtimeRequired: args.runtimeRequired ?? (isMutating ? ['transactional_db'] : []),
    integrationsRequired: args.integrationsRequired ?? [],
    verificationScenarios: args.verificationScenarios ?? [],
    implementationHint: args.implementationHint,
  }
}

// ─── Templates ────────────────────────────────────────────────────────────────

const TEMPLATES: ApiTemplate[] = [
  // ── State-machine endpoints — emit verbatim from each plan ────────────────
  // Mirrors the paths in StateMachinesReport so missing_endpoint findings drop
  // to zero when the validator re-runs against the Phase 6 output.
  {
    id: 'state_machine_endpoints',
    shouldFire: ctx => ctx.machines.length > 0,
    build: () => null, // handled in generate() — emits one API per requiredEndpoint
  },

  // ── Generation job — submit ────────────────────────────────────────────────
  {
    id: 'submit_generation_job',
    shouldFire: ctx =>
      ctx.workflowIds.has('submit_generation_job') ||
      ctx.capabilities.has('ai_jobs') ||
      ctx.capabilities.has('video_generation_jobs'),
    build: ctx => {
      const table = inferJobTable(ctx)
      const usesCredits = ctx.capabilities.has('credits')
      const provider = pickAiProvider(ctx)
      const ruleRefs = [
        'project_owner_required_for_generation',
        ...(usesCredits ? ['reserve_credits_before_generation', 'credits_non_negative'] : []),
        'valid_generation_job_status_transition',
      ].filter(id => ctx.ruleIds.has(id))
      return api({
        id: 'submit_generation_job',
        method: 'POST',
        path: `/${table}/submit`,
        name: 'Submit generation job',
        category: 'business',
        purpose: 'End user submits a long-running generation job. Validates input, reserves credits, inserts a queued row, and enqueues a worker.',
        workflowIds: ['submit_generation_job'].filter(id => ctx.workflowIds.has(id)),
        businessRuleIds: ruleRefs,
        stateMachineIds: ctx.machineById.has('sm_generation_jobs') ? ['sm_generation_jobs'] : [],
        requiredAuth: true,
        inputSchemaRequired: true,
        rateLimitRequired: true,
        transactionRequired: true,
        runtimeRequired: ['queue', 'worker', 'event_bus', 'transactional_db', ...(usesCredits ? ['advisory_locks'] : [])],
        integrationsRequired: [provider],
        verificationScenarios: [
          usesCredits ? 'User with balance=0 submits a job → 402; no row in generation_jobs.' : 'Submit succeeds with status=queued.',
          'Two concurrent submissions reserving the same final credit → exactly one accepted; balance/reserved invariant holds.',
          'Owner check: user submits a job referencing another user\'s project → 403 / 404.',
        ],
        implementationHint: `BEGIN; ${usesCredits ? 'SELECT … FOR UPDATE on credit_wallets WHERE user_id = $1; if balance - reserved < cost → 402 ROLLBACK. UPDATE credit_wallets SET reserved = reserved + cost; ' : ''}INSERT INTO ${table} (status='queued', owner_id, …) RETURNING id; enqueue worker(${table}_queue, id); COMMIT. Validate body with Zod (prompt, parameters, project_id).`,
      })
    },
  },

  // ── Credits — balance + purchase ───────────────────────────────────────────
  {
    id: 'get_credits_balance',
    shouldFire: ctx => ctx.capabilities.has('credits'),
    build: () => api({
      id: 'get_credits_balance',
      method: 'GET',
      path: '/credits/balance',
      name: 'Get credit balance',
      category: 'billing',
      purpose: 'Return the authenticated user\'s available credit balance and active reservation.',
      workflowIds: [],
      businessRuleIds: ['credits_non_negative'],
      requiredAuth: true,
      inputSchemaRequired: false,
      paginationRequired: false,
      rateLimitRequired: true,
      verificationScenarios: [
        'Authenticated user reads their own balance — returns balance + reserved.',
        'Unauthenticated request → 401.',
      ],
      implementationHint: 'SELECT balance, reserved FROM credit_wallets WHERE user_id = auth.uid(); return { available: balance - reserved, balance, reserved }. RLS: USING (user_id = auth.uid()).',
    }),
  },
  {
    id: 'purchase_credits',
    shouldFire: ctx => ctx.capabilities.has('credits') && ctx.capabilities.has('payments'),
    build: ctx => api({
      id: 'purchase_credits',
      method: 'POST',
      path: '/credits/purchase',
      name: 'Purchase credits',
      category: 'billing',
      purpose: 'Create a checkout session for a credit pack; credits land only after the provider webhook confirms.',
      workflowIds: ['purchase_credits'].filter(id => ctx.workflowIds.has(id)),
      businessRuleIds: ['credits_non_negative', 'payment_webhook_idempotency'].filter(id => ctx.ruleIds.has(id)),
      requiredAuth: true,
      inputSchemaRequired: true,
      rateLimitRequired: true,
      transactionRequired: true,
      runtimeRequired: ['transactional_db', 'event_bus'],
      integrationsRequired: [pickPaymentIntegration(ctx)],
      verificationScenarios: [
        'Successful purchase + matching webhook → exactly one credit grant; webhook_log row written.',
        'Duplicate webhook replay → no double credit; webhook_log unique on event_id.',
      ],
      implementationHint: `Validate pack_id + price server-side; create ${pickPaymentIntegration(ctx)} checkout session; INSERT INTO payments (user_id, pack_id, status='pending', provider_session_id) within a single transaction; return { url }. Credits are NEVER granted from this endpoint — only the webhook may grant.`,
    }),
  },

  // ── Webhook — Stripe / Paddle ──────────────────────────────────────────────
  {
    id: 'webhook_stripe',
    shouldFire: ctx => ctx.capabilities.has('webhooks') && ctx.capabilities.has('payments'),
    build: ctx => {
      const provider = pickPaymentIntegration(ctx)
      return api({
        id: `webhook_${provider}`,
        method: 'POST',
        path: `/webhooks/${provider}`,
        name: `${provider[0].toUpperCase()}${provider.slice(1)} webhook receiver`,
        category: 'webhook',
        purpose: `Receive ${provider} events; verify signature; apply state changes idempotently.`,
        workflowIds: ['purchase_credits', 'subscribe_plan', 'place_order'].filter(id => ctx.workflowIds.has(id)),
        businessRuleIds: ['payment_webhook_idempotency'].filter(id => ctx.ruleIds.has(id)),
        requiredAuth: false, // signed by provider, not session-authed
        inputSchemaRequired: true,
        rateLimitRequired: true,
        idempotencyRequired: true,
        transactionRequired: true,
        runtimeRequired: ['transactional_db'],
        integrationsRequired: [provider],
        verificationScenarios: [
          `Replay the same ${provider} event twice → side effect runs once; webhook_log has one row.`,
          'Tampered signature → reject 400 before any DB write.',
          'Out-of-order events → updated_at guard drops stale states.',
        ],
        implementationHint: `Verify ${provider} signature with the configured webhook secret; INSERT INTO webhook_log (event_id, provider, signature_verified) ON CONFLICT (event_id) DO NOTHING; if 0 rows inserted return 200 (no-op). Otherwise apply the side effect (credit grant / subscription update / order paid) in the same transaction as the webhook_log row.`,
      })
    },
  },

  // ── Storage — signed upload + signed download ─────────────────────────────
  {
    id: 'storage_signed_upload',
    shouldFire: ctx => ctx.capabilities.has('storage'),
    build: ctx => {
      const table = inferAssetTable(ctx)
      return api({
        id: 'storage_signed_upload',
        method: 'POST',
        path: '/assets/signed-upload',
        name: 'Request signed upload URL',
        category: 'storage',
        purpose: 'Validate metadata + quota and return a short-lived signed URL the client can PUT to directly.',
        workflowIds: ['asset_upload'].filter(id => ctx.workflowIds.has(id)),
        businessRuleIds: ['validate_signed_upload_metadata', 'private_asset_owner_access'].filter(id => ctx.ruleIds.has(id)),
        requiredAuth: true,
        inputSchemaRequired: true,
        rateLimitRequired: true,
        runtimeRequired: ['transactional_db'],
        integrationsRequired: ['storage'],
        verificationScenarios: [
          'Disallowed contentType (e.g. application/x-msdownload) → 400 before any URL is issued.',
          'Path traversal in intended_path (e.g. "../other-user/x.png") → 400.',
          'Per-user quota exceeded → 402/429 before signed URL is issued.',
        ],
        implementationHint: `Zod schema { contentType ∈ allow-list, sizeBytes ≤ maxBytes, intendedPath matches /<owner_id>/* prefix }. Read storage_usage; reject if quota exceeded. Generate 15-min signed PUT URL; INSERT INTO ${table} (status='pending', owner_id, content_type, size_bytes); return { url, assetId }.`,
      })
    },
  },
  {
    id: 'storage_signed_download',
    shouldFire: ctx => ctx.capabilities.has('storage'),
    build: ctx => {
      const table = inferAssetTable(ctx)
      return api({
        id: 'storage_signed_download',
        method: 'GET',
        path: `/${table}/:id/download-url`,
        name: 'Get signed download URL',
        category: 'storage',
        purpose: 'Return a short-lived signed download URL for an asset the requester is allowed to read.',
        businessRuleIds: ['private_asset_owner_access'].filter(id => ctx.ruleIds.has(id)),
        requiredAuth: true,
        rateLimitRequired: true,
        runtimeRequired: [],
        integrationsRequired: ['storage'],
        verificationScenarios: [
          'User A requests user B\'s private asset → 403 / 404; the signed URL is never minted.',
          'Public asset → returns a long-lived URL or a CDN URL per ACL.',
        ],
        implementationHint: `SELECT visibility, owner_id FROM ${table} WHERE id = $1; reject 403/404 if visibility='private' AND owner_id != auth.uid(); generate 15-min signed GET URL; return { url, expiresAt }.`,
      })
    },
  },

  // ── Admin — list jobs ──────────────────────────────────────────────────────
  {
    id: 'admin_list_jobs',
    shouldFire: ctx =>
      ctx.capabilities.has('admin') &&
      (ctx.capabilities.has('ai_jobs') || ctx.capabilities.has('video_generation_jobs') || ctx.capabilities.has('workflow_engine')),
    build: ctx => {
      const table = inferJobTable(ctx)
      return api({
        id: 'admin_list_jobs',
        method: 'GET',
        path: `/admin/${table}`,
        name: 'Admin: list jobs',
        category: 'admin',
        purpose: 'Admin-only listing of jobs with status filter + cursor pagination.',
        businessRuleIds: ['admin_only_job_management', 'audit_admin_actions'].filter(id => ctx.ruleIds.has(id)),
        requiredAuth: true,
        requiredRole: 'admin',
        paginationRequired: true,
        rateLimitRequired: true,
        runtimeRequired: [],
        verificationScenarios: [
          'Non-admin GET /admin/* → 403.',
          'Pagination clamps ?limit to a server-defined max.',
        ],
        implementationHint: `adminAuth middleware re-reads users.role from DB on every request. Accept ?status, ?limit, ?cursor. SELECT … FROM ${table} WHERE ($status IS NULL OR status=$status) ORDER BY created_at DESC LIMIT $limit; return cursor for next page.`,
      })
    },
  },

  // ── Admin — list users + suspend ───────────────────────────────────────────
  {
    id: 'admin_list_users',
    shouldFire: ctx => ctx.capabilities.has('admin') && ctx.capabilities.has('auth'),
    build: () => api({
      id: 'admin_list_users',
      method: 'GET',
      path: '/admin/users',
      name: 'Admin: list users',
      category: 'admin',
      purpose: 'Admin-only listing of platform users (paginated).',
      requiredAuth: true,
      requiredRole: 'admin',
      paginationRequired: true,
      rateLimitRequired: true,
      verificationScenarios: [
        'Non-admin GET /admin/users → 403.',
      ],
      implementationHint: 'adminAuth middleware. SELECT id, email, role, suspended_at, created_at FROM users ORDER BY created_at DESC LIMIT $limit; cursor for next page.',
    }),
  },
  {
    id: 'admin_suspend_user',
    shouldFire: ctx => ctx.capabilities.has('admin') && ctx.capabilities.has('auth'),
    build: () => api({
      id: 'admin_suspend_user',
      method: 'POST',
      path: '/admin/users/:id/suspend',
      name: 'Admin: suspend user',
      category: 'admin',
      purpose: 'Admin suspends a user, revoking their active refresh tokens.',
      workflowIds: ['admin_suspend_user'],
      businessRuleIds: ['admin_only_job_management', 'audit_admin_actions', 'refresh_token_single_use'],
      requiredAuth: true,
      requiredRole: 'admin',
      rateLimitRequired: true,
      transactionRequired: true,
      verificationScenarios: [
        'Non-admin POST /admin/users/:id/suspend → 403, no state change.',
        'Suspended user with a still-valid access token cannot make authenticated requests.',
        'audit_logs row written for every suspend.',
      ],
      implementationHint: 'BEGIN; UPDATE users SET suspended_at = NOW() WHERE id = $1; UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1; INSERT INTO audit_logs (admin_id, action="suspend_user", target_id=$1, before, after); COMMIT.',
    }),
  },

  // ── Composite — projects/:id/full ──────────────────────────────────────────
  {
    id: 'project_full',
    shouldFire: ctx =>
      ctx.entityNames.has('projects') ||
      /\bprojects?\b/i.test(ctx.prompt),
    build: ctx => {
      const includes = [
        'project',
        ctx.capabilities.has('storage') ? 'assets' : null,
        ctx.entityNames.has('prompts') ? 'prompts' : null,
        (ctx.capabilities.has('ai_jobs') || ctx.capabilities.has('video_generation_jobs') || ctx.capabilities.has('workflow_engine')) ? 'generation_jobs' : null,
        ctx.entityNames.has('outputs') ? 'outputs' : null,
      ].filter(Boolean) as string[]
      return api({
        id: 'project_full',
        method: 'GET',
        path: '/projects/:id/full',
        name: 'Get project (full nested view)',
        category: 'business',
        purpose: `Composite read endpoint returning ${includes.join(' + ')} for a project owned by the requester.`,
        businessRuleIds: ['project_owner_required_for_generation'].filter(id => ctx.ruleIds.has(id)),
        requiredAuth: true,
        rateLimitRequired: true,
        verificationScenarios: [
          'Non-owner GET /projects/:id/full → 403/404.',
          `Response shape includes ${includes.join(', ')}.`,
        ],
        implementationHint: `Verify project ownership; SELECT project + LEFT JOIN ${includes.filter(i => i !== 'project').join(' + ')} (or run parallel queries) and return a single nested JSON document. Cap nested rows per relation (e.g. last 100 jobs).`,
      })
    },
  },

  // ── Food delivery — orders ──────────────────────────────────────────────────
  {
    id: 'place_order',
    shouldFire: ctx => ctx.capabilities.has('order_management'),
    build: ctx => {
      const table = inferOrderTable(ctx)
      return api({
        id: 'place_order',
        method: 'POST',
        path: `/${table}/place`,
        name: 'Place order',
        category: 'business',
        purpose: 'Create an order, reserve inventory, and create a payment intent atomically.',
        workflowIds: ['place_order'].filter(id => ctx.workflowIds.has(id)),
        businessRuleIds: [
          'inventory_non_negative',
          'order_buyer_seller_admin_only_access',
          'valid_order_status_transition',
        ].filter(id => ctx.ruleIds.has(id)),
        stateMachineIds: ctx.machineById.has('sm_orders') ? ['sm_orders'] : [],
        requiredAuth: true,
        inputSchemaRequired: true,
        rateLimitRequired: true,
        transactionRequired: true,
        runtimeRequired: ['transactional_db', 'advisory_locks', 'event_bus'],
        integrationsRequired: [pickPaymentIntegration(ctx)],
        verificationScenarios: [
          'Two concurrent orders for the last item in stock → exactly one succeeds; final stock = 0.',
          'Buyer cannot read another buyer\'s order details (RLS verified).',
        ],
        implementationHint: `BEGIN; SELECT … FOR UPDATE on inventory rows for each line item; reject 409 if any quantity < requested; INSERT INTO ${table} (buyer_id, status='pending', total_cents, …); INSERT line_items; create ${pickPaymentIntegration(ctx)} payment intent; COMMIT.`,
      })
    },
  },
  {
    id: 'order_refund',
    shouldFire: ctx => ctx.capabilities.has('order_management') && ctx.capabilities.has('payments'),
    build: ctx => {
      const table = inferOrderTable(ctx)
      return api({
        id: 'order_refund',
        method: 'POST',
        path: `/${table}/:id/refund`,
        name: 'Refund order (admin)',
        category: 'admin',
        purpose: 'Admin refunds a delivered order; processes refund via payment provider and writes audit row.',
        workflowIds: ['place_order'].filter(id => ctx.workflowIds.has(id)),
        businessRuleIds: [
          'valid_order_status_transition',
          'audit_admin_actions',
          'payment_webhook_idempotency',
        ].filter(id => ctx.ruleIds.has(id)),
        stateMachineIds: ctx.machineById.has('sm_orders') ? ['sm_orders'] : [],
        requiredAuth: true,
        requiredRole: 'admin',
        rateLimitRequired: true,
        transactionRequired: true,
        runtimeRequired: ['transactional_db'],
        integrationsRequired: [pickPaymentIntegration(ctx)],
        verificationScenarios: [
          'Non-admin POST /orders/:id/refund → 403; no state change.',
          'Idempotent under retry: replaying the request does not double-refund.',
        ],
        implementationHint: `BEGIN; verify admin role server-side; call ${pickPaymentIntegration(ctx)} refund API with idempotency key = order_id+timestamp_bucket; UPDATE ${table} SET status='refunded'; INSERT INTO audit_logs (admin_id, action='refund_order', target_id, before, after); COMMIT.`,
      })
    },
  },

  // ── Hospital booking ───────────────────────────────────────────────────────
  {
    id: 'book_appointment',
    shouldFire: ctx => ctx.capabilities.has('booking') && isHospitalDomain(ctx),
    build: ctx => {
      const table = inferAppointmentTable(ctx)
      return api({
        id: 'book_appointment',
        method: 'POST',
        path: `/${table}/book`,
        name: 'Book appointment',
        category: 'business',
        purpose: 'Patient books an appointment with a doctor; advisory-lock guards prevent double-booking.',
        workflowIds: ['create_booking'].filter(id => ctx.workflowIds.has(id)),
        businessRuleIds: [
          'valid_booking_status_transition',
          'no_double_booking',
          'doctor_or_patient_only_appointment_access',
        ].filter(id => ctx.ruleIds.has(id)),
        stateMachineIds: ctx.machineById.has('sm_bookings') ? ['sm_bookings'] : [],
        requiredAuth: true,
        inputSchemaRequired: true,
        rateLimitRequired: true,
        transactionRequired: true,
        runtimeRequired: ['transactional_db', 'advisory_locks'],
        verificationScenarios: [
          'Two patients book the same slot concurrently → exactly one confirmed; the other gets 409.',
          'Patient B reads patient A\'s appointment → 403/404.',
        ],
        implementationHint: `BEGIN; pg_advisory_xact_lock(hash(doctor_id, slot_start)); SELECT 1 FROM ${table} WHERE doctor_id=$1 AND slot_start=$2 AND status IN ('requested','confirmed') FOR UPDATE; if found return 409. INSERT INTO ${table} (patient_id, doctor_id, slot_start, status='requested'); COMMIT.`,
      })
    },
  },

  // ── Learning platform — enroll + progress + dashboard ──────────────────────
  {
    id: 'enroll_in_course',
    shouldFire: ctx => isLearningDomain(ctx),
    build: ctx => api({
      id: 'enroll_in_course',
      method: 'POST',
      path: '/courses/:id/enroll',
      name: 'Enroll in course',
      category: 'business',
      purpose: 'Authenticated user enrolls in a course (or upgrades an existing enrollment).',
      workflowIds: [],
      businessRuleIds: ['enrolled_user_only_course_access'].filter(id => ctx.ruleIds.has(id)),
      stateMachineIds: ctx.machineById.has('sm_enrollments') ? ['sm_enrollments'] : [],
      requiredAuth: true,
      inputSchemaRequired: true,
      rateLimitRequired: true,
      transactionRequired: true,
      runtimeRequired: ['transactional_db'],
      verificationScenarios: [
        'Duplicate enroll for the same (user, course) → idempotent: returns existing enrollment row.',
        'Paid course enroll without successful payment → reject 402.',
      ],
      implementationHint: 'INSERT INTO enrollments (user_id, course_id, status=\'enrolled\') ON CONFLICT (user_id, course_id) DO UPDATE SET status=\'enrolled\'; for paid courses verify a successful payment row exists for this (user, course) before insert.',
    }),
  },
  {
    id: 'lesson_progress',
    shouldFire: ctx => isLearningDomain(ctx),
    build: ctx => api({
      id: 'lesson_progress',
      method: 'POST',
      path: '/lessons/:id/progress',
      name: 'Record lesson progress',
      category: 'business',
      purpose: 'Update progress for the authenticated user on a lesson they are enrolled in.',
      businessRuleIds: ['progress_belongs_to_enrolled_user', 'enrolled_user_only_course_access'].filter(id => ctx.ruleIds.has(id)),
      stateMachineIds: ctx.machineById.has('sm_enrollments') ? ['sm_enrollments'] : [],
      requiredAuth: true,
      inputSchemaRequired: true,
      rateLimitRequired: true,
      transactionRequired: true,
      runtimeRequired: ['transactional_db'],
      verificationScenarios: [
        'User B writes progress for user A → reject (RLS WITH CHECK).',
        'Write progress on an unenrolled course → reject.',
      ],
      implementationHint: 'RLS USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid() AND EXISTS (SELECT 1 FROM enrollments WHERE user_id = auth.uid() AND course_id = NEW.course_id AND status = \'active\')). UPSERT progress row by (user_id, lesson_id).',
    }),
  },
  {
    id: 'course_dashboard',
    shouldFire: ctx => isLearningDomain(ctx),
    build: () => api({
      id: 'course_dashboard',
      method: 'GET',
      path: '/courses/:id/dashboard',
      name: 'Get course dashboard',
      category: 'business',
      purpose: 'Return enrollment, progress %, completed lessons, next lesson, and certificates for the requester on a course.',
      businessRuleIds: ['enrolled_user_only_course_access', 'progress_belongs_to_enrolled_user'],
      requiredAuth: true,
      rateLimitRequired: true,
      verificationScenarios: [
        'Non-enrolled user GETs the dashboard → 403/empty.',
      ],
      implementationHint: 'Verify enrollment EXISTS for (auth.uid(), course_id); SELECT lessons + progress + certificates in parallel; return a single nested document.',
    }),
  },

  // ── CRM / support — tickets + customer admin ───────────────────────────────
  {
    id: 'admin_list_customers',
    shouldFire: ctx => isCrmDomain(ctx) && ctx.capabilities.has('admin'),
    build: () => api({
      id: 'admin_list_customers',
      method: 'GET',
      path: '/admin/customers',
      name: 'Admin: list customers',
      category: 'admin',
      purpose: 'Admin-only listing of customers (CRM).',
      requiredAuth: true,
      requiredRole: 'admin',
      paginationRequired: true,
      rateLimitRequired: true,
      verificationScenarios: [
        'Non-admin GET /admin/customers → 403.',
      ],
      implementationHint: 'adminAuth middleware. SELECT * FROM customers ORDER BY created_at DESC LIMIT $limit; cursor for next page.',
    }),
  },
  {
    id: 'list_tickets',
    shouldFire: ctx => isCrmDomain(ctx) || ctx.entityNames.has('tickets'),
    build: () => api({
      id: 'list_tickets',
      method: 'GET',
      path: '/tickets',
      name: 'List tickets',
      category: 'business',
      purpose: 'Role-scoped listing of tickets — agents see their queue, managers see their team\'s, admins see all.',
      businessRuleIds: ['crm_role_based_access'],
      requiredAuth: true,
      paginationRequired: true,
      rateLimitRequired: true,
      verificationScenarios: [
        'Agent A only sees tickets in their queue.',
        'Manager M sees tickets owned by M\'s reports.',
      ],
      implementationHint: 'RLS USING (assignee_id = auth.uid() OR EXISTS (SELECT 1 FROM users m WHERE m.id = assignee_id AND m.manager_id = auth.uid()) OR role(auth.uid()) = \'admin\').',
    }),
  },
  {
    id: 'assign_ticket',
    shouldFire: ctx => isCrmDomain(ctx) || ctx.entityNames.has('tickets'),
    build: () => api({
      id: 'assign_ticket',
      method: 'POST',
      path: '/tickets/:id/assign',
      name: 'Assign ticket to agent',
      category: 'business',
      purpose: 'Assign a ticket to an agent. Triggers state-machine transition open → in_progress.',
      businessRuleIds: ['crm_role_based_access', 'audit_admin_actions'],
      stateMachineIds: ['sm_tickets'],
      requiredAuth: true,
      requiredRole: 'admin',
      rateLimitRequired: true,
      transactionRequired: true,
      verificationScenarios: [
        'Non-agent POST /tickets/:id/assign → 403.',
        'Assigning a closed ticket → 409 (terminal state).',
      ],
      implementationHint: 'BEGIN; verify role (agent/admin); SELECT … FOR UPDATE on tickets row; reject 409 if status != \'open\'; UPDATE status=\'in_progress\', assignee_id, started_at; INSERT audit_logs row; COMMIT.',
    }),
  },
  {
    id: 'resolve_ticket',
    shouldFire: ctx => isCrmDomain(ctx) || ctx.entityNames.has('tickets'),
    build: () => api({
      id: 'resolve_ticket',
      method: 'POST',
      path: '/tickets/:id/resolve',
      name: 'Resolve ticket',
      category: 'business',
      purpose: 'Mark a ticket resolved. Requires assignee or admin; resolution notes mandatory.',
      businessRuleIds: ['crm_role_based_access', 'audit_admin_actions'],
      stateMachineIds: ['sm_tickets'],
      requiredAuth: true,
      requiredRole: 'admin',
      rateLimitRequired: true,
      transactionRequired: true,
      verificationScenarios: [
        'Resolve from an unreachable state (e.g. open) → 409.',
        'audit_logs row written.',
      ],
      implementationHint: 'BEGIN; SELECT … FOR UPDATE; reject 409 if status not in (\'in_progress\',\'reopened\'); UPDATE status=\'resolved\', resolution_notes, resolved_at; INSERT audit row; COMMIT.',
    }),
  },
  {
    id: 'reopen_ticket',
    shouldFire: ctx => isCrmDomain(ctx) || ctx.entityNames.has('tickets'),
    build: () => api({
      id: 'reopen_ticket',
      method: 'POST',
      path: '/tickets/:id/reopen',
      name: 'Reopen ticket',
      category: 'business',
      purpose: 'Original reporter (or admin) reopens a resolved ticket within the reopen window.',
      businessRuleIds: ['crm_role_based_access'],
      stateMachineIds: ['sm_tickets'],
      requiredAuth: true,
      rateLimitRequired: true,
      transactionRequired: true,
      verificationScenarios: [
        'Reopen from terminal status=closed → 409.',
        'Reopen by non-reporter / non-admin → 403.',
      ],
      implementationHint: 'BEGIN; SELECT … FOR UPDATE; reject if status=\'closed\' or outside reopen window; UPDATE status=\'reopened\', clear resolved_at; COMMIT.',
    }),
  },
]

// ─── State-machine endpoint expansion ────────────────────────────────────────
//
// For every plan in StateMachinesReport, emit one DomainApiPlan per
// requiredEndpoint, mirroring the path/method/role/businessRules. This is
// what lets the validator's missing_endpoint findings drop to 0 once Phase 6
// has run.

function expandStateMachineEndpoints(ctx: Ctx): Omit<DomainApiPlan, 'shadowMode'>[] {
  const out: Omit<DomainApiPlan, 'shadowMode'>[] = []
  for (const plan of ctx.machines) {
    for (const ep of plan.requiredEndpoints) {
      const idBase = `${plan.id}__${ep.method}__${ep.path}`
        .replace(/[^a-z0-9_]/gi, '_')
        .replace(/_+/g, '_')
        .toLowerCase()
      const isAdminPath = /\/admin\//.test(ep.path)
      const role: DomainApiRequiredRole | undefined =
        ep.requiredRole === 'admin' ? 'admin' :
        ep.requiredRole === 'system' ? 'system' :
        ep.requiredRole === 'user' ? 'user' :
        isAdminPath ? 'admin' :
        undefined
      const isMutating = ep.method !== 'GET'
      const integrations: string[] = []
      if (plan.domain === 'subscription' || plan.domain === 'order' || plan.domain === 'payment') {
        integrations.push(pickPaymentIntegration(ctx))
      }
      out.push(api({
        id: idBase,
        method: ep.method as DomainApiMethod,
        path: ep.path,
        name: `${plan.id} → ${ep.method} ${ep.path}`,
        category: isAdminPath ? 'admin' : (plan.domain === 'subscription' ? 'billing' : 'business'),
        purpose: ep.purpose,
        businessRuleIds: ep.businessRules.filter(id => ctx.ruleIds.has(id)),
        stateMachineIds: [plan.id],
        requiredAuth: ep.requiredAuth,
        requiredRole: role,
        inputSchemaRequired: isMutating,
        paginationRequired: false,
        rateLimitRequired: isMutating || isAdminPath,
        transactionRequired: isMutating,
        runtimeRequired: isMutating ? ['transactional_db', ...(plan.domain === 'async_job' ? ['advisory_locks'] : [])] : [],
        integrationsRequired: integrations,
        verificationScenarios: [
          ...(isAdminPath ? [`Non-admin ${ep.method} ${ep.path} → 403; no state change.`] : []),
          ...(isMutating ? [`Disallowed transition into the target state → 409 / rejection.`] : []),
        ],
        implementationHint: `${ep.purpose}. Funnel through fn_transition_${plan.tableName}(${plan.tableName === 'tickets' ? 'ticket_id' : 'id'}, to_status) so the state-machine guard is enforced atomically. Audit admin writes.`,
      }))
    }
  }
  return out
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function generateDomainApiPlan(input: DomainApiGeneratorInput): DomainApiPlanReport {
  const understanding = input.understanding
  const ctx: Ctx = {
    prompt: input.prompt,
    promptLower: (input.prompt || '').toLowerCase(),
    understanding,
    capabilities: new Set(understanding.criticalCapabilities),
    patterns: new Set(understanding.backendPatterns),
    primaryDomain: understanding.primaryDomain,
    workflows: input.workflows.workflows ?? [],
    workflowIds: new Set((input.workflows.workflows ?? []).map(w => w.id)),
    workflowsList: input.workflows.workflows ?? [],
    rules: input.rules.rules ?? [],
    ruleIds: new Set((input.rules.rules ?? []).map(r => r.id)),
    machines: input.machines.plans ?? [],
    machineById: new Map((input.machines.plans ?? []).map(p => [p.id, p])),
    entityNames: new Set((input.entityNames ?? []).map(n => n.toLowerCase())),
  }

  // Step 1: state-machine-derived endpoints (mirror what the planner emitted).
  const fromStateMachines = expandStateMachineEndpoints(ctx)

  // Step 2: template-driven domain endpoints.
  const fromTemplates: Omit<DomainApiPlan, 'shadowMode'>[] = []
  for (const tpl of TEMPLATES) {
    if (tpl.id === 'state_machine_endpoints') continue // handled above
    let fires = false
    try { fires = tpl.shouldFire(ctx) } catch { fires = false }
    if (!fires) continue
    let built: Omit<DomainApiPlan, 'shadowMode'> | null = null
    try { built = tpl.build(ctx) } catch { built = null }
    if (built) fromTemplates.push(built)
  }

  // Merge with method+path dedupe; templates win over state-machine mirror so
  // the richer hints survive.
  const byKey = new Map<string, Omit<DomainApiPlan, 'shadowMode'>>()
  for (const a of fromStateMachines) {
    const k = `${a.method} ${a.path}`
    if (!byKey.has(k)) byKey.set(k, a)
  }
  for (const a of fromTemplates) {
    const k = `${a.method} ${a.path}`
    // Merge: prefer the template, but fold in stateMachineIds + businessRules
    const prior = byKey.get(k)
    if (prior) {
      const merged: Omit<DomainApiPlan, 'shadowMode'> = {
        ...a,
        stateMachineIds: Array.from(new Set([...(prior.stateMachineIds ?? []), ...(a.stateMachineIds ?? [])])),
        businessRuleIds: Array.from(new Set([...(prior.businessRuleIds ?? []), ...(a.businessRuleIds ?? [])])),
        runtimeRequired: Array.from(new Set([...(prior.runtimeRequired ?? []), ...(a.runtimeRequired ?? [])])),
        integrationsRequired: Array.from(new Set([...(prior.integrationsRequired ?? []), ...(a.integrationsRequired ?? [])])),
      }
      byKey.set(k, merged)
    } else {
      byKey.set(k, a)
    }
  }

  const apis: DomainApiPlan[] = Array.from(byKey.values()).map(a => ({ ...a, shadowMode: true as const }))

  // Recommended-but-not-confident: surface missing_endpoint findings from
  // the optional Phase 5 validator that we did NOT cover here.
  const missingButRecommended: DomainApiPlan[] = []
  if (input.validation) {
    const knownPaths = new Set(apis.map(a => `${a.method} ${a.path}`))
    for (const f of input.validation.findings) {
      if (f.type !== 'missing_endpoint') continue
      const path = f.appliesTo?.endpointPaths?.[0]
      if (!path) continue
      const m = /^([A-Z]+)\s+(.+)$/.exec(path)
      if (!m) continue
      const method = m[1] as DomainApiMethod
      const route = m[2]
      const key = `${method} ${route}`
      if (knownPaths.has(key)) continue
      const isAdminPath = /\/admin\//.test(route)
      missingButRecommended.push({
        id: `recommended_${method.toLowerCase()}_${route.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`,
        method,
        path: route,
        name: `Recommended: ${method} ${route}`,
        category: isAdminPath ? 'admin' : 'business',
        purpose: f.message,
        workflowIds: [],
        businessRuleIds: [],
        stateMachineIds: f.appliesTo?.stateMachineIds ?? [],
        requiredAuth: true,
        requiredRole: isAdminPath ? 'admin' : undefined,
        inputSchemaRequired: method !== 'GET',
        paginationRequired: false,
        rateLimitRequired: method !== 'GET' || isAdminPath,
        runtimeRequired: method !== 'GET' ? ['transactional_db'] : [],
        integrationsRequired: [],
        verificationScenarios: [],
        implementationHint: f.recommendation,
        shadowMode: true,
      })
    }
  }

  // Aggregate confidence: scale by understanding confidence and how many
  // referenced rules / state machines actually exist.
  const baseScore = Math.max(0.35, Math.min(0.95, understanding.confidence.score))
  let coverageSum = 0
  let coverageDen = 0
  for (const a of apis) {
    const refs = (a.businessRuleIds.length + a.stateMachineIds.length)
    if (refs === 0) continue
    const present = a.businessRuleIds.filter(id => ctx.ruleIds.has(id)).length +
                    a.stateMachineIds.filter(id => ctx.machineById.has(id)).length
    coverageSum += present / refs
    coverageDen += 1
  }
  const coverage = coverageDen === 0 ? 0.7 : coverageSum / coverageDen
  const overallConfidence = apis.length === 0
    ? 0
    : Math.round(baseScore * (0.5 + 0.5 * coverage) * 100) / 100

  // Warnings
  const warnings: string[] = []
  if (apis.length === 0) {
    warnings.push('No domain APIs could be generated. Ensure the upstream phases produced workflows / rules / state machines for this product.')
  }
  if (understanding.confidence.band === 'low') {
    warnings.push('Underlying ProductUnderstanding confidence is low — generated APIs are best-effort. Surface a clarification request to the user before relying on them.')
  }
  // Cross-check: every state-machine endpoint should appear in the planned set
  for (const plan of ctx.machines) {
    for (const ep of plan.requiredEndpoints) {
      const k = `${ep.method} ${ep.path}`
      if (!apis.some(a => `${a.method} ${a.path}` === k)) {
        warnings.push(`State-machine endpoint ${k} (from "${plan.id}") was not produced by the generator — Phase 5 will still flag it as missing.`)
      }
    }
  }

  return {
    apis,
    missingButRecommended,
    overallConfidence,
    warnings,
    shadowMode: true,
  }
}

// ─── Convenience: extract the planned endpoint paths for the validator ──────
//
// Matches the format the Phase 5 validator expects in
// `plannedEndpointPaths` so we can re-run validation against the Phase 6
// output and confirm missing_endpoint findings drop.

export function plannedEndpointPathsFromReport(report: DomainApiPlanReport): string[] {
  return report.apis.map(a => `${a.method} ${a.path}`)
}

// Re-export types for convenience
export type {
  DomainApiPlan,
  DomainApiPlanReport,
  DomainApiCategory,
  DomainApiMethod,
  DomainApiRequiredRole,
}
