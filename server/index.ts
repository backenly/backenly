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
import { assertEditionCompositionOrExit } from '../lib/edition/cloud-extension'
import { installProcessSafetyNet } from './lib/async-route'
import { startUsageLedger, usageLedger } from '../lib/usage/ledger'
import app from './app'

// Before the socket, not after. This process serves every /api/v1/* request in
// production, so a cloud deployment that is missing its private half must die
// here rather than answer one request with single-tenant tenancy rules. A no-op
// unless BACKENLY_EDITION is explicitly cloud.
assertEditionCompositionOrExit('Runtime Server')

const PORT = parseInt(process.env.RUNTIME_PORT || '3001', 10)

const server = app.listen(PORT, () => {
  console.log(`[Runtime Server] Listening on http://localhost:${PORT}`)
  console.log(`[Runtime Server] Health: http://localhost:${PORT}/health`)
})

// The boundary of last resort, installed WITH the server so a drain is possible.
//
// Ordinary failures never reach it: every route is wrapped, so a dependency
// error becomes a 500 and this process keeps serving. A rejection that gets
// here escaped the request model altogether, and PM2 restarts this process, so
// exiting is the recovery rather than a second outage. See async-route.ts.
installProcessSafetyNet({ server })

// Metered usage this process records (function runs, egress on the single-box
// layout) is applied in batches: replay what an earlier process spooled, and
// spool on the way down. lib/usage/ledger.ts.
startUsageLedger()

// Graceful shutdown. The ledger is flushed AFTER the server stops accepting
// requests, so the last requests' usage is in the flush, and before exit. The
// ledger's own signal hook has already spooled it synchronously, so a flush
// that cannot reach the database in time is replayed on the next start.
process.on('SIGTERM', () => {
  console.log('[Runtime Server] SIGTERM received, shutting down gracefully...')
  server.close(async () => {
    console.log('[Runtime Server] HTTP server closed')
    await usageLedger().shutdown(5_000)
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  console.log('[Runtime Server] SIGINT received, shutting down gracefully...')
  server.close(async () => {
    await usageLedger().shutdown(5_000)
    process.exit(0)
  })
})
