/**
 * FRONTEND CONNECT EXECUTOR
 * ==========================
 * Generates framework-specific SDK snippets and marks the project as frontend-connected.
 * Uses the frontend detector to tailor output to the user's framework.
 */

import { prisma } from '@/lib/db/prisma'
import {
  detectFrontendFramework,
  generateFrameworkSnippet,
  formatFrameworkMessage,
} from '@/lib/ai/frontend-detector'

export interface FrontendIntegrationResult {
  success: boolean
  message: string
  sdkSnippet?: string
  framework?: string
}

export async function executeFrontendIntegration(
  projectId: string,
  userMessage?: string,
  conversationHistory?: Array<{ role: string; content: string }>
): Promise<FrontendIntegrationResult> {
  // Load project to get public key / info
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, apiKeys: { take: 1, select: { key: true } } },
  })

  if (!project) {
    return { success: false, message: 'Project not found.' }
  }

  const publicKey = project.apiKeys[0]?.key || `pk_${projectId.slice(0, 8)}`

  // Detect the user's frontend framework (falls back to 'unknown' gracefully)
  const framework = detectFrontendFramework(userMessage || '', conversationHistory)
  const snippet = generateFrameworkSnippet(framework, projectId, publicKey)
  const frameworkMessage = formatFrameworkMessage(snippet)

  // Mark frontend as connected
  const existing = await prisma.project.findUnique({
    where: { id: projectId },
    select: { activeIntegrations: true },
  })
  const integrations = (existing?.activeIntegrations as Record<string, any>) ?? {}
  await prisma.project.update({
    where: { id: projectId },
    data: {
      activeIntegrations: {
        ...integrations,
        frontend: {
          enabled: true,
          framework: framework !== 'unknown' ? framework : undefined,
          activatedAt: new Date().toISOString(),
          activatedBy: 'integration_executor',
        },
      },
      isFrontendConnected: true,
    },
  })

  return {
    success: true,
    message: frameworkMessage,
    sdkSnippet: snippet.setupCode,
    framework,
  }
}
