/**
 * EMAIL & NOTIFICATIONS (Transactional, Event-Driven)
 * 
 * Purpose: Notifications as side effects, NOT a messaging system
 * 
 * User says: "Send welcome email when user signs up"
 * System does: Automatic email on event trigger
 * 
 * ⚠️ CRITICAL: Users must NEVER see:
 * - SMTP configuration
 * - Email providers
 * - Raw templates
 * - Delivery logs
 */

/**
 * Email notification definition
 * Maps product events to email actions
 */
export interface EmailNotification {
  id: string
  name: string                      // User-friendly name
  
  // Trigger event (when to send)
  triggerEvent: string              // "user.created", "payment.failed", "comment.created"
  
  // Email content (system-managed templates)
  template: {
    type: 'welcome' | 'reminder' | 'notification' | 'alert' | 'transactional'
    subject: string                 // Can include {{variables}}
    body: string                    // Plain text or HTML
    variables: string[]             // List of available variables
  }
  
  // Recipient selection
  recipient: {
    targetEntity: string            // Which entity to email
    targetField: string             // Email field name
    condition?: string              // Additional filtering
  }
  
  // Compliance (automatic)
  compliance: {
    unsubscribeEnabled: boolean
    gdprCompliant: boolean
    retentionDays: number
  }
  
  // Retry policy
  retryPolicy: {
    maxAttempts: number
    backoffMs: number
  }
  
  // System-managed (NEVER exposed)
  _internal: {
    provider: 'resend' | 'sendgrid' | 'postmark'  // System chooses
    providerTemplateId?: string
    totalSent: number
    failedSends: number
    lastSent?: Date
  }
  
  enabled: boolean
  createdAt: Date
}

/**
 * Email notification state for project
 */
export interface EmailNotificationState {
  enabled: boolean
  notifications: Record<string, EmailNotification>
  
  // Compliance settings (automatic)
  compliance: {
    unsubscribeLink: string         // Auto-generated
    privacyPolicyUrl?: string
    companyName: string             // From project metadata
    companyAddress?: string
  }
  
  // Send history for idempotency
  sendHistory: Record<string, {
    notificationId: string
    recipientId: string
    timestamp: Date
    status: 'sent' | 'failed' | 'bounced'
    attempts: number
  }>
  
  reason: string
}

/**
 * Parse email notification from natural language
 * 
 * User says: "Send welcome email when user signs up"
 * System generates: Complete email notification
 */
