/**
 * PHASE 8: ERROR TAXONOMY
 * =======================
 * Formal, structured error categories for the 7 most common failure types.
 * Used by the auto-fix registry and retry wrapper to make classification
 * and recovery decisions without parsing raw log strings ad hoc.
 *
 * Every error that surfaces from the execution pipeline is classified into
 * one of these categories so operators can understand what happened at a
 * glance — without digging through raw stack traces or pg error codes.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ErrorTaxonomyCode =
  | 'FK_CONSTRAINT'             // Foreign key constraint violations
  | 'DUPLICATE_RESOURCE'        // Duplicate table / column / key / index
  | 'MIGRATION_FAILURE'         // Schema migration / ALTER TABLE / db push failures
  | 'INTEGRATION_MISCONFIG'     // Missing or invalid integration API key / config
  | 'AUTH_MISCONFIG'            // JWT secret missing, provider not configured, RLS off
  | 'WEBHOOK_VERIFY_FAILURE'    // Webhook signature / HMAC mismatch
  | 'TRIGGER_DELIVERY_FAILURE'  // Event trigger failed to reach its target URL/function

export interface ErrorTaxonomyEntry {
  code: ErrorTaxonomyCode
  /** Short human label shown in UI / dashboards */
  label: string
  /** Full sentence for operator understanding */
  description: string
  /** Whether retrying the same operation might succeed */
  recoverable: boolean
  /** Whether a deterministic fix can be applied without user input */
  autoFixable: boolean
  /** Guidance for operators reading a timeline entry with this classification */
  operatorGuidance: string
  /**
   * Patterns (lowercased strings or regexes) to match against the raw error message.
   * First category whose pattern matches wins.
   */
  patterns: (string | RegExp)[]
}

// ─── Taxonomy Definitions ─────────────────────────────────────────────────────

