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
    select: { id: true, name: true, anonKey: true },
  })

  if (!project) {
    return { success: false, message: 'Project not found.' }
  }

  // Project.anonKey, not the first ApiKey's persisted plaintext.
  //
  // This snippet is pasted into a customer's frontend source, so the credential
  // in it is published to every visitor of their app. It used to take
  // `project.apiKeys[0]?.key`, which is whichever key happened to be created
  // first — routinely an sk_live_ admin key. The anon key is the credential
  // designed for this, and it is the only one still stored recoverably. See
  // lib/auth/api-key-plaintext.ts.
  const publicKey = project.anonKey || `pk_${projectId.slice(0, 8)}`

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
