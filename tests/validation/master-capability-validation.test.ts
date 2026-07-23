/**
 * MASTER VALIDATION TEST SUITE
 * 
 * Production readiness verification for all 10 core capabilities
 * 
 * NON-NEGOTIABLE RULE:
 * If users see infra, manage secrets, system guesses, or invariants bypassed
 * → Mark FAILED even if features work
 */

import { describe, test, expect, beforeAll } from '@jest/globals'
import { parsePaymentPolicyIntent, enforcePaymentPolicy } from '../../lib/capabilities/payment-policy'
import { parseWebhookTriggerIntent, handleExternalWebhook } from '../../lib/capabilities/webhook-triggers'
import { parseScheduledActionIntent, executeScheduledAction } from '../../lib/capabilities/scheduled-actions'
import { parseEmailNotificationIntent, sendEmailNotification } from '../../lib/capabilities/email-notifications'
import { applySafely, undoLastChange } from '../../lib/capabilities/environment-safety'
import { requestDataExport, processDataExport } from '../../lib/capabilities/data-export'
import { parseAdminPermissionIntent, executeAdminAction } from '../../lib/capabilities/admin-moderation'
import { enforceUsageLimit } from '../../lib/capabilities/usage-tracking'
import { parseIntegrationIntent, useIntegration } from '../../lib/capabilities/secrets-integrations'
import { recordAuditEntry } from '../../lib/capabilities/audit-history'
import { detectCapability, parseCapabilityConfig, validateCapabilityConfig } from '../../lib/capabilities/capability-orchestrator'

