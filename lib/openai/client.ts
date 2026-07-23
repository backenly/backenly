import OpenAI from 'openai'
import type { ChatCompletion } from 'openai/resources/chat/completions'
import { log } from '../logger'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

if (!OPENAI_API_KEY) {
  console.warn('⚠️  OPENAI_API_KEY is not set. AI features will be disabled.')
}

// Initialize OpenAI client
export const openai = OPENAI_API_KEY
  ? new OpenAI({
      apiKey: OPENAI_API_KEY,
      timeout: 30_000,   // 30s — matches the singleton in openai-service.ts
      maxRetries: 1,
    })
  : null

// Check if AI features are enabled
export function isAIEnabled(): boolean {
  return process.env.ENABLE_AI_FEATURES === 'true' && openai !== null
}

// Helper function to make OpenAI API calls with error handling
export async function chatCompletion(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  options?: {
    model?: string
    temperature?: number
    maxTokens?: number
    stream?: boolean
  }
): Promise<OpenAI.Chat.Completions.ChatCompletion | null> {
  if (!isAIEnabled()) {
    log.warn('OpenAI API is not configured or disabled')
    return null
  }

  try {
    const response = await openai!.chat.completions.create({
      model: options?.model || OPENAI_MODEL,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens,
      stream: options?.stream ?? false,
    })

    // Ensure we have a ChatCompletion (not a stream)
    if (!('usage' in response)) {
      throw new Error('Unexpected stream response - stream should be disabled')
    }
    
    log.info('OpenAI API call successful', {
      model: options?.model || OPENAI_MODEL,
      tokens: response.usage?.total_tokens,
    })

    return response as ChatCompletion
  } catch (error: any) {
    log.error('OpenAI API call failed', error, {
      model: options?.model || OPENAI_MODEL,
    })
    throw error
  }
}

// Helper for streaming responses
export async function* chatCompletionStream(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  options?: {
    model?: string
    temperature?: number
    maxTokens?: number
  }
): AsyncGenerator<string, void, unknown> {
  if (!isAIEnabled()) {
    throw new Error('OpenAI API is not configured or disabled')
  }

  try {
    const stream = await openai!.chat.completions.create({
      model: options?.model || OPENAI_MODEL,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens,
      stream: true,
    })

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content
      if (content) {
        yield content
      }
    }
  } catch (error: any) {
    log.error('OpenAI streaming API call failed', error)
    throw error
  }
}

// Helper for embeddings
export async function createEmbedding(
  input: string | string[],
  model: string = 'text-embedding-3-small'
): Promise<number[][] | null> {
  if (!isAIEnabled()) {
    log.warn('OpenAI API is not configured or disabled')
    return null
  }

  try {
    const response = await openai!.embeddings.create({
      model,
      input: Array.isArray(input) ? input : [input],
    })

    return response.data.map(item => item.embedding)
  } catch (error: any) {
    log.error('OpenAI embedding API call failed', error)
    throw error
  }
}

