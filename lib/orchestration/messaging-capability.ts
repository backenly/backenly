/**
 * MESSAGING CAPABILITY (Email First)
 */

import { BackendStateGraph, EmailTemplate } from './backend-state-graph'
import { CapabilityExecutor, CapabilityDescriptor, CapabilityExecutionResult } from './capabilities'

export const EMAIL_DESCRIPTOR: CapabilityDescriptor = {
  type: 'EMAIL_MESSAGING',
  version: '1.0.0',
  ownedGraphSection: 'notifications',
  description: 'Enables system-managed email notifications.',
}

export class EmailExecutor extends CapabilityExecutor {
  constructor() {
    super(EMAIL_DESCRIPTOR)
  }

  validate(params: any, graph: BackendStateGraph): { valid: boolean; error?: string } {
    if (!params.templateName) return { valid: false, error: 'Template name is required' }
    return { valid: true }
  }

  async execute(params: any, graph: BackendStateGraph): Promise<CapabilityExecutionResult> {
    const templateId = `tmpl_${params.templateName.toLowerCase().replace(/\s+/g, '_')}`
    
    const newTemplate: EmailTemplate = {
      id: templateId,
      name: params.templateName,
      subject: params.subject || `Notification: ${params.templateName}`,
      body: params.body || 'Email content pending generation...',
      triggerEvent: params.triggerEvent || 'manual',
      reason: params.reason || 'System email requested',
    }

    return {
      success: true,
      message: `Email template "${params.templateName}" enabled.`,
      graphChanges: {
        notifications: {
          ...graph.notifications,
          email: {
            ...graph.notifications.email,
            enabled: true,
            templates: {
              ...graph.notifications.email.templates,
              [templateId]: newTemplate
            }
          }
        }
      },
      details: { templateId }
    }
  }

  async rollback(params: any, graph: BackendStateGraph): Promise<boolean> {
    return true
  }
}
