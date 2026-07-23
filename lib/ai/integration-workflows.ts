/**
 * INTEGRATION WORKFLOWS
 * =====================
 * Defines what "complete" means for each major third-party integration.
 *
 * The critical insight: "Stripe done" is not "key stored".
 * "Stripe done" is:
 *   ✓ checkout/session endpoint exists
 *   ✓ webhook endpoint exists with HMAC verification
 *   ✓ payment success updates domain state (order.status = 'paid')
 *   ✓ idempotency guard on webhook replay
 *   ✓ stock/inventory decremented on success
 *
 * This file drives two systems:
 *   1. The phase orchestrator — knows what to build for each integration
 *   2. The behavioral verifier — knows what to check after building
 *
 * When a credential is missing, the workflow's `requiredSecrets` tells the
 * agent EXACTLY what to ask for, and `buildSteps` tells it exactly what to
 * build once the secret arrives. No guessing. No re-planning.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type IntegrationType =
  | 'payments'
  | 'email'
  | 'ai'
  | 'sms'
  | 'analytics'
  | 'auth'
  | 'storage'
  | 'realtime'

export interface IntegrationSecret {
  /** Key name used in STORE_INTEGRATION_KEY */
  key: string
  /** Human-readable label shown to user */
  label: string
  /** Regex pattern to validate the key format before storing */
  pattern?: RegExp
  /** Where to get this key */
  source: string
}

export interface IntegrationArtifact {
  type: 'table' | 'endpoint' | 'function' | 'trigger' | 'webhook_handler' | 'bucket'
  name: string
  description: string
  /** True if this artifact can be created without the integration secret */
  createdBeforeSecret?: boolean
}

export interface IntegrationWorkflow {
  integrationId: string
  name: string
  type: IntegrationType
  /** All secrets needed for this integration to be fully functional */
  requiredSecrets: IntegrationSecret[]
  /**
   * What backend artifacts must exist for this integration to be "complete".
   * The executor uses these as subgoal hints after credentials are provided.
   */
  requiredArtifacts: IntegrationArtifact[]
  /**
   * Behavioral assertions — what must be TRUE end-to-end for this integration
   * to pass the verification gate. These are checked by flow-verifier.ts.
   */
  completionCriteria: string[]
  /**
   * Step-by-step build instructions given to the agent after the secret is stored.
   * Phrased as subgoal descriptions so they slot directly into the subgoal list.
   */
  buildSteps: string[]
  /**
   * Message shown to user when this integration is blocked on credentials.
   * Should be direct and tell them exactly what to paste.
   */
  blockedMessage: string
}

// ── Registry ──────────────────────────────────────────────────────────────────

