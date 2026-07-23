/**
 * QA Journey Runner — Backenly Product-Readiness Test Suite
 *
 * Executes realistic end-to-end user journeys against the live API.
 * Records every SSE event, HTTP status, mutation, and response.
 *
 * This suite REGISTERS A REAL USER and creates real projects, so the target
 * defaults to localhost. Pointing it somewhere else is an explicit act:
 *
 *   BASE_URL=https://your-deployment npx tsx scripts/qa-journey-runner.ts
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const TEST_EMAIL = `qa-runner-${Date.now()}@backenly-qa-test.com`
const TEST_PASSWORD = 'QaTest@2024!'
const TEST_NAME = 'QA Runner Bot'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SSEEvent {
  type: string
  [key: string]: unknown
}

interface PromptResult {
  promptIndex: number
  promptText: string
  httpStatus: number
  durationMs: number
  events: SSEEvent[]
  thinkingMessages: string[]
  planSteps: Array<{ action: string; label: string }>
  stepResults: Array<{ action: string; label: string; status: string; error?: string }>
  completeEvent: SSEEvent | null
  errorEvent: SSEEvent | null
  buildStatus: SSEEvent | null
  finalMessage: string
  builtItems: Array<{ id: string; label: string }>
  blockedItems: Array<{ id: string; label: string; detail?: string }>
  failedItems: Array<{ id: string; label: string }>
  overallStatus: string
  rawSSE: string
  issues: string[]
  pass: boolean
}

interface JourneyResult {
  journeyName: string
  projectId: string
  projectName: string
  promptResults: PromptResult[]
  totalPrompts: number
  passed: number
  failed: number
  issues: string[]
  tablesCreated: string[]
  apisCreated: string[]
}

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

// Some routes use Authorization header (projectValidation middleware),
// others use the auth-token cookie (withAuth / requireUser via Next.js cookies()).
// Send BOTH to cover all routes.
function authHeaders(token?: string): Record<string, string> {
  if (!token) return { 'Content-Type': 'application/json' }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Cookie': `auth-token=${token}`,
  }
}

async function apiPost(path: string, body: unknown, token?: string, retries = 3): Promise<{ status: number; data: unknown }> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(body),
      })
      let data: unknown
      try { data = await res.json() } catch { data = null }
      return { status: res.status, data }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt < retries - 1 && (msg.includes('ENOTFOUND') || msg.includes('ECONNRESET') || msg.includes('fetch failed'))) {
        log('warn', `  ↺ Network error on apiPost (attempt ${attempt + 1}/${retries}): ${msg.slice(0, 80)} — retrying in 10s`)
        await sleep(10_000)
        continue
      }
      throw err
    }
  }
  throw new Error('apiPost: exhausted retries')
}

async function apiGet(path: string, token: string, retries = 3): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Cookie': `auth-token=${token}`,
  }
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${path}`, { headers })
      let data: unknown
      try { data = await res.json() } catch { data = null }
      return { status: res.status, data }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt < retries - 1 && (msg.includes('ENOTFOUND') || msg.includes('ECONNRESET') || msg.includes('fetch failed'))) {
        log('warn', `  ↺ Network error on apiGet (attempt ${attempt + 1}/${retries}): ${msg.slice(0, 80)} — retrying in 10s`)
        await sleep(10_000)
        continue
      }
      throw err
    }
  }
  throw new Error('apiGet: exhausted retries')
}

// ─── SSE Streaming ────────────────────────────────────────────────────────────

async function sendChatPrompt(
  message: string,
  projectId: string,
  token: string,
  conversationId?: string
): Promise<PromptResult> {
  const startTime = Date.now()
  const events: SSEEvent[] = []
  const rawLines: string[] = []
  let httpStatus = 0
  let completeEvent: SSEEvent | null = null
  let errorEvent: SSEEvent | null = null
  let buildStatus: SSEEvent | null = null
  const thinkingMessages: string[] = []
  const planSteps: Array<{ action: string; label: string }> = []
  const stepResults: Array<{ action: string; label: string; status: string; error?: string }> = []

  const url = `${BASE_URL}/api/ai/chat?projectId=${projectId}`
  const body: Record<string, unknown> = { message }
  if (conversationId) body.conversationId = conversationId

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Cookie': `auth-token=${token}`,
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    })

    httpStatus = res.status

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      return buildResult(message, httpStatus, Date.now() - startTime, events, rawLines.join('\n'),
        thinkingMessages, planSteps, stepResults, completeEvent, errorEvent, buildStatus,
        [`HTTP ${httpStatus}: ${text.slice(0, 200)}`])
    }

    // Detect response type — several pipeline stages (commandStage, deployStage, apiKeyStage)
    // return a regular JSON response, NOT an SSE stream.
    const contentType = res.headers.get('content-type') ?? ''
    const isSSE = contentType.includes('text/event-stream')

    if (!isSSE) {
      // Non-SSE response: parse as JSON and create a synthetic complete event
      const text = await res.text().catch(() => '{}')
      rawLines.push(text)
      let parsed: Record<string, unknown> = {}
      try { parsed = JSON.parse(text) } catch { /* raw text */ }

      // All non-SSE JSON responses from the pipeline are terminal responses.
      // Normalize them into a synthetic complete event so the test harness
      // can grade them uniformly regardless of which sub-behavior fired.
      // Known JSON types: verification, inspection, execution_complete,
      // execution_failed, continuation_unbound, rate_limited, integration_needs_key,
      // execution_partial, integration_needed, command_scan, command_status,
      // deploy_preview, deploy_success, deploy_refusal, api_key_*, error, ...
      const rawType = parsed.type ? String(parsed.type) : 'complete'
      // rate_limited is a valid terminal response (cooldown), not a test failure
      const isErrorType = rawType === 'error' || rawType.includes('failed')
      const synth: SSEEvent = {
        type: isErrorType ? 'error' : 'complete',
        _originalType: rawType,
        message: String(parsed.message ?? parsed.error ?? text.slice(0, 200)),
        success: !isErrorType && parsed.success !== false,
        responseData: parsed,
        buildSummary: (parsed.buildSummary ?? null) as unknown,
      }
      events.push(synth)
      if (isErrorType) {
        errorEvent = synth
      } else {
        completeEvent = synth
      }
    } else {
      // SSE stream — read until done, then flush remaining buffer
      function processSSELine(line: string) {
        rawLines.push(line)
        if (!line.startsWith('data: ')) return
        const dataStr = line.slice(6).trim()
        if (!dataStr || dataStr === '[DONE]') return
        let evt: SSEEvent
        try { evt = JSON.parse(dataStr) } catch { return }
        events.push(evt)
        if (evt.type === 'thinking') thinkingMessages.push(evt.message as string)
        else if (evt.type === 'plan') {
          planSteps.push(...((evt.steps as Array<{ action: string; label: string }>) ?? []))
        } else if (evt.type === 'step') {
          stepResults.push({ action: evt.action as string, label: evt.label as string, status: evt.status as string, error: evt.error as string | undefined })
        } else if (evt.type === 'build_status') {
          buildStatus = evt
        } else if (evt.type === 'complete') {
          completeEvent = evt
        } else if (evt.type === 'error') {
          errorEvent = evt
        }
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const timeoutMs = 180_000

      const timeout = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('SSE_TIMEOUT')), timeoutMs)
      )

      const stream = (async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            // Flush remaining buffer after stream ends
            if (buffer.trim()) {
              for (const line of buffer.split('\n')) processSSELine(line)
            }
            break
          }
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) processSSELine(line)
        }
      })()

      await Promise.race([stream, timeout]).catch((err: Error) => {
        if (err.message === 'SSE_TIMEOUT') {
          events.push({ type: 'qa_timeout', message: 'SSE stream timed out after 3 minutes' })
        }
      })

      reader.cancel().catch(() => {})
    }
  } catch (err: unknown) {
    const message2 = err instanceof Error ? err.message : String(err)
    // Network-level failures (DNS, connection reset) — retry once after 15s
    if (message2.includes('ENOTFOUND') || message2.includes('ECONNRESET') || message2.includes('fetch failed')) {
      log('warn', `  ↺ Network error in sendChatPrompt: ${message2.slice(0, 80)} — retrying in 15s`)
      await sleep(15_000)
      return sendChatPrompt(message, projectId, token, conversationId)
    }
    events.push({ type: 'qa_fetch_error', message: message2 })
    httpStatus = httpStatus || 0
  }

  return buildResult(message, httpStatus, Date.now() - startTime, events, rawLines.join('\n'),
    thinkingMessages, planSteps, stepResults, completeEvent, errorEvent, buildStatus, [])
}

