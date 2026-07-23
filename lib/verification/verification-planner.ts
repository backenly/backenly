/**
 * VERIFICATION PLANNER — Phase 7 (shadow mode)
 * ============================================
 * Reads the full Phase 1–6 output set (ProductUnderstanding, WorkflowsReport,
 * BusinessRulesReport, StateMachinesReport, PlanValidationReport,
 * DomainApiPlanReport) and emits a structured BehaviorVerificationReport
 * describing the *verification scenarios* this product needs.
 *
 * A scenario is the smallest unit Backenly can later run to *prove* that the
 * backend behaves correctly under the contracts the upstream phases described.
 *
 * STRICT SHADOW MODE in Phase 7:
 *   • No live execution against the workspace DB.
 *   • No production routes are mounted.
 *   • No schema changes occur.
 *   • All scenarios produced here carry `shadowMode: true`.
 *
 * Phase 8 will eventually run these scenarios against a sandbox.
 *
 * Strictly deterministic — no LLM, no DB, no network.
 */

import type { ProductUnderstanding, CriticalCapability } from '../../lib/ai/understanding/types'
import type {
  WorkflowsReport,
  BusinessRulesReport,
  StateMachinesReport,
  PlanValidationReport,
  DomainApiPlanReport,
  BehaviorVerificationReport,
  VerificationScenario,
  VerificationStep,
  VerificationCategory,
  VerificationSeverity,
  VerificationStepAction,
  VerificationReadinessImpact,
} from '../../lib/ai/planning/types'

// ─── Inputs ───────────────────────────────────────────────────────────────────

