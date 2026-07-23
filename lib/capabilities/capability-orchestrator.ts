/**
 * CAPABILITY ORCHESTRATOR
 * 
 * Central coordination for all 10 core capabilities
 * Routes intent to appropriate capability system
 */

import { parsePaymentPolicyIntent } from './payment-policy'
import { parseWebhookTriggerIntent } from './webhook-triggers'
import { parseScheduledActionIntent } from './scheduled-actions'
import { parseEmailNotificationIntent } from './email-notifications'
import { parseAdminPermissionIntent } from './admin-moderation'
import { parseIntegrationIntent } from './secrets-integrations'

/**
 * Capability type enum
 */
export enum CapabilityType {
  PAYMENT_POLICY = 'PAYMENT_POLICY',
  WEBHOOK_TRIGGERS = 'WEBHOOK_TRIGGERS',
  SCHEDULED_ACTIONS = 'SCHEDULED_ACTIONS',
  EMAIL_NOTIFICATIONS = 'EMAIL_NOTIFICATIONS',
  ENVIRONMENT_SAFETY = 'ENVIRONMENT_SAFETY',
  DATA_EXPORT = 'DATA_EXPORT',
  ADMIN_MODERATION = 'ADMIN_MODERATION',
  USAGE_TRACKING = 'USAGE_TRACKING',
  INTEGRATION_CAPABILITY = 'INTEGRATION_CAPABILITY',
  AUDIT_HISTORY = 'AUDIT_HISTORY'
}

/**
 * Parse user message and detect which capability is being requested
 */
export function detectCapability(userMessage: string, feature?: string): CapabilityType | null {
  const lower = userMessage.toLowerCase()
  
  // Use feature hint from intent parser if available
  if (feature) {
    switch (feature) {
      case 'PAYMENT_POLICY': return CapabilityType.PAYMENT_POLICY
      case 'WEBHOOK_TRIGGERS': return CapabilityType.WEBHOOK_TRIGGERS
      case 'SCHEDULED_ACTIONS': return CapabilityType.SCHEDULED_ACTIONS
      case 'EMAIL_NOTIFICATIONS': return CapabilityType.EMAIL_NOTIFICATIONS
      case 'ADMIN_MODERATION': return CapabilityType.ADMIN_MODERATION
      case 'INTEGRATION_CAPABILITY': return CapabilityType.INTEGRATION_CAPABILITY
    }
  }
  
  // #1 Payment Policy
  if (
    (/\b(free|paid|pro|premium|basic|tier|plan)\b/i.test(lower) &&
     /\b(users|user|customers|can|cannot|allowed|limited|unlimited)\b/i.test(lower))
  ) {
    return CapabilityType.PAYMENT_POLICY
  }
  
  // #2 Webhook Triggers
  if (
    /\bwhen\b/i.test(lower) &&
    (/\b(payment|subscription|form|event)\b/i.test(lower) ||
     /\b(succeeds|fails|submitted)\\b/i.test(lower))
  ) {
    return CapabilityType.WEBHOOK_TRIGGERS
  }
  
  // #3 Scheduled Actions
  if (
    (/\bevery\b|\bonce\b|\bafter\b/i.test(lower) &&
     /\b(day|week|month|hour)\b/i.test(lower)) ||
    /\b(daily|weekly|monthly|nightly)\b/i.test(lower)
  ) {
    return CapabilityType.SCHEDULED_ACTIONS
  }
  
  // #4 Email Notifications
  if (
    /\bsend\b.*?\b(email|notification|message)\b/i.test(lower) ||
    /\b(email|notify|message)\b.*?\bwhen\b/i.test(lower)
  ) {
    return CapabilityType.EMAIL_NOTIFICATIONS
  }
  
  // #5 Environment Safety
  if (
    /\b(undo|rollback|revert|restore|safe|environment)\b/i.test(lower)
  ) {
    return CapabilityType.ENVIRONMENT_SAFETY
  }
  
  // #6 Data Export
  if (
    /\b(export|download|gdpr|compliance)\b/i.test(lower) &&
    /\b(data|project|database)\b/i.test(lower)
  ) {
    return CapabilityType.DATA_EXPORT
  }
  
  // #7 Admin Moderation
  if (
    /\b(admin|moderator|owner)\b/i.test(lower) &&
    /\bcan\b/i.test(lower) &&
    /\b(ban|remove|refund|reset|unlock)\b/i.test(lower)
  ) {
    return CapabilityType.ADMIN_MODERATION
  }
  
  // #8 Usage Tracking (implicit - no user-facing intent)
  // This is automatic based on other capabilities
  
  // #9 Secrets & Integrations
  if (
    /\b(use|enable|add|integrate)\b/i.test(lower) &&
    /\b(openai|gpt|ai|twilio|sms|sendgrid)\b/i.test(lower)
  ) {
    return CapabilityType.INTEGRATION_CAPABILITY
  }
  
  // #10 Audit History (automatic - always enabled)
  // This runs in background for all changes
  
  return null
}

/**
 * Parse capability-specific configuration from user message
 */
export function parseCapabilityConfig(
  capabilityType: CapabilityType,
  userMessage: string
): any | null {
  
  switch (capabilityType) {
    case CapabilityType.PAYMENT_POLICY:
      return parsePaymentPolicyIntent(userMessage)
      
    case CapabilityType.WEBHOOK_TRIGGERS:
      return parseWebhookTriggerIntent(userMessage)
      
    case CapabilityType.SCHEDULED_ACTIONS:
      return parseScheduledActionIntent(userMessage)
      
    case CapabilityType.EMAIL_NOTIFICATIONS:
      return parseEmailNotificationIntent(userMessage)
      
    case CapabilityType.ADMIN_MODERATION:
      return parseAdminPermissionIntent(userMessage)
      
    case CapabilityType.INTEGRATION_CAPABILITY:
      return parseIntegrationIntent(userMessage)
      
    default:
      return null
  }
}

