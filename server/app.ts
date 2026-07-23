import express from 'express'
import cors from 'cors'
import helmet from 'helmet'

import authRoutes from './routes/auth'
import oauthRoutes from './routes/oauth'
import databaseRoutes from './routes/database'
import realtimeRoutes from './routes/realtime'
import presenceRoutes from './routes/presence'
import broadcastRoutes from './routes/broadcast'
import triggerRoutes from './routes/triggers'
import logRoutes from './routes/logs'
import bootstrapRoutes from './routes/bootstrap'
import dynamicRoutes from './routes/dynamic'
import v2Routes from './routes/v2'
import { nextProxy } from './routes/next-proxy'

const app = express()

// ── Security ───────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }))

// Public runtime API — every authenticated route uses x-api-key (no cookies),
// so we don't need credentials:true. CORS_ORIGIN may be a comma-separated list
// in env; the previous wildcard fallback is gone — we fail closed if it isn't
// set in production (no quiet allow-all on a public surface).
const corsOriginsRaw = process.env.CORS_ORIGIN ?? ''
const corsOrigins = corsOriginsRaw.split(',').map(s => s.trim()).filter(Boolean)
const isProd = process.env.NODE_ENV === 'production'

if (isProd && corsOrigins.length === 0) {
  // Surface this loudly at boot so a misconfigured env never goes silent.
  console.error('[Runtime Server] FATAL: CORS_ORIGIN must be set in production. Refusing to start with allow-all.')
  process.exit(1)
}

app.use(cors({
  origin: (origin, callback) => {
    // Server-to-server / curl (no Origin) — allow; API-key check still applies.
    if (!origin) return callback(null, true)
    if (corsOrigins.length === 0) {
      // Dev fallback only.
      return callback(null, true)
    }
    if (corsOrigins.includes(origin) || corsOrigins.includes('*')) {
      return callback(null, true)
    }
    // Explicit project-level CORS lives in the Next.js middleware (per-project
    // allowedOrigins). The Express runtime trusts whatever the global env says.
    return callback(null, false)
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'X-User-Token'],
}))

// ── Next.js-owned v1 surfaces (storage, orgs, stats, checkout, …) ──────────────
// nginx sends ALL /api/v1/* here, but these routes only exist in the Next app.
// Forward them BEFORE body parsing so multipart uploads stream untouched, and
// before the dynamic catch-all which would misread them as table CRUD.
app.use('/api/v1', nextProxy)

// ── Body parsing ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'backenly-runtime', timestamp: new Date().toISOString() })
})

// ── v1 Routes — mount all specific routes BEFORE the catch-all ─────────────────
const BASE = '/api/v1'

// Auth (no API key required — public registration/login for end users)
app.use(BASE, authRoutes)

// End-user OAuth (Google/GitHub/…) — GET /:projectId/auth/:provider[/callback].
// Mounted before the dynamic catch-all, which hard-404s any path containing
// "auth". No API key: the provider redirect flow is browser-initiated.
app.use(BASE, oauthRoutes)

// Database CRUD (requires API key)
app.use(BASE, databaseRoutes)

// Realtime SSE (NOW requires API key — UUID-obscurity is not security)
app.use(BASE, realtimeRoutes)

// Presence (NOW requires API key)
app.use(BASE, presenceRoutes)

// Broadcast (NOW requires API key)
app.use(BASE, broadcastRoutes)

// Triggers (platform JWT cookie auth)
app.use(BASE, triggerRoutes)

// Logs (API key)
app.use(BASE, logRoutes)

// Bootstrap — origin-based handshake, no API key required.
// MUST be mounted before the dynamic catch-all (which would otherwise
// claim /:projectId/bootstrap as a generic resource path).
app.use(BASE, bootstrapRoutes)

// Dynamic catch-all (API key or JWT)
// v2: PostgREST's native grammar. Mounted on its own base, so the v1 catch-all
// never sees these paths and cannot misread them as table CRUD.
app.use('/api/v2', v2Routes)

app.use(BASE, dynamicRoutes)

// ── Global error handler ───────────────────────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Runtime Server] Unhandled error:', err?.message ?? 'unknown')
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' })
})

export default app