export interface VerificationPlannerInput {
  prompt: string
  understanding: ProductUnderstanding
  workflows: WorkflowsReport
  rules: BusinessRulesReport
  machines: StateMachinesReport
  /** Optional — Phase 5 output, used to detect runtime / integration gaps */
  validation?: PlanValidationReport
  /** Optional — Phase 6 output, used to thread API ids onto scenarios */
  apis?: DomainApiPlanReport
  /** Optional — IntentGraph entity names */
  entityNames?: string[]
  /** Optional — IntegrationIds the project has stored credentials for */
  availableIntegrations?: string[]
  /** Optional — Runtime modules the project has provisioned (queue, worker, …) */
  availableRuntime?: string[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface Ctx {
  prompt: string
  promptLower: string
  understanding: ProductUnderstanding
  capabilities: Set<CriticalCapability>
  patterns: Set<string>
  primaryDomain: string
  workflows: WorkflowsReport['workflows']
  workflowIds: Set<string>
  rules: BusinessRulesReport['rules']
  ruleIds: Set<string>
  machines: StateMachinesReport['plans']
  machineIds: Set<string>
  apis: DomainApiPlanReport['apis']
  apiByPath: Map<string, DomainApiPlanReport['apis'][number]>
  entityNames: Set<string>
  availableIntegrations: Set<string>
  availableRuntime: Set<string>
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

function step(
  id: string,
  action: VerificationStepAction,
  target: string,
  expected: string,
  input?: Record<string, unknown>,
): VerificationStep {
  return input === undefined
    ? { id, action, target, expected }
    : { id, action, target, input, expected }
}

// ─── Templates ────────────────────────────────────────────────────────────────
//
// Each template is a small builder that, given the full Ctx, decides whether
// it fires and (if so) returns one or more scenarios. Keeping each scenario
// compact keeps the report readable in the dashboard.

interface ScenarioTemplate {
  id: string
  shouldFire: (ctx: Ctx) => boolean
  build: (ctx: Ctx) => Omit<VerificationScenario, 'shadowMode' | 'canRunNow' | 'blockedBy'>
}

const TEMPLATES: ScenarioTemplate[] = [
  // ── AUTH ────────────────────────────────────────────────────────────────────
  {
    id: 'signup_login_works',
    shouldFire: ctx => ctx.capabilities.has('auth'),
    build: () => ({
      id: 'signup_login_works',
      name: 'Sign-up + sign-in produce a usable session',
      category: 'auth',
      severity: 'critical',
      workflowIds: ['user_signup_login'],
      businessRuleIds: ['password_storage_bcrypt', 'unique_user_email'],
      apiIds: ['POST_/auth/signup', 'POST_/auth/login'],
      stateMachineIds: [],
      preconditions: ['users table exists', 'JWT signing key configured'],
      steps: [
        step('signup', 'create_user', '/auth/signup',
          '201 + user row with bcrypt/argon hash; no plaintext stored',
          { email: 'a@example.com', password: 'P@ssw0rd!1' }),
        step('login', 'login', '/auth/login',
          '200 with access + refresh tokens',
          { email: 'a@example.com', password: 'P@ssw0rd!1' }),
        step('verify_hash', 'check_db_effect', 'users.password_hash',
          'starts with $2b$ or $argon2id; never equals submitted password'),
      ],
      expectedResult: 'Signup creates a single user row; login returns a JWT; password is hashed.',
      failureMeaning: 'Users cannot sign in OR passwords are stored in a recoverable form.',
      implementationHint: 'POST /auth/signup → bcrypt cost ≥12; POST /auth/login → returns access+refresh tokens; assert SELECT password_hash FROM users WHERE email=… starts with $2b$ or $argon2.',
    }),
  },
  {
    id: 'reset_password_available',
    shouldFire: ctx => ctx.capabilities.has('auth'),
    build: () => ({
      id: 'reset_password_available',
      name: 'Password reset flow is available end-to-end',
      category: 'auth',
      severity: 'high',
      workflowIds: ['user_signup_login'],
      businessRuleIds: ['password_storage_bcrypt'],
      apiIds: ['POST_/auth/reset-request', 'POST_/auth/reset-confirm'],
      stateMachineIds: [],
      preconditions: ['user exists', 'email transport configured'],
      steps: [
        step('request', 'call_api', '/auth/reset-request',
          '200 + reset_token row written',
          { email: 'a@example.com' }),
        step('email_sent', 'check_notification', 'email:reset_password',
          'exactly one email enqueued for the user'),
        step('confirm', 'call_api', '/auth/reset-confirm',
          '200 + password_hash updated; old hash differs',
          { token: '<from_email>', newPassword: 'NewP@ss!9' }),
      ],
      expectedResult: 'Reset link is one-shot, time-bound, and changes the stored hash.',
      failureMeaning: 'Account recovery is impossible OR a stolen reset link can be reused.',
      implementationHint: 'reset_tokens (token, user_id, expires_at, used_at). Single-use enforced by used_at IS NULL check on consume.',
    }),
  },
  {
    id: 'refresh_token_available',
    shouldFire: ctx => ctx.capabilities.has('auth'),
    build: () => ({
      id: 'refresh_token_available',
      name: 'Refresh token rotates and revokes the old token',
      category: 'auth',
      severity: 'high',
      workflowIds: ['user_signup_login'],
      businessRuleIds: ['refresh_token_single_use'],
      apiIds: ['POST_/auth/refresh'],
      stateMachineIds: [],
      preconditions: ['user is logged in with a refresh token'],
      steps: [
        step('refresh1', 'call_api', '/auth/refresh',
          '200 with new access+refresh tokens',
          { refreshToken: '<old>' }),
        step('replay', 'call_api', '/auth/refresh',
          '401 — old token is now used_at!=null',
          { refreshToken: '<old>' }),
        step('audit', 'check_db_effect', 'refresh_tokens.used_at',
          'old token row has used_at set; new row has used_at IS NULL'),
      ],
      expectedResult: 'Each refresh issues a new token AND invalidates the old one.',
      failureMeaning: 'A stolen refresh token can be replayed indefinitely.',
      implementationHint: 'Mark refresh_tokens.used_at on rotate; reject replays; on replay revoke ALL active tokens for the user.',
    }),
  },

  // ── RLS / OWNERSHIP ─────────────────────────────────────────────────────────
  {
    id: 'user_b_cannot_read_user_a_assets',
    shouldFire: ctx => ctx.capabilities.has('storage') && ctx.capabilities.has('auth'),
    build: ctx => ({
      id: 'user_b_cannot_read_user_a_assets',
      name: 'User B cannot read User A\'s private asset',
      category: 'rls',
      severity: 'critical',
      workflowIds: ['asset_upload'],
      businessRuleIds: ['private_asset_owner_access'],
      apiIds: [`GET_/${inferAssetTable(ctx)}/:id`],
      stateMachineIds: [],
      preconditions: ['RLS enabled on asset table', 'two users exist'],
      steps: [
        step('user_a_upload', 'create_record', inferAssetTable(ctx),
          'asset row created with owner_id=A and visibility=private',
          { ownerId: 'A', visibility: 'private' }),
        step('user_b_read', 'attempt_forbidden_access', `/${inferAssetTable(ctx)}/:id`,
          '403 / 404 — no information leak; storage URL also denied',
          { actor: 'B' }),
      ],
      expectedResult: 'User B receives 403/404; storage object key denies the download.',
      failureMeaning: 'Tenant isolation is broken — any user can download any private asset.',
      implementationHint: 'RLS USING (visibility=public OR owner_id=auth.uid()). Storage object keys must include owner_id prefix.',
    }),
  },
  {
    id: 'user_cannot_submit_job_for_other_project',
    shouldFire: ctx =>
      ctx.workflowIds.has('submit_generation_job') && ctx.capabilities.has('auth'),
    build: ctx => ({
      id: 'user_cannot_submit_job_for_other_project',
      name: 'User cannot submit a job for another user\'s project',
      category: 'rls',
      severity: 'critical',
      workflowIds: ['submit_generation_job'],
      businessRuleIds: ['project_owner_required_for_generation'],
      apiIds: [`POST_/${inferJobTable(ctx)}`],
      stateMachineIds: ['sm_generation_jobs'],
      preconditions: ['ownership middleware mounted on POST /jobs'],
      steps: [
        step('user_a_project', 'create_record', 'projects',
          'project row owner_id=A',
          { ownerId: 'A' }),
        step('user_b_submit', 'attempt_forbidden_access', `/${inferJobTable(ctx)}`,
          '403/404 — no row inserted into job table',
          { actor: 'B', projectId: '<A_project>' }),
        step('verify_no_row', 'check_db_effect', `${inferJobTable(ctx)}.count`,
          'row count for B\'s submission is 0'),
      ],
      expectedResult: 'Foreign-project submissions are rejected and leave no trace.',
      failureMeaning: 'A user can spend another user\'s credits / pollute another user\'s job queue.',
      implementationHint: 'Check project.owner_id = JWT.userId in middleware AND back it with RLS on the job table.',
    }),
  },
  {
    id: 'private_asset_requires_signed_url',
    shouldFire: ctx => ctx.capabilities.has('storage'),
    build: ctx => ({
      id: 'private_asset_requires_signed_url',
      name: 'Private asset download requires a short-lived signed URL',
      category: 'storage',
      severity: 'high',
      workflowIds: ['asset_upload'],
      businessRuleIds: ['private_asset_owner_access'],
      apiIds: [`GET_/${inferAssetTable(ctx)}/:id/download`],
      stateMachineIds: [],
      preconditions: ['signed-URL provider wired', 'asset uploaded'],
      steps: [
        step('public_attempt', 'attempt_forbidden_access', `/${inferAssetTable(ctx)}/raw/:id`,
          '403/404 from object store on the unsigned URL'),
        step('issue_signed', 'call_api', `/${inferAssetTable(ctx)}/:id/download`,
          '200 with a signed URL whose expiry ≤ 15 min',
          { actor: 'owner' }),
        step('signed_works', 'call_api', '<signed_url>',
          '200 with the file content (one-time within TTL)'),
      ],
      expectedResult: 'Asset is unreachable without a current signed URL belonging to the owner.',
      failureMeaning: 'Anyone who guesses an object key can fetch private user data.',
      implementationHint: 'Generate signed URLs with expires=15min and bound to caller user_id; reject direct path access.',
    }),
  },

  // ── CREDITS ─────────────────────────────────────────────────────────────────
  {
    id: 'zero_credit_user_cannot_submit_generation_job',
    shouldFire: ctx =>
      ctx.capabilities.has('credits') &&
      ctx.workflowIds.has('submit_generation_job'),
    build: ctx => ({
      id: 'zero_credit_user_cannot_submit_generation_job',
      name: 'User with zero credits cannot submit a generation job',
      category: 'billing',
      severity: 'critical',
      workflowIds: ['submit_generation_job'],
      businessRuleIds: ['credits_non_negative', 'reserve_credits_before_generation'],
      apiIds: [`POST_/${inferJobTable(ctx)}`],
      stateMachineIds: ['sm_generation_jobs'],
      preconditions: ['user exists with credit_wallets.balance=0'],
      steps: [
        step('submit', 'attempt_forbidden_access', `/${inferJobTable(ctx)}`,
          '402 Payment Required — no row inserted',
          { actor: 'user', cost: 1 }),
        step('verify_no_row', 'check_db_effect', `${inferJobTable(ctx)}.count`,
          'row count for this user is 0'),
        step('verify_wallet', 'check_db_effect', 'credit_wallets.balance',
          'balance still 0; reserved still 0'),
      ],
      expectedResult: 'Submission is rejected with 402; database is untouched.',
      failureMeaning: 'Users can spend credits they don\'t have — direct revenue loss.',
      implementationHint: 'Reservation check inside the same txn as the INSERT; rollback on insufficient balance.',
    }),
  },
  {
    id: 'credits_reserved_before_job_creation',
    shouldFire: ctx =>
      ctx.capabilities.has('credits') &&
      ctx.workflowIds.has('submit_generation_job'),
    build: ctx => ({
      id: 'credits_reserved_before_job_creation',
      name: 'Credits are reserved in the same txn as job insert',
      category: 'billing',
      severity: 'critical',
      workflowIds: ['submit_generation_job'],
      businessRuleIds: ['reserve_credits_before_generation'],
      apiIds: [`POST_/${inferJobTable(ctx)}`],
      stateMachineIds: ['sm_generation_jobs'],
      preconditions: ['user has balance=10, reserved=0'],
      steps: [
        step('submit', 'call_api', `/${inferJobTable(ctx)}`,
          '201 + job row inserted',
          { actor: 'user', cost: 6 }),
        step('verify_reservation', 'check_db_effect', 'credit_wallets',
          'balance=10, reserved=6 immediately after insert'),
        step('verify_job', 'check_db_effect', `${inferJobTable(ctx)}`,
          'job row has reserved_credits=6 and status=queued'),
      ],
      expectedResult: 'Reservation appears at the same instant as the job row.',
      failureMeaning: 'A crash between insert and reserve leaves credits unaccounted for.',
      implementationHint: 'BEGIN; SELECT … FOR UPDATE wallet; UPDATE wallet reserved+=cost; INSERT job; COMMIT.',
    }),
  },
  {
    id: 'failed_job_refunds_reserved_credits',
    shouldFire: ctx =>
      ctx.capabilities.has('credits') &&
      (ctx.workflowIds.has('process_generation_job') || ctx.workflowIds.has('cancel_or_retry_job')),
    build: ctx => ({
      id: 'failed_job_refunds_reserved_credits',
      name: 'A failed job releases its reserved credits',
      category: 'billing',
      severity: 'critical',
      workflowIds: ['process_generation_job', 'cancel_or_retry_job'],
      businessRuleIds: ['refund_reserved_credits_on_failure'],
      apiIds: [],
      stateMachineIds: ['sm_generation_jobs'],
      preconditions: ['user balance=10, reserved=3 from a queued job', 'worker can be made to fail'],
      steps: [
        step('force_failure', 'run_state_transition', `${inferJobTable(ctx)}.queued->failed`,
          'job.status=failed; reserved=0; balance=10',
          { trigger: 'provider_error' }),
        step('verify_wallet', 'check_db_effect', 'credit_wallets',
          'balance=10, reserved=0 (refunded, not deducted)'),
        step('verify_event', 'check_event_emitted', 'job.failed',
          'exactly one job.failed event'),
      ],
      expectedResult: 'Failure refunds the reservation; balance is unchanged.',
      failureMeaning: 'Users are charged for jobs that did not succeed — chargeback risk.',
      implementationHint: 'In the worker\'s failure branch, UPDATE wallet SET reserved=reserved-reserved_credits in the same txn as the status flip.',
    }),
  },
  {
    id: 'concurrent_credit_deduction_no_double_spend',
    shouldFire: ctx => ctx.capabilities.has('credits'),
    build: ctx => ({
      id: 'concurrent_credit_deduction_no_double_spend',
      name: 'Concurrent submissions cannot double-spend the wallet',
      category: 'billing',
      severity: 'critical',
      workflowIds: ['submit_generation_job'],
      businessRuleIds: ['credits_non_negative', 'reserve_credits_before_generation'],
      apiIds: [`POST_/${inferJobTable(ctx)}`],
      stateMachineIds: ['sm_generation_jobs'],
      preconditions: ['user balance=10, reserved=0', 'submit endpoint exists'],
      steps: [
        step('concurrent_two', 'call_api', `/${inferJobTable(ctx)}`,
          'exactly one 201, exactly one 402 (the loser)',
          { actor: 'user', cost: 6, parallel: 2 }),
        step('verify_balance', 'check_db_effect', 'credit_wallets',
          'balance=10, reserved <= 10 (one reservation accepted, one rejected)'),
        step('verify_jobs', 'check_db_effect', `${inferJobTable(ctx)}.count`,
          'row count = 1'),
      ],
      expectedResult: 'At most one of the two requests succeeds; wallet never goes negative.',
      failureMeaning: 'Race conditions let users overspend the wallet; revenue loss + audit risk.',
      implementationHint: 'SELECT … FOR UPDATE on the wallet OR pg_advisory_xact_lock(user_id) before the reservation.',
    }),
  },

  // ── STRIPE / PAYMENT WEBHOOKS ───────────────────────────────────────────────
  {
    id: 'stripe_webhook_signature_required',
    shouldFire: ctx =>
      ctx.capabilities.has('payments') && ctx.capabilities.has('webhooks'),
    build: () => ({
      id: 'stripe_webhook_signature_required',
      name: 'Payment webhook requires a valid signature',
      category: 'webhook',
      severity: 'critical',
      workflowIds: ['purchase_credits', 'subscribe_plan', 'place_order'],
      businessRuleIds: ['payment_webhook_idempotency'],
      apiIds: ['POST_/webhooks/payments'],
      stateMachineIds: [],
      preconditions: ['webhook signing secret configured'],
      steps: [
        step('unsigned', 'attempt_forbidden_access', '/webhooks/payments',
          '400/401 — no side effects',
          { signature: 'invalid' }),
        step('verify_no_log', 'check_db_effect', 'webhook_log.count',
          'no row appended for the unsigned attempt'),
      ],
      expectedResult: 'Unsigned webhooks are rejected before any side effect runs.',
      failureMeaning: 'Anyone can forge payment events and grant themselves credits / plans.',
      implementationHint: 'Verify Stripe-Signature using STRIPE_WEBHOOK_SECRET *before* any DB read.',
    }),
  },
  {
    id: 'stripe_webhook_idempotency_prevents_double_credit',
    shouldFire: ctx =>
      ctx.capabilities.has('payments') && ctx.capabilities.has('webhooks'),
    build: () => ({
      id: 'stripe_webhook_idempotency_prevents_double_credit',
      name: 'Replayed payment webhook does not double-grant',
      category: 'webhook',
      severity: 'critical',
      workflowIds: ['purchase_credits', 'subscribe_plan', 'place_order'],
      businessRuleIds: ['payment_webhook_idempotency'],
      apiIds: ['POST_/webhooks/payments'],
      stateMachineIds: [],
      preconditions: ['webhook_log table with UNIQUE(event_id)'],
      steps: [
        step('first', 'simulate_webhook', 'payment_intent.succeeded',
          '200 + side effect applied once',
          { eventId: 'evt_1', signature: 'valid' }),
        step('replay', 'simulate_webhook', 'payment_intent.succeeded',
          '200 no-op (already processed)',
          { eventId: 'evt_1', signature: 'valid' }),
        step('verify_log', 'check_db_effect', 'webhook_log',
          'exactly one row for evt_1'),
        step('verify_credit', 'check_db_effect', 'credit_wallets.balance',
          'balance reflects exactly one grant'),
      ],
      expectedResult: 'The second delivery is a no-op; credits granted exactly once.',
      failureMeaning: 'Stripe retries (which happen normally) silently double-credit accounts.',
      implementationHint: 'INSERT INTO webhook_log (event_id, …) ON CONFLICT (event_id) DO NOTHING; if 0 rows then return 200 no-op.',
    }),
  },
  {
    id: 'payment_success_adds_credits',
    shouldFire: ctx =>
      ctx.capabilities.has('payments') && ctx.capabilities.has('credits'),
    build: () => ({
      id: 'payment_success_adds_credits',
      name: 'Successful payment grants the right number of credits',
      category: 'billing',
      severity: 'critical',
      workflowIds: ['purchase_credits'],
      businessRuleIds: ['payment_webhook_idempotency'],
      apiIds: ['POST_/webhooks/payments'],
      stateMachineIds: [],
      preconditions: ['plan price → credit ratio configured'],
      steps: [
        step('purchase', 'simulate_webhook', 'payment_intent.succeeded',
          '200 + balance increases by the plan\'s credit grant',
          { eventId: 'evt_pay_1', amount: 1000, planId: 'plan_pro' }),
        step('verify_balance', 'check_db_effect', 'credit_wallets.balance',
          'balance += planCredits exactly once'),
      ],
      expectedResult: 'Credits land in the wallet within seconds of the webhook.',
      failureMeaning: 'Users pay but never receive credits — refunds + churn.',
      implementationHint: 'Inside the idempotent webhook txn, UPDATE credit_wallets SET balance = balance + grant.',
    }),
  },

  // ── STATE MACHINE ───────────────────────────────────────────────────────────
  {
    id: 'generation_job_invalid_transition_rejected',
    shouldFire: ctx => ctx.machines.some(m => m.id === 'sm_generation_jobs'),
    build: ctx => ({
      id: 'generation_job_invalid_transition_rejected',
      name: 'Invalid status transition on a job is rejected',
      category: 'state_machine',
      severity: 'high',
      workflowIds: [],
      businessRuleIds: ['valid_generation_job_status_transition'],
      apiIds: [],
      stateMachineIds: ['sm_generation_jobs'],
      preconditions: ['job exists with status=completed'],
      steps: [
        step('try_invalid', 'run_state_transition', `${inferJobTable(ctx)}.completed->running`,
          '409 / DB rejection — status remains completed'),
        step('verify_db', 'check_db_effect', `${inferJobTable(ctx)}.status`,
          'status still completed'),
      ],
      expectedResult: 'Disallowed transitions are rejected at the DB layer.',
      failureMeaning: 'Workers can resurrect completed jobs and double-charge users.',
      implementationHint: 'BEFORE UPDATE trigger on the job table that raises EXCEPTION on disallowed transitions.',
    }),
  },
  {
    id: 'cancel_completed_job_rejected',
    shouldFire: ctx => ctx.machines.some(m => m.id === 'sm_generation_jobs'),
    build: ctx => ({
      id: 'cancel_completed_job_rejected',
      name: 'Cancelling a completed job returns 409',
      category: 'state_machine',
      severity: 'medium',
      workflowIds: ['cancel_or_retry_job'],
      businessRuleIds: ['valid_generation_job_status_transition'],
      apiIds: [`POST_/${inferJobTable(ctx)}/:id/cancel`],
      stateMachineIds: ['sm_generation_jobs'],
      preconditions: ['job in status=completed'],
      steps: [
        step('attempt_cancel', 'attempt_forbidden_access', `/${inferJobTable(ctx)}/:id/cancel`,
          '409 — terminal state cannot transition'),
      ],
      expectedResult: 'Endpoint refuses to cancel terminal-state jobs.',
      failureMeaning: 'Users can flip terminal jobs to cancelled and trigger refund flows.',
      implementationHint: 'Check status before transition; return 409 with code=invalid_transition.',
    }),
  },
  {
    id: 'retry_failed_job_allowed',
    shouldFire: ctx => ctx.machines.some(m => m.id === 'sm_generation_jobs'),
    build: ctx => ({
      id: 'retry_failed_job_allowed',
      name: 'Retrying a failed job re-queues with attempts++',
      category: 'state_machine',
      severity: 'medium',
      workflowIds: ['cancel_or_retry_job'],
      businessRuleIds: ['valid_generation_job_status_transition'],
      apiIds: [`POST_/${inferJobTable(ctx)}/:id/retry`],
      stateMachineIds: ['sm_generation_jobs'],
      preconditions: ['job in status=failed; attempts < max_attempts'],
      steps: [
        step('retry', 'call_api', `/${inferJobTable(ctx)}/:id/retry`,
          '202 + status flips to queued and attempts++',
          { actor: 'owner' }),
        step('verify', 'check_db_effect', `${inferJobTable(ctx)}`,
          'status=queued; attempts incremented'),
      ],
      expectedResult: 'Retry is the only allowed escape from failed.',
      failureMeaning: 'Users cannot recover from transient provider errors.',
      implementationHint: 'POST /:id/retry → fn_transition_job(id, queued); check attempts<max.',
    }),
  },

  // ── ADMIN ───────────────────────────────────────────────────────────────────
  {
    id: 'non_admin_cannot_access_admin_jobs',
    shouldFire: ctx =>
      ctx.capabilities.has('admin') &&
      (ctx.capabilities.has('ai_jobs') || ctx.capabilities.has('video_generation_jobs') || ctx.capabilities.has('workflow_engine')),
    build: ctx => ({
      id: 'non_admin_cannot_access_admin_jobs',
      name: 'Non-admin cannot reach admin job endpoints',
      category: 'admin',
      severity: 'critical',
      workflowIds: ['admin_manage_jobs'],
      businessRuleIds: ['admin_only_job_management'],
      apiIds: [`POST_/admin/${inferJobTable(ctx)}/:id/force-cancel`],
      stateMachineIds: ['sm_generation_jobs'],
      preconditions: ['end_user with role=user exists'],
      steps: [
        step('forge_attempt', 'attempt_forbidden_access', `/admin/${inferJobTable(ctx)}/:id/force-cancel`,
          '403 — even with a forged JWT claim role=admin',
          { actor: 'user', forgedClaim: { role: 'admin' } }),
        step('verify_no_change', 'check_db_effect', `${inferJobTable(ctx)}`,
          'job state unchanged'),
      ],
      expectedResult: 'Server re-reads role from DB and rejects forged JWT claims.',
      failureMeaning: 'Anyone can force-cancel any user\'s job — fundamental admin escape.',
      implementationHint: 'adminAuth middleware: SELECT role FROM users WHERE id=$1 — never trust JWT claim alone.',
    }),
  },
  {
    id: 'admin_force_cancel_writes_audit_log',
    shouldFire: ctx =>
      ctx.capabilities.has('admin') && ctx.capabilities.has('audit_logs'),
    build: ctx => ({
      id: 'admin_force_cancel_writes_audit_log',
      name: 'Admin force-cancel produces exactly one audit_log row',
      category: 'admin',
      severity: 'high',
      workflowIds: ['admin_manage_jobs'],
      businessRuleIds: ['audit_admin_actions'],
      apiIds: [`POST_/admin/${inferJobTable(ctx)}/:id/force-cancel`],
      stateMachineIds: ['sm_generation_jobs'],
      preconditions: ['admin user exists', 'job exists in non-terminal state'],
      steps: [
        step('force_cancel', 'call_api', `/admin/${inferJobTable(ctx)}/:id/force-cancel`,
          '200 + job cancelled',
          { actor: 'admin' }),
        step('audit_row', 'check_db_effect', 'audit_logs',
          'exactly one row with action="force_cancel_job", admin_id, target_id'),
      ],
      expectedResult: 'Audit row is appended in the same txn as the side effect.',
      failureMeaning: 'Admin actions are untraceable — compliance + insider-threat risk.',
      implementationHint: 'BEGIN; UPDATE job …; INSERT INTO audit_logs (…); COMMIT.',
    }),
  },

  // ── STORAGE ─────────────────────────────────────────────────────────────────
  {
    id: 'signed_upload_requires_auth',
    shouldFire: ctx => ctx.capabilities.has('storage'),
    build: () => ({
      id: 'signed_upload_requires_auth',
      name: 'Signed upload URL endpoint requires authentication',
      category: 'storage',
      severity: 'critical',
      workflowIds: ['asset_upload'],
      businessRuleIds: ['validate_signed_upload_metadata'],
      apiIds: ['POST_/assets/sign'],
      stateMachineIds: [],
      preconditions: ['signed-URL endpoint mounted'],
      steps: [
        step('anon', 'attempt_forbidden_access', '/assets/sign',
          '401 — no token'),
        step('bad_path', 'attempt_forbidden_access', '/assets/sign',
          '400 — path not in user\'s prefix',
          { actor: 'user', path: '../other-user/x.png' }),
        step('bad_mime', 'attempt_forbidden_access', '/assets/sign',
          '400 — MIME not in allow-list',
          { actor: 'user', contentType: 'application/x-msdownload' }),
      ],
      expectedResult: 'Signed URLs are only issued to authenticated users for owned paths and allow-listed MIMEs.',
      failureMeaning: 'Unauthenticated uploads OR path-traversal into other tenants.',
      implementationHint: 'Zod schema on /assets/sign: { path matches `${userId}/*`, contentType ∈ allow-list, sizeBytes ≤ max }.',
    }),
  },
  {
    id: 'asset_download_requires_owner_or_signed_url',
    shouldFire: ctx => ctx.capabilities.has('storage'),
    build: ctx => ({
      id: 'asset_download_requires_owner_or_signed_url',
      name: 'Asset download requires owner JWT or a signed URL',
      category: 'storage',
      severity: 'high',
      workflowIds: ['asset_upload'],
      businessRuleIds: ['private_asset_owner_access'],
      apiIds: [`GET_/${inferAssetTable(ctx)}/:id/download`],
      stateMachineIds: [],
      preconditions: ['private asset exists'],
      steps: [
        step('anon', 'attempt_forbidden_access', `/${inferAssetTable(ctx)}/:id/download`,
          '401/403 — no token'),
        step('owner', 'call_api', `/${inferAssetTable(ctx)}/:id/download`,
          '200 with signed URL',
          { actor: 'owner' }),
      ],
      expectedResult: 'Owner gets a signed URL; everyone else is rejected.',
      failureMeaning: 'Asset URLs leak via direct enumeration.',
      implementationHint: 'Wrap the download endpoint with auth middleware AND check owner_id = JWT.userId.',
    }),
  },

  // ── RUNTIME (workers / queues) ──────────────────────────────────────────────
  {
    id: 'queued_job_is_claimed_by_worker',
    shouldFire: ctx => ctx.machines.some(m => m.id === 'sm_generation_jobs'),
    build: ctx => ({
      id: 'queued_job_is_claimed_by_worker',
      name: 'A queued job is claimed by exactly one worker',
      category: 'runtime',
      severity: 'high',
      workflowIds: ['process_generation_job'],
      businessRuleIds: ['valid_generation_job_status_transition'],
      apiIds: [],
      stateMachineIds: ['sm_generation_jobs'],
      preconditions: ['queue + worker provisioned'],
      steps: [
        step('insert_queued', 'create_record', inferJobTable(ctx),
          'job inserted with status=queued',
          { status: 'queued' }),
        step('two_workers', 'run_state_transition', `${inferJobTable(ctx)}.queued->running`,
          'exactly one worker flips to running; the other observes 0 rows',
          { workers: 2 }),
        step('verify', 'check_db_effect', `${inferJobTable(ctx)}.worker_id`,
          'a single non-null worker_id is recorded'),
      ],
      expectedResult: 'SELECT … FOR UPDATE SKIP LOCKED gives exactly one claim.',
      failureMeaning: 'Two workers run the same job — duplicate provider charges.',
      implementationHint: 'SELECT id FROM jobs WHERE status=queued FOR UPDATE SKIP LOCKED LIMIT 1.',
    }),
  },
  {
    id: 'stuck_running_job_times_out',
    shouldFire: ctx => ctx.machines.some(m => m.id === 'sm_generation_jobs'),
    build: ctx => ({
      id: 'stuck_running_job_times_out',
      name: 'A running job past job_timeout_minutes flips to failed',
      category: 'runtime',
      severity: 'high',
      workflowIds: ['process_generation_job'],
      businessRuleIds: ['valid_generation_job_status_transition'],
      apiIds: [],
      stateMachineIds: ['sm_generation_jobs'],
      preconditions: ['cron sweep installed; job_timeout_minutes set'],
      steps: [
        step('age_running_job', 'create_record', inferJobTable(ctx),
          'running job with started_at well past timeout',
          { status: 'running', startedAtAgoMinutes: 999 }),
        step('cron_runs', 'run_state_transition', `${inferJobTable(ctx)}.running->failed`,
          'cron flips status to failed, refunds reservation'),
        step('verify', 'check_db_effect', `${inferJobTable(ctx)}`,
          'status=failed; error_message="timeout"'),
      ],
      expectedResult: 'Cron sweeps stale running jobs without operator intervention.',
      failureMeaning: 'Crashed workers hold credits and seats forever.',
      implementationHint: 'Cron: UPDATE jobs SET status=failed WHERE status=running AND started_at < NOW()-interval timeout RETURNING id.',
    }),
  },
  {
    id: 'job_completion_emits_notification',
    shouldFire: ctx =>
      ctx.machines.some(m => m.id === 'sm_generation_jobs') && ctx.capabilities.has('notifications'),
    build: ctx => ({
      id: 'job_completion_emits_notification',
      name: 'Job completion emits exactly one notification',
      category: 'runtime',
      severity: 'medium',
      workflowIds: ['process_generation_job'],
      businessRuleIds: ['respect_notification_preferences'],
      apiIds: [],
      stateMachineIds: ['sm_generation_jobs'],
      preconditions: ['notification system online; user opted-in'],
      steps: [
        step('complete_job', 'run_state_transition', `${inferJobTable(ctx)}.running->completed`,
          'status=completed; job.completed event emitted'),
        step('event_emitted', 'check_event_emitted', 'job.completed',
          'exactly one event'),
        step('email_sent', 'check_notification', 'email:job_completed',
          'exactly one notification_log row with status=sent'),
      ],
      expectedResult: 'Completion fans out one notification per opted-in channel.',
      failureMeaning: 'Users miss completion alerts and never come back to download.',
      implementationHint: 'Emit job.completed inside the same txn that flips status; notification worker reads notification_preferences before sending.',
    }),
  },

  // ── ORDERS / FOOD DELIVERY ──────────────────────────────────────────────────
  {
    id: 'inventory_cannot_go_negative',
    shouldFire: ctx => ctx.capabilities.has('inventory'),
    build: () => ({
      id: 'inventory_cannot_go_negative',
      name: 'Inventory cannot drop below zero under concurrent orders',
      category: 'workflow',
      severity: 'critical',
      workflowIds: ['place_order'],
      businessRuleIds: ['inventory_non_negative'],
      apiIds: ['POST_/orders'],
      stateMachineIds: ['sm_orders'],
      preconditions: ['SKU with quantity=1'],
      steps: [
        step('two_orders', 'call_api', '/orders',
          'one 201, one 409 out_of_stock',
          { sku: 'X', parallel: 2 }),
        step('verify_stock', 'check_db_effect', 'inventory.quantity',
          'final stock = 0; never negative'),
      ],
      expectedResult: 'Exactly one order succeeds; inventory floors at 0.',
      failureMeaning: 'Overselling — fulfilment impossible, refunds explode.',
      implementationHint: 'CHECK (quantity >= 0) + SELECT … FOR UPDATE on the inventory row inside the order txn.',
    }),
  },
  {
    id: 'duplicate_payment_webhook_does_not_double_process',
    shouldFire: ctx =>
      ctx.capabilities.has('order_management') &&
      ctx.capabilities.has('payments') &&
      ctx.capabilities.has('webhooks'),
    build: () => ({
      id: 'duplicate_payment_webhook_does_not_double_process',
      name: 'Order webhook idempotency holds across retries',
      category: 'webhook',
      severity: 'critical',
      workflowIds: ['place_order'],
      businessRuleIds: ['payment_webhook_idempotency'],
      apiIds: ['POST_/webhooks/payments'],
      stateMachineIds: ['sm_orders'],
      preconditions: ['order in pending state'],
      steps: [
        step('first', 'simulate_webhook', 'payment_intent.succeeded',
          '200 + order.status=paid'),
        step('replay', 'simulate_webhook', 'payment_intent.succeeded',
          '200 no-op; status still paid'),
        step('verify_inventory', 'check_db_effect', 'inventory',
          'inventory decremented exactly once'),
      ],
      expectedResult: 'A retried Stripe webhook never decrements inventory twice.',
      failureMeaning: 'Stock disappears + customer is charged once but order moved twice.',
      implementationHint: 'Same idempotency log + ON CONFLICT pattern as credit grants.',
    }),
  },
  {
    id: 'non_buyer_cannot_view_private_order',
    shouldFire: ctx => ctx.capabilities.has('order_management'),
    build: ctx => ({
      id: 'non_buyer_cannot_view_private_order',
      name: 'Third-party user cannot read someone else\'s order',
      category: 'rls',
      severity: 'high',
      workflowIds: ['place_order'],
      businessRuleIds: ['order_buyer_seller_admin_only_access'],
      apiIds: [`GET_/${inferOrderTable(ctx)}/:id`],
      stateMachineIds: ['sm_orders'],
      preconditions: ['order owned by buyer A; user C exists'],
      steps: [
        step('user_c', 'attempt_forbidden_access', `/${inferOrderTable(ctx)}/:id`,
          '403/404',
          { actor: 'C' }),
      ],
      expectedResult: 'Order rows are scoped to buyer / seller / admin via RLS.',
      failureMeaning: 'Order metadata leaks (PII, address) to anyone who guesses an id.',
      implementationHint: 'RLS USING (buyer_id=auth.uid() OR seller_id=auth.uid() OR role=admin).',
    }),
  },
  {
    id: 'invalid_order_status_transition_rejected',
    shouldFire: ctx => ctx.capabilities.has('order_management'),
    build: ctx => ({
      id: 'invalid_order_status_transition_rejected',
      name: 'Invalid order status transition is rejected',
      category: 'state_machine',
      severity: 'high',
      workflowIds: ['place_order'],
      businessRuleIds: ['valid_order_status_transition'],
      apiIds: [],
      stateMachineIds: ['sm_orders'],
      preconditions: ['order in status=delivered'],
      steps: [
        step('try_invalid', 'run_state_transition', `${inferOrderTable(ctx)}.delivered->paid`,
          '409 / DB rejection'),
      ],
      expectedResult: 'Backwards transitions are rejected at the DB layer.',
      failureMeaning: 'Operators or workers can rewind orders and repeat fulfilment.',
      implementationHint: 'BEFORE UPDATE trigger raises on disallowed transitions.',
    }),
  },

  // ── HOSPITAL / BOOKING ──────────────────────────────────────────────────────
  {
    id: 'double_booking_rejected',
    shouldFire: ctx => ctx.capabilities.has('booking'),
    build: ctx => ({
      id: 'double_booking_rejected',
      name: 'Two patients cannot book the same slot concurrently',
      category: 'workflow',
      severity: 'critical',
      workflowIds: ['create_booking'],
      businessRuleIds: ['no_double_booking'],
      apiIds: [`POST_/${inferAppointmentTable(ctx)}`],
      stateMachineIds: ['sm_bookings'],
      preconditions: ['slot exists, no current booking'],
      steps: [
        step('two_patients', 'call_api', `/${inferAppointmentTable(ctx)}`,
          'one 201, one 409 slot_taken',
          { slotId: 'S1', parallel: 2 }),
        step('verify_one_row', 'check_db_effect', `${inferAppointmentTable(ctx)}`,
          'exactly one active booking for the slot'),
      ],
      expectedResult: 'EXCLUDE constraint / partial unique index serialises the race.',
      failureMeaning: 'Two patients show up for the same appointment; provider trust collapses.',
      implementationHint: 'CREATE UNIQUE INDEX appt_slot_active ON appointments (resource_id, slot_start) WHERE status IN (\'pending\',\'confirmed\').',
    }),
  },
  {
    id: 'patient_cannot_view_other_patient_appointment',
    shouldFire: ctx =>
      ctx.understanding.primaryDomain === 'hospital_booking_app' ||
      ctx.understanding.primaryDomain === 'healthcare_app' ||
      ctx.entityNames.has('appointments'),
    build: ctx => ({
      id: 'patient_cannot_view_other_patient_appointment',
      name: 'Patient cannot read another patient\'s appointment',
      category: 'rls',
      severity: 'critical',
      workflowIds: ['create_booking'],
      businessRuleIds: ['doctor_or_patient_only_appointment_access'],
      apiIds: [`GET_/${inferAppointmentTable(ctx)}/:id`],
      stateMachineIds: ['sm_bookings'],
      preconditions: ['two patients, one appointment'],
      steps: [
        step('other_patient', 'attempt_forbidden_access', `/${inferAppointmentTable(ctx)}/:id`,
          '403/404',
          { actor: 'patient_b' }),
      ],
      expectedResult: 'Healthcare RLS keeps records private to patient + assigned doctor + admin.',
      failureMeaning: 'PHI exposure — HIPAA / GDPR breach.',
      implementationHint: 'RLS USING (patient_id=auth.uid() OR doctor_id=auth.uid() OR role=admin).',
    }),
  },
  {
    id: 'doctor_can_confirm_appointment',
    shouldFire: ctx =>
      ctx.understanding.primaryDomain === 'hospital_booking_app' ||
      ctx.understanding.primaryDomain === 'healthcare_app' ||
      ctx.entityNames.has('appointments'),
    build: ctx => ({
      id: 'doctor_can_confirm_appointment',
      name: 'Doctor can confirm a requested appointment',
      category: 'state_machine',
      severity: 'high',
      workflowIds: ['create_booking'],
      businessRuleIds: ['valid_booking_status_transition'],
      apiIds: [`POST_/${inferAppointmentTable(ctx)}/:id/confirm`],
      stateMachineIds: ['sm_bookings'],
      preconditions: ['appointment in status=requested', 'doctor account exists'],
      steps: [
        step('confirm', 'call_api', `/${inferAppointmentTable(ctx)}/:id/confirm`,
          '200 + status=confirmed',
          { actor: 'doctor' }),
      ],
      expectedResult: 'Doctor role transitions the appointment per the state machine.',
      failureMeaning: 'Doctors cannot confirm appointments — booking system is non-functional.',
      implementationHint: 'POST /:id/confirm requires doctor role; calls fn_transition_appointment(id, confirmed).',
    }),
  },
  {
    id: 'sensitive_record_access_is_audited',
    shouldFire: ctx =>
      ctx.understanding.primaryDomain === 'hospital_booking_app' ||
      ctx.understanding.primaryDomain === 'healthcare_app' ||
      ctx.understanding.primaryDomain === 'fintech_app',
    build: () => ({
      id: 'sensitive_record_access_is_audited',
      name: 'Reading a sensitive record creates an audit_log row',
      category: 'admin',
      severity: 'high',
      workflowIds: [],
      businessRuleIds: ['audit_sensitive_record_access'],
      apiIds: ['GET_/medical-records/:id'],
      stateMachineIds: [],
      preconditions: ['admin user exists; sensitive row exists'],
      steps: [
        step('admin_read', 'call_api', '/medical-records/:id',
          '200 + record returned',
          { actor: 'admin' }),
        step('audit_row', 'check_db_effect', 'audit_logs',
          'exactly one row with action="read", target_type="medical_record"'),
      ],
      expectedResult: 'Every sensitive read leaves a trail.',
      failureMeaning: 'Insider abuse is undetectable.',
      implementationHint: 'Logger middleware on sensitive routes inserts audit row AFTER the 2xx response.',
    }),
  },

  // ── LEARNING PLATFORM ──────────────────────────────────────────────────────
  {
    id: 'unenrolled_user_cannot_access_paid_lesson',
    shouldFire: ctx =>
      ctx.understanding.primaryDomain === 'learning_platform' ||
      ctx.entityNames.has('enrollments') ||
      ctx.entityNames.has('lessons'),
    build: () => ({
      id: 'unenrolled_user_cannot_access_paid_lesson',
      name: 'Unenrolled user is denied lesson content',
      category: 'rls',
      severity: 'critical',
      workflowIds: [],
      businessRuleIds: ['enrolled_user_only_course_access'],
      apiIds: ['GET_/lessons/:id'],
      stateMachineIds: [],
      preconditions: ['course C with paid lessons; user B not enrolled'],
      steps: [
        step('user_b_read', 'attempt_forbidden_access', '/lessons/:id',
          '403/empty',
          { actor: 'user_b' }),
      ],
      expectedResult: 'Lessons are gated by an active enrollment row.',
      failureMeaning: 'Paid content is free for the taking — direct revenue loss.',
      implementationHint: 'RLS on lessons referencing enrollments where status=active.',
    }),
  },
  {
    id: 'enrolled_user_progress_update_succeeds',
    shouldFire: ctx =>
      ctx.understanding.primaryDomain === 'learning_platform' ||
      ctx.entityNames.has('enrollments') ||
      ctx.entityNames.has('progress'),
    build: () => ({
      id: 'enrolled_user_progress_update_succeeds',
      name: 'Enrolled user can update their own progress',
      category: 'workflow',
      severity: 'medium',
      workflowIds: [],
      businessRuleIds: ['progress_belongs_to_enrolled_user'],
      apiIds: ['POST_/progress'],
      stateMachineIds: ['sm_enrollments'],
      preconditions: ['user A enrolled in course C'],
      steps: [
        step('write', 'call_api', '/progress',
          '201 + progress row inserted',
          { actor: 'A', courseId: 'C', lessonId: 'L1', percent: 50 }),
      ],
      expectedResult: 'Owners can write their own progress.',
      failureMeaning: 'Progress tracking is unusable for the legitimate path.',
      implementationHint: 'RLS USING (user_id=auth.uid()) WITH CHECK (enrollment exists).',
    }),
  },
  {
    id: 'progress_update_for_another_user_rejected',
    shouldFire: ctx =>
      ctx.understanding.primaryDomain === 'learning_platform' ||
      ctx.entityNames.has('progress'),
    build: () => ({
      id: 'progress_update_for_another_user_rejected',
      name: 'User B cannot write progress on behalf of user A',
      category: 'rls',
      severity: 'high',
      workflowIds: [],
      businessRuleIds: ['progress_belongs_to_enrolled_user'],
      apiIds: ['POST_/progress'],
      stateMachineIds: ['sm_enrollments'],
      preconditions: ['users A and B exist'],
      steps: [
        step('forge', 'attempt_forbidden_access', '/progress',
          '403 — RLS WITH CHECK denies the row',
          { actor: 'B', userId: 'A' }),
      ],
      expectedResult: 'WITH CHECK clause stops cross-user writes even if RLS USING passes.',
      failureMeaning: 'Adversaries can poison other users\' learning history.',
      implementationHint: 'RLS WITH CHECK (user_id=auth.uid()).',
    }),
  },
  {
    id: 'subscription_webhook_idempotency_holds',
    shouldFire: ctx =>
      ctx.capabilities.has('subscriptions') && ctx.capabilities.has('webhooks'),
    build: () => ({
      id: 'subscription_webhook_idempotency_holds',
      name: 'Subscription provider webhook is idempotent',
      category: 'webhook',
      severity: 'critical',
      workflowIds: ['subscribe_plan'],
      businessRuleIds: ['payment_webhook_idempotency', 'valid_subscription_status_transition'],
      apiIds: ['POST_/webhooks/payments'],
      stateMachineIds: ['sm_subscriptions'],
      preconditions: ['subscription row exists'],
      steps: [
        step('first', 'simulate_webhook', 'subscription.updated',
          '200 + status applied'),
        step('replay', 'simulate_webhook', 'subscription.updated',
          '200 no-op'),
        step('verify_audit', 'check_db_effect', 'audit_logs',
          'exactly one audit row for the transition'),
      ],
      expectedResult: 'Replays produce zero additional state changes.',
      failureMeaning: 'Duplicate provider events flip subscriptions multiple times.',
      implementationHint: 'webhook_log UNIQUE(event_id) + fn_transition_subscription guards inside the txn.',
    }),
  },

  // ── CRM / SUPPORT TICKETS ──────────────────────────────────────────────────
  {
    id: 'non_admin_cannot_suspend_user',
    shouldFire: ctx =>
      ctx.capabilities.has('admin') &&
      (ctx.understanding.primaryDomain === 'internal_crm' || ctx.workflows.some(w => w.id === 'admin_suspend_user')),
    build: () => ({
      id: 'non_admin_cannot_suspend_user',
      name: 'Non-admin cannot reach the user-suspend endpoint',
      category: 'admin',
      severity: 'critical',
      workflowIds: ['admin_suspend_user'],
      businessRuleIds: ['admin_only_job_management', 'audit_admin_actions'],
      apiIds: ['POST_/admin/users/:id/suspend'],
      stateMachineIds: [],
      preconditions: ['regular user exists'],
      steps: [
        step('attempt', 'attempt_forbidden_access', '/admin/users/:id/suspend',
          '403',
          { actor: 'user' }),
      ],
      expectedResult: 'Server-side role re-check rejects forged claims.',
      failureMeaning: 'Anyone can lock out arbitrary accounts.',
      implementationHint: 'adminAuth middleware + audit row.',
    }),
  },
  {
    id: 'agent_can_assign_ticket',
    shouldFire: ctx =>
      ctx.machines.some(m => m.id === 'sm_tickets'),
    build: () => ({
      id: 'agent_can_assign_ticket',
      name: 'Agent can assign a ticket',
      category: 'state_machine',
      severity: 'medium',
      workflowIds: [],
      businessRuleIds: ['crm_role_based_access'],
      apiIds: ['POST_/tickets/:id/assign'],
      stateMachineIds: ['sm_tickets'],
      preconditions: ['ticket in status=open; agent role exists'],
      steps: [
        step('assign', 'call_api', '/tickets/:id/assign',
          '200 + status=in_progress',
          { actor: 'agent', assignee: 'agent_2' }),
      ],
      expectedResult: 'Agents drive the ticket lifecycle through allowed transitions.',
      failureMeaning: 'Agents cannot work tickets — the support queue stalls.',
      implementationHint: 'POST /:id/assign requires agent role; calls fn_transition_ticket(id, in_progress).',
    }),
  },
  {
    id: 'resolved_ticket_can_be_reopened',
    shouldFire: ctx => ctx.machines.some(m => m.id === 'sm_tickets'),
    build: () => ({
      id: 'resolved_ticket_can_be_reopened',
      name: 'Reporter can reopen a resolved ticket within window',
      category: 'state_machine',
      severity: 'medium',
      workflowIds: [],
      businessRuleIds: ['crm_role_based_access'],
      apiIds: ['POST_/tickets/:id/reopen'],
      stateMachineIds: ['sm_tickets'],
      preconditions: ['ticket in status=resolved within reopen window'],
      steps: [
        step('reopen', 'call_api', '/tickets/:id/reopen',
          '200 + status=reopened',
          { actor: 'reporter' }),
      ],
      expectedResult: 'Reopen is the legal escape from resolved before close_window.',
      failureMeaning: 'Customers cannot reopen incorrectly closed tickets.',
      implementationHint: 'POST /:id/reopen → fn_transition_ticket(id, reopened); requires reporter or admin.',
    }),
  },
  {
    id: 'admin_action_writes_audit_log',
    shouldFire: ctx =>
      ctx.capabilities.has('admin') && ctx.capabilities.has('audit_logs'),
    build: () => ({
      id: 'admin_action_writes_audit_log',
      name: 'Every admin write produces an audit_log row',
      category: 'admin',
      severity: 'high',
      workflowIds: ['admin_manage_jobs', 'admin_suspend_user'],
      businessRuleIds: ['audit_admin_actions'],
      apiIds: [],
      stateMachineIds: [],
      preconditions: ['admin endpoint exists'],
      steps: [
        step('admin_action', 'call_api', '/admin/<any>',
          '2xx + side effect',
          { actor: 'admin' }),
        step('audit', 'check_db_effect', 'audit_logs',
          'exactly one row referencing admin_id, action, target_id'),
      ],
      expectedResult: 'No admin write escapes the audit trail.',
      failureMeaning: 'Admin abuse cannot be reconstructed after the fact.',
      implementationHint: 'Wrap admin handlers with an auditWriter that runs in the same txn.',
    }),
  },
]

// ─── canRunNow / blockedBy resolution ────────────────────────────────────────

function resolveBlockers(ctx: Ctx, scenario: Omit<VerificationScenario, 'shadowMode' | 'canRunNow' | 'blockedBy'>): {
  canRunNow: boolean
  blockedBy: string[]
} {
  const blockers = new Set<string>()

  // 1) Webhook scenarios need the integration credentials stored.
  if (scenario.category === 'webhook') {
    if (ctx.capabilities.has('payments') && !ctx.availableIntegrations.has('stripe') && !ctx.availableIntegrations.has('paddle')) {
      blockers.add('integration:payment_provider_credentials_missing')
    }
    if (!ctx.availableRuntime.has('webhook_log')) {
      blockers.add('runtime:webhook_log_table_missing')
    }
  }

  // 2) Runtime scenarios need queue + worker.
  if (scenario.category === 'runtime') {
    if (!ctx.availableRuntime.has('queue')) blockers.add('runtime:queue')
    if (!ctx.availableRuntime.has('worker')) blockers.add('runtime:worker')
  }

  // 3) State-machine scenarios need the state machine plan to actually exist
  //    (defence in depth — the scenario template only fires when it does).
  for (const smId of scenario.stateMachineIds) {
    if (!ctx.machineIds.has(smId)) blockers.add(`state_machine:${smId}_missing`)
  }

  // 4) Storage scenarios need a storage driver wired.
  if (scenario.category === 'storage' && !ctx.availableRuntime.has('storage_driver')) {
    blockers.add('runtime:storage_driver_missing')
  }

  // 5) Notifications need the notification runtime.
  for (const s of scenario.steps) {
    if (s.action === 'check_notification' && !ctx.availableRuntime.has('notification_worker')) {
      blockers.add('runtime:notification_worker_missing')
    }
    if (s.action === 'check_event_emitted' && !ctx.availableRuntime.has('event_bus')) {
      blockers.add('runtime:event_bus_missing')
    }
  }

  return {
    canRunNow: blockers.size === 0,
    blockedBy: [...blockers],
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function planBehaviorVerification(input: VerificationPlannerInput): BehaviorVerificationReport {
  const understanding = input.understanding
  const workflows = input.workflows.workflows ?? []
  const rules = input.rules.rules ?? []
  const machines = input.machines.plans ?? []
  const apis = input.apis?.apis ?? []

  const ctx: Ctx = {
    prompt: input.prompt,
    promptLower: (input.prompt || '').toLowerCase(),
    understanding,
    capabilities: new Set(understanding.criticalCapabilities),
    patterns: new Set(understanding.backendPatterns),
    primaryDomain: understanding.primaryDomain,
    workflows,
    workflowIds: new Set(workflows.map(w => w.id)),
    rules,
    ruleIds: new Set(rules.map(r => r.id)),
    machines,
    machineIds: new Set(machines.map(m => m.id)),
    apis,
    apiByPath: new Map(apis.map(a => [a.id, a])),
    entityNames: new Set((input.entityNames ?? []).map(n => n.toLowerCase())),
    availableIntegrations: new Set(input.availableIntegrations ?? []),
    availableRuntime: new Set(input.availableRuntime ?? []),
  }

  const scenarios: VerificationScenario[] = []
  const seenIds = new Set<string>()

  for (const tpl of TEMPLATES) {
    let fires = false
    try { fires = tpl.shouldFire(ctx) } catch { fires = false }
    if (!fires) continue
    if (seenIds.has(tpl.id)) continue
    seenIds.add(tpl.id)

    let built: Omit<VerificationScenario, 'shadowMode' | 'canRunNow' | 'blockedBy'>
    try {
      built = tpl.build(ctx)
    } catch {
      continue
    }

    if (!validateScenarioShape(built)) continue

    const { canRunNow, blockedBy } = resolveBlockers(ctx, built)

    scenarios.push({
      ...built,
      canRunNow,
      blockedBy,
      shadowMode: true,
    })
  }

  const criticalCount = scenarios.filter(s => s.severity === 'critical').length
  const runnableCount = scenarios.filter(s => s.canRunNow).length
  const blockedCount = scenarios.filter(s => !s.canRunNow).length

  const warnings: string[] = []
  if (scenarios.length === 0) {
    warnings.push('No verification scenarios were planned — confirm prompt mentions auth, ownership, billing, or async behaviour before relying on this report.')
  }
  if (understanding.confidence.band === 'low') {
    warnings.push('Underlying ProductUnderstanding confidence is low — verification scenarios are best-effort.')
  }
  if (criticalCount > 0 && runnableCount === 0) {
    warnings.push('All critical scenarios are blocked — provision queue/worker/storage/integration credentials before claiming Production Ready.')
  }
  // Coverage warning: surface critical rules with no scenario.
  for (const rule of rules) {
    if (rule.severity !== 'critical') continue
    const covered = scenarios.some(s => s.businessRuleIds.includes(rule.id))
    if (!covered) {
      warnings.push(`Critical rule "${rule.id}" has no verification scenario — Production Ready is not safe to claim.`)
    }
  }

  // Readiness impact computation:
  //   • blocks_production: at least one critical scenario exists AND none can
  //     yet be run (or the upstream validator is in low confidence).
  //   • verification_ready: every critical scenario is runnable and the
  //     project has the runtime + integrations needed.
  //   • needs_verification: in between — scenarios are planned and partially
  //     runnable but not all critical ones are unblocked yet.
  let readinessImpact: VerificationReadinessImpact
  if (criticalCount === 0) {
    readinessImpact = scenarios.length > 0 ? 'verification_ready' : 'needs_verification'
  } else if (blockedCount === scenarios.length || understanding.confidence.band === 'low') {
    readinessImpact = 'blocks_production'
  } else if (scenarios.filter(s => s.severity === 'critical' && s.canRunNow).length === criticalCount) {
    readinessImpact = 'verification_ready'
  } else {
    readinessImpact = 'needs_verification'
  }

  return {
    scenarios,
    criticalCount,
    runnableCount,
    blockedCount,
    readinessImpact,
    warnings,
    shadowMode: true,
  }
}

// ─── Defence-in-depth shape validation ────────────────────────────────────────

function validateScenarioShape(s: Omit<VerificationScenario, 'shadowMode' | 'canRunNow' | 'blockedBy'>): boolean {
  if (!s.id || !s.name) return false
  if (!s.preconditions || s.preconditions.length === 0) return false
  if (!s.steps || s.steps.length === 0) return false
  if (!s.expectedResult) return false
  if (!s.failureMeaning) return false
  for (const st of s.steps) {
    if (!st.id || !st.action || !st.target || !st.expected) return false
  }
  return true
}

// Re-export types for convenience
export type {
  VerificationScenario,
  VerificationStep,
  BehaviorVerificationReport,
  VerificationCategory,
  VerificationSeverity,
  VerificationStepAction,
  VerificationReadinessImpact,
}
