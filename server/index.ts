/**
 * Backenly Runtime API Server — Port 3001
 *
 * Handles all /api/v1/* routes (public runtime API for end-users):
 *   - Auth  (signin / signup)
 *   - Database CRUD
 *   - Realtime SSE (PostgreSQL LISTEN/NOTIFY)
 *   - Presence
 *   - Broadcast
 *   - Triggers (platform management)
 *   - Logs
 *   - Dynamic catch-all (generated table CRUD)
 *
 * Next.js on port 3000 handles the frontend and platform management APIs.
 * In development, Next.js rewrites /api/v1/* → http://localhost:3001/api/v1/*
 * In production, nginx proxies /api/v1/* → this server.
 */

import 'dotenv/config'
import app from './app'

const PORT = parseInt(process.env.RUNTIME_PORT || '3001', 10)

const server = app.listen(PORT, () => {
  console.log(`[Runtime Server] Listening on http://localhost:${PORT}`)
  console.log(`[Runtime Server] Health: http://localhost:${PORT}/health`)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Runtime Server] SIGTERM received, shutting down gracefully...')
  server.close(() => {
    console.log('[Runtime Server] HTTP server closed')
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  console.log('[Runtime Server] SIGINT received, shutting down gracefully...')
  server.close(() => {
    process.exit(0)
  })
})
