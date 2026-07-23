/**
 * REASONING ENGINE
 * 
 * Uses LLM to answer conversational queries about backend state.
 * Like Cursor/Bolt: prompt → LLM plan → execute
 * 
 * Returns structured output with action, plan, and explanation.
 */

import OpenAI from 'openai'
import { buildWorkspaceState, formatWorkspaceStateForLLM, WorkspaceState } from './workspace-state'
import { getSystemPrompt } from './system-prompt'
const BACKENLY_AI_SYSTEM_PROMPT = getSystemPrompt()
import { BackendStateGraph } from '@/lib/orchestration/backend-state-graph'
import { getModel } from './model-router'
import { getOpenAIClient } from './openai-service'

/**
 * Build a concise, imperative "Quick Backend Facts" block from workspace state.
 * Injected as a dedicated system message so the LLM is explicitly directed
 * to reference these facts in every answer — even for off-topic questions.
 */
function buildQuickBackendFacts(state: WorkspaceState): string {
  const tableList = state.tables.length > 0
    ? state.tables.map(t => `${t.name} (${t.fields.length} fields)`).join(', ')
    : 'none'
  const apiCount = state.apis.length
  const authStatus = state.auth.enabled
    ? `${state.auth.type?.toUpperCase() || 'JWT'} (providers: ${state.auth.providers.join(', ') || 'none'})`
    : 'disabled'
  const storageStatus = state.storage.enabled
    ? `enabled — buckets: ${state.storage.buckets.join(', ') || 'none'}`
    : 'disabled'

  return [
    'QUICK BACKEND FACTS (cite these in your RESPONSE to prove context-awareness):',
    `  • Tables (${state.tables.length}): ${tableList}`,
    `  • API endpoints: ${apiCount}`,
    `  • Authentication: ${authStatus}`,
    `  • Storage: ${storageStatus}`,
    '',
    'When answering ANY question — even meta or personality questions — open your RESPONSE',
    'with a one-sentence summary of these facts before answering the actual question.',
  ].join('\n')
}

// Simple in-memory conversation history per project
const conversationHistory = new Map<string, Array<{role: 'user' | 'assistant', content: string}>>()

export type AIAction = 'answer' | 'mutate' | 'clarify'

export interface ToolCall {
  tool: string
  arguments: Record<string, any>
}

export interface ReasoningResult {
  action: AIAction
  tool?: ToolCall
  explanation: string
  plan?: string[]
  response: string
  usedLLM: boolean
}

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Add message to conversation history
 */
export function addToConversationHistory(projectId: string, message: ConversationMessage): void {
  const history = conversationHistory.get(projectId) || []
  history.push(message)
  // Keep only last 10 messages for context window
  if (history.length > 10) {
    history.shift()
  }
  conversationHistory.set(projectId, history)
}

/**
 * Get conversation history for a project
 */
export function getConversationHistory(projectId: string): ConversationMessage[] {
  return conversationHistory.get(projectId) || []
}

/**
 * Generate intelligent response using LLM reasoning
 * 
 * ALWAYS sends workspace state + conversation history + architectural memory to LLM
 * This is what makes Cursor/Bolt feel smart
 */
export async function generateReasonedResponse(
  userMessage: string,
  graph: BackendStateGraph,
  projectName: string,
  projectId?: string,
  architecturalMemory?: string
): Promise<ReasoningResult> {
  try {
    // Build workspace state
    const workspaceState = buildWorkspaceState(graph, projectName)
    const stateText = formatWorkspaceStateForLLM(workspaceState)
    const quickFacts = buildQuickBackendFacts(workspaceState)

    // Build messages array
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: BACKENLY_AI_SYSTEM_PROMPT },
      {
        role: 'system',
        content: `Workspace State:\n\n${stateText}`
      },
      {
        role: 'system',
        content: quickFacts,
      },
    ]

    // Add architectural memory if available
    if (architecturalMemory) {
      messages.push({
        role: 'system',
        content: `Project Memory:\n${architecturalMemory}`
      })
    }

    // Add conversation history if available
    if (projectId) {
      const history = getConversationHistory(projectId)
      if (history.length > 0) {
        messages.push({
          role: 'system',
          content: `Recent Conversation:\n${history.map(h => `${h.role === 'user' ? 'User' : 'AI'}: ${h.content}`).join('\n')}`
        })
      }
    }

    // Add current user message
    messages.push({ role: 'user', content: userMessage })

    // Call LLM with full context - optimized for speed
    const openai = getOpenAIClient()
    const completion = await openai.chat.completions.create({
      model: getModel('respond'), // Conversational response — smart model
      messages,
      temperature: 0.3,
      max_tokens: 400, // Reduced for faster responses
      presence_penalty: 0,
      frequency_penalty: 0,
    })

    const response = completion.choices[0]?.message?.content?.trim()
    
    if (!response) {
      throw new Error('Empty response from LLM')
    }

    // Parse structured response from LLM
    const parsed = parseStructuredResponse(response)

    // Store in conversation history
    if (projectId) {
      addToConversationHistory(projectId, { role: 'user', content: userMessage })
      addToConversationHistory(projectId, { role: 'assistant', content: parsed.response })
    }

    return {
      ...parsed,
      usedLLM: true,
    }
  } catch (error) {
    console.error('[ReasoningEngine] LLM error:', error)
    
    // Fallback to simple response if LLM fails
    const workspaceState = buildWorkspaceState(graph, projectName)
    const fallbackResponse = generateFallbackResponse(userMessage, workspaceState)
    
    return {
      action: 'answer',
      explanation: 'Fallback response due to LLM error',
      response: fallbackResponse,
      usedLLM: false,
    }
  }
}

