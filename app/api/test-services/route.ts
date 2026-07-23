export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { testPostgresConnection, testMongoConnection } from '@/lib/db'
import { isAIEnabled, openai } from '@/lib/openai/client'

export async function GET() {
  const results: {
    postgresql: { connected: boolean; error?: string }
    mongodb: { connected: boolean; error?: string }
    openai: { enabled: boolean; error?: string; model?: string }
  } = {
    postgresql: { connected: false },
    mongodb: { connected: false },
    openai: { enabled: false },
  }

  // Test PostgreSQL
  try {
    const postgresConnected = await testPostgresConnection()
    results.postgresql.connected = postgresConnected
    if (!postgresConnected) {
      results.postgresql.error = 'Connection test returned false'
    }
  } catch (error: any) {
    results.postgresql.error = error.message || String(error)
    console.error('PostgreSQL test error:', error)
  }

  // Test MongoDB
  try {
    if (!process.env.MONGODB_URI) {
      results.mongodb.error = 'MONGODB_URI not set in environment (optional service)'
    } else {
      const mongoConnected = await testMongoConnection()
      results.mongodb.connected = mongoConnected
      if (!mongoConnected) {
        results.mongodb.error = 'Connection test returned false'
      }
    }
  } catch (error: any) {
    results.mongodb.error = error.message || String(error)
    console.error('MongoDB test error:', error)
  }

  // Test OpenAI
  try {
    const aiEnabled = isAIEnabled()
    results.openai.enabled = aiEnabled
    
    if (aiEnabled && openai) {
      // Try a simple API call to verify the key works
      try {
        const testResponse = await openai.models.list()
        results.openai.model = 'API key validated'
      } catch (apiError: any) {
        results.openai.error = `API key invalid: ${apiError.message || String(apiError)}`
        results.openai.enabled = false
      }
    } else {
      if (!process.env.OPENAI_API_KEY) {
        results.openai.error = 'OPENAI_API_KEY not set in environment'
      } else if (process.env.ENABLE_AI_FEATURES !== 'true') {
        results.openai.error = 'ENABLE_AI_FEATURES is not set to "true"'
      } else {
        results.openai.error = 'OpenAI client not initialized'
      }
    }
  } catch (error: any) {
    results.openai.error = error.message || String(error)
    console.error('OpenAI test error:', error)
  }

  // Check environment variables (without exposing sensitive data)
  const envCheck = {
    DATABASE_URL: process.env.DATABASE_URL 
      ? (process.env.DATABASE_URL.startsWith('postgresql://') || process.env.DATABASE_URL.startsWith('postgres://') 
          ? '✅ Valid format' 
          : '❌ Invalid format (must start with postgresql:// or postgres://)')
      : '❌ Not set',
    MONGODB_URI: process.env.MONGODB_URI
      ? (process.env.MONGODB_URI.startsWith('mongodb://') || process.env.MONGODB_URI.startsWith('mongodb+srv://')
          ? '✅ Valid format'
          : '❌ Invalid format (must start with mongodb:// or mongodb+srv://)')
      : 'ℹ️  Not set (optional)',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY 
      ? `✅ Set (${process.env.OPENAI_API_KEY.substring(0, 7)}...)` 
      : '❌ Not set',
    ENABLE_AI_FEATURES: process.env.ENABLE_AI_FEATURES || 'Not set',
  }

  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: results,
    environment: {
      NODE_ENV: process.env.NODE_ENV,
      ...envCheck,
    },
    summary: {
      allWorking: results.postgresql.connected && 
                  (results.mongodb.connected || !process.env.MONGODB_URI) && 
                  results.openai.enabled,
      postgresql: results.postgresql.connected ? '✅ Connected' : '❌ Disconnected',
      mongodb: results.mongodb.connected ? '✅ Connected' : (process.env.MONGODB_URI ? '❌ Disconnected' : 'ℹ️  Not configured'),
      openai: results.openai.enabled ? '✅ Enabled' : '❌ Disabled',
    },
  })
}