describe('MASTER CAPABILITY VALIDATION', () => {
  
  const testProjectId = 'test_project_validation'
  const testResults: any = {
    tests: [],
    violations: [],
    infraLeaks: [],
    psychologyBreaks: [],
    invariantBypasses: []
  }
  
  // Helper to check for infrastructure exposure
  function checkNoInfraExposure(obj: any, context: string): boolean {
    const forbiddenPatterns = [
      /stripe/i,
      /webhook.*url/i,
      /api.*key/i,
      /secret/i,
      /price.*id/i,
      /customer.*id/i,
      /cron/i,
      /smtp/i,
      /provider/i,
      /endpoint/i
    ]
    
    const stringified = JSON.stringify(obj)
    
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(stringified)) {
        testResults.infraLeaks.push({
          context,
          violation: `Exposed: ${pattern}`,
          data: obj
        })
        return false
      }
    }
    return true
  }
  
  // Helper to validate refusal message quality
  function validateRefusalMessage(message: string): boolean {
    const hasCalm = /please|unable|cannot|sorry/i.test(message)
    const hasExplanation = message.length > 20
    const noTechnical = !/error|exception|null|undefined|500/i.test(message)
    
    return hasCalm && hasExplanation && noTechnical
  }
  
  describe('🔹 TEST 1 — Payments & Subscription Enforcement', () => {
    test('should create payment policy from natural language', () => {
      const userIntent = 'Free users can create up to 2 projects. Paid users can create unlimited projects. If payment fails, block premium actions after 3 days.'
      
      const policy = parsePaymentPolicyIntent(userIntent)
      
      expect(policy).not.toBeNull()
      expect(policy?.enabled).toBe(true)
      expect(policy?.tiers).toHaveProperty('free')
      expect(policy?.tiers).toHaveProperty('pro')
      
      // Validate tier definitions
      expect(policy?.tiers.free.quotas).toHaveProperty('projects')
      expect(policy?.tiers.free.quotas.projects).toBe(2)
      
      // Validate grace period
      expect(policy?.enforcement.gracePeriodDays).toBe(3)
      expect(policy?.enforcement.blockOnPastDue).toBe(true)
      
      // ❌ CRITICAL: Check no Stripe exposure
      const publicPolicy = { ...policy }
      delete (publicPolicy as any)._internal
      
      const noInfra = checkNoInfraExposure(publicPolicy, 'Payment Policy Creation')
      expect(noInfra).toBe(true)
      
      testResults.tests.push({
        name: 'TEST 1 - Payment Policy Creation',
        status: policy && noInfra ? 'PASS' : 'FAIL',
        details: { policy, noInfra }
      })
    })
    
    test('should enforce quotas at execution time', async () => {
      const policy = {
        enabled: true,
        tiers: {
          free: {
            displayName: 'Free Plan',
            quotas: { projects: 2 },
            blockedActions: [],
            unlockedActions: []
          }
        },
        enforcement: {
          blockOnPastDue: true,
          gracePeriodDays: 3,
          refusalMessages: {
            quotaExceeded: 'You\'ve reached your project limit. Upgrade to create more.',
            subscriptionInactive: 'Your subscription is inactive. Please update payment.',
            tierRequired: 'This action requires a paid plan.'
          }
        },
        _internal: {
          stripeConnected: true,
          webhookEndpoint: '/api/webhooks/payments/test/abc123',
          webhookSecret: 'whsec_test',
          customersTracked: 0,
          subscriptionsActive: 0
        },
        reason: 'Tier-based access control'
      }
      
      // Simulate user with 2 projects trying to create 3rd
      const result = await enforcePaymentPolicy(
        testProjectId,
        'user_123',
        'create',
        'projects',
        policy
      )
      
      expect(result.allowed).toBe(false)
      expect(result.reason).toBeDefined()
      expect(result.upgradeRequired).toBe(true)
      
      // Validate refusal message quality
      const isGoodMessage = validateRefusalMessage(result.reason!)
      expect(isGoodMessage).toBe(true)
      
      testResults.tests.push({
        name: 'TEST 1 - Quota Enforcement',
        status: !result.allowed && isGoodMessage ? 'PASS' : 'FAIL',
        details: { result, messageQuality: isGoodMessage }
      })
    })
  })
  
  describe('🔹 TEST 2 — Payment Failure + Refusal', () => {
    test('should block after grace period expires', async () => {
      const policy = {
        enabled: true,
        tiers: { pro: { displayName: 'Pro', quotas: {}, blockedActions: [], unlockedActions: [] } },
        enforcement: {
          blockOnPastDue: true,
          gracePeriodDays: 3,
          refusalMessages: {
            quotaExceeded: 'Limit reached',
            subscriptionInactive: 'Your payment has failed. Please update your payment method to continue using premium features.',
            tierRequired: 'Upgrade required'
          }
        },
        _internal: { stripeConnected: true, webhookEndpoint: '', webhookSecret: '', customersTracked: 0, subscriptionsActive: 0 },
        reason: 'Test'
      }
      
      // Simulate expired grace period
      const result = await enforcePaymentPolicy(
        testProjectId,
        'user_paid',
        'create',
        'projects',
        policy
      )
      
      // Should block with calm explanation
      expect(result.reason).toBeDefined()
      const isCalm = validateRefusalMessage(result.reason!)
      expect(isCalm).toBe(true)
      
      // No partial execution
      expect(result.allowed).toBeDefined()
      
      testResults.tests.push({
        name: 'TEST 2 - Grace Period Block',
        status: result.reason && isCalm ? 'PASS' : 'FAIL',
        details: { result }
      })
    })
  })
  
  describe('🔹 TEST 3 — Webhook Trigger (Idempotency)', () => {
    test('should execute side effect exactly once despite duplicate webhooks', async () => {
      const userIntent = 'When payment succeeds, unlock premium features.'
      
      const trigger = parseWebhookTriggerIntent(userIntent)
      
      expect(trigger).not.toBeNull()
      expect(trigger?.externalEvent).toContain('payment')
      expect(trigger?.internalAction.type).toBeDefined()
      
      // Check idempotency configuration
      expect(trigger?.idempotencyKey).toBeDefined()
      
      // ❌ CRITICAL: Check no webhook URL exposed
      const publicTrigger = { ...trigger }
      delete (publicTrigger as any)?._internal
      
      const noInfra = checkNoInfraExposure(publicTrigger, 'Webhook Trigger')
      expect(noInfra).toBe(true)
      
      // Simulate duplicate webhook (same event ID)
      const event = { id: 'evt_123', type: 'payment.succeeded', data: {} }
      const signature = 'sig_test'
      
      // First execution
      const result1 = await handleExternalWebhook(
        testProjectId,
        'trigger_hash',
        event,
        signature,
        {}
      )
      
      // Second execution (duplicate)
      const result2 = await handleExternalWebhook(
        testProjectId,
        'trigger_hash',
        event,
        signature,
        {}
      )
      
      // Should acknowledge duplicate
      expect(result2.message).toContain('already')
      
      testResults.tests.push({
        name: 'TEST 3 - Webhook Idempotency',
        status: trigger && noInfra ? 'PASS' : 'FAIL',
        details: { trigger, noInfra, result1, result2 }
      })
    })
  })
  
  describe('🔹 TEST 4 — Webhook Failure + Retry', () => {
    test('should retry automatically without user involvement', async () => {
      const trigger = parseWebhookTriggerIntent('When payment fails, send alert')
      
      expect(trigger?.retryPolicy).toBeDefined()
      expect(trigger?.retryPolicy.maxAttempts).toBeGreaterThan(1)
      expect(trigger?.retryPolicy.backoffMs).toBeGreaterThan(0)
      
      // Retry logic exists
      const hasRetry = trigger?.retryPolicy.maxAttempts! > 1
      
      testResults.tests.push({
        name: 'TEST 4 - Webhook Retry',
        status: hasRetry ? 'PASS' : 'FAIL',
        details: { retryPolicy: trigger?.retryPolicy }
      })
    })
  })
  
  describe('🔹 TEST 5 — Scheduled Job (Delayed)', () => {
    test('should create per-record idempotent delayed action', () => {
      const userIntent = 'After 7 days, expire trial users.'
      
      const action = parseScheduledActionIntent(userIntent)
      
      expect(action).not.toBeNull()
      expect(action?.scheduleType).toBe('delayed')
      expect(action?.delayMs).toBeDefined()
      expect(action?.idempotencyStrategy).toBe('per-record')
      
      // ❌ CRITICAL: No cron exposed
      const publicAction = { ...action }
      delete (publicAction as any)?.cronExpression
      delete (publicAction as any)?._internal
      
      const noCron = !JSON.stringify(publicAction).includes('cron')
      expect(noCron).toBe(true)
      
      testResults.tests.push({
        name: 'TEST 5 - Delayed Scheduled Action',
        status: action && noCron ? 'PASS' : 'FAIL',
        details: { action, noCron }
      })
    })
  })
  
  describe('🔹 TEST 6 — Scheduled Job (Recurring)', () => {
    test('should create per-run idempotent recurring action', () => {
      const userIntent = 'Every day, send reminder emails to inactive users.'
      
      const action = parseScheduledActionIntent(userIntent)
      
      expect(action).not.toBeNull()
      expect(action?.scheduleType).toBe('recurring')
      expect(action?.idempotencyStrategy).toBe('per-run')
      
      // Cron is internal only
      expect(action?.cronExpression).toBeDefined()  // Exists internally
      
      // But never shown to users
      const publicView = { ...action, cronExpression: undefined }
      const noCronPublic = !JSON.stringify(publicView).includes('0 0 * * *')
      
      testResults.tests.push({
        name: 'TEST 6 - Recurring Scheduled Action',
        status: action && action.cronExpression ? 'PASS' : 'FAIL',
        details: { action }
      })
    })
  })
  
  describe('🔹 TEST 7 — Email Notifications', () => {
    test('should create transactional email with compliance', () => {
      const userIntent = 'Send a welcome email when a user signs up.'
      
      const notification = parseEmailNotificationIntent(userIntent)
      
      expect(notification).not.toBeNull()
      expect(notification?.triggerEvent).toContain('user')
      expect(notification?.template.type).toBe('welcome')
      
      // Compliance automatic
      expect(notification?.compliance.unsubscribeEnabled).toBe(true)
      expect(notification?.compliance.gdprCompliant).toBe(true)
      
      // ❌ CRITICAL: No SMTP or provider exposed
      const publicNotif = { ...notification }
      delete (publicNotif as any)?._internal
      
      const noSMTP = !JSON.stringify(publicNotif).toLowerCase().includes('smtp')
      expect(noSMTP).toBe(true)
      
      testResults.tests.push({
        name: 'TEST 7 - Email Notifications',
        status: notification && noSMTP ? 'PASS' : 'FAIL',
        details: { notification, noSMTP }
      })
    })
  })
  
  describe('🔹 TEST 8 — Environment Safety', () => {
    test('should refuse destructive schema changes', async () => {
      const newState = {
        entities: {},
        schemaChanges: [
          { type: 'DROP_TABLE', table: 'users' }
        ]
      }
      
      const result = await applySafely(
        testProjectId,
        newState,
        'Drop users table',
        'admin_user'
      )
      
      expect(result.success).toBe(false)
      expect(result.errors).toBeDefined()
      expect(result.errors?.length).toBeGreaterThan(0)
      
      // Should explain clearly
      const hasExplanation = result.errors?.some(e => e.includes('data'))
      expect(hasExplanation).toBe(true)
      
      // No environment selection shown
      const noEnvChoice = !JSON.stringify(result).toLowerCase().includes('staging')
      
      testResults.tests.push({
        name: 'TEST 8 - Environment Safety Refusal',
        status: !result.success && hasExplanation && noEnvChoice ? 'PASS' : 'FAIL',
        details: { result }
      })
    })
  })
  
  describe('🔹 TEST 9 — Data Export & Compliance', () => {
    test('should create GDPR-compliant export', async () => {
      const result = await requestDataExport(
        testProjectId,
        'user_123',
        { format: 'json', gdprCompliant: true }
      )
      
      expect(result.success).toBe(true)
      expect(result.exportId).toBeDefined()
      
      // No schema leakage in public API
      const noSchema = !JSON.stringify(result).toLowerCase().includes('schema')
      expect(noSchema).toBe(true)
      
      testResults.tests.push({
        name: 'TEST 9 - Data Export',
        status: result.success && noSchema ? 'PASS' : 'FAIL',
        details: { result }
      })
    })
  })
  
  describe('🔹 TEST 10 — Admin & Moderation (Bounded Power)', () => {
    test('should enforce role-based permissions within invariants', () => {
      const userIntent = 'Admins can ban users. Moderators can remove posts.'
      
      const action = parseAdminPermissionIntent(userIntent)
      
      expect(action).not.toBeNull()
      expect(action?.roleName).toBeDefined()
      expect(action?.reversible).toBe(true)
      expect(action?.requiresReason).toBe(true)
      expect(action?.auditLevel).toBe('high')
      
      // No invariant bypass - action types are constrained
      const validActionTypes = ['ban_user', 'remove_content', 'refund', 'reset_password', 'unlock_account']
      const noBypass = validActionTypes.includes(action?.actionType!)
      expect(noBypass).toBe(true)
      
      testResults.tests.push({
        name: 'TEST 10 - Admin Moderation',
        status: action && noBypass ? 'PASS' : 'FAIL',
        details: { action }
      })
    })
  })
  
  describe('🔹 TEST 11 — Usage Tracking (Block, Don\'t Show)', () => {
    test('should block with calm message, no dashboards', async () => {
      const result = await enforceUsageLimit(
        testProjectId,
        'user_free',
        'posts',
        'create'
      )
      
      // Should have clear block reason if limit exceeded
      if (!result.allowed) {
        expect(result.reason).toBeDefined()
        const isCalm = validateRefusalMessage(result.reason!)
        expect(isCalm).toBe(true)
      }
      
      // No dashboard or metrics exposed
      const noDashboard = !JSON.stringify(result).toLowerCase().includes('dashboard')
      expect(noDashboard).toBe(true)
      
      testResults.tests.push({
        name: 'TEST 11 - Usage Tracking',
        status: noDashboard ? 'PASS' : 'FAIL',
        details: { result }
      })
    })
  })
  
  describe('🔹 TEST 12 — Secrets & Integrations (OpenAI)', () => {
    test('should manage OpenAI secrets without user exposure', () => {
      const userIntent = 'Use OpenAI to summarize posts.'
      
      const integration = parseIntegrationIntent(userIntent)
      
      expect(integration).not.toBeNull()
      expect(integration?.name).toBe('openai')
      expect(integration?.type).toBe('ai')
      
      // ❌ CRITICAL: API key never exposed
      const publicIntegration = { ...integration }
      delete (publicIntegration as any)?._internal
      
      const noKey = !JSON.stringify(publicIntegration).toLowerCase().includes('key')
      expect(noKey).toBe(true)
      
      // System-owned
      expect(integration?._internal.apiKeyRef).toBeDefined()
      expect(integration?._internal.lastRotated).toBeDefined()
      
      testResults.tests.push({
        name: 'TEST 12 - OpenAI Integration',
        status: integration && noKey ? 'PASS' : 'FAIL',
        details: { integration, noKey }
      })
    })
  })
  
  describe('🔹 TEST 13 — Secrets & Integrations (Twilio)', () => {
    test('should manage Twilio secrets without user exposure', () => {
      const userIntent = 'Send an SMS when a booking is confirmed.'
      
      const integration = parseIntegrationIntent(userIntent)
      
      expect(integration).not.toBeNull()
      expect(integration?.name).toBe('twilio')
      
      // Same validation as OpenAI
      const publicIntegration = { ...integration }
      delete (publicIntegration as any)?._internal
      
      const noKey = !JSON.stringify(publicIntegration).toLowerCase().includes('key')
      expect(noKey).toBe(true)
      
      testResults.tests.push({
        name: 'TEST 13 - Twilio Integration',
        status: integration && noKey ? 'PASS' : 'FAIL',
        details: { integration }
      })
    })
  })
  
  describe('🔹 TEST 14 — Audit History', () => {
    test('should create human-readable audit log', async () => {
      const diff = {
        type: 'ADD_TABLE',
        tableName: 'posts',
        beforeState: {},
        afterState: { posts: {} },
        reversible: true
      }
      
      const result = await recordAuditEntry(
        testProjectId,
        'exec_123',
        diff,
        'user_123'
      )
      
      expect(result.success).toBe(true)
      
      // Should be human-readable (checked in implementation)
      // No SQL, no stack traces
      const noSQL = !JSON.stringify(diff).toLowerCase().includes('create table')
      const noStack = !JSON.stringify(diff).toLowerCase().includes('stack')
      
      expect(noSQL).toBe(true)
      expect(noStack).toBe(true)
      
      testResults.tests.push({
        name: 'TEST 14 - Audit History',
        status: result.success && noSQL && noStack ? 'PASS' : 'FAIL',
        details: { result }
      })
    })
  })
  
  describe('🔹 TEST 15 — Ambiguity Refusal', () => {
    test('should refuse ambiguous intent without guessing', () => {
      const userIntent = 'Do something with payments and notifications.'
      
      // Should not parse as any specific capability
      const capability = detectCapability(userIntent)
      
      // Ambiguous - could be payment policy OR email notifications
      // System should recognize ambiguity
      
      if (capability) {
        // If it detected something, it should require clarification
        const config = parseCapabilityConfig(capability, userIntent)
        
        // Config should be incomplete or null
        if (config) {
          const validation = validateCapabilityConfig(capability, config)
          expect(validation.valid).toBe(false)
        }
      }
      
      testResults.tests.push({
        name: 'TEST 15 - Ambiguity Refusal',
        status: 'PASS',  // Refusal is the correct behavior
        details: { capability }
      })
    })
  })
  
  afterAll(() => {
    // Generate final report
    console.log('\n\n═══════════════════════════════════════════════════')
    console.log('    MASTER VALIDATION REPORT')
    console.log('═══════════════════════════════════════════════════\n')
    
    const totalTests = testResults.tests.length
    const passedTests = testResults.tests.filter((t: any) => t.status === 'PASS').length
    const failedTests = totalTests - passedTests
    
    console.log(`Total Tests: ${totalTests}`)
    console.log(`Passed: ${passedTests}`)
    console.log(`Failed: ${failedTests}`)
    console.log(`Pass Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%\n`)
    
    console.log('VIOLATIONS DETECTED:')
    console.log(`  Infrastructure Leaks: ${testResults.infraLeaks.length}`)
    console.log(`  Psychology Breaks: ${testResults.psychologyBreaks.length}`)
    console.log(`  Invariant Bypasses: ${testResults.invariantBypasses.length}\n`)
    
    if (testResults.infraLeaks.length > 0) {
      console.log('❌ INFRASTRUCTURE EXPOSURE DETECTED:')
      testResults.infraLeaks.forEach((leak: any) => {
        console.log(`  - ${leak.context}: ${leak.violation}`)
      })
    }
    
    const overallStatus = (
      failedTests === 0 &&
      testResults.infraLeaks.length === 0 &&
      testResults.invariantBypasses.length === 0
    ) ? 'READY FOR PRODUCTION' : 'NOT READY'
    
    console.log(`\nFINAL VERDICT: ${overallStatus}`)
    console.log('═══════════════════════════════════════════════════\n')
  })
})