export const ERROR_TAXONOMY: Record<ErrorTaxonomyCode, ErrorTaxonomyEntry> = {

  FK_CONSTRAINT: {
    code: 'FK_CONSTRAINT',
    label: 'Foreign Key Constraint',
    description:
      'A foreign key constraint was violated — the referenced parent row does not exist, ' +
      'or there is a type mismatch between the FK column and the referenced PK.',
    recoverable: true,
    autoFixable: true,
    operatorGuidance:
      'If the error is a type mismatch (int vs uuid), the executor will auto-coerce on retry. ' +
      'If the parent row is missing, ensure parent data exists before inserting child rows.',
    patterns: [
      'violates foreign key constraint',
      'foreign key violation',
      /foreign key constraint.*fails/i,
      /insert or update on table.*violates/i,
      /update or delete on table.*violates/i,
      /is not present in table/i,
      /type mismatch.*integer.*uuid/i,
      /integer.*type.*uuid/i,
      /incompatible types/i,
    ],
  },

  DUPLICATE_RESOURCE: {
    code: 'DUPLICATE_RESOURCE',
    label: 'Duplicate Resource',
    description:
      'A resource (table, column, key, index, constraint) already exists. ' +
      'This is safe to treat as an idempotent no-op.',
    recoverable: true,
    autoFixable: true,
    operatorGuidance:
      'Duplicate creation is treated as idempotent — the existing resource is preserved ' +
      'and the step is skipped. Self-corrected flag will be set on the timeline entry.',
    patterns: [
      'already exists',
      'duplicate key value',
      'unique constraint',
      /relation.*already exists/i,
      /index.*already exists/i,
      /table.*already exists/i,
      /column.*already exists/i,
      /constraint.*already exists/i,
      /duplicate entry/i,
    ],
  },

  MIGRATION_FAILURE: {
    code: 'MIGRATION_FAILURE',
    label: 'Migration Failure',
    description:
      'A schema migration (prisma db push, ALTER TABLE, CREATE TABLE, ADD COLUMN) failed, ' +
      'possibly due to conflicting columns, type changes on populated tables, or SQL syntax errors.',
    recoverable: true,
    autoFixable: false,
    operatorGuidance:
      'Inspect the migration error detail. Common causes: changing a column type on a non-empty ' +
      'table, adding a NOT NULL column without a default, or referencing a missing parent table. ' +
      'If the error is "relation does not exist", the auto-fix will create the table and retry.',
    patterns: [
      'migration',
      'prisma db push',
      'schema generation',
      /alter table.*failed/i,
      /could not create.*table/i,
      /could not add.*column/i,
      /syntax error.*sql/i,
      /p1000|p1001|p1002|p1003|p1010|p1017/i,  // Prisma migration error codes
      /database.*schema.*error/i,
      /schema.*migration.*failed/i,
      /relation.*does not exist/i,
      /no such table/i,
    ],
  },

  INTEGRATION_MISCONFIG: {
    code: 'INTEGRATION_MISCONFIG',
    label: 'Integration Misconfiguration',
    description:
      'An external integration (Stripe, SendGrid, Twilio, OpenAI, etc.) is missing required ' +
      'credentials or its stored API key is invalid or expired.',
    recoverable: false,
    autoFixable: false,
    operatorGuidance:
      'Verify the integration API key is stored via STORE_INTEGRATION_KEY and is still valid. ' +
      'Re-run STORE_INTEGRATION_KEY with correct credentials, then retry the integration action.',
    patterns: [
      'api key not found',
      'integration not configured',
      'missing api key',
      'invalid api key',
      /no.*integration.*key/i,
      /stripe.*not configured/i,
      /sendgrid.*not configured/i,
      /twilio.*not configured/i,
      /smtp.*not configured/i,
      /openai.*not configured/i,
      /anthropic.*not configured/i,
      /integration.*credentials.*missing/i,
      /credentials.*not found/i,
      /api.*key.*expired/i,
    ],
  },

  AUTH_MISCONFIG: {
    code: 'AUTH_MISCONFIG',
    label: 'Auth Misconfiguration',
    description:
      'Authentication is incomplete or invalid — missing JWT secret, OAuth provider not ' +
      'configured, RLS not enabled, or project JWT secret not generated.',
    recoverable: false,
    autoFixable: false,
    operatorGuidance:
      'Ensure the JWT secret is set for the project. Run ENABLE_AUTH to activate authentication. ' +
      'For OAuth, verify client ID and secret are stored. For RLS, run SET_PERMISSION on relevant tables.',
    patterns: [
      'jwt secret',
      'auth not enabled',
      'no auth provider',
      /jwt.*invalid/i,
      /jwt.*missing/i,
      /jwt.*not configured/i,
      /jwt.*not set/i,
      /auth.*not enabled/i,
      /auth.*not configured/i,
      /provider.*not configured/i,
      /rls.*not.*enabled/i,
      /missing.*jwt.*secret/i,
      /no.*jwt.*secret/i,
      /authentication.*not.*set up/i,
    ],
  },

  WEBHOOK_VERIFY_FAILURE: {
    code: 'WEBHOOK_VERIFY_FAILURE',
    label: 'Webhook Verification Failure',
    description:
      'Webhook signature verification failed — the HMAC signature in the request header ' +
      'does not match what was computed using the stored webhook secret.',
    recoverable: false,
    autoFixable: false,
    operatorGuidance:
      'Verify the webhook secret in STORE_INTEGRATION_KEY matches the secret configured in ' +
      'the sending service (e.g. Stripe dashboard). Ensure the raw request body (not parsed JSON) ' +
      'is used for signature computation.',
    patterns: [
      'webhook signature',
      'invalid signature',
      'signature mismatch',
      'webhook verification',
      'signature verification failed',
      /hmac.*mismatch/i,
      /hmac.*invalid/i,
      /payload.*signature.*invalid/i,
      /webhook.*secret.*invalid/i,
      /x-signature.*invalid/i,
      /stripe-signature.*invalid/i,
      /stripe.*signature.*mismatch/i,
      /webhook.*not.*verified/i,
    ],
  },

  TRIGGER_DELIVERY_FAILURE: {
    code: 'TRIGGER_DELIVERY_FAILURE',
    label: 'Trigger Delivery Failure',
    description:
      'An event trigger (on_insert, on_update, on_delete, on_webhook, cron) failed to ' +
      'deliver its payload to the configured target URL or AI function.',
    recoverable: true,
    autoFixable: false,
    operatorGuidance:
      'Check that the target URL is reachable and returning 2xx. Review the trigger logs for ' +
      'the response body. The system will retry automatically up to the configured limit.',
    patterns: [
      'trigger delivery failed',
      'trigger failed',
      'webhook delivery failed',
      'function execution failed',
      /could not deliver.*trigger/i,
      /trigger.*target.*unreachable/i,
      /trigger.*timeout/i,
      /trigger.*http.*error/i,
      /failed to deliver.*event/i,
      /trigger.*returned.*[45]\d\d/i,
      /ai.*function.*failed/i,
    ],
  },
}

// ─── Classification API ───────────────────────────────────────────────────────

/**
 * Classify a raw error message into a taxonomy entry.
 * Returns null if no known category matches (unclassified).
 */
export function classifyError(error: string | Error): ErrorTaxonomyEntry | null {
  const msg = typeof error === 'string' ? error : error.message
  const lower = msg.toLowerCase()

  for (const entry of Object.values(ERROR_TAXONOMY)) {
    for (const pattern of entry.patterns) {
      if (typeof pattern === 'string') {
        if (lower.includes(pattern.toLowerCase())) return entry
      } else {
        if (pattern.test(msg)) return entry
      }
    }
  }

  return null
}

/**
 * Classify and return just the code string, or 'UNKNOWN' if unclassified.
 */
export function classifyErrorCode(error: string | Error): ErrorTaxonomyCode | 'UNKNOWN' {
  return classifyError(error)?.code ?? 'UNKNOWN'
}

/**
 * Returns true if this error is safe to retry (per taxonomy).
 */
export function isRecoverable(error: string | Error): boolean {
  return classifyError(error)?.recoverable ?? false
}

/**
 * Returns true if a deterministic auto-fix exists for this error.
 */
export function isAutoFixable(error: string | Error): boolean {
  return classifyError(error)?.autoFixable ?? false
}
