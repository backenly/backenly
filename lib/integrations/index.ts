/**
 * INTEGRATION EXECUTION DISPATCHER
 * ==================================
 * Routes integration intents to the correct executor.
 *
 * Supported integrations:
 *   stripe, google_auth, github_auth, resend, openai, deploy, frontend, function
 */

export type IntegrationId =
  | 'stripe'
  | 'google_auth'
  | 'github_auth'
  | 'resend'
  | 'sendgrid'
  | 'openai'
  | 'anthropic'
  | 'deploy'
  | 'frontend'
  | 'function'
  | 'runway'
  | 'stability'
  | 'replicate'
  | 'kling'
  | 'pika'
  | 'posthog'
  | 'onesignal'

export interface DispatchResult {
  success: boolean
  message: string
  needsApiKey?: boolean
  needsCredentials?: boolean
  needsConfirmation?: boolean
  keyHint?: string
  credentialHint?: string
  confirmationId?: string
  data?: Record<string, any>
}

export async function dispatchIntegration(
  integrationId: IntegrationId,
  projectId: string,
  params: Record<string, any> = {}
): Promise<DispatchResult> {
  switch (integrationId) {
    case 'stripe': {
      const { executeStripeIntegration } = await import('./stripe.executor')
      return executeStripeIntegration(projectId, params.apiKey, params.webhookSecret)
    }

    case 'google_auth': {
      const { executeAuthIntegration } = await import('./auth.executor')
      return executeAuthIntegration(projectId, 'google', params.clientId, params.clientSecret)
    }

    case 'github_auth': {
      const { executeAuthIntegration } = await import('./auth.executor')
      return executeAuthIntegration(projectId, 'github', params.clientId, params.clientSecret)
    }

    case 'resend': {
      const { executeEmailIntegration } = await import('./email.executor')
      return executeEmailIntegration(projectId, 'resend', params.apiKey)
    }

    case 'sendgrid': {
      const { executeEmailIntegration } = await import('./email.executor')
      return executeEmailIntegration(projectId, 'sendgrid', params.apiKey)
    }

    case 'openai': {
      const { executeAiIntegration } = await import('./ai.executor')
      return executeAiIntegration(projectId, 'openai', params.apiKey)
    }

    case 'anthropic': {
      const { executeAiIntegration } = await import('./ai.executor')
      return executeAiIntegration(projectId, 'anthropic', params.apiKey)
    }

    case 'posthog': {
      // PostHog is product analytics, NOT an LLM — it has its own executor.
      const { executePostHogIntegration } = await import('./posthog.executor')
      return executePostHogIntegration(projectId, params.apiKey)
    }

    case 'onesignal': {
      const { executePushIntegration } = await import('./push.executor')
      return executePushIntegration(projectId, params.appId, params.restApiKey ?? params.apiKey)
    }

    // Video generation providers — store key and return activation confirmation
    case 'runway':
    case 'stability':
    case 'replicate':
    case 'kling':
    case 'pika': {
      const { executeVideoProviderIntegration } = await import('./video-provider.executor')
      return executeVideoProviderIntegration(projectId, integrationId, params.apiKey)
    }

    case 'deploy': {
      const { executeDeployIntegration } = await import('./deploy.executor')
      return executeDeployIntegration(projectId, params.confirmed, params.confirmationId)
    }

    case 'frontend': {
      const { executeFrontendIntegration } = await import('./frontend.executor')
      return executeFrontendIntegration(projectId, params.userMessage, params.conversationHistory)
    }

    case 'function': {
      const { executeFunctionIntegration } = await import('./function.executor')
      return executeFunctionIntegration(
        projectId,
        params.description || 'Custom function',
        params.triggerType,
        params.triggerTable
      )
    }

    default:
      return {
        success: false,
        message: `Unknown integration: ${integrationId}`,
      }
  }
}

/**
 * Map natural language integration mentions to integration IDs.
 * Returns the first match found.
 */
export function detectIntegrationId(message: string): IntegrationId | null {
  const lower = message.toLowerCase()

  if (/stripe|payment|subscription|billing|checkout/.test(lower)) return 'stripe'
  if (/google auth|sign in with google|google oauth|google login/.test(lower)) return 'google_auth'
  if (/github auth|sign in with github|github oauth|github login/.test(lower)) return 'github_auth'
  if (/resend|send.*email|email.*send|welcome email|transactional email/.test(lower)) return 'resend'
  if (/sendgrid/.test(lower)) return 'sendgrid'
  if (/openai|gpt|chatbot|ai.*generat|generat.*ai/.test(lower)) return 'openai'
  if (/anthropic|claude/.test(lower)) return 'anthropic'
  if (/\bposthog\b|post.?hog/.test(lower)) return 'posthog'
  if (/onesignal|one.?signal|push.?notification/.test(lower)) return 'onesignal'
  if (/runway\s*ml|runway\s*api/.test(lower)) return 'runway'
  if (/stability[\s-]?ai|stable[\s-]?diffusion|sdxl/.test(lower)) return 'stability'
  if (/replicate/.test(lower)) return 'replicate'
  if (/\bkling\b/.test(lower)) return 'kling'
  if (/\bpika\b/.test(lower)) return 'pika'
  if (/deploy|go live|make.*live|push.*production|launch/.test(lower)) return 'deploy'
  if (/connect.*frontend|sdk|frontend.*connect/.test(lower)) return 'frontend'
  if (/function|serverless|trigger|automation/.test(lower)) return 'function'

  return null
}
