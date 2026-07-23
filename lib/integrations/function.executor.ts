/**
 * FUNCTION EXECUTOR
 * ==================
 * Creates AI-generated serverless functions triggered by DB events.
 */

import { prisma } from '@/lib/db/prisma'
import { validateAiFunctionData } from '@/lib/ai/function-validation'

export interface FunctionIntegrationResult {
  success: boolean
  message: string
  functionId?: string
  functionName?: string
}

export async function executeFunctionIntegration(
  projectId: string,
  description: string,
  triggerType: 'on_db_insert' | 'on_db_update' | 'on_db_delete' | 'on_signup' | 'manual' = 'manual',
  triggerTable?: string
): Promise<FunctionIntegrationResult> {
  const { generateFunctionCode } = await import('@/lib/services/ai-functions/generator')

  const generated = await generateFunctionCode(description, triggerType, triggerTable || null, projectId)

  const validation = validateAiFunctionData(generated.name, description)
  if (!validation.valid) {
    console.warn(`[FunctionExecutor] Skipping phantom function creation: ${validation.reason}`)
    return {
      success: false,
      message: `Could not create function — the generated name was invalid. Please rephrase the description and try again.`,
    }
  }

  const fn = await prisma.aiFunction.create({
    data: {
      projectId,
      name: generated.name,
      description,
      triggerType,
      triggerTable: triggerTable || null,
      generatedCode: generated.code,
      status: 'active',
    },
  })

  return {
    success: true,
    message: `Done: Function "${generated.name}" created and active. Triggers on ${triggerType.replace('on_', '').replace('_', ' ')}.`,
    functionId: fn.id,
    functionName: generated.name,
  }
}