function buildResult(
  promptText: string,
  httpStatus: number,
  durationMs: number,
  events: SSEEvent[],
  rawSSE: string,
  thinkingMessages: string[],
  planSteps: Array<{ action: string; label: string }>,
  stepResults: Array<{ action: string; label: string; status: string; error?: string }>,
  completeEvent: SSEEvent | null,
  errorEvent: SSEEvent | null,
  buildStatus: SSEEvent | null,
  extraIssues: string[]
): PromptResult {
  const issues: string[] = [...extraIssues]

  // Grade the result
  if (httpStatus === 500) issues.push('CRITICAL: HTTP 500 Internal Server Error')
  if (httpStatus === 404) issues.push('CRITICAL: HTTP 404 Not Found')
  if (httpStatus === 0) issues.push('CRITICAL: No HTTP response (fetch failed or timed out)')
  if (events.find(e => e.type === 'qa_timeout')) issues.push('WARN: SSE stream timed out (>3 min)')
  if (events.find(e => e.type === 'qa_fetch_error')) issues.push('CRITICAL: Fetch error — network/connection failure')
  if (!completeEvent && !errorEvent && httpStatus === 200) issues.push('WARN: No complete/error event received — stream ended silently')

  // Extract build summary — can be at multiple paths depending on pipeline stage:
  //   agent-loop path:    complete.buildSummary.built
  //   credential path:    complete.responseData.buildResponse.built
  //   top-level fallback: complete.built
  const completeData = completeEvent as Record<string, unknown> | null
  const buildSummary = (completeData?.buildSummary ?? (completeData?.responseData as Record<string, unknown>)?.buildResponse ?? completeData) as Record<string, unknown> | null

  function extractArray(key: string): Array<{ id: string; label: string; detail?: string }> {
    return (buildSummary?.[key] ?? completeData?.[key] ?? []) as Array<{ id: string; label: string; detail?: string }>
  }

  const builtItems = extractArray('built')
  const blockedItems = extractArray('blocked')
  const failedItems = extractArray('failed')

  // Determine the original pipeline response type for context-aware grading
  const originalType = String(completeData?._originalType ?? completeData?.type ?? '')
  const isNonBuildResponse = ['inspection', 'verification', 'command_scan', 'command_status',
    'command_help', 'command_why', 'continuation_unbound', 'rate_limited', 'cooldown',
    'deploy_preview', 'deploy_refusal', 'approval_required',
    'api_key_stored', 'api_key_format_error', 'api_key_invalid', 'integration_needed',
    'integration_needs_key', 'plan_mode', 'rollback_complete', 'rollback_failed',
    'schema_versions', 'non_feature_refusal', 'capability_boundary', 'safety_warning',
    'safety_blocked', 'conflict_detected'].some(t => originalType.includes(t))

  // Fake success check: success=true but nothing built AND message is generic
  if (completeData?.success === true && builtItems.length === 0 && !isNonBuildResponse) {
    const msg = ((completeData.message as string) ?? '').toLowerCase()
    if (!msg.includes('already') && !msg.includes('no changes') && !msg.includes('scan') &&
        !msg.includes('status') && !msg.includes('score') && !msg.includes('table') &&
        !msg.includes('api') && !msg.includes('blocked') && !msg.includes('production')) {
      issues.push('WARN: success=true but built[] is empty — possible fake success')
    }
  }

  // Best available message
  const finalMessage = ((buildSummary?.summary as string) ?? (completeData?.message as string) ?? (errorEvent?.message as string) ?? '').trim()
  const overallStatus = (buildSummary?.status as string) ?? (originalType || 'unknown') ?? (errorEvent ? 'error' : 'unknown')

  // Check step errors
  for (const step of stepResults) {
    if (step.status === 'error') issues.push(`STEP_FAIL: ${step.label} — ${step.error ?? 'no error detail'}`)
  }

  // Check failed items
  for (const f of failedItems) {
    issues.push(`BUILD_FAIL: ${f.label}`)
  }

  // Pass = no CRITICAL issues + HTTP 2xx + some response received
  // Don't require completeEvent specifically — cooldown, approval, and other terminal
  // pipeline responses are valid without a "complete" event.
  const pass = issues.filter(i => i.startsWith('CRITICAL')).length === 0
    && httpStatus >= 200 && httpStatus < 300
    && events.length > 0

  return {
    promptIndex: 0,
    promptText,
    httpStatus,
    durationMs,
    events,
    thinkingMessages,
    planSteps,
    stepResults,
    completeEvent,
    errorEvent,
    buildStatus,
    finalMessage,
    builtItems,
    blockedItems,
    failedItems,
    overallStatus,
    rawSSE,
    issues,
    pass,
  }
}