/**
 * Generate execution steps for capability
 */
export function generateCapabilitySteps(
  capabilityType: CapabilityType,
  config: any
): Array<{ step: string; description: string }> {
  
  switch (capabilityType) {
    case CapabilityType.PAYMENT_POLICY:
      return [
        { step: 'PARSE_PAYMENT_POLICY', description: 'Parse payment tiers from intent' },
        { step: 'CREATE_STRIPE_ACCOUNT', description: 'Setup Stripe Connect (system-managed)' },
        { step: 'CONFIGURE_WEBHOOKS', description: 'Setup payment webhooks (invisible)' },
        { step: 'APPLY_TIER_GATING', description: 'Apply tier-based access rules' },
        { step: 'ENABLE_ENFORCEMENT', description: 'Enable runtime enforcement' }
      ]
      
    case CapabilityType.WEBHOOK_TRIGGERS:
      return [
        { step: 'PARSE_TRIGGER', description: 'Parse webhook trigger rules' },
        { step: 'CREATE_ENDPOINT', description: 'Generate webhook endpoint (hashed)' },
        { step: 'CONFIGURE_SIGNATURE', description: 'Setup signature verification' },
        { step: 'MAP_TO_ACTIONS', description: 'Map events to internal actions' },
        { step: 'ENABLE_IDEMPOTENCY', description: 'Enable duplicate prevention' }
      ]
      
    case CapabilityType.SCHEDULED_ACTIONS:
      return [
        { step: 'PARSE_TIME_INTENT', description: 'Parse time-based intent' },
        { step: 'TRANSLATE_TO_CRON', description: 'Generate cron expression (internal)' },
        { step: 'MAP_TO_ACTIONS', description: 'Map to state machine actions' },
        { step: 'CONFIGURE_IDEMPOTENCY', description: 'Setup per-run or per-record idempotency' },
        { step: 'SCHEDULE_EXECUTION', description: 'Register with cron runner' }
      ]
      
    case CapabilityType.EMAIL_NOTIFICATIONS:
      return [
        { step: 'PARSE_EMAIL_TRIGGER', description: 'Parse email trigger event' },
        { step: 'GENERATE_TEMPLATE', description: 'Generate email template' },
        { step: 'CONFIGURE_PROVIDER', description: 'Setup email provider (system-managed)' },
        { step: 'MAP_TO_EVENTS', description: 'Map to triggering events' },
        { step: 'ENABLE_COMPLIANCE', description: 'Enable unsubscribe and GDPR' }
      ]
      
    case CapabilityType.ADMIN_MODERATION:
      return [
        { step: 'PARSE_ADMIN_ROLES', description: 'Parse admin role definitions' },
        { step: 'CONFIGURE_PERMISSIONS', description: 'Configure action permissions' },
        { step: 'ENABLE_AUDIT_LOG', description: 'Enable admin action logging' },
        { step: 'MAP_TO_INVARIANTS', description: 'Map to invariant system' },
        { step: 'VERIFY_REVERSIBILITY', description: 'Configure action reversibility' }
      ]
      
    case CapabilityType.INTEGRATION_CAPABILITY:
      return [
        { step: 'PARSE_INTEGRATION', description: 'Parse integration type' },
        { step: 'STORE_SECRETS', description: 'Store secrets in vault (encrypted)' },
        { step: 'CONFIGURE_SCOPING', description: 'Scope access per project' },
        { step: 'ENABLE_ROTATION', description: 'Enable automatic key rotation' },
        { step: 'MAP_TO_ACTIONS', description: 'Map to capability actions' }
      ]
      
    case CapabilityType.ENVIRONMENT_SAFETY:
      return [
        { step: 'CREATE_VERSION', description: 'Create immutable version snapshot' },
        { step: 'RUN_SAFETY_CHECKS', description: 'Verify no data loss or breaking changes' },
        { step: 'APPLY_CHANGES', description: 'Apply changes safely' },
        { step: 'ENABLE_ROLLBACK', description: 'Enable safe undo' }
      ]
      
    case CapabilityType.DATA_EXPORT:
      return [
        { step: 'CREATE_EXPORT_REQUEST', description: 'Create export request' },
        { step: 'LOAD_DATA', description: 'Load all project data' },
        { step: 'TRANSFORM_TO_PORTABLE', description: 'Transform to portable format' },
        { step: 'GENERATE_DOWNLOAD', description: 'Generate secure download link' }
      ]
      
    default:
      return []
  }
}

/**
 * Validate capability configuration
 */
export function validateCapabilityConfig(
  capabilityType: CapabilityType,
  config: any
): { valid: boolean; errors?: string[] } {
  
  if (!config) {
    return {
      valid: false,
      errors: ['Failed to parse capability configuration']
    }
  }
  
  // Each capability has its own validation rules
  switch (capabilityType) {
    case CapabilityType.PAYMENT_POLICY:
      if (!config.tiers || Object.keys(config.tiers).length === 0) {
        return {
          valid: false,
          errors: ['Payment policy must define at least one tier']
        }
      }
      break
      
    case CapabilityType.WEBHOOK_TRIGGERS:
      if (!config.externalEvent || !config.internalAction) {
        return {
          valid: false,
          errors: ['Webhook trigger must specify external event and internal action']
        }
      }
      break
      
    case CapabilityType.SCHEDULED_ACTIONS:
      if (!config.timeIntent || !config.action) {
        return {
          valid: false,
          errors: ['Scheduled action must specify time intent and action']
        }
      }
      break
  }
  
  return { valid: true }
}
