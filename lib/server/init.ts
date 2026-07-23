import { initializeDatabases } from '../db'
import { log } from '../logger'
import { isAIEnabled } from '../openai/client'

// Server initialization function
export async function initializeServer() {
  log.info('🚀 Initializing Backenly server...')

  try {
    // Initialize databases
    log.info('📊 Connecting to databases...')
    const dbStatus = await initializeDatabases()
    
    if (dbStatus.postgres) {
      log.info('✅ PostgreSQL connected')
    } else {
      log.warn('⚠️  PostgreSQL connection failed')
    }

    if (dbStatus.mongodb) {
      log.info('✅ MongoDB connected')
    } else {
      log.warn('⚠️  MongoDB connection failed')
    }

    // Check OpenAI configuration
    if (isAIEnabled()) {
      log.info('✅ OpenAI API configured')
    } else {
      log.warn('⚠️  OpenAI API not configured or disabled')
    }

    log.info('✅ Server initialization complete')
    
    return {
      success: true,
      databases: dbStatus,
      aiEnabled: isAIEnabled(),
    }
  } catch (error: any) {
    log.error('❌ Server initialization failed', error)
    throw error
  }
}

// Call initialization on module load (for Next.js)
if (typeof window === 'undefined') {
  // Only initialize in server environment
  initializeServer().catch((error) => {
    console.error('Failed to initialize server:', error)
  })
}

