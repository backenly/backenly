/**
 * Intent Reconstructor — AI-powered backend intent reconstruction
 * 
 * Takes app inspection data and reconstructs what backend it needs
 * WITHOUT importing any code
 */

import { AppInspectionResult } from './app-inspector'
import OpenAI from 'openai'
import { prisma } from '@/lib/db'

export interface IntentReconstructionResult {
  success: boolean
  error?: string
  projectId?: string
  humanSummary?: HumanSummary
  backendIntent?: BackendIntent
}

export interface HumanSummary {
  appType: string // "Social media app", "Todo list", "Blog"
  dataCollections: string[] // ["posts", "users", "comments"]
  features: string[] // ["User authentication", "Create posts", "Like posts"]
  storage: string | null // "Profile pictures" or null
}

export interface BackendIntent {
  tables: TableIntent[]
  apis: APIIntent[]
  auth: AuthIntent | null
  storage: StorageIntent | null
}

export interface TableIntent {
  name: string
  description: string
  columns: ColumnIntent[]
}

export interface ColumnIntent {
  name: string
  type: string
  nullable: boolean
  unique?: boolean
  default?: string
}

export interface APIIntent {
  resource: string
  operations: {
    create: boolean
    read: boolean
    update: boolean
    delete: boolean
  }
}

export interface AuthIntent {
  method: 'email' | 'oauth'
  providers?: string[]
}

export interface StorageIntent {
  enabled: boolean
  allowedTypes: string[]
}

export class IntentReconstructor {
  /**
   * Reconstruct backend intent from app inspection
   */
  static async reconstruct(inspectionData: AppInspectionResult['data']): Promise<IntentReconstructionResult> {
    try {
      if (!inspectionData) {
        return {
          success: false,
          error: 'No inspection data provided',
        }
      }

      console.log('[IntentReconstructor] Reconstructing intent from:', inspectionData.appName)

      // Use AI to understand the app's intent
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      })

      const prompt = this.buildReconstructionPrompt(inspectionData)

      const completion = await openai.chat.completions.create({
        model: 'gpt-4.1',
        messages: [
          {
            role: 'system',
            content: `You are a backend architect analyzing frontend applications. Your job is to understand what backend the app needs by observing its behavior.

CRITICAL RULES:
1. DO NOT import or read source code
2. Infer backend needs from observed behavior only
3. Be conservative - only include what you're confident about
4. Output valid JSON only, no markdown`,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      })

      const result = completion.choices[0].message.content
      if (!result) {
        throw new Error('No response from AI')
      }

      const reconstruction = JSON.parse(result)

      // Create or update project with reconstructed intent
      const userId = 'system' // TODO: Get from auth context
      
      const project = await prisma.project.create({
        data: {
          name: inspectionData.appName || 'Connected App',
          description: `Backend reconstructed from ${inspectionData.appUrl}`,
          userId, // Will be updated when user connects
        },
      })

      // Create metadata with reconstructed intent
      await prisma.projectMetadata.create({
        data: {
          projectId: project.id,
          originalPrompt: `Connected from URL: ${inspectionData.appUrl}`,
          entities: JSON.stringify(reconstruction.backendIntent.tables || []),
          relationships: JSON.stringify([]),
          behaviors: JSON.stringify(reconstruction.backendIntent.apis || []),
          security: JSON.stringify(reconstruction.backendIntent.auth || {}),
          tablePlans: JSON.stringify(reconstruction.backendIntent.tables || []),
          apiPlans: JSON.stringify(reconstruction.backendIntent.apis || []),
        },
      })

      return {
        success: true,
        projectId: project.id,
        humanSummary: reconstruction.humanSummary,
        backendIntent: reconstruction.backendIntent,
      }

    } catch (error) {
      console.error('[IntentReconstructor] Failed:', error)
      return {
        success: false,
        error: 'Failed to understand what the app does',
      }
    }
  }

  /**
   * Build AI prompt for reconstruction
   */
  private static buildReconstructionPrompt(data: NonNullable<AppInspectionResult['data']>): string {
    return `Analyze this frontend application and reconstruct what backend it needs.

APP NAME: ${data.appName}
APP URL: ${data.appUrl}
TECHNOLOGIES: ${data.technologies.join(', ')}

DETECTED APIs:
${data.detectedAPIs.map(api => `- ${api.method} ${api.endpoint}`).join('\n')}

DETECTED DATA MODELS:
${data.detectedDataModels.map(model => `- ${model.name}`).join('\n')}

DETECTED AUTH: ${data.detectedAuth ? `${data.detectedAuth.method}${data.detectedAuth.provider ? ` (${data.detectedAuth.provider})` : ''}` : 'None'}

DETECTED STORAGE: ${data.detectedStorage ? 'Yes (file uploads)' : 'No'}

Based on this information, reconstruct:
1. What type of app this is (in human terms)
2. What data collections it needs
3. What features it has
4. What backend tables and APIs are required

Output as JSON:
{
  "humanSummary": {
    "appType": "Brief description like 'Social media app' or 'Task manager'",
    "dataCollections": ["users", "posts", "comments"],
    "features": ["User sign-up", "Create posts", "Like posts"],
    "storage": "Profile pictures" or null
  },
  "backendIntent": {
    "tables": [
      {
        "name": "users",
        "description": "User accounts",
        "columns": [
          { "name": "id", "type": "uuid", "nullable": false, "unique": true },
          { "name": "email", "type": "string", "nullable": false, "unique": true },
          { "name": "name", "type": "string", "nullable": true }
        ]
      }
    ],
    "apis": [
      {
        "resource": "users",
        "operations": { "create": true, "read": true, "update": true, "delete": false }
      }
    ],
    "auth": { "method": "email" } or null,
    "storage": { "enabled": true, "allowedTypes": ["image/jpeg", "image/png"] } or null
  }
}

Be conservative - only include what you're confident the app needs.`
  }
}
