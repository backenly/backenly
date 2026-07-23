import { BackendStateGraph } from './backend-state-graph'
import { enhanceGuidanceMessage, summarizeMessyPrompt, generateDemoContent } from './ai-assistant'
import { CanonicalIntent, IntentType, Domain, Action, IntentStatus } from './types'

/**
 * Determine initial intent status based on confidence and constraints
 * 
 * DRAFT: Needs clarification (ambiguous, low confidence)
 * READY: AI is confident, awaiting user confirmation to execute
 * COMMITTED: Auto-commit for clear executable behaviors (NEW!)
 * EXECUTED: Execution completed (set by executor)
 */
function determineIntentStatus(
  confidence: number,
  constraints: Record<string, any>,
  userMessage: string
): IntentStatus {
  // If it's guidance/clarification/demo/guardrail, it's DRAFT
  if (constraints.isAmbiguous || constraints.isBeginnerGuidance || constraints.isDemo || constraints.isGuardrail) {
    return 'DRAFT'
  }
  
  // 🚀 AUTO-COMMIT: If user provides clear executable behavior, skip confirmation
  // These patterns indicate user knows what they want - execute immediately
  const hasExecutableVerb = /\b(sign up|signup|sign in|signin|log in|login|create|add|upload|delete|remove|enable|disable|allow|restrict|update|modify|track|notify|send|charge|pay|deploy|launch|go live|make it live)\b/i.test(userMessage)
  const hasEntity = /\b(user|users|account|accounts|post|posts|comment|comments|photo|photos|image|images|file|files|payment|payments|order|orders)\b/i.test(userMessage)
  
  // If it has executable verb + entity + high confidence → AUTO-COMMIT
  if (hasExecutableVerb && hasEntity && confidence >= 0.90) {
    console.log('[Intent Parser] 🚀 AUTO-COMMIT: Clear executable behavior detected')
    return 'COMMITTED'  // Skip confirmation, execute immediately!
  }
  
  // If confidence >= 0.85, it's READY for user confirmation
  if (confidence >= 0.85) {
    return 'READY'
  }
  
  // Otherwise, needs more clarification
  return 'DRAFT'
}

/**
 * Helper to create intent with automatic status determination
 */
function createIntent(intent: Omit<CanonicalIntent, 'status'>): CanonicalIntent {
  return {
    ...intent,
    status: determineIntentStatus(intent.confidence, intent.constraints, intent.source_text)
  }
}

/**
 * Phase 1: Intent Canonicalization Layer
 * 
 * Converts natural language into strict, deterministic intent objects.
 * Same input ALWAYS produces same output.
 * 
 * This is Backenly's moat - stability and reproducibility.
 */

/**
 * Parse natural language into canonical intent
 * 
 * CRITICAL: Same input MUST produce same output
 */
