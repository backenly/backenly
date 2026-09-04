export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { prisma } from '@/lib/db'
import { markBackendGenerated } from '@/lib/analytics/logger'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'
import { canWriteProject } from '@/lib/edition/guard'

/**
 * POST /api/projects/[projectId]/commit  (SSE streaming)
 *
 * Streams task-level progress back to the client so the UI can tick
 * each checklist item one-by-one as the build completes.
 *
 * SSE event types:
 *   task_update  – { taskId, taskIndex, status: 'active' | 'complete' }
 *   complete     – { success, message, executionId, changes, narration }
 *   error        – { error }
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const encoder = new TextEncoder()

  // ReadableStream + synchronous enqueue — never blocks, no backpressure issues.
  // TransformStream writer.write() deadlocks in Node.js 20 standalone when the
  // readable side isn't yet being consumed (before Response is returned).
  let streamController: ReadableStreamDefaultController<Uint8Array>
  const readable = new ReadableStream<Uint8Array>({
    start(c) { streamController = c },
  })

  const send = (event: string, data: object) => {
    try {
      streamController.enqueue(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      )
    } catch { /* client disconnected */ }
  }

  // Run everything in the background so we can return the ReadableStream immediately
  ;(async () => {
      try {
        // ── Auth ─────────────────────────────────────────────────────────────
        const sessionToken = request.cookies.get('auth-token')?.value
        if (!sessionToken) {
          send('error', { error: 'Unauthorized' })
          try { streamController.close() } catch {}
          return
        }

        let userId: string
        try {
          const decoded = await verifyToken(sessionToken)
          userId = decoded.userId
        } catch {
          send('error', { error: 'Unauthorized' })
          try { streamController.close() } catch {}
          return
        }

        // ── Parse body ───────────────────────────────────────────────────────
        let userMessage: string
        try {
          const body = await request.json()
          userMessage = body.userMessage
        } catch {
          send('error', { error: 'Invalid request body' })
          try { streamController.close() } catch {}
          return
        }

        if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length < 5) {
          send('error', { error: 'userMessage is required and must be at least 5 characters' })
          try { streamController.close() } catch {}
          return
        }

        const projectId = params.id

        // ── Verify project ownership ─────────────────────────────────────────
        if (!(await canWriteProject(userId, projectId))) {
          send('error', { error: 'Project not found' })
          try { streamController.close() } catch {}
          return
        }

        console.log(`[Commit SSE] User committing intent for project ${projectId}`)

        // ── Heartbeat: keep Nginx/proxy alive during long orchestration ───────
        // Nginx default proxy_read_timeout is 60s; orchestration can take 180s.
        // Send SSE comment pings every 20s so the connection is never idle.
        let heartbeatInterval: ReturnType<typeof setInterval> | null = setInterval(() => {
          try {
            streamController.enqueue(encoder.encode(': ping\n\n'))
          } catch {
            if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null }
          }
        }, 20000)

        // ── Run build runtime (new graph-based build engine) ─────────────────
        // Replaces the dynamic agent loop. Executes phase-by-phase, creates all
        // tables/APIs/auth from canonical domain templates, never produces undefined
        // table names or silently skips APIs.
        const { runBuild } = await import('@/lib/ai/build-runtime')

        // Fetch stored integration keys so nodes auto-unblock when credentials exist
        const INTEGRATION_ENV_MAP: Record<string, string> = {
          stripe:    'STRIPE_SECRET_KEY',
          resend:    'RESEND_API_KEY',
          sendgrid:  'SENDGRID_API_KEY',
          openai:    'OPENAI_API_KEY',
          anthropic: 'ANTHROPIC_API_KEY',
        }
        let availableSecrets: string[] = []
        try {
          const storedKeys = await prisma.projectIntegrationKey.findMany({
            where: { projectId },
            select: { integrationId: true },
          })
          availableSecrets = storedKeys
            .map(k => INTEGRATION_ENV_MAP[k.integrationId])
            .filter((v): v is string => !!v)
        } catch { /* non-fatal — leave availableSecrets empty */ }

        // Stream real build events so the frontend can show live blocked-credential prompts.
        // Only the event types the client handles are forwarded — heartbeats and timing are
        // handled separately via the heartbeatInterval above.
        const STREAMABLE_EVENTS = new Set([
          'node_running', 'node_blocked', 'node_complete',
          'build_start', 'verification_complete', 'build_complete',
        ])
        const buildCtx = {
          projectId,
          userId,
          availableSecrets,
          emit: (event: string, data: unknown) => {
            if (STREAMABLE_EVENTS.has(event)) {
              send(event, data as object)
            }
          },
        }

        // ── Build execution with hard timeout ────────────────────────────────────
        // If any node hangs indefinitely (DB call, LLM call, network hang), the
        // heartbeat keeps the SSE stream alive forever and the client spinner
        // never clears. Enforce a 5-minute hard ceiling — any build that takes
        // longer than this is almost certainly stuck, not just slow.
        const BUILD_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

        let buildResult: Awaited<ReturnType<typeof runBuild>>
        try {
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Build timed out after 5 minutes. The backend was partially built — retry to continue.')), BUILD_TIMEOUT_MS)
          )
          buildResult = await Promise.race([
            runBuild(userMessage, buildCtx, { mode: 'build', resume: false }),
            timeoutPromise,
          ])
        } finally {
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval)
            heartbeatInterval = null
          }
        }

        const buildResponse = buildResult.response
        const builtNodes = buildResponse?.built ?? []

        console.log(`[Commit SSE] Build runtime complete:`, {
          jobStatus: buildResponse?.jobStatus,
          built: builtNodes.length,
          blocked: buildResponse?.blocked.length ?? 0,
          failed: buildResponse?.failed.length ?? 0,
        })

        // Transform BuildResponse into the changes format the project page expects
        const transformedChanges = {
          tables: builtNodes
            .filter(n => n.id.startsWith('schema.'))
            .map(n => ({ name: n.id.replace(/^schema\./, ''), status: 'created' })),
          apis: builtNodes
            .filter(n => n.id.startsWith('flow.'))
            .map(n => ({
              // Derive a human-readable name from the flow node ID
              name: n.id.replace(/^flow\./, '').replace(/_management$|_ops$|_checkout$|_catalog$|_processing$|_apis$/, ''),
              status: 'created',
            })),
          capabilities: [
            ...(builtNodes.some(n => n.id.startsWith('auth.'))
              ? [{ name: 'auth', type: 'auth', status: 'enabled' }]
              : []),
            ...builtNodes
              .filter(n => n.id.startsWith('storage.'))
              .map(n => ({ name: n.id.replace(/^storage\./, ''), type: 'storage', status: 'enabled' })),
            ...builtNodes
              .filter(n => n.id.startsWith('function.'))
              .map(n => ({ name: n.id.replace(/^function\./, ''), type: 'function', status: 'enabled' })),
          ],
        }

        const buildSuccess = !!buildResponse && ['verified', 'partial', 'blocked'].includes(buildResponse.jobStatus)

        // Track backend_generated funnel event (non-blocking)
        if (buildSuccess) {
          markBackendGenerated(projectId, userId)
          import('@/lib/ai/minimal-executor').then(({ inferAndSaveRelationships }) => inferAndSaveRelationships(projectId).catch(() => {}))
          import('@/lib/ai/execution-cache').then(({ invalidateSchemaCache }) => { invalidateSchemaCache(projectId) }).catch(() => {})
        }

        await send('complete', {
          success: buildSuccess,
          message: buildResponse?.markdown || (
            (buildResponse?.built?.length ?? 0) === 0 && (buildResponse?.blocked?.length ?? 0) === 0
              ? `I couldn't tell what to build from that. Try describing the feature in plain words — e.g. "add a posts table with title, body, and an author" — or type /status to see what's already in your backend.`
              : buildResponse?.blocked?.length
                ? `Almost there — paste the API key in chat to finish the integration.`
                : `Built ${buildResponse?.built?.length ?? 0} component${(buildResponse?.built?.length ?? 0) !== 1 ? 's' : ''}.`
          ),
          executionId: `build-${Date.now()}`,
          changes: transformedChanges,
          buildRuntime: true,
          buildResponse,
        })
      } catch (error) {
        console.error('[Commit SSE] Error:', error)
        send('error', {
          error: sanitizeDiagnostic(error) || 'Failed to commit intent',
        })
      } finally {
        try { streamController.close() } catch {}
      }
    })()

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable Nginx buffering for true streaming
    },
  })
}

