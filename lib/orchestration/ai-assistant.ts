import { chatCompletion, isAIEnabled } from '../openai/client'
import { BackendStateGraph } from './backend-state-graph'
import { CanonicalIntent } from './types'

/**
 * AI Assistant for Orchestration
 * 
 * "AI to talk, not to decide."
 * 
 * Uses LLM to rephrase, clarify, and explain, while keeping the engine deterministic.
 */

/**
 * 1. Beginner Guidance & Rephrasing
 * Enhances rule-based guidance with friendly, behavioral suggestions.
 */
export async function enhanceGuidanceMessage(
  userMessage: string,
  baseMessage: string
): Promise<string> {
  if (!isAIEnabled()) return baseMessage

  try {
    const response = await chatCompletion([
      {
        role: 'system',
        content: `You are a calm, expert Product Manager for Backenly. 
        Backenly is a platform that builds backends based on user behavior.
        The user is non-technical and anxious.
        Your goal: Rephrase their vague idea into friendly, behavior-based suggestions.
        DO NOT use technical terms like "database", "schema", "API", "backend", "SQL", "server".
        FOCUS on what the users of their app will DO.
        Keep the response short, encouraging, and end with a question about the first user behavior.`
      },
      {
        role: 'user',
        content: `The user said: "${userMessage}". Our system identified this needs beginner guidance. 
        Standard response: "${baseMessage}"
        Please provide a more natural, personalized version of this response.`
      }
    ])

    return response?.choices[0]?.message?.content || baseMessage
  } catch (error) {
    console.error('[AI Assistant] Guidance enhancement failed:', error)
    return baseMessage
  }
}

/**
 * 2. Prompt Clarification & Summarization
 * Summarizes messy paragraphs into candidate behaviors.
 */
export async function summarizeMessyPrompt(
  userMessage: string
): Promise<{ refinedPrompt?: string; suggestions?: string[] }> {
  if (!isAIEnabled()) return {}

  try {
    const response = await chatCompletion([
      {
        role: 'system',
        content: `You are a Product Manager. A user has provided a long, messy description of what they want to build.
        Summarize this into 2-3 specific, concrete "User Behaviors".
        Example: "Users can sign up", "Users can upload photos", "Users can like posts".
        Return a JSON object: { "summary": "Short summary", "suggestions": ["Behavior 1", "Behavior 2"] }`
      },
      {
        role: 'user',
        content: `Prompt: "${userMessage}"`
      }
    ], { temperature: 0.3 })

    const content = response?.choices[0]?.message?.content
    if (!content) return {}

    try {
      const parsed = JSON.parse(content)
      return {
        refinedPrompt: parsed.summary,
        suggestions: parsed.suggestions
      }
    } catch {
      return { refinedPrompt: content }
    }
  } catch (error) {
    console.error('[AI Assistant] Prompt summarization failed:', error)
    return {}
  }
}

/**
 * 3. Explanation Layer
 * Translates internal facts/errors into human language.
 */
export async function explainDecision(
  intent: CanonicalIntent,
  decisionType: 'SAFETY_BLOCK' | 'CHANGE_SUMMARY' | 'ERROR',
  context: { violations?: string[]; changes?: any[]; error?: string }
): Promise<string> {
  if (!isAIEnabled()) return ''

  try {
    const response = await chatCompletion([
      {
        role: 'system',
        content: `You are a helpful Product Manager explaining system decisions to a user.
        Translate technical facts into clear, human language.
        If it's a safety block, explain WHY (e.g., privacy, data integrity) without being scary.
        If it's a change summary, celebrate what was accomplished in simple terms.
        DO NOT use jargon if possible.`
      },
      {
        role: 'user',
        content: `Decision Type: ${decisionType}
        User Intent: "${intent.source_text}"
        Technical Context: ${JSON.stringify(context)}
        Please explain this to the user.`
      }
    ])

    return response?.choices[0]?.message?.content || ''
  } catch (error) {
    console.error('[AI Assistant] Decision explanation failed:', error)
    return ''
  }
}

/**
 * 4. Demo & Sales Mode
 * Generates sample prompts and explains Backenly's "magic".
 */
export async function generateDemoContent(
  topic: string
): Promise<{ explanation: string; samples: string[] }> {
  const defaultResponse = {
    explanation: "Backenly builds production-grade backends from simple descriptions of user behavior.",
    samples: ["Users can sign up with Google", "Allow users to upload profile pictures", "Only admins can delete posts"]
  }

  if (!isAIEnabled()) return defaultResponse

  try {
    const response = await chatCompletion([
      {
        role: 'system',
        content: `You are a Sales Engineer for Backenly.
        Explain how Backenly would handle a specific topic in 1-2 sentences.
        Then provide 3 sample prompts that a user could type to build that feature.
        Return a JSON object: { "explanation": "...", "samples": ["...", "...", "..."] }`
      },
      {
        role: 'user',
        content: `Topic: "${topic}"`
      }
    ], { temperature: 0.8 })

    const content = response?.choices[0]?.message?.content
    if (!content) return defaultResponse

    try {
      return JSON.parse(content)
    } catch {
      return defaultResponse
    }
  } catch (error) {
    console.error('[AI Assistant] Demo content generation failed:', error)
    return defaultResponse
  }
}