export async function parseIntent(userMessage: string, graph: BackendStateGraph): Promise<CanonicalIntent> {
  const normalized = userMessage.trim().toLowerCase().replace(/[’‘]/g, "'")
  
  // Phase 0: Detect Intent Supersession (Elite Polish)
  const isOverride = /\b(actually|instead|change that|no wait|scratch that)\b/i.test(normalized)
  
  // Resolve pronouns based on state graph context
  const resolution = resolvePronouns(normalized, graph)
  
  // Handle override metadata
  if (isOverride) {
    console.log(`[Intent Parser] Detected override phrase in: "${userMessage}"`)
  }

  let intent: CanonicalIntent;

  if (resolution.isAmbiguous) {
    intent = createIntent({
      intent_type: 'QUERY',
      domain: 'SYSTEM',
      action: 'ALLOW',
      target: 'clarification',
      constraints: {
        isAmbiguous: true,
        message: resolution.clarification,
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 1.0,
    })
  } else if (
    /\b(i don't know backend|not technical|just have an idea|help me build|where do i start|don't know where to start|don't know what to do)\b/i.test(normalized) ||
    (normalized.length > 50 && /\b(like instagram|like uber|like airbnb|like tiktok|social media app|ecommerce|marketplace|build instagram backend)\b/i.test(normalized) && !/\b(sign up|log in|create|add|upload|delete|remove|enable|disable)\b/i.test(normalized))
  ) {
    const baseMessage = "I hear you, and don't worry—you don't need any technical knowledge to build this. I'll handle all the complex setup for you.\n\nIt sounds like you're building a social space where people can share and connect. To get started, we just need to define how people will interact with your app. Tell me, what should your users be able to do first? For example, should they be able to 'sign up', 'post photos', or 'like posts'?"
    
    // AI Enhancement (Product Manager Voice)
    const enhancedMessage = await enhanceGuidanceMessage(userMessage, baseMessage)

    intent = createIntent({
      intent_type: 'QUERY',
      domain: 'SYSTEM',
      action: 'ALLOW',
      target: 'guidance',
      reason: 'BEGINNER_GUIDANCE',
      constraints: {
        isBeginnerGuidance: true,
        message: enhancedMessage,
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 1.0,
    })
  } else {
    // ... the rest of the logic ...
    // This is too big to refactor in one go easily without breaking everything.
    // I'll just add it to the individual blocks I already modified and the final return.
    
    // BACKTRACK: I'll just add it to the return objects I can see.
    return { ...await parseActualIntent(userMessage, graph, resolution), isOverride };
  }

  intent.isOverride = isOverride;
  return intent;
}

async function parseActualIntent(userMessage: string, graph: BackendStateGraph, resolution: any): Promise<CanonicalIntent> {
  const normalized = userMessage.trim().toLowerCase()
  const effectiveText = resolution.text
  
  // DEMO patterns
  if (/\b(how does it work|show me a demo|give me examples|what can you do|demo)\b/i.test(normalized)) {
    const topic = normalized.replace(/\b(how does it work|show me a demo|give me examples|what can you do|demo)\b/gi, '').trim() || 'general'
    const demo = await generateDemoContent(topic)
    
    return createIntent({
      intent_type: 'QUERY',
      domain: 'SYSTEM',
      action: 'ALLOW',
      target: 'demo',
      constraints: {
        isDemo: true,
        message: demo.explanation,
        samples: demo.samples
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 1.0,
    })
  }

  // Pattern matching for stability
  // Each pattern maps to ONE canonical intent
  
  // PHASE 10: GUARDRAILS for unsupported features (Check FIRST)
  if (/\b(video calls?|video chats?|facetime|webrtc)\b/i.test(effectiveText)) {
    return createIntent({
      intent_type: 'QUERY',
      domain: 'SYSTEM',
      action: 'ALLOW',
      target: 'guardrail',
      constraints: {
        isGuardrail: true,
        message: "Realtime video calls aren't supported yet — but chat is.",
        suggestion: "Try: 'Enable realtime chat'"
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.99,
    })
  }

  if (/\b(transcodes?|transcoding|resize video|video compressions?)\b/i.test(effectiveText)) {
    return createIntent({
      intent_type: 'QUERY',
      domain: 'SYSTEM',
      action: 'ALLOW',
      target: 'guardrail',
      constraints: {
        isGuardrail: true,
        message: "Automatic video transcoding isn't supported yet — but file storage is.",
        suggestion: "Try: 'Allow users to upload videos'"
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.99,
    })
  }

  if (/\b(multi-region|multi region|global deploy|edge computing)\b/i.test(effectiveText)) {
    return createIntent({
      intent_type: 'QUERY',
      domain: 'SYSTEM',
      action: 'ALLOW',
      target: 'guardrail',
      constraints: {
        isGuardrail: true,
        message: "Multi-region deployment is an Enterprise feature and isn't supported in the standard tier yet.",
        suggestion: "Try: 'Make my app live' for standard deployment."
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.99,
    })
  }

  if (/\b(ai image|generate image|dall-e|stable diffusion|midjourney)\b/i.test(effectiveText)) {
    return createIntent({
      intent_type: 'QUERY',
      domain: 'SYSTEM',
      action: 'ALLOW',
      target: 'guardrail',
      constraints: {
        isGuardrail: true,
        message: "AI image generation isn't supported yet — but image storage is.",
        suggestion: "Try: 'Allow users to upload images'"
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.99,
    })
  }

  // ROLLBACK patterns
  if (
    /\b(undo|revert|rollback|roll back)\b/i.test(effectiveText) &&
    (/\b(last|previous|recent|latest|change|update|modification|what i did|my last|it|that|those|them|everything)\b/i.test(effectiveText) || 
     effectiveText.split(/\s+/).length <= 2)
  ) {
    return createIntent({
      intent_type: 'ROLLBACK',
      domain: 'DEPLOYMENT',
      action: 'UNDO',
      target: 'last_change',
      constraints: {},
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.98,
    })
  }
  
  // SCHEMA definition patterns ("Posts have title and content")
  if (
    /\b(\w+s?)\b.*(have|has|contains|contains a|with).*\b(\w+)\b/i.test(effectiveText) &&
    !/\b(let|allow|enable|support|should|can|add)\b/i.test(effectiveText) &&
    /\b(post|user|comment|order|item|product|customer|invoice|review|message|booking)\b/i.test(effectiveText)
  ) {
    const entityName = extractEntityName(effectiveText)
    const fields = extractFields(effectiveText)
    return createIntent({
      intent_type: 'DATA_MODEL_MODIFY',
      domain: 'DATABASE',
      action: 'UPDATE',
      target: entityName,
      constraints: {
        isSchemaUpdate: true,
        fields: fields.length > 0 ? fields : undefined,
        fullText: effectiveText
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.95,
    })
  }

  // RBAC patterns ("Only admins can delete posts")
  if (
    /\b(only|just|let|allow|disable|enable|prevent|restrict|deny|require).*(admin|owner|manager|moderator|verified users?|logged-in users?|guests?|free users?|paid users?).*(can|allow|should|able to|cannot|should not|must not|to|do that|create|delete|remove|edit|update|view|see|payment)\b/i.test(effectiveText) ||
    /\b(admin|owner|manager|moderator|verified users?|logged-in users?|guests?|free users?|paid users?).*(can|allow|should|able to|cannot|should not|must not|to|do that|create|delete|remove|edit|update|view|see|payment)\b/i.test(effectiveText) ||
    /\b(disable|enable|restrict|allow|require).*(for|to|after)\s+(admin|owner|manager|moderator|verified users?|logged-in users?|guests?|free users?|paid users?|payment)\b/i.test(effectiveText)
  ) {
    const roleMatch = effectiveText.match(/\b(admin|owner|manager|moderator|verified users?|logged-in users?|guests?|free users?|paid users?)\b/i)
    const role = roleMatch ? roleMatch[0] : 'admin'
    const resourceMatch = effectiveText.match(/\b(posts?|comments?|items?|products?|users?|orders?|records?|projects?)\b/i)
    const resource = resourceMatch ? resourceMatch[0] : undefined

    return createIntent({
      intent_type: 'ACCESS_CONTROL',
      domain: 'AUTH',
      action: /\b(cannot|should not|must not|disable|prevent|restrict|deny|require)\b/i.test(effectiveText) ? 'RESTRICT' : 'ALLOW',
      feature: 'RBAC_POLICY',
      target: role,
      constraints: {
        role,
        resource,
        isPolicy: true
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.96,
    })
  }

  // QUOTA/LIMIT patterns ("Limit file size")
  if (
    /\b(limit|restrict|quota|max|maximum).*(size|count|number|amount|usage)\b/i.test(effectiveText)
  ) {
    const domain = effectiveText.includes('file') || effectiveText.includes('storage') ? 'STORAGE' : 
                   effectiveText.includes('api') || effectiveText.includes('request') ? 'API' : 'SYSTEM'
    
    return createIntent({
      intent_type: 'ACCESS_CONTROL',
      domain: domain as Domain,
      action: 'RESTRICT',
      target: 'resource_limit',
      constraints: {
        isQuota: true,
        limit: effectiveText.match(/\d+/)?.[0] || 'default'
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.94,
    })
  }

  // REALTIME patterns
  if (
    /\b(realtime|real-time|live|chat|websocket|pubsub|subscribe)\b/i.test(effectiveText) &&
    /\b(let|allow|enable|support|should|can|add)\b/i.test(effectiveText)
  ) {
    return createIntent({
      intent_type: 'INTEGRATION',
      domain: 'SYSTEM',
      action: 'ENABLE',
      feature: 'REALTIME_SYNC',
      target: effectiveText.match(/\b(chat|updates|notifications)\b/i)?.[0] || 'general_sync',
      constraints: {
        isCapability: true,
        channelName: effectiveText.match(/\b(chat|updates|notifications)\b/i)?.[0] || 'general_sync',
        permissions: effectiveText.includes('public') ? 'public' : 'protected',
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.96,
    })
  }

  // SEARCH & ANALYTICS patterns
  if (
    /\b(search|find|track|analytics|metrics|usage|stats|elasticsearch|algolia)\b/i.test(effectiveText) &&
    /\b(let|allow|enable|support|should|can|add|how many|setup|integrate)\b/i.test(effectiveText)
  ) {
    const isSearch = /\b(search|find)\b/i.test(effectiveText)
    const entity = effectiveText.match(/\b(posts?|users?|comments?|orders?|items?|products?)\b/i)?.[0] || 'all'
    const metric = effectiveText.match(/\b(usage|error|latency|visitor|view|stats)\b/i)?.[0] || 'system_activity'

    return createIntent({
      intent_type: 'INTEGRATION',
      domain: 'SYSTEM',
      action: 'ENABLE',
      feature: isSearch ? 'SEARCH_INDEXING' : 'USAGE_ANALYTICS',
      target: isSearch ? entity : metric,
      constraints: {
        isCapability: true,
        entity: entity,
        metric: metric,
        retention: effectiveText.includes('year') ? '365d' : '30d',
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.97,
    })
  }

  // MESSAGING & EMAIL patterns
  if (
    /\b(email|send email|welcome email|notify users by email)\b/i.test(effectiveText) ||
    (/\b(email)\b/i.test(effectiveText) && /\b(password reset|signup|registration|welcome)\b/i.test(effectiveText))
  ) {
    const template = effectiveText.includes('welcome') ? 'Welcome Email' : 
                     effectiveText.includes('password') ? 'Password Reset' : 'Notification'
    
    return createIntent({
      intent_type: 'INTEGRATION',
      domain: 'SYSTEM',
      action: 'ENABLE',
      feature: 'EMAIL_MESSAGING',
      target: template,
      constraints: {
        isCapability: true,
        templateName: template,
        triggerEvent: effectiveText.includes('welcome') ? 'user.created' : 
                      effectiveText.includes('password') ? 'auth.password_reset' : 'manual',
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.98,
    })
  }

  // PAYMENT POLICY patterns (Inner Layer - User Apps Charging THEIR Users)
  // This is NOT Backenly billing (Paddle). This is Merchant-of-Record for user apps.
  if (
    (/\b(free|paid|pro|premium|basic|tier|plan)\b/i.test(effectiveText) &&
     /\b(users|user|customers|can|cannot|allowed|limited|unlimited)\b/i.test(effectiveText) &&
     /\b(create|add|upload|post|publish|access|view|edit|delete)\b/i.test(effectiveText)) ||
    (/\b(subscription|payment)\b/i.test(effectiveText) &&
     /\b(unpaid|inactive|block|restrict|grace|period)\b/i.test(effectiveText))
  ) {
    return createIntent({
      intent_type: 'ACCESS_CONTROL',
      domain: 'SYSTEM',
      action: 'ENABLE',
      feature: 'PAYMENT_POLICY',
      target: 'tier_based_access',
      constraints: {
        isCapability: true,
        userMessage: effectiveText,
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.96,
    })
  }

  // SCHEDULED ACTIONS patterns (#3)
  if (
    (/\bevery\b|\bonce\b|\bafter\b/i.test(effectiveText) &&
     /\b(day|week|month|hour|night|morning)\b/i.test(effectiveText)) ||
    /\b(daily|weekly|monthly|nightly)\b/i.test(effectiveText)
  ) {
    return createIntent({
      intent_type: 'INFRASTRUCTURE',
      domain: 'SYSTEM',
      action: 'ENABLE',
      feature: 'SCHEDULED_ACTIONS',
      target: 'time_based_execution',
      constraints: {
        isCapability: true,
        userMessage: effectiveText,
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.95,
    })
  }

  // WEBHOOK TRIGGERS patterns (#2)
  if (
    /\bwhen\b/i.test(effectiveText) &&
    (/\b(payment|subscription|form|event|webhook)\b/i.test(effectiveText) ||
     /\b(succeeds|fails|submitted|created|updated|deleted|canceled)\b/i.test(effectiveText))
  ) {
    return createIntent({
      intent_type: 'INFRASTRUCTURE',
      domain: 'SYSTEM',
      action: 'ENABLE',
      feature: 'WEBHOOK_TRIGGERS',
      target: 'external_events',
      constraints: {
        isCapability: true,
        userMessage: effectiveText,
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.95,
    })
  }

  // EMAIL NOTIFICATIONS patterns (#4)
  if (
    /\bsend\b.*?\b(email|notification|message)\b/i.test(effectiveText) ||
    /\b(email|notify|message|alert)\b.*?\bwhen\b/i.test(effectiveText)
  ) {
    return createIntent({
      intent_type: 'INFRASTRUCTURE',
      domain: 'SYSTEM',
      action: 'ENABLE',
      feature: 'EMAIL_NOTIFICATIONS',
      target: 'transactional_emails',
      constraints: {
        isCapability: true,
        userMessage: effectiveText,
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.94,
    })
  }

  // ADMIN MODERATION patterns (#7)
  if (
    /\b(admin|moderator|owner|manager)\b/i.test(effectiveText) &&
    /\bcan\b/i.test(effectiveText) &&
    /\b(ban|remove|refund|reset|unlock|moderate)\b/i.test(effectiveText)
  ) {
    return createIntent({
      intent_type: 'ACCESS_CONTROL',
      domain: 'SYSTEM',
      action: 'ENABLE',
      feature: 'ADMIN_MODERATION',
      target: 'role_based_actions',
      constraints: {
        isCapability: true,
        userMessage: effectiveText,
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.96,
    })
  }

  // SECRETS & INTEGRATIONS patterns (#9)
  if (
    /\b(use|enable|add|integrate)\b/i.test(effectiveText) &&
    /\b(openai|gpt|ai|twilio|sms|sendgrid|email)\b/i.test(effectiveText)
  ) {
    return createIntent({
      intent_type: 'INTEGRATION',
      domain: 'SYSTEM',
      action: 'ENABLE',
      feature: 'INTEGRATION_CAPABILITY',
      target: 'system_managed_secrets',
      constraints: {
        isCapability: true,
        userMessage: effectiveText,
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.94,
    })
  }

  // Old webhook pattern (keep for backward compatibility)
  if (
    /\b(notify|send|webhook|slack|zapier|emit|trigger|event)\b/i.test(effectiveText) &&
    /\b(when|on|every time|signup|order|created|updated|shipped)\b/i.test(effectiveText)
  ) {
    const isWebhook = /\b(webhook|slack|zapier|notify)\b/i.test(effectiveText)
    const eventName = effectiveText.includes('signup') ? 'user.created' : 
                      effectiveText.includes('order') ? 'order.created' : 'system.event'
    
    return createIntent({
      intent_type: 'INTEGRATION',
      domain: 'SYSTEM',
      action: 'ENABLE',
      feature: isWebhook ? 'WEBHOOKS' : 'EVENTS',
      target: eventName,
      constraints: {
        isCapability: true,
        url: effectiveText.match(/https?:\/\/[^\s]+/i)?.[0] || 'https://hooks.slack.com/services/internal',
        eventName: eventName,
        subscriber: effectiveText.includes('slack') ? 'slack' : 
                    effectiveText.includes('zapier') ? 'zapier' : 'external_service',
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.96,
    })
  }


  // BACKGROUND JOBS patterns
  if (
    /\b(background|job|later|queue|schedule|async|asynchronously|cron|nightly|weekly)\b/i.test(effectiveText) &&
    /\b(run|process|send|do|task|worker)\b/i.test(effectiveText)
  ) {
    return createIntent({
      intent_type: 'INFRASTRUCTURE',
      domain: 'SYSTEM',
      action: 'ENABLE',
      feature: 'BACKGROUND_JOBS',
      target: effectiveText.match(/\b(email|upload|report|analytics|cleanup)\b/i)?.[0] || 'general_task',
      constraints: {
        isCapability: true,
        trigger: effectiveText.includes('nightly') || effectiveText.includes('weekly') || effectiveText.includes('schedule') ? 'schedule' : 'event',
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.95,
    })
  }

  // POLICY & TRACKING patterns
  if (
    /\b(track|audit|monitor|record|history|log|audit log|track last login|ip address|device|location|lock account|failed login|two-factor|2fa|verify email|reset password)\b/i.test(effectiveText) &&
    /\b(let|allow|enable|can|support|should|must|have|want|automatic|auto)\b/i.test(effectiveText) &&
    !/\b(log in|sign in|sign up)\b/i.test(effectiveText)
  ) {
    const domain = /\b(login|log in|auth|password|email|2fa|two-factor)\b/i.test(effectiveText) ? 'AUTH' : 'MONITORING'
    const feature = effectiveText.includes('track') ? 'TRACKING_POLICY' : 
                    effectiveText.includes('log') ? 'LOGGING_POLICY' :
                    effectiveText.includes('lock') ? 'SECURITY_POLICY' : 'SYSTEM_POLICY'
    
    return createIntent({
      intent_type: 'ACCESS_CONTROL',
      domain: domain as Domain,
      action: 'ENABLE',
      feature: feature,
      target: effectiveText.match(/\b(login|ip|device|location|password|email|account)\b/i)?.[0] || 'system',
      constraints: {
        isPolicy: true,
        strictEnforcement: /\b(must|require|force)\b/i.test(effectiveText),
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.98,
    })
  }
  // Patterns: "Make it live", "Go live", "Launch this app", "Deploy my backend to production"
  if (
    /\b(make it live|go live|launch)/i.test(effectiveText) ||
    /\b(make).*(app|backend).*(live|public)/i.test(effectiveText) ||
    /\b(deploy|publish|ship).*(backend|app|it|this|my|to production|live|production)/i.test(effectiveText) ||
    /^(deploy|publish|ship)(\s+(it|this|my))?$/i.test(effectiveText)
  ) {
    return createIntent({
      intent_type: 'DEPLOYMENT',
      domain: 'DEPLOYMENT',
      action: 'DEPLOY',
      constraints: {
        environment: 'production',
        provider: 'local', // Default to Backenly Hosted Runtime
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.97,
    })
  }

  // CONNECT FRONTEND patterns
  // Patterns: "Connect my app at http://localhost:5173", "Connect https://myapp.com", "Disconnect http://localhost:3000"
  if (
    /\b(connect|bind|link|attach).*(app|frontend|website|site|client).*(at|to|@|url|origin|domain)/i.test(effectiveText) ||
    /\b(connect|bind|link|attach).*(http|https|localhost|www\.|[a-z0-9-]+\.com|[a-z0-9-]+\.app)/i.test(effectiveText) ||
    /^connect\s+(http|https)/i.test(effectiveText)
  ) {
    // Extract URL from the message
    const urlMatch = effectiveText.match(/(https?:\/\/[^\s]+|localhost[:\d]*|[a-z0-9-]+\.[a-z0-9-]+(?:\.[a-z]+)?)/i)
    const frontendUrl = urlMatch ? urlMatch[0] : ''

    return createIntent({
      intent_type: 'FRONTEND_CONNECTION',
      domain: 'DEPLOYMENT',
      action: 'CONNECT',
      target: frontendUrl,
      constraints: {
        frontendUrl,
        requiresConfirmation: true,
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.98,
    })
  }

  // DISCONNECT FRONTEND patterns
  if (
    /\b(disconnect|unbind|unlink|detach|remove).*(app|frontend|website|site|client)/i.test(effectiveText) ||
    /\b(disconnect|unbind|unlink|detach|remove).*(http|https|localhost|www\.|[a-z0-9-]+\.com|[a-z0-9-]+\.app)/i.test(effectiveText) ||
    /^disconnect\s+(http|https)/i.test(effectiveText)
  ) {
    // Extract URL from the message
    const urlMatch = effectiveText.match(/(https?:\/\/[^\s]+|localhost[:\d]*|[a-z0-9-]+\.[a-z0-9-]+(?:\.[a-z]+)?)/i)
    const frontendUrl = urlMatch ? urlMatch[0] : ''

    return createIntent({
      intent_type: 'FRONTEND_CONNECTION',
      domain: 'DEPLOYMENT',
      action: 'DISCONNECT',
      target: frontendUrl,
      constraints: {
        frontendUrl,
        requiresConfirmation: true,
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.98,
    })
  }

  // AUTH patterns
  if (
    /\b(let|allow|enable|support|should|can).*(sign in|log in|login|signin|sign up|signup|auth|authenticate).*(google|github|facebook|twitter|apple)/i.test(effectiveText) ||
    /\b(google|github|facebook|twitter|apple).*(sign in|log in|login|auth|signup|register)/i.test(effectiveText)
  ) {
    const provider = extractProvider(effectiveText)
    return createIntent({
      intent_type: 'FEATURE_ADD',
      domain: 'AUTH',
      action: 'ENABLE',
      feature: `${provider.toUpperCase()}_SIGN_IN`,
      constraints: {
        users: 'all',
        environment: 'default',
        provider,
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.98,
    })
  }

  // Basic Auth (Email/Password)
  if (
    /\b(email|password).*(login|signup|sign in|sign up|register|authenticate)/i.test(effectiveText) ||
    /\b(sign up|sign in|login|log in|signup)\b/i.test(effectiveText)
  ) {
    return createIntent({
      intent_type: 'FEATURE_ADD',
      domain: 'AUTH',
      action: 'ENABLE',
      feature: 'EMAIL_PASSWORD_AUTH',
      constraints: {},
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.98,
    })
  }

  // Roles/Admins
  if (/\b(role|admin|permission|owner)/i.test(effectiveText)) {
    return createIntent({
      intent_type: 'ACCESS_CONTROL',
      domain: 'AUTH',
      action: 'UPDATE',
      feature: 'RBAC',
      constraints: {
        hasAdmins: effectiveText.includes('admin'),
        hasRoles: true,
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.92,
    })
  }

  // Basic Auth (Email/Password)


  // STORAGE patterns
  if (
    (/\b(upload|uploads?|add|attach|store|save|images?|photos?|files?|pdfs?|videos?|contents?|thumbnails?|resize|compress|watermark|storage|buckets?|quota|backup|restore|version|private access|public share|media|avatar|pictures?|filestorage|file.?storage)\b/i.test(effectiveText) &&
    /\b(let|allow|enable|can|support|should|must|resize|compress|watermark|generate|thumbnail|backup|restore|quota|limit|delete|rename|move|share|access|have|want|need|make|set|implement|add|setup|configure|do|build|create|activate|turn.?on)\b/i.test(effectiveText)) ||
    /\b(private access|public sharing|file access|make.*private|make.*public|set.*private|set.*public)\b/i.test(effectiveText) ||
    /\b(implement|enable|add|setup|activate)\s+(file.?storage|filestorage|storage)\b/i.test(effectiveText)
  ) {
    const isImageOnly = /\b(images?|photos?|pictures?|avatar)\b/i.test(effectiveText) && !/\b(files?|pdf|videos?|documents?)\b/i.test(effectiveText)
    const target = (/\b(profile|avatar|user.?photos?|user.?pictures?)\b/i.test(effectiveText)) ? 'profile_pictures' :
                   (/\b(documents?|pdfs?|invoices?|reports?)\b/i.test(effectiveText)) ? 'documents' :
                   (/\b(videos?|movies?|clips?|reels?)\b/i.test(effectiveText)) ? 'videos' : 'general_uploads'
    
    return createIntent({
      intent_type: 'FEATURE_ADD',
      domain: 'STORAGE',
      action: 'ENABLE',
      feature: 'FILE_STORAGE_SYSTEM',
      target: target,
      constraints: {
        fileTypes: isImageOnly ? ['image/*'] : ['*/*'],
        maxSize: (/\b(size|limit|quota|large|big)\b/i.test(effectiveText)) ? '100MB' : '10MB',
        isPrivate: /\b(private|protected|only me|secure)\b/i.test(effectiveText),
        isPublic: /\b(public|share|everyone|anyone)\b/i.test(effectiveText),
        features: {
          thumbnails: /\b(thumbnail|preview)\b/i.test(effectiveText),
          resize: /\b(resize|scale)\b/i.test(effectiveText),
          compress: /\b(compress|optimize|small)\b/i.test(effectiveText),
        }
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.99,
    })
  }
  
  // DATABASE patterns - create entities
  if (
    /\b(create|add|build|make|enable|users can|allow users to|they can|can also).*(table|model|entity|collection|posts?|comments?|items?|products?|users?|orders?|records?|projects?)/i.test(effectiveText) ||
    /\b(table|model|entity|collection).*(called|named)/i.test(effectiveText)
  ) {
    const entityName = extractEntityName(effectiveText)
    return createIntent({
      intent_type: 'DATA_MODEL_ADD',
      domain: 'DATABASE',
      action: 'CREATE',
      target: entityName,
      constraints: {
        inferFields: true,
        isPublic: !effectiveText.includes('private') && !effectiveText.includes('only me'),
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.96,
    })
  }

  // CRUD Actions on entities
  if (/\b(edit|update|delete|remove|see|list|view|find|search|sort|filter).*(post|comment|user|item|order)/i.test(effectiveText)) {
    const entityName = extractEntityName(effectiveText)
    return createIntent({
      intent_type: 'DATA_MODEL_MODIFY',
      domain: 'DATABASE',
      action: effectiveText.includes('delete') || effectiveText.includes('remove') ? 'DELETE' : 'UPDATE',
      target: entityName,
      constraints: {
        operation: effectiveText.includes('search') ? 'search' : 'crud'
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.9,
    })
  }

  // Monitoring & Health
  if (/\b(monitor|alert|track|status|health|check|report)\b/i.test(effectiveText) || (/\blog\b/i.test(effectiveText) && !/\blog\s+in\b/i.test(effectiveText))) {
    return createIntent({
      intent_type: 'FEATURE_ADD',
      domain: 'MONITORING',
      action: 'ENABLE',
      feature: 'SYSTEM_HEALTH_MONITOR',
      constraints: {},
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.94,
    })
  }
  
  // Email notifications
  if (/\b(send|email|notify).*(when|after|if).*(form|submit|signup|register)/i.test(effectiveText)) {
    return createIntent({
      intent_type: 'FEATURE_ADD',
      domain: 'INTEGRATION',
      action: 'ENABLE',
      feature: 'EMAIL_NOTIFICATION',
      constraints: {
        trigger: 'form_submission',
        provider: 'default',
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.85,
    })
  }
  
  // Public access
  if (/\b(let anyone|public|open|everyone can)/i.test(effectiveText)) {
    return createIntent({
      intent_type: 'ACCESS_CONTROL',
      domain: 'API',
      action: 'ALLOW',
      feature: 'PUBLIC_ACCESS',
      constraints: {
        authentication: false,
        allRoutes: true,
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.9,
    })
  }
  
  // Fallback to LLM-based parsing (less deterministic)
  return await parseFallback(userMessage)
}

/**
 * Extract fields from schema definition
 */
function extractFields(text: string): string[] {
  const normalized = text.toLowerCase()
  const parts = normalized.split(/\b(have|has|contains|contains a|with)\b/)
  if (parts.length < 3) return []
  
  const fieldPart = parts[2].trim()
  // Remove trailing periods and common stop words
  const cleanFieldPart = fieldPart.replace(/\.$/, '').replace(/\b(and|or|,)\b/g, ' ')
  
  const stopWords = ['and', 'or', 'with', 'the', 'some', 'any', 'contains', 'has', 'have']
  
  return cleanFieldPart
    .split(/\s+/)
    .map(f => f.trim())
    .filter(f => f && f.length > 2 && !stopWords.includes(f) || f === 'title' || f === 'id')
}

/**
 * Extract provider from text
 */
function extractProvider(text: string): string {
  if (/google/i.test(text)) return 'google'
  if (/github/i.test(text)) return 'github'
  if (/facebook/i.test(text)) return 'facebook'
  if (/twitter/i.test(text)) return 'twitter'
  return 'google' // default
}

/**
 * Extract entity name from text
 */
function extractEntityName(text: string): string {
  // Try to find entity name after keywords
  const match = text.match(/(?:table|model|entity|collection|create|add|build|make|to|also)\s+(?:called|named)?\s*([a-z_]+)/i)
  if (match && !['also', 'can', 'to'].includes(match[1])) return match[1]
  
  // Look for common nouns
  const knownEntities = ['post', 'comment', 'item', 'product', 'user', 'order', 'record', 'project']
  for (const ent of knownEntities) {
    if (new RegExp(`\\b${ent}s?\\b`, 'i').test(text)) {
      return ent + 's' // Pluralize for table name
    }
  }

  // Try to find plural nouns
  const words = text.split(/\s+/)
  for (const word of words) {
    if (/s$/.test(word) && word.length > 3) {
      return word
    }
  }
  
  return 'entity'
}

/**
 * Resolve pronouns ("it", "them", "those", "ones") using BackendStateGraph
 */
function resolvePronouns(text: string, graph: BackendStateGraph): { text: string; isAmbiguous?: boolean; clarification?: string } {
  const pronouns = /\b(it|them|those|that|ones|they)\b/i
  if (!pronouns.test(text)) return { text }

  // 1. Identify last modified collection/resource
  const entities = Object.values(graph.entities).sort((a, b) => 
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
  const buckets = Object.values(graph.storage.buckets).sort((a, b) => 
    // BucketState doesn't have createdAt, use version as proxy or just presence
    b.name.localeCompare(a.name) 
  )
  
  const lastEntity = entities[0]?.name || 'resource'
  const bucketKeys = Object.keys(graph.storage.buckets)
  const lastBucket = bucketKeys[bucketKeys.length - 1] || 'storage'

  console.log(`[Pronoun Resolver] Graph Debug: Entities=${Object.keys(graph.entities).join(',')}, Buckets=${bucketKeys.join(',')}`)

  // PHASE 10: AMBIGUITY DETECTION
  // If user says "Make it private" and we have a bucket, it could refer to the bucket or an entity
  if (/\b(it|that)\b/i.test(text) && /\b(private|public)\b/i.test(text)) {
    if (buckets.length > 0) {
      // Even if only one exists, "it" is ambiguous between the bucket and potential entities
      return {
        text,
        isAmbiguous: true,
        clarification: "Do you mean uploaded files or user profiles?"
      }
    }
  }

  let resolved = text
  
  // Rule: "them", "those", "ones", "they" refers to last entity or bucket
  if (/\b(them|those|ones|they)\b/i.test(text)) {
    // Context-sensitive resolution
    const isSubject = /^(they|it)\b/i.test(text)
    
    if (!isSubject && (text.includes('upload') || text.includes('file') || text.includes('picture') || text.includes('remove') || text.includes('delete'))) {
      resolved = resolved.replace(/\b(them|those|ones)\b/gi, lastBucket)
      resolved = resolved.replace(/\b(they)\b/gi, lastEntity) // "they" as subject is usually entity
    } else {
      resolved = resolved.replace(/\b(them|those|ones|they)\b/gi, lastEntity)
    }
  }

  // Rule: "it", "that" refers to last entity
  if (/\b(it|that)\b/i.test(text)) {
    if (text.includes('private') || text.includes('public')) {
       // Might be bucket or entity
       resolved = resolved.replace(/\b(it|that)\b/gi, lastBucket || lastEntity)
    } else {
       resolved = resolved.replace(/\b(it|that)\b/gi, lastEntity)
    }
  }

  console.log(`[Pronoun Resolver] "${text}" -> "${resolved}" (Context: ${lastEntity}/${lastBucket})`)
  return { text: resolved }
}

/**
 * Fallback parser using LLM
 * (Less deterministic but handles edge cases)
 */
async function parseFallback(userMessage: string): Promise<CanonicalIntent> {
  // 1. Try AI-based summarization for messy prompts
  const { refinedPrompt, suggestions } = await summarizeMessyPrompt(userMessage)
  
  if (suggestions && suggestions.length > 0) {
    return createIntent({
      intent_type: 'QUERY',
      domain: 'SYSTEM',
      action: 'ALLOW',
      target: 'clarification',
      constraints: {
        isAmbiguous: true,
        message: `I've summarized your request. To move forward, could you confirm if you'd like to start with one of these behaviors?`,
        suggestions
      },
      source_text: userMessage,
      timestamp: new Date().toISOString(),
      confidence: 0.8,
    })
  }

  // For now, return a generic intent
  // TODO: Use OpenAI to parse complex intents
  return createIntent({
    intent_type: 'FEATURE_ADD',
    domain: 'DATABASE',
    action: 'CREATE',
    constraints: {},
    source_text: userMessage,
    timestamp: new Date().toISOString(),
    confidence: 0.5, // Low confidence
  })
}

/**
 * Validate intent completeness
 */
export function validateIntent(intent: CanonicalIntent): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []
  
  if (!intent.intent_type) errors.push('Missing intent_type')
  if (!intent.domain) errors.push('Missing domain')
  if (!intent.action) errors.push('Missing action')
  if (!intent.source_text) errors.push('Missing source_text')
  if (intent.confidence < 0.5) errors.push('Confidence too low')
  
  return {
    valid: errors.length === 0,
    errors,
  }
}