export const INTEGRATION_WORKFLOWS: Record<string, IntegrationWorkflow> = {

  // ── Stripe ─────────────────────────────────────────────────────────────────
  stripe: {
    integrationId: 'stripe',
    name: 'Stripe Payments',
    type: 'payments',
    requiredSecrets: [
      {
        key: 'stripe',
        label: 'Stripe Secret Key',
        pattern: /^sk_(test|live)_/,
        source: 'Stripe Dashboard → Developers → API Keys',
      },
      {
        key: 'stripe_webhook_secret',
        label: 'Stripe Webhook Signing Secret',
        pattern: /^whsec_/,
        source: 'Stripe Dashboard → Developers → Webhooks → Signing secret',
      },
    ],
    requiredArtifacts: [
      {
        type: 'table',
        name: 'orders',
        description: 'Orders table with status, amount, stripe_payment_intent_id, stripe_session_id, user_id',
        createdBeforeSecret: true,
      },
      {
        type: 'endpoint',
        name: 'POST /checkout/session',
        description: 'Creates a Stripe Checkout session and returns the redirect URL',
      },
      {
        type: 'webhook_handler',
        name: 'POST /webhooks/stripe',
        description: 'Handles stripe webhook events — validates HMAC signature, updates order status',
      },
      {
        type: 'function',
        name: 'handle_payment_success',
        description: 'AI function: on payment_intent.succeeded — marks order paid, decrements stock, idempotency check',
      },
    ],
    completionCriteria: [
      'orders table exists with status, stripe_payment_intent_id, stripe_session_id columns',
      'POST /checkout/session endpoint exists and is protected by auth',
      'POST /webhooks/stripe endpoint exists with Stripe HMAC signature verification',
      'Payment success event updates order.status to "paid"',
      'Duplicate webhook events are handled idempotently (no double-charge)',
      'Stock/inventory is decremented on successful payment (if product table exists)',
    ],
    buildSteps: [
      'Create orders table with status (pending/paid/refunded), amount, stripe_payment_intent_id, stripe_session_id, user_id columns',
      'Generate REST API for orders table',
      'Create POST /checkout/session endpoint that calls Stripe API to create a checkout session',
      'Create POST /webhooks/stripe endpoint that verifies stripe-signature HMAC header',
      'Create handle_payment_success AI function that updates order status to paid on payment_intent.succeeded',
      'Add idempotency check: skip processing if order.status is already paid',
    ],
    blockedMessage: 'Stripe integration requires your Stripe Secret Key (sk_test_... or sk_live_...). Paste it here and I will build the full payment flow: checkout session, webhook handler, and payment success logic.',
  },

  // ── Resend ─────────────────────────────────────────────────────────────────
  resend: {
    integrationId: 'resend',
    name: 'Resend Email',
    type: 'email',
    requiredSecrets: [
      {
        key: 'resend_api_key',
        label: 'Resend API Key',
        pattern: /^re_/,
        source: 'resend.com → API Keys',
      },
    ],
    requiredArtifacts: [
      {
        type: 'function',
        name: 'send_email',
        description: 'AI function that sends transactional email via Resend API',
      },
      {
        type: 'trigger',
        name: 'email_on_event',
        description: 'DB trigger that fires send_email on the relevant domain event (e.g. new order, new user)',
      },
    ],
    completionCriteria: [
      'send_email AI function exists and references the stored Resend API key',
      'At least one DB trigger fires send_email on a relevant domain event',
      'Email template includes relevant data from the triggering record',
      'Function handles Resend API errors gracefully (does not crash on send failure)',
    ],
    buildSteps: [
      'Create send_email AI function using stored Resend API key — accepts to, subject, html body',
      'Create DB trigger on the most relevant table (e.g. orders on INSERT) to fire send_email',
      'Pass relevant row data (order id, user email, amount) as template variables to the email',
    ],
    blockedMessage: 'Email notifications require a Resend API key (re_...). Paste it here and I will create the email function and connect it to your domain events automatically.',
  },

  // ── SendGrid ───────────────────────────────────────────────────────────────
  sendgrid: {
    integrationId: 'sendgrid',
    name: 'SendGrid Email',
    type: 'email',
    requiredSecrets: [
      {
        key: 'sendgrid_api_key',
        label: 'SendGrid API Key',
        pattern: /^SG\./,
        source: 'app.sendgrid.com → Settings → API Keys',
      },
    ],
    requiredArtifacts: [
      {
        type: 'function',
        name: 'send_email',
        description: 'AI function that sends email via SendGrid API',
      },
      {
        type: 'trigger',
        name: 'email_on_event',
        description: 'DB trigger that fires send_email on relevant domain events',
      },
    ],
    completionCriteria: [
      'send_email AI function exists and references the stored SendGrid API key',
      'At least one DB trigger fires send_email on a relevant domain event',
    ],
    buildSteps: [
      'Create send_email AI function using stored SendGrid API key',
      'Create DB trigger on the relevant table to fire send_email with row data',
    ],
    blockedMessage: 'Email notifications require a SendGrid API key (SG. ...). Paste it here and I will create the email function and connect it to your domain events.',
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  openai: {
    integrationId: 'openai',
    name: 'OpenAI',
    type: 'ai',
    requiredSecrets: [
      {
        key: 'openai_api_key',
        label: 'OpenAI API Key',
        pattern: /^sk-/,
        source: 'platform.openai.com → API Keys',
      },
    ],
    requiredArtifacts: [
      {
        type: 'function',
        name: 'ai_function',
        description: 'Serverless AI function using OpenAI (summarize, classify, generate, etc.)',
      },
    ],
    completionCriteria: [
      'At least one AI function exists using the stored OpenAI API key',
      'Function is triggered by a relevant domain event or exposed as an endpoint',
    ],
    buildSteps: [
      'Create AI function using the stored OpenAI key for the relevant domain use case',
      'Connect function to trigger or expose it as a callable endpoint',
    ],
    blockedMessage: 'AI features require an OpenAI API key (sk-...). Paste it here and I will create the AI function for your use case.',
  },

  // ── Anthropic ──────────────────────────────────────────────────────────────
  anthropic: {
    integrationId: 'anthropic',
    name: 'Anthropic Claude',
    type: 'ai',
    requiredSecrets: [
      {
        key: 'anthropic_api_key',
        label: 'Anthropic API Key',
        pattern: /^sk-ant-/,
        source: 'console.anthropic.com → API Keys',
      },
    ],
    requiredArtifacts: [
      {
        type: 'function',
        name: 'ai_function',
        description: 'Serverless AI function using Anthropic Claude',
      },
    ],
    completionCriteria: [
      'At least one AI function exists using the stored Anthropic API key',
      'Function is triggered or exposed as an endpoint',
    ],
    buildSteps: [
      'Create AI function using the stored Anthropic key',
      'Connect function to trigger or expose as an endpoint',
    ],
    blockedMessage: 'AI features require an Anthropic API key (sk-ant-...). Paste it here and I will create the Claude-powered function.',
  },

  // ── Twilio ─────────────────────────────────────────────────────────────────
  twilio: {
    integrationId: 'twilio',
    name: 'Twilio SMS',
    type: 'sms',
    requiredSecrets: [
      {
        key: 'twilio_account_sid',
        label: 'Twilio Account SID',
        source: 'console.twilio.com → Account Info',
      },
      {
        key: 'twilio_auth_token',
        label: 'Twilio Auth Token',
        source: 'console.twilio.com → Account Info',
      },
      {
        key: 'twilio_phone_number',
        label: 'Twilio Phone Number',
        source: 'console.twilio.com → Phone Numbers',
      },
    ],
    requiredArtifacts: [
      {
        type: 'function',
        name: 'send_sms',
        description: 'AI function that sends SMS via Twilio',
      },
      {
        type: 'trigger',
        name: 'sms_on_event',
        description: 'DB trigger that fires send_sms on relevant events',
      },
    ],
    completionCriteria: [
      'send_sms AI function exists and references Twilio credentials',
      'At least one trigger fires send_sms on a relevant domain event',
    ],
    buildSteps: [
      'Create send_sms AI function using stored Twilio Account SID, Auth Token, and phone number',
      'Create DB trigger on the relevant table to fire send_sms',
    ],
    blockedMessage: 'SMS notifications require Twilio credentials (Account SID, Auth Token, phone number). Add them in Settings → Integrations and I will create the SMS function.',
  },

  // ── Runway ML ─────────────────────────────────────────────────────────────
  // #88: Video AI provider — critical for 3D/video generation SaaS products.
  runway: {
    integrationId: 'runway',
    name: 'Runway ML',
    type: 'ai',
    requiredSecrets: [
      {
        key: 'runway_api_key',
        label: 'Runway ML API Key',
        pattern: /^key_/,
        source: 'app.runwayml.com → Account → API Keys',
      },
    ],
    requiredArtifacts: [
      {
        type: 'function',
        name: 'submit_video_generation',
        description: 'AI function: submits a video generation job to Runway ML API, polls for completion, stores output URL',
        createdBeforeSecret: false,
      },
      {
        type: 'function',
        name: 'poll_video_generation',
        description: 'AI function: polls Runway ML task status, updates job.status and output_url on completion',
      },
      {
        type: 'trigger',
        name: 'start_generation_on_job_insert',
        description: 'DB trigger: when a generation_jobs row is inserted with status=queued, fire submit_video_generation',
      },
    ],
    completionCriteria: [
      'submit_video_generation function exists and uses stored Runway API key',
      'poll_video_generation function exists with exponential back-off retry',
      'generation_jobs table has output_url, task_id, and provider columns',
      'DB trigger fires submit_video_generation on new queued jobs',
      'Job status transitions: queued → running → completed/failed',
    ],
    buildSteps: [
      'Create submit_video_generation AI function: POST to Runway ML /v1/image_to_video or /v1/text_to_video, store task_id in job row, update status to running',
      'Create poll_video_generation AI function: GET /v1/tasks/{taskId}, update job.status + output_url when SUCCEEDED, set failed on FAILED',
      'Create DB trigger on generation_jobs INSERT (status=queued) to fire submit_video_generation',
      'Add output_url, task_id, provider, error_message columns to generation_jobs table if not present',
      'Create a cron job to poll in-progress jobs every 30 seconds via poll_video_generation',
    ],
    blockedMessage: 'Video generation requires a Runway ML API key (key_...). Get it from app.runwayml.com → Account → API Keys. Paste it here and I will wire up the full video generation pipeline: job submission, status polling, output storage, and realtime progress updates.',
  },

  // ── Stability AI ──────────────────────────────────────────────────────────
  // #88: Image/video AI provider — Stable Diffusion, Stable Video Diffusion.
  stability_ai: {
    integrationId: 'stability_ai',
    name: 'Stability AI',
    type: 'ai',
    requiredSecrets: [
      {
        key: 'stability_api_key',
        label: 'Stability AI API Key',
        source: 'platform.stability.ai → Account → API Keys',
      },
    ],
    requiredArtifacts: [
      {
        type: 'function',
        name: 'generate_image',
        description: 'AI function: calls Stability AI API to generate images or video frames from text/image prompts',
      },
      {
        type: 'trigger',
        name: 'start_generation_on_job_insert',
        description: 'DB trigger: fires generate_image on new generation job rows',
      },
    ],
    completionCriteria: [
      'generate_image function exists and uses stored Stability AI API key',
      'DB trigger fires generate_image on new queued jobs',
      'Output stored in generated_outputs table with fileUrl and metadata',
    ],
    buildSteps: [
      'Create generate_image AI function using stored Stability AI API key — POST to /v1/generation/{engine_id}/text-to-image',
      'Store generated image bytes to project storage bucket and write output URL to generated_outputs',
      'Create DB trigger on generation_jobs INSERT to fire generate_image',
    ],
    blockedMessage: 'Image/video generation requires a Stability AI API key. Get it from platform.stability.ai. Paste it here and I will build the full generation pipeline.',
  },

  // ── Replicate ─────────────────────────────────────────────────────────────
  // #88: Hosts Kling, Pika, SDXL, and 1000s of other models via unified API.
  replicate: {
    integrationId: 'replicate',
    name: 'Replicate',
    type: 'ai',
    requiredSecrets: [
      {
        key: 'replicate_api_key',
        label: 'Replicate API Token',
        pattern: /^r8_/,
        source: 'replicate.com → Account → API tokens',
      },
    ],
    requiredArtifacts: [
      {
        type: 'function',
        name: 'run_model',
        description: 'AI function: runs any Replicate model by ID, polls for output, stores result',
      },
      {
        type: 'trigger',
        name: 'start_generation_on_job_insert',
        description: 'DB trigger: fires run_model on new queued generation jobs',
      },
    ],
    completionCriteria: [
      'run_model function exists and uses stored Replicate API token',
      'DB trigger fires run_model on new queued jobs',
      'Replicate webhook registered to push completion events back to project',
    ],
    buildSteps: [
      'Create run_model AI function: POST to https://api.replicate.com/v1/predictions with model + input params',
      'Register Replicate webhook: POST /webhooks/replicate to receive async completion events',
      'On webhook event: update job.status, store output URL in generated_outputs table',
      'Create DB trigger on generation_jobs INSERT (status=queued) to fire run_model',
    ],
    blockedMessage: 'AI model runs (Kling, SDXL, etc.) require a Replicate API token (r8_...). Get it from replicate.com/account. Paste it here and I will build the full async prediction pipeline with webhook completion callbacks.',
  },
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Get workflow spec for a detected integration. Returns null if not in registry. */
export function getIntegrationWorkflow(integrationId: string): IntegrationWorkflow | null {
  return INTEGRATION_WORKFLOWS[integrationId.toLowerCase()] ?? null
}

/**
 * Check whether an integration has all its required secrets stored.
 * Returns { allPresent: true } if the workflow has no required secrets or they are all stored.
 */
export async function checkIntegrationSecrets(
  projectId: string,
  integrationId: string,
): Promise<{ allPresent: boolean; missing: string[] }> {
  const workflow = getIntegrationWorkflow(integrationId)
  if (!workflow || workflow.requiredSecrets.length === 0) {
    return { allPresent: true, missing: [] }
  }

  try {
    const { hasIntegrationKey } = await import('@/lib/services/integrationKeyStore')
    const missing: string[] = []

    for (const secret of workflow.requiredSecrets) {
      const has = await hasIntegrationKey(projectId, secret.key)
      if (!has) missing.push(secret.label)
    }

    return { allPresent: missing.length === 0, missing }
  } catch {
    return {
      allPresent: false,
      missing: workflow.requiredSecrets.map(s => s.label),
    }
  }
}

/**
 * Format a blocked integration as a user-facing message.
 * Tells the user exactly what credential to paste and what will happen after.
 */
export function formatIntegrationBlockedMessage(
  integrationId: string,
  missingSections: string[],
): string {
  const workflow = getIntegrationWorkflow(integrationId)
  if (workflow) return workflow.blockedMessage

  // Generic fallback
  return `${integrationId} requires credentials before it can be built. Add them in Settings → Integrations.\n\nNeeded: ${missingSections.join(', ')}`
}

/**
 * Get the build steps for an integration, formatted as subgoal descriptions.
 * Used to inject integration subgoals into the agent loop after credentials are stored.
 */
export function getIntegrationBuildSteps(integrationId: string): string[] {
  return getIntegrationWorkflow(integrationId)?.buildSteps ?? []
}

/**
 * All integration IDs that are known to require credentials.
 * Used to detect "this subgoal is about an integration" in the phase classifier.
 */
export const KNOWN_INTEGRATION_IDS = Object.keys(INTEGRATION_WORKFLOWS)