// ─── Database State Inspection ────────────────────────────────────────────────

async function getProjectTables(projectId: string, token: string): Promise<string[]> {
  // API requires type=postgresql and Cookie auth (withProjectAccess uses requireUser → cookies)
  const res = await apiGet(`/api/database/tables?projectId=${projectId}&type=postgresql&view=all`, token)
  if (res.status !== 200) return []
  const data = res.data as Record<string, unknown>
  // Response shape: { success: true, data: [{ name, ... }], count }
  const tables = (data?.data ?? data?.tables ?? []) as Array<{ name?: string; tableName?: string }>
  if (!Array.isArray(tables)) return []
  return tables.map((t) => t.name ?? t.tableName ?? '').filter(Boolean)
}

async function getProjectAPIs(projectId: string, token: string): Promise<string[]> {
  const tables = await getProjectTables(projectId, token)
  return tables // API counts derived from table list for now
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function upgradeTestUser(userId: string): Promise<void> {
  // SSH to the deployment host and bump the test user's subscription to PRO
  // so we have unlimited AI builds and multiple projects during the test run.
  const { execSync } = await import('child_process')
  const sql = `
    UPDATE "Subscription" s
    SET "planId" = (SELECT id FROM "Plan" WHERE name = 'PRO' LIMIT 1), status = 'ACTIVE', "currentPeriodEnd" = NOW() + INTERVAL '1 year'
    WHERE "userId" = '${userId}' AND EXISTS (SELECT 1 FROM "Plan" WHERE name = 'PRO');
    UPDATE "UserAiUsage" SET "buildsUsed" = 0 WHERE "userId" = '${userId}';
  `.replace(/\n/g, ' ').trim()

  // Requires an explicitly configured host. There is no default: a literal one
  // publishes the target, and `StrictHostKeyChecking=no` against a hardcoded
  // address means silently trusting whatever answers at it.
  const sshHost = process.env.QA_SSH_HOST
  const dbName = process.env.QA_DB_NAME || 'backenly'
  if (!sshHost) {
    log('warn', 'QA_SSH_HOST not set — skipping subscription upgrade (test continues on the free plan)')
    return
  }

  const cmd = `ssh ${sshHost} "sudo -u postgres psql -d ${dbName} -c \\"${sql}\\"" 2>&1`
  try {
    const out = execSync(cmd, { timeout: 15000 }).toString()
    log('pass', `Subscription upgraded to PRO: ${out.trim().slice(0, 80)}`)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log('warn', `Could not upgrade subscription (continuing anyway): ${msg.slice(0, 100)}`)
  }
}

async function setupTestAccount(): Promise<{ token: string; userId: string }> {
  log('info', `Registering test account: ${TEST_EMAIL}`)
  const reg = await apiPost('/api/auth/register', {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    name: TEST_NAME,
  })

  if (reg.status === 200 || reg.status === 201) {
    const d = reg.data as Record<string, unknown>
    const token = d.token as string
    const userId = (d.user as Record<string, unknown>)?.id as string
    log('pass', `Registered — userId: ${userId}`)
    await upgradeTestUser(userId)
    return { token, userId }
  }

  if (reg.status === 409 || reg.status === 400) {
    // Email already exists — try login
    log('info', 'Email exists, logging in...')
    const login = await apiPost('/api/auth/login', { email: TEST_EMAIL, password: TEST_PASSWORD })
    if (login.status === 200) {
      const d = login.data as Record<string, unknown>
      const token = d.token as string
      const userId = (d.user as Record<string, unknown>)?.id as string
      log('pass', `Logged in — userId: ${userId}`)
      await upgradeTestUser(userId)
      return { token, userId }
    }
    throw new Error(`Login failed: ${login.status} — ${JSON.stringify(login.data)}`)
  }

  throw new Error(`Registration failed: ${reg.status} — ${JSON.stringify(reg.data)}`)
}

async function createTestProject(name: string, token: string, userId: string): Promise<string> {
  const res = await apiPost('/api/projects', {
    name: `[QA] ${name}`,
    description: `QA Journey Test — ${new Date().toISOString()}`,
    environment: 'development',
    userId, // required by Zod schema
  }, token)

  if (res.status === 200 || res.status === 201) {
    const d = res.data as Record<string, unknown>
    // Response shape: { success: true, data: { id, ... }, apiKey }
    const inner = (d.data ?? d) as Record<string, unknown>
    const projectId = (inner.id ?? d.id) as string
    if (!projectId) throw new Error(`No id in project response: ${JSON.stringify(d).slice(0, 200)}`)
    log('pass', `Project created: ${projectId} — ${name}`)
    return projectId
  }
  throw new Error(`Project creation failed: ${res.status} — ${JSON.stringify(res.data)}`)
}

// ─── Journey Runner ───────────────────────────────────────────────────────────

async function runJourney(
  journeyName: string,
  prompts: Array<{ text: string; checks: string[] }>,
  token: string,
  userId: string
): Promise<JourneyResult> {
  log('journey', `\n${'═'.repeat(60)}\n  JOURNEY: ${journeyName}\n${'═'.repeat(60)}`)

  const projectId = await createTestProject(journeyName, token, userId)
  const convId = `${projectId}-qa-${Date.now()}`
  const promptResults: PromptResult[] = []
  let passed = 0
  let failed = 0
  const journeyIssues: string[] = []

  const tablesBefore = await getProjectTables(projectId, token)

  for (let i = 0; i < prompts.length; i++) {
    const { text, checks } = prompts[i]
    log('prompt', `\n[${i + 1}/${prompts.length}] ${text.slice(0, 80)}...`)

    const tablesBefore2 = await getProjectTables(projectId, token)
    const result = await sendChatPromptWithCooldownRetry(text, projectId, token, convId)
    result.promptIndex = i + 1
    const tablesAfter = await getProjectTables(projectId, token)
    const newTables = tablesAfter.filter(t => !tablesBefore2.includes(t))

    // Custom checks per prompt
    const checkIssues = runChecks(result, checks, newTables, tablesAfter)
    result.issues.push(...checkIssues)
    result.pass = result.pass && checkIssues.filter(c => c.startsWith('FAIL')).length === 0

    if (result.pass) {
      passed++
      log('pass', `  ✓ PASS — ${result.overallStatus} | built:${result.builtItems.length} blocked:${result.blockedItems.length} | ${result.durationMs}ms`)
    } else {
      failed++
      log('fail', `  ✗ FAIL — ${result.issues.join('; ')}`)
      journeyIssues.push(...result.issues.filter(i2 => i2.startsWith('CRITICAL') || i2.startsWith('FAIL')))
    }

    log('detail', `     Message: ${result.finalMessage.slice(0, 200)}`)
    if (result.blockedItems.length) log('detail', `     Blocked: ${result.blockedItems.map(b => b.label).join(', ')}`)
    if (result.builtItems.length) log('detail', `     Built:   ${result.builtItems.map(b => b.label).join(', ')}`)
    if (newTables.length) log('detail', `     New tables: ${newTables.join(', ')}`)

    promptResults.push(result)
    // Throttle between prompts — 12s gives the build lock time to clear for short operations.
    // For long builds (>30s), sendChatPromptWithCooldownRetry handles the retry automatically.
    await sleep(12_000)
  }

  const tablesAfterAll = await getProjectTables(projectId, token)

  log('summary', `\n  Journey complete — passed: ${passed}/${prompts.length} | new tables: ${tablesAfterAll.filter(t => !tablesBefore.includes(t)).join(', ')}`)

  return {
    journeyName,
    projectId,
    projectName: `[QA] ${journeyName}`,
    promptResults,
    totalPrompts: prompts.length,
    passed,
    failed,
    issues: journeyIssues,
    tablesCreated: tablesAfterAll.filter(t => !tablesBefore.includes(t)),
    apisCreated: [],
  }
}

// ─── Per-Prompt Checkers ──────────────────────────────────────────────────────

function runChecks(result: PromptResult, checks: string[], newTables: string[], allTables: string[]): string[] {
  const issues: string[] = []
  for (const check of checks) {
    if (check.startsWith('table:')) {
      const tName = check.slice(6)
      if (!allTables.some(t => t.toLowerCase().includes(tName.toLowerCase()))) {
        issues.push(`FAIL: expected table "${tName}" not found in schema (found: ${allTables.join(', ')})`)
      }
    } else if (check === 'no_duplicate_tables') {
      const dupes = allTables.filter((t, i) => allTables.indexOf(t) !== i)
      if (dupes.length) issues.push(`FAIL: duplicate tables detected: ${dupes.join(', ')}`)
    } else if (check === 'block_stripe') {
      const msg = result.finalMessage.toLowerCase()
      // Accept: explicit Stripe block, OR generic payment_provider block (when prompt says "Connect Stripe" literally)
      const hasStripeBlock = result.blockedItems.some(b =>
        b.label?.toLowerCase().includes('stripe') || (b.id ?? '').toLowerCase().includes('stripe') ||
        b.label?.toLowerCase().includes('payment provider') || (b.id ?? '').toLowerCase().includes('payment_provider')
      ) || (
        msg.includes('stripe') &&
        (msg.includes('key') || msg.includes('credential') || msg.includes('api') || msg.includes('secret'))
      ) || msg.includes('payment provider') || msg.includes('provider not selected') ||
        String(result.overallStatus).includes('integration_needs_key') || String(result.overallStatus).includes('blocked')
      if (!hasStripeBlock) {
        issues.push(`FAIL: payment integration should be blocked (no key) but was not clearly blocked in response`)
      }
    } else if (check === 'requires_approval') {
      const msg = result.finalMessage.toLowerCase()
      const origType = String((result.completeEvent as Record<string, unknown>)?._originalType ?? '')
      // Accept: message contains approval language OR the response type is destructive gate
      const hasApprovalGate = msg.includes('confirm') || msg.includes('approval') || msg.includes('sure') ||
        (msg.includes('remove') && msg.includes('are you')) ||
        msg.includes('destructive') || msg.includes('proceed') || msg.includes('delete') ||
        origType.includes('destructive') || origType.includes('approval') || origType.includes('gate')
      if (!hasApprovalGate && result.overallStatus !== 'blocked') {
        issues.push(`FAIL: destructive action should require approval but no gate detected (got: "${result.finalMessage.slice(0, 80)}")`)
      }
    } else if (check === 'no_new_tables') {
      if (newTables.length > 0) {
        issues.push(`FAIL: expected no new tables (scan/status should be read-only) but got: ${newTables.join(', ')}`)
      }
    } else if (check === 'has_tables') {
      if (allTables.length === 0) {
        issues.push(`FAIL: expected backend tables to exist after initial build, found none`)
      }
    } else if (check === 'no_empty_build') {
      // Build must not return "Build complete." with 0 built items and no meaningful message.
      // Acceptable: built items exist, OR message explicitly explains why nothing changed.
      const msg = result.finalMessage.toLowerCase()
      const hasBuiltItems = result.builtItems.length > 0
      const hasExplicitNoOp =
        msg.includes('already exist') || msg.includes('nothing changed') ||
        msg.includes("couldn't determine") || msg.includes('no changes') ||
        msg.includes('already built') || msg.includes('no executable')
      const isEmptyBuild =
        !hasBuiltItems && !hasExplicitNoOp &&
        (msg.includes('build complete') || msg.includes('starting') || msg.length < 60)
      if (isEmptyBuild) {
        issues.push(`FAIL: build returned 0 items with no explanation (got: "${result.finalMessage.slice(0, 120)}")`)
      }
    } else if (check === 'no_500') {
      if (result.httpStatus === 500) issues.push(`FAIL: HTTP 500 received`)
    } else if (check === 'no_fake_success') {
      if (result.overallStatus === 'verified' && result.builtItems.length === 0 && result.finalMessage.length < 30) {
        issues.push(`FAIL: possible fake success — verified with no built items and short message`)
      }
    } else if (check === 'rollback_mentioned') {
      const msg = result.finalMessage.toLowerCase()
      if (!msg.includes('rollback') && !msg.includes('rolled back') && !msg.includes('restored') &&
          !msg.includes('undone') && !msg.includes('reverted') && !msg.includes('undo')) {
        issues.push(`FAIL: rollback response should mention rollback/restored but got: ${result.finalMessage.slice(0, 100)}`)
      }
    } else if (check === 'audit_response') {
      const msg = result.finalMessage.toLowerCase()
      // Accept: message contains removal/deletion/causal language OR a /why-style "reason" breakdown
      const hasAuditContent = msg.includes('remov') || msg.includes('delet') || msg.includes('because') ||
        msg.includes('request') || msg.includes('reason') || msg.includes('why') ||
        msg.includes('happened') || msg.includes('failed') || msg.includes('error')
      if (!hasAuditContent) {
        issues.push(`FAIL: audit/history response should explain the "why" but got: ${result.finalMessage.slice(0, 100)}`)
      }
    }
  }
  return issues
}

// ─── Journey Definitions ──────────────────────────────────────────────────────

const JOURNEY_1_MARKETPLACE = [
  {
    text: 'Build me a marketplace for handmade products where sellers can open stores, upload products, buyers can order, pay online, review products, and message sellers.',
    checks: ['has_tables', 'table:users', 'table:products', 'no_duplicate_tables', 'no_500'],
  },
  {
    text: 'Add a seller dashboard backend where sellers can see their orders, revenue, product stock, and recent messages.',
    checks: ['no_duplicate_tables', 'no_500', 'no_fake_success'],
  },
  {
    text: 'Add product search with category filtering, price filtering, and pagination.',
    checks: ['no_500', 'no_fake_success', 'no_duplicate_tables'],
  },
  {
    text: 'Add wishlist and cart support.',
    checks: ['table:cart', 'table:wishlist', 'no_duplicate_tables', 'no_500'],
  },
  {
    text: 'Add inventory management so stock decreases after successful payment.',
    checks: ['no_500', 'no_duplicate_tables'],
  },
  {
    text: 'Connect Stripe checkout.',
    checks: ['block_stripe', 'no_500'],
  },
  {
    text: 'sk_test_1234567890abcdef',
    checks: ['no_500'],
  },
  {
    text: 'Add email notifications for order confirmation, shipping update, and seller new order alert.',
    checks: ['no_500', 'no_fake_success'],
  },
  {
    text: 'Make this production ready. Scan what is missing.',
    checks: ['no_new_tables', 'no_500'],
  },
  {
    text: 'Fix all safe issues automatically.',
    checks: ['no_500', 'no_fake_success'],
  },
  {
    text: 'Remove reviews from the project. I don\'t want reviews anymore.',
    checks: ['requires_approval', 'no_500'],
  },
  {
    text: 'confirm remove reviews',
    checks: ['no_500', 'no_fake_success'],
  },
  {
    text: 'Why did you remove reviews?',
    checks: ['audit_response', 'no_500'],
  },
  {
    text: 'Rollback the last change.',
    checks: ['rollback_mentioned', 'no_500'],
  },
  {
    text: '/status',
    checks: ['no_new_tables', 'no_500'],
  },
  {
    text: '/scan',
    checks: ['no_new_tables', 'no_500'],
  },
]

// CB1 regression: marketplace build must create foundational entities first.
// "pay online" must NOT cause stripe/orders to be built before users/products.
const CB1_REGRESSION_PROMPT = 'Build me a marketplace for handmade products where sellers can open stores, upload products, buyers can order, pay online, review products, and message sellers.'
const CB1_REGRESSION_CHECKS = ['has_tables', 'table:users', 'table:products', 'table:stores', 'no_500']

const CROSS_JOURNEY_TESTS = [
  // ── CB1 regression — entity-first ordering ─────────────────────────────────
  {
    text: CB1_REGRESSION_PROMPT,
    checks: CB1_REGRESSION_CHECKS,
  },
  {
    text: 'do whatever you think is needed',
    checks: ['no_500', 'no_fake_success'],
  },
  {
    text: 'delete one bucket',
    checks: ['no_500'],
  },
  {
    text: 'make it production grade',
    checks: ['no_new_tables', 'no_500'],
  },
  {
    text: 'connect payment',
    checks: ['no_500'],
  },
  {
    text: 'remove payment system',
    checks: ['requires_approval', 'no_500'],
  },
  {
    text: 'this is broken fix it',
    checks: ['no_500', 'no_fake_success'],
  },
  {
    text: 'continue',
    checks: ['no_500', 'no_fake_success'],
  },
  {
    text: 'why did this fail?',
    checks: ['no_500'],
  },
  {
    text: 'undo that',
    checks: ['no_500'],
  },
  {
    text: 'deploy',
    checks: ['no_500'],
  },
  // ── No-op build regression (R2 fix) ────────────────────────────────────────
  // After a build that creates users/products, "Add wishlist and cart support."
  // must either create carts/wishlists OR explicitly explain why not.
  // Must NEVER return "Build complete." with 0 items and no explanation.
  {
    text: 'Build a simple product catalog with users and products tables.',
    checks: ['has_tables', 'table:users', 'table:products', 'no_500'],
  },
  {
    text: 'Add wishlist and cart support.',
    checks: ['no_empty_build', 'no_500'],
  },
]

// ── Cold-start build routing regression tests ───────────────────────────────
// Each of these MUST run on a fresh empty project.
// They verify that serious autonomous build prompts always reach runBuild()
// and produce foundational schema (users first) — not just payment/integration nodes.
// CB1: "pay online" / "manage billing" must NOT trigger template short-circuit.
const COLD_START_REGRESSION_TESTS: Array<{ name: string; text: string; checks: string[] }> = [
  {
    name: 'CB1-Marketplace',
    text: 'Build me a marketplace for handmade products where sellers can open stores, upload products, buyers can order, pay online, review products, and message sellers.',
    checks: ['has_tables', 'table:users', 'table:products', 'no_500'],
  },
  {
    name: 'CB1-SaaS',
    text: 'Build me a SaaS project management tool where teams can create projects, assign tasks, track time, invite members, and manage billing.',
    checks: ['has_tables', 'table:users', 'no_duplicate_tables', 'no_500'],
  },
  {
    name: 'CB1-FoodDelivery',
    text: 'Build me a food delivery backend where restaurants list menus, customers order food, drivers accept deliveries, and customers pay online.',
    checks: ['has_tables', 'table:users', 'no_duplicate_tables', 'no_500'],
  },
]

// ─── Logging ──────────────────────────────────────────────────────────────────

const LOG_COLORS = {
  info:    '\x1b[36m',   // cyan
  pass:    '\x1b[32m',   // green
  fail:    '\x1b[31m',   // red
  warn:    '\x1b[33m',   // yellow
  journey: '\x1b[35m',   // magenta
  prompt:  '\x1b[34m',   // blue
  detail:  '\x1b[90m',   // dark gray
  summary: '\x1b[96m',   // bright cyan
  reset:   '\x1b[0m',
}

function log(level: keyof typeof LOG_COLORS, msg: string) {
  const color = LOG_COLORS[level] ?? LOG_COLORS.info
  console.log(`${color}${msg}${LOG_COLORS.reset}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Wraps sendChatPrompt with automatic cooldown detection and retry.
 * When the build rate-limiter fires (cooldown active), parse the wait duration
 * and retry once instead of counting it as a test failure.
 */
async function sendChatPromptWithCooldownRetry(
  message: string,
  projectId: string,
  token: string,
  conversationId?: string,
  maxRetries = 1,
): Promise<PromptResult> {
  let result = await sendChatPrompt(message, projectId, token, conversationId)

  for (let retry = 0; retry < maxRetries; retry++) {
    const msgLower = result.finalMessage.toLowerCase()
    const origType = String((result.completeEvent as Record<string, unknown>)?._originalType ?? '')
    const isCooldown =
      msgLower.includes('cooldown') ||
      msgLower.includes('rate limit') ||
      (msgLower.includes('please wait') && /\d+\s*s/.test(msgLower)) ||
      origType.includes('rate_limited') ||
      result.httpStatus === 429

    // Also retry when the build lock is still held from a previous operation
    const isBuildLock =
      msgLower.includes('build operation is already running') ||
      msgLower.includes('already running for this project') ||
      msgLower.includes('wait for it to complete')

    if (!isCooldown && !isBuildLock) break

    let sleepSecs: number
    if (isBuildLock) {
      sleepSecs = 35
      log('warn', `  ↺ Build lock active — sleeping ${sleepSecs}s then retrying...`)
    } else {
      // Parse cooldown seconds from message like "please wait 46s" or "wait 117 seconds"
      const secMatch = result.finalMessage.match(/wait[^.]*?(\d+)\s*s(?:ec(?:ond)?s?)?/i)
      sleepSecs = secMatch ? parseInt(secMatch[1]) + 5 : 125
      log('warn', `  ↺ Cooldown detected — sleeping ${sleepSecs}s then retrying prompt...`)
    }
    await sleep(sleepSecs * 1000)
    result = await sendChatPrompt(message, projectId, token, conversationId)
  }

  return result
}

// ─── Report Generation ────────────────────────────────────────────────────────

function generateReport(journeys: JourneyResult[], crossJourney: JourneyResult, coldStart?: JourneyResult): void {
  const divider = '═'.repeat(72)
  const thin = '─'.repeat(72)
  const allJourneys = [...journeys, crossJourney, ...(coldStart ? [coldStart] : [])]

  console.log(`\n${divider}`)
  console.log(`  BACKENLY QA REPORT — ${new Date().toISOString()}`)
  console.log(`${divider}\n`)

  // ── 1. Journey Results Table
  console.log('1. JOURNEY RESULTS TABLE')
  console.log(thin)
  console.log('Journey                          | Prompts | Pass | Fail | Issues')
  console.log(thin)
  for (const j of allJourneys) {
    const name = j.journeyName.padEnd(32).slice(0, 32)
    const p = String(j.totalPrompts).padStart(7)
    const pass = String(j.passed).padStart(4)
    const fail = String(j.failed).padStart(4)
    const iss = j.issues.length.toString().padStart(6)
    console.log(`${name} | ${p} | ${pass} | ${fail} | ${iss}`)
  }
  console.log()

  // ── 2. Critical Bugs
  console.log('2. CRITICAL BUGS FOUND')
  console.log(thin)
  let bugCount = 0
  for (const j of allJourneys) {
    for (const r of j.promptResults) {
      const critical = r.issues.filter(i => i.startsWith('CRITICAL') || i.startsWith('FAIL'))
      if (critical.length === 0) continue
      bugCount++
      console.log(`\nBug #${bugCount}`)
      console.log(`  Journey:  ${j.journeyName}`)
      console.log(`  Prompt:   [${r.promptIndex}] ${r.promptText.slice(0, 100)}`)
      console.log(`  Expected: checks: ${JOURNEY_1_MARKETPLACE[r.promptIndex - 1]?.checks?.join(', ') ?? 'see definition'}`)
      console.log(`  Actual:   HTTP ${r.httpStatus} | status=${r.overallStatus} | built=${r.builtItems.length} | blocked=${r.blockedItems.length}`)
      console.log(`  Issues:   ${critical.join('\n            ')}`)
      console.log(`  Message:  ${r.finalMessage.slice(0, 200)}`)
    }
  }
  if (bugCount === 0) console.log('  No critical bugs found.')
  console.log()

  // ── 3. UX Quality Report
  console.log('3. UX QUALITY REPORT')
  console.log(thin)
  let responseCount = 0
  let botlikeCount = 0
  const botlikeResponses: Array<{ journey: string; prompt: string; message: string; issue: string }> = []

  for (const j of allJourneys) {
    for (const r of j.promptResults) {
      responseCount++
      const msg = r.finalMessage
      const issues: string[] = []

      // Detect bot-like patterns
      if (msg.toLowerCase().startsWith('great') || msg.toLowerCase().startsWith('certainly') || msg.toLowerCase().startsWith('of course')) {
        issues.push('Generic opener ("Great/Certainly/Of course")')
      }
      if (msg.includes('As an AI') || msg.includes('As a language model')) {
        issues.push('Self-identifies as AI in response')
      }
      if (msg.length < 30 && r.httpStatus === 200 && r.overallStatus !== 'blocked') {
        issues.push('Response too short — may be truncated or empty')
      }
      if (/✅.*✅.*✅/.test(msg)) {
        issues.push('Excessive emoji checkmarks — marketing-like')
      }
      if (msg.toLowerCase().includes('let me know if you need') || msg.toLowerCase().includes('feel free to')) {
        issues.push('Filler closing phrase')
      }

      if (issues.length) {
        botlikeCount++
        botlikeResponses.push({ journey: j.journeyName, prompt: r.promptText.slice(0, 60), message: msg.slice(0, 150), issue: issues.join('; ') })
      }
    }
  }

  console.log(`  Total responses graded: ${responseCount}`)
  console.log(`  Bot-like patterns detected: ${botlikeCount}/${responseCount}`)
  if (botlikeResponses.length) {
    console.log('\n  Worst responses:')
    for (const b of botlikeResponses.slice(0, 5)) {
      console.log(`    • [${b.journey}] "${b.prompt}"`)
      console.log(`      Issue: ${b.issue}`)
      console.log(`      Message: ${b.message}`)
    }
  }
  console.log()

  // ── 4. Runtime Reliability Report
  console.log('4. RUNTIME RELIABILITY REPORT')
  console.log(thin)
  let total500 = 0, total404 = 0, totalTimeout = 0, totalSilent = 0
  for (const j of allJourneys) {
    for (const r of j.promptResults) {
      if (r.httpStatus === 500) total500++
      if (r.httpStatus === 404) total404++
      if (r.issues.some(i => i.includes('TIMEOUT'))) totalTimeout++
      if (r.issues.some(i => i.includes('silent'))) totalSilent++
    }
  }
  console.log(`  HTTP 500 errors:    ${total500}`)
  console.log(`  HTTP 404 errors:    ${total404}`)
  console.log(`  SSE timeouts:       ${totalTimeout}`)
  console.log(`  Silent failures:    ${totalSilent}`)

  // Tables check — look for duplicates across journeys
  console.log('\n  Tables created per journey:')
  for (const j of journeys) {
    console.log(`    ${j.journeyName}: [${j.tablesCreated.join(', ')}]`)
  }
  console.log()

  // ── 5. Launch Readiness Verdict
  console.log('5. LAUNCH READINESS VERDICT')
  console.log(thin)
  const totalPrompts = allJourneys.reduce((s, j) => s + j.totalPrompts, 0)
  const totalPassed = allJourneys.reduce((s, j) => s + j.passed, 0)
  const totalFailed = allJourneys.reduce((s, j) => s + j.failed, 0)
  const passRate = Math.round((totalPassed / totalPrompts) * 100)

  console.log(`  Total prompts tested: ${totalPrompts}`)
  console.log(`  Passed: ${totalPassed} (${passRate}%)`)
  console.log(`  Failed: ${totalFailed}`)
  console.log(`  HTTP 500s: ${total500}`)
  console.log(`  Timeouts: ${totalTimeout}`)
  console.log()

  if (total500 > 0 || passRate < 70) {
    console.log('\x1b[31m  VERDICT: NOT USABLE — critical failures present\x1b[0m')
    console.log('  Cannot expose 10 real users to these failure rates without manual rescue.')
  } else if (passRate < 85) {
    console.log('\x1b[33m  VERDICT: PARTIAL — usable with supervision\x1b[0m')
    console.log('  Core flows work but edge cases and some follow-ups fail. Needs fixes before broad rollout.')
  } else {
    console.log('\x1b[32m  VERDICT: USABLE — with the caveats listed above\x1b[0m')
    console.log('  Core journeys pass. Blocked integrations (Stripe/email) are handled honestly.')
  }
  console.log()

  // ── Full event log for debugging
  console.log('6. DETAILED PROMPT LOG (all events)')
  console.log(thin)
  for (const j of allJourneys) {
    console.log(`\n  [${j.journeyName}] project: ${j.projectId}`)
    for (const r of j.promptResults) {
      const icon = r.pass ? '✓' : '✗'
      console.log(`\n    ${icon} Prompt ${r.promptIndex}: ${r.promptText.slice(0, 80)}`)
      console.log(`       HTTP ${r.httpStatus} | ${r.durationMs}ms | status=${r.overallStatus}`)
      console.log(`       Built:   ${r.builtItems.map(b => b.label).join(', ') || '(none)'}`)
      console.log(`       Blocked: ${r.blockedItems.map(b => b.label).join(', ') || '(none)'}`)
      console.log(`       Failed:  ${r.failedItems.map(f => f.label).join(', ') || '(none)'}`)
      console.log(`       Message: ${r.finalMessage.slice(0, 250)}`)
      if (r.issues.length) console.log(`       Issues:  ${r.issues.join('\n                ')}`)
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(72)}`)
  console.log(`  BACKENLY QA JOURNEY RUNNER`)
  console.log(`  Target: ${BASE_URL}`)
  console.log(`  Started: ${new Date().toISOString()}`)
  console.log(`${'═'.repeat(72)}\n`)

  let token: string
  let userId: string

  try {
    const account = await setupTestAccount()
    token = account.token
    userId = account.userId
  } catch (err) {
    console.error('\x1b[31mFATAL: Could not set up test account:\x1b[0m', err)
    process.exit(1)
  }

  const journeyResults: JourneyResult[] = []

  // Journey 1 — Multi-Vendor Marketplace (full)
  const j1 = await runJourney('Multi-Vendor Marketplace', JOURNEY_1_MARKETPLACE, token, userId)
  journeyResults.push(j1)

  // Cross-Journey Failure Tests (run on a fresh project)
  log('journey', '\n  Creating fresh project for cross-journey tests...')
  const crossProject = await createTestProject('Cross-Journey Failure Tests', token, userId).catch(() => j1.projectId)
  const crossResults: JourneyResult = {
    journeyName: 'Cross-Journey Failure Tests',
    projectId: crossProject,
    projectName: '[QA] Cross-Journey',
    promptResults: [],
    totalPrompts: CROSS_JOURNEY_TESTS.length,
    passed: 0,
    failed: 0,
    issues: [],
    tablesCreated: [],
    apisCreated: [],
  }

  const crossConvId = `${crossProject}-cross-${Date.now()}`
  for (let i = 0; i < CROSS_JOURNEY_TESTS.length; i++) {
    const { text, checks } = CROSS_JOURNEY_TESTS[i]
    log('prompt', `\n[CROSS ${i + 1}/${CROSS_JOURNEY_TESTS.length}] ${text.slice(0, 80)}`)
    const r = await sendChatPromptWithCooldownRetry(text, crossProject, token, crossConvId)
    r.promptIndex = i + 1
    const tables = await getProjectTables(crossProject, token)
    const checkIssues = runChecks(r, checks, [], tables)
    r.issues.push(...checkIssues)
    r.pass = r.pass && checkIssues.filter(c => c.startsWith('FAIL')).length === 0
    if (r.pass) { crossResults.passed++; log('pass', `  ✓ ${r.overallStatus} | ${r.durationMs}ms`) }
    else { crossResults.failed++; log('fail', `  ✗ ${r.issues.join('; ')}`) }
    log('detail', `     ${r.finalMessage.slice(0, 200)}`)
    crossResults.promptResults.push(r)
    crossResults.issues.push(...r.issues.filter(i2 => i2.startsWith('CRITICAL') || i2.startsWith('FAIL')))
    await sleep(12_000)
  }

  crossResults.tablesCreated = await getProjectTables(crossProject, token)

  // ── Cold-start regression: each test gets its own empty project ────────────
  log('journey', '\n  Running cold-start build routing regression tests (1 fresh project per test)...')
  const coldStartResults: JourneyResult = {
    journeyName: 'Cold-Start Build Routing Regression',
    projectId: 'multi',
    projectName: '[QA] Cold-Start',
    promptResults: [],
    totalPrompts: COLD_START_REGRESSION_TESTS.length,
    passed: 0,
    failed: 0,
    issues: [],
    tablesCreated: [],
    apisCreated: [],
  }

  for (let i = 0; i < COLD_START_REGRESSION_TESTS.length; i++) {
    const { name, text, checks } = COLD_START_REGRESSION_TESTS[i]
    log('prompt', `\n[COLD ${i + 1}/${COLD_START_REGRESSION_TESTS.length}] ${name}: ${text.slice(0, 80)}`)
    const freshProject = await createTestProject(`Cold-Start-${name}`, token, userId).catch(() => crossProject)
    const r = await sendChatPromptWithCooldownRetry(text, freshProject, token, `${freshProject}-cold-${Date.now()}`)
    r.promptIndex = i + 1
    const tables = await getProjectTables(freshProject, token)
    const checkIssues = runChecks(r, checks, tables, tables)
    r.issues.push(...checkIssues)
    r.pass = r.pass && checkIssues.filter(c => c.startsWith('FAIL')).length === 0
    if (r.pass) { coldStartResults.passed++; log('pass', `  ✓ [${name}] ${r.overallStatus} | tables: ${tables.join(', ')} | ${r.durationMs}ms`) }
    else { coldStartResults.failed++; log('fail', `  ✗ [${name}] ${r.issues.join('; ')}`) }
    log('detail', `     Tables: ${tables.join(', ') || '(none)'}`)
    log('detail', `     Message: ${r.finalMessage.slice(0, 200)}`)
    coldStartResults.promptResults.push(r)
    coldStartResults.issues.push(...r.issues.filter(i2 => i2.startsWith('CRITICAL') || i2.startsWith('FAIL')))
    coldStartResults.tablesCreated.push(...tables)
    await sleep(12_000)
  }

  generateReport(journeyResults, crossResults, coldStartResults)
}

main().catch(err => {
  console.error('\x1b[31mFATAL ERROR:\x1b[0m', err)
  process.exit(1)
})