/**
 * Parse structured response from LLM
 * Expected format:
 * ACTION: answer|mutate|clarify
 * EXPLANATION: ...
 * TOOL: (optional, for mutate)
 * TOOL_ARGUMENTS: (optional, JSON)
 * PLAN: (optional, for mutations)
 *   1. Step one
 *   2. Step two
 * RESPONSE: The actual response to show user
 */
function parseStructuredResponse(rawResponse: string): Omit<ReasoningResult, 'usedLLM'> {
  const lines = rawResponse.split('\n').map(l => l.trim()).filter(Boolean)
  
  let action: AIAction = 'answer'
  let explanation = ''
  let response = rawResponse
  const plan: string[] = []
  let tool: ToolCall | undefined
  let toolName = ''
  let toolArgs = ''
  
  let currentSection: 'action' | 'explanation' | 'tool' | 'tool_args' | 'plan' | 'response' | null = null
  
  for (const line of lines) {
    const upperLine = line.toUpperCase()
    
    if (upperLine.startsWith('ACTION:')) {
      const actionValue = line.substring(7).trim().toLowerCase()
      if (actionValue === 'mutate' || actionValue === 'clarify' || actionValue === 'answer') {
        action = actionValue
      } else if (actionValue === 'mutation') {
        action = 'mutate' // backward compatibility
      }
      currentSection = 'action'
    } else if (upperLine.startsWith('EXPLANATION:')) {
      explanation = line.substring(12).trim()
      currentSection = 'explanation'
    } else if (upperLine.startsWith('TOOL:')) {
      toolName = line.substring(5).trim()
      currentSection = 'tool'
    } else if (upperLine.startsWith('TOOL_ARGUMENTS:')) {
      toolArgs = line.substring(15).trim()
      currentSection = 'tool_args'
    } else if (upperLine.startsWith('PLAN:')) {
      currentSection = 'plan'
    } else if (upperLine.startsWith('RESPONSE:')) {
      response = line.substring(9).trim()
      currentSection = 'response'
    } else if (currentSection === 'explanation') {
      explanation += ' ' + line
    } else if (currentSection === 'tool_args') {
      toolArgs += line // accumulate JSON
    } else if (currentSection === 'plan' && /^\d+[.\)]/.test(line)) {
      const step = line.replace(/^\d+[.\)]\s*/, '').trim()
      if (step) plan.push(step)
    } else if (currentSection === 'response') {
      response += '\n' + line
    }
  }
  
  // Parse tool call if present
  if (toolName && toolArgs) {
    try {
      tool = {
        tool: toolName,
        arguments: JSON.parse(toolArgs)
      }
    } catch (e) {
      console.warn('[ReasoningEngine] Failed to parse tool arguments:', toolArgs)
    }
  }
  
  // If no structured format detected, treat entire response as answer
  if (!explanation && plan.length === 0 && !tool) {
    explanation = 'Direct response to user question'
    response = rawResponse
  }
  
  return {
    action,
    tool,
    explanation: explanation || 'Response generated from workspace state',
    plan: plan.length > 0 ? plan : undefined,
    response: response.trim(),
  }
}

/**
 * Generate simple fallback response if LLM fails
 */
function generateFallbackResponse(userMessage: string, state: ReturnType<typeof buildWorkspaceState>): string {
  const lower = userMessage.toLowerCase()
  
  // Simple keyword matching as fallback
  if (lower.includes('table')) {
    if (state.tables.length === 0) return 'Your backend currently has no tables.'
    return `Your backend has ${state.tables.length} tables: ${state.tables.map(t => t.name).join(', ')}`
  }
  
  if (lower.includes('api')) {
    if (state.apis.length === 0) return 'Your backend currently has no APIs.'
    return `Your backend has ${state.apis.length} APIs: ${state.apis.map(a => `${a.method} ${a.path}`).join(', ')}`
  }
  
  if (lower.includes('auth')) {
    if (!state.auth.enabled) return 'Authentication is currently disabled.'
    return `Authentication is enabled${state.auth.providers.length ? ` with: ${state.auth.providers.join(', ')}` : ''}.`
  }
  
  // General summary
  const parts: string[] = []
  parts.push(`Your backend has ${state.stats.tables} tables, ${state.stats.apis} APIs`)
  if (state.auth.enabled) parts.push('with authentication enabled')
  if (state.storage.enabled) parts.push('and storage configured')
  return parts.join(' ') + '.'
}