export function parseEmailNotificationIntent(userMessage: string): EmailNotification | null {
  const lower = userMessage.toLowerCase()
  
  // Check if this is email notification intent
  const isEmailIntent = (
    /\bsend\b.*?\b(email|notification|message)\b/i.test(lower) ||
    /\b(email|notify|message|alert)\b.*?\bwhen\b/i.test(lower)
  )
  
  if (!isEmailIntent) {
    return null
  }
  
  // Extract trigger event
  let triggerEvent = 'custom.event'
  let templateType: 'welcome' | 'reminder' | 'notification' | 'alert' | 'transactional' = 'notification'
  
  if (/sign\s*up|register|creat.*?account|user.*?created/i.test(lower)) {
    triggerEvent = 'user.created'
    templateType = 'welcome'
  } else if (/payment.*?(fail|decline)|subscription.*?(unpaid|past.?due)/i.test(lower)) {
    triggerEvent = 'payment.failed'
    templateType = 'alert'
  } else if (/comment|reply|mention|message/i.test(lower)) {
    triggerEvent = 'comment.created'
    templateType = 'notification'
  } else if (/remind|reminder|follow.?up/i.test(lower)) {
    triggerEvent = 'reminder.scheduled'
    templateType = 'reminder'
  } else if (/order|purchase|receipt|confirmation/i.test(lower)) {
    triggerEvent = 'order.created'
    templateType = 'transactional'
  }
  
  // Extract subject and body hints
  let subject = 'Notification'
  let body = 'You have a new notification.'
  
  if (templateType === 'welcome') {
    subject = 'Welcome to {{app_name}}!'
    body = 'Thanks for signing up. We\'re excited to have you.'
  } else if (templateType === 'alert') {
    subject = 'Payment Issue - Action Required'
    body = 'Your payment has failed. Please update your payment method to continue.'
  } else if (templateType === 'reminder') {
    subject = 'Reminder: {{action_needed}}'
    body = 'Just a friendly reminder about {{action_needed}}.'
  } else if (templateType === 'transactional') {
    subject = 'Order Confirmation #{{order_id}}'
    body = 'Thank you for your order. Details: {{order_details}}'
  }
  
  // Determine recipient
  let targetEntity = 'users'
  let targetField = 'email'
  
  if (/admin|moderator|owner/i.test(lower)) {
    targetEntity = 'admins'
  }
  
  return {
    id: `email_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    name: `${templateType} on ${triggerEvent}`,
    triggerEvent,
    template: {
      type: templateType,
      subject,
      body,
      variables: extractVariables(subject + body)
    },
    recipient: {
      targetEntity,
      targetField,
    },
    compliance: {
      unsubscribeEnabled: true,
      gdprCompliant: true,
      retentionDays: 90
    },
    retryPolicy: {
      maxAttempts: 3,
      backoffMs: 5000
    },
    _internal: {
      provider: 'resend',  // System chooses best provider
      totalSent: 0,
      failedSends: 0
    },
    enabled: true,
    createdAt: new Date()
  }
}

/**
 * Send email notification (triggered by event)
 * 
 * This is called automatically when the trigger event occurs
 * Completely invisible to users
 */
export async function sendEmailNotification(
  projectId: string,
  notificationId: string,
  notification: EmailNotification,
  eventData: any
): Promise<{ success: boolean; messageId?: string }> {
  
  console.log(`[Email Notification] Triggering: ${notification.name}`)
  
  try {
    // Find recipients
    const recipients = await findRecipients(projectId, notification, eventData)
    
    if (recipients.length === 0) {
      console.log(`[Email Notification] No recipients found for ${notificationId}`)
      return { success: true }  // Not an error
    }
    
    // Send to each recipient
    for (const recipient of recipients) {
      // Check idempotency
      const idempotencyKey = `${notificationId}_${recipient.id}_${eventData.id || Date.now()}`
      const existing = await getSendHistory(projectId, idempotencyKey)
      
      if (existing?.status === 'sent') {
        console.log(`[Email Notification] Already sent to ${recipient.email}`)
        continue
      }
      
      // Render template with variables
      const rendered = renderTemplate(notification.template, {
        ...eventData,
        recipient_email: recipient.email,
        recipient_name: recipient.name,
        app_name: 'Your App'  // From project metadata
      })
      
      // Send via provider
      const result = await sendViaProvider(
        notification._internal.provider,
        recipient.email,
        rendered.subject,
        rendered.body,
        {
          unsubscribeLink: await getUnsubscribeLink(projectId, recipient.id),
          compliance: notification.compliance
        }
      )
      
      // Log send
      await logSend(projectId, idempotencyKey, notificationId, recipient.id, 
        result.success ? 'sent' : 'failed', 1)
      
      // Update stats
      await updateNotificationStats(projectId, notificationId, {
        totalSent: notification._internal.totalSent + (result.success ? 1 : 0),
        failedSends: notification._internal.failedSends + (result.success ? 0 : 1),
        lastSent: new Date()
      })
    }
    
    return { success: true }
    
  } catch (error) {
    console.error(`[Email Notification] Failed:`, error)
    
    // Schedule retry
    await scheduleEmailRetry(projectId, notificationId, notification, eventData, 1)
    
    return { success: false }
  }
}

/**
 * Find recipients for notification
 */
async function findRecipients(
  projectId: string,
  notification: EmailNotification,
  eventData: any
): Promise<Array<{ id: string; email: string; name?: string }>> {
  // TODO: Query project's isolated database
  // SELECT id, email, name FROM {targetEntity} WHERE {condition}
  return []  // Placeholder
}

/**
 * Render template with variables
 */
function renderTemplate(
  template: { subject: string; body: string },
  variables: Record<string, any>
): { subject: string; body: string } {
  let subject = template.subject
  let body = template.body
  
  // Replace {{variable}} with values
  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g')
    subject = subject.replace(regex, String(value || ''))
    body = body.replace(regex, String(value || ''))
  })
  
  return { subject, body }
}

/**
 * Send via email provider
 */
async function sendViaProvider(
  provider: string,
  to: string,
  subject: string,
  body: string,
  options: any
): Promise<{ success: boolean; messageId?: string }> {
  // TODO: Integrate with actual email provider
  // Resend, SendGrid, or Postmark
  console.log(`[Email Provider] Sending via ${provider} to ${to}`)
  return { success: true, messageId: `msg_${Date.now()}` }
}

/**
 * Get unsubscribe link for recipient
 */
async function getUnsubscribeLink(projectId: string, recipientId: string): Promise<string> {
  // Generate secure unsubscribe link
  const token = Buffer.from(`${projectId}:${recipientId}:${Date.now()}`).toString('base64url')
  return `https://api.backenly.com/unsubscribe/${token}`
}

/**
 * Get send history
 */
async function getSendHistory(projectId: string, idempotencyKey: string): Promise<any | null> {
  // TODO: Load from project state
  return null
}

/**
 * Log email send
 */
async function logSend(
  projectId: string,
  idempotencyKey: string,
  notificationId: string,
  recipientId: string,
  status: 'sent' | 'failed' | 'bounced',
  attempts: number
) {
  // TODO: Store in project state
  console.log(`[Email Log] ${idempotencyKey} → ${status} (${attempts} attempts)`)
}

/**
 * Update notification stats
 */
async function updateNotificationStats(
  projectId: string,
  notificationId: string,
  updates: any
) {
  // TODO: Update in BackendStateGraph
  console.log(`[Email Stats] ${notificationId}`, updates)
}

/**
 * Schedule email retry
 */
async function scheduleEmailRetry(
  projectId: string,
  notificationId: string,
  notification: EmailNotification,
  eventData: any,
  currentAttempt: number
) {
  if (currentAttempt >= notification.retryPolicy.maxAttempts) {
    console.error(`[Email Retry] Max attempts reached for ${notificationId}`)
    return
  }
  
  const delayMs = notification.retryPolicy.backoffMs * Math.pow(2, currentAttempt - 1)
  console.log(`[Email Retry] Retry ${currentAttempt + 1} in ${delayMs}ms`)
  
  // TODO: Schedule retry
}

/**
 * Extract variables from template string
 */
function extractVariables(text: string): string[] {
  const matches = text.match(/\{\{([^}]+)\}\}/g) || []
  return matches.map(m => m.replace(/\{\{|\}\}/g, '').trim())
}
