export const dynamic = 'force-dynamic'

/**
 * POST /api/mcp/tool — direct dispatch into a single brain tool.
 * OPTIONS            — CORS preflight.
 *
 * Body: { tool: string, args: object }
 * Returns: { ok, summary, data?, needsUser, timing: { ms, heavy } }
 *
 * Defense-in-depth:
 *   1. mcpGuard      — auth + plan quota + per-key rate limit.
 *   2. Destructive   — every destructive tool is refused here regardless
 *                      of any `confirmed` flag the body might carry.
 *   3. Catalog       — only catalog tools dispatch. Control-loop tools
 *                      (propose_plan, ask_user, finish) are blocked even
 *                      though they exist in the brain.
 *   4. dispatchTool  — the brain's pre-flight validator runs again; its
 *                      executor approval gate is the final safety net.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { mcpGuard, recordMcpCall, refuseIfReadOnly } from '@/lib/mcp/guard'
import { corsHeaders, optionsResponse } from '@/lib/mcp/cors'
import { catalogByName, STATE_SECTIONS, BRANCH_ACTIONS, isReadOnlyTool } from '@/lib/mcp/catalog'
import { dispatchTool, isDestructiveTool, READ_ONLY_TOOLS } from '@/lib/ai/brain/tools'
import { dbQuery, dbInsert, dbUpdate, dbDelete } from '@/lib/mcp/runtime-db'
import { dbErrorBody } from '@/lib/db/query-errors'
import { parseMigration, MigrationParseError } from '@/lib/mcp/migration-parser'
import { prisma } from '@/lib/db/prisma'
import { createTokenScope, runInTokenScope } from '@/lib/ai/token-meter'
import { createHash } from 'crypto'

/**
 * Tools on this route that spend Backenly's model budget. See the gate in POST
 * for how this set was derived and why everything else stays ungated.
 *
 * Membership means BOTH halves apply: the pre-gate below refuses the call when
 * the month's credits are spent, and the token scope around dispatch debits
 * what the call actually burned. A tool that gates without charging is not a
 * cheaper tool — it is an unlimited one, because a meter that never moves never
 * reaches the cap. That was the live state of `generate_function` until the
 * charge below was added.
 *
 * `answer_question` is currently unreachable here — MCP_EXCLUDE in
 * lib/mcp/catalog.ts keeps the brain's control-loop tools off this surface, so
 * the 404 fires before either half runs. It stays listed deliberately: if it is
 * ever exposed, it arrives already metered rather than repeating this bug.
 */
const MODEL_BACKED_TOOLS = new Set(['answer_question', 'generate_function'])

const ENDPOINT = '/api/mcp/tool'

const HEAVY_TOOLS = new Set([
  'create_table', 'enable_teams', 'generate_function', 'enable_vector_search',
  'generate_aggregate_api', 'create_cron_job',
])

const RequestSchema = z.object({
  tool: z.string().trim().min(1).max(80),
  args: z.record(z.unknown()).default({}),
})

export function OPTIONS() {
  return optionsResponse()
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  const guard = await mcpGuard(request)
  if (guard.response) return withCors(guard.response)
  const auth = guard.auth!

  // Parse + validate body.
  let parsed: z.infer<typeof RequestSchema>
  try {
    const json = await request.json()
    parsed = RequestSchema.parse(json)
  } catch (err) {
    const issue = err instanceof z.ZodError ? err.issues[0]?.message : 'Body must be { tool, args }.'
    const res = NextResponse.json(
      { ok: false, error: issue ?? 'Invalid body.', code: 'BAD_BODY' },
      { status: 400 },
    )
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 400, error: 'BAD_BODY' },
    )
    return withCors(res)
  }

  const { tool, args } = parsed

  // ── Read-only keys ────────────────────────────────────────────────────────
  //
  // Before anything else that could touch state. tools/list already hides every
  // mutating tool from a read-only key, so reaching here means the client was
  // pinned to an older manifest or is calling the dispatch surface directly —
  // both of which must be refused rather than served.
  if (auth.readOnly && !isReadOnlyTool(tool)) {
    const res = refuseIfReadOnly(auth, tool)!
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 403, error: 'READ_ONLY_KEY' },
    )
    return withCors(res)
  }

  // ── Credit gate for the model-backed tools ────────────────────────────────
  //
  // Most of this route is deterministic — the typed tools compile to SQL via
  // executeAction and cost us no model spend, so they stay open even for a user
  // with no credits left. Two do call OpenAI on our key and must be gated, or
  // an exhausted agent could simply route around /api/mcp/chat and keep
  // spending through here:
  //
  //   • answer_question   — direct completion (lib/ai/brain/tools.ts)
  //   • generate_function — executeAction → lib/ai/function-generator +
  //                         lib/services/ai-functions/generator
  //
  // Derived by tracing every dynamic import reachable from executeAction; those
  // two modules are the only OpenAI callers on the path. GENERATE_API, by
  // contrast, is pure SQL generation and is deliberately NOT gated. Keep this
  // set in sync when a new model-backed tool lands.
  if (MODEL_BACKED_TOOLS.has(tool)) {
    const { enforceAiCredits } = await import('@/lib/billing')
    const credits = await enforceAiCredits(auth.userId)
    if (credits !== true) {
      recordMcpCall(
        { ...auth, endpoint: ENDPOINT, startedAt },
        { statusCode: 402, tool, error: 'AI_CREDITS_EXHAUSTED' },
      )
      return withCors(NextResponse.json(
        {
          ok: false,
          error: credits.message,
          code: 'AI_CREDITS_EXHAUSTED',
          currentPlan: credits.currentPlan,
          requiredPlan: credits.requiredPlan,
          upgradeRequired: true,
          remedy:
            `\`${tool}\` uses Backenly's model budget and this month's credits are spent. ` +
            `Every other tool on this route is deterministic and still works. ` +
            `Credits reset on the 1st, or upgrade the plan.`,
          retryable: false,
        },
        { status: 402 },
      ))
    }
  }

  // `read_backend_state({section})` resolves to a different underlying tool.
  // The call is still RECORDED as read_backend_state — that is what the agent
  // invoked and what the activity feed should say — but dispatch targets the
  // resolved name.
  let dispatchName = tool
  const dispatchArgs: Record<string, unknown> = args

  // fetch_docs — synthetic read-only tool. Serves the agent-facing docs
  // (public/llms.txt) so a connected host LLM can self-serve context instead of
  // hallucinating the API/tool vocabulary (§9.3). No brain call, no mutation.
  if (tool === 'fetch_docs') {
    const topic = typeof args.topic === 'string' ? args.topic.trim() : ''
    const { markdown, matchedTopic } = await loadDocs(request, topic)
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 200, tool, mutation: false, summary: matchedTopic ? `docs: ${matchedTopic}` : 'docs: full guide' },
    )
    return withCors(NextResponse.json({
      ok: true,
      summary: matchedTopic ? `Backenly docs — ${matchedTopic}` : 'Backenly agent guide',
      data: { topic: matchedTopic ?? null, markdown },
      needsUser: false,
      timing: { ms: Date.now() - startedAt, heavy: false },
    }))
  }

  // generate_types — synthetic read-only tool. TypeScript row types straight
  // from the live PostgreSQL catalog, so an agent never hand-writes types that
  // silently drift on the next migration. No brain call, no mutation.
  if (tool === 'generate_types') {
    const format = typeof args.format === 'string' ? args.format.trim().toLowerCase() : 'dts'
    if (!['dts', 'client', 'openapi'].includes(format)) {
      const res = NextResponse.json(
        {
          ok: false,
          error: `Unknown format "${format}". Use "dts" (type declarations), "client" (declarations + a typed client), or "openapi".`,
          code: 'VALIDATION',
        },
        { status: 400 },
      )
      recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool, error: 'VALIDATION' })
      return withCors(res)
    }

    const { readWorkspaceSchema } = await import('@/lib/typegen/schema-reader')
    const { generateTypes } = await import('@/lib/typegen/type-generator')
    const schema = await readWorkspaceSchema(auth.projectId)
    const types = generateTypes(schema)

    let source = types.source
    let filename = 'backenly.types.ts'
    if (format === 'client') {
      const { generateTypedClient } = await import('@/lib/typegen/client-generator')
      source = generateTypedClient(schema, types, { projectId: auth.projectId }).source
      filename = 'backenly.client.ts'
    } else if (format === 'openapi') {
      const { generateOpenApiSpec } = await import('@/lib/typegen/openapi-generator')
      const project = await prisma.project.findUnique({
        where: { id: auth.projectId },
        select: { name: true },
      })
      source = JSON.stringify(
        generateOpenApiSpec(schema, {
          title: `Backenly API — ${project?.name ?? auth.projectId}`,
          serverUrl: process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com',
        }),
        null,
        2,
      )
      filename = 'backenly.openapi.json'
    }

    // A content hash, so "regenerate and diff" is one comparison rather than a
    // read of the whole file. This is what makes drift DETECTABLE instead of
    // merely fixable.
    const schemaHash = createHash('sha256').update(source).digest('hex').slice(0, 16)

    const summary = schema.tables.length
      ? `Generated ${format === 'openapi' ? 'an OpenAPI 3.1 spec' : 'TypeScript types'} for ` +
        `${schema.tables.length} table(s): ${types.tableNames.join(', ')}. ` +
        `Save data.source as ${filename}. schemaHash=${schemaHash} — regenerate and compare hashes to ` +
        `detect drift after any migration.`
      : `This project has no tables yet, so there is nothing to type. Create tables first ` +
        `(apply_migration or backend_chat), then call generate_types again.`

    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 200, tool, mutation: false, summary: `types: ${format} (${schema.tables.length} tables)` },
    )
    return withCors(NextResponse.json({
      ok: true,
      summary,
      data: {
        format,
        filename,
        source,
        tableNames: types.tableNames,
        schemaHash,
        generatedAt: schema.generatedAt,
      },
      needsUser: false,
      timing: { ms: Date.now() - startedAt, heavy: false },
    }))
  }

  // check_intent_conformance — synthetic read-only tool. Compares the intent
  // ledger against the live catalog so an agent can verify that a build
  // produced the shape it asked for. No brain call, no mutation.
  if (tool === 'check_intent_conformance') {
    const { checkIntentConformance } = await import('@/lib/autonomy/intent-conformance')
    const report = await checkIntentConformance(auth.projectId)
    const only = typeof args.tableName === 'string' ? args.tableName.toLowerCase().trim() : ''
    const findings = only ? report.findings.filter((f) => f.table === only) : report.findings

    const summary = findings.length === 0
      ? `No drift across ${report.checked} recorded column intent(s).` +
        (report.unverifiable > 0
          ? ` ${report.unverifiable} column(s) have no recorded intent and are unverified, not proven healthy.`
          : '')
      : `${findings.length} conformance issue(s):\n` +
        findings.map((f) => `  • ${f.detail}`).join('\n')

    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 200, tool, mutation: false, summary: `conformance: ${findings.length} finding(s)` },
    )
    return withCors(NextResponse.json({
      ok: true,
      summary,
      data: { ...report, findings },
      needsUser: false,
      timing: { ms: Date.now() - startedAt, heavy: false },
    }))
  }

  // check_sensor_health — synthetic read-only tool. Reports whether the
  // autonomy probes can still detect anything, distinguishing "verified clean"
  // from "has never produced a finding, so its silence proves nothing".
  if (tool === 'check_sensor_health') {
    const { checkSensorHealth, summariseSensorHealth } = await import('@/lib/autonomy/sensor-health')
    const report = await checkSensorHealth(auth.projectId)
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 200, tool, mutation: false, summary: `sensors: ${report.unverified} unverified, ${report.errored} errored` },
    )
    return withCors(NextResponse.json({
      ok: true,
      summary: summariseSensorHealth(report),
      data: report,
      needsUser: false,
      timing: { ms: Date.now() - startedAt, heavy: false },
    }))
  }

  // check_approval — synthetic read-only tool: poll the status of an
  // escalated destructive request (created when backend_chat hits the
  // destructive gate). Scoped to this key's project by construction.
  if (tool === 'check_approval') {
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (!id) {
      return withCors(NextResponse.json(
        { ok: false, error: 'check_approval requires { id }', code: 'BAD_BODY' },
        { status: 400 },
      ))
    }
    const { getApprovalForProject } = await import('@/lib/mcp/approvals')
    const approval = await getApprovalForProject(auth.projectId, id)
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: approval ? 200 : 404, tool, mutation: false, summary: approval ? `approval ${approval.status}` : 'approval missing' },
    )
    if (!approval) {
      return withCors(NextResponse.json(
        { ok: false, error: 'No approval request with that id in this project.', code: 'NOT_FOUND' },
        { status: 404 },
      ))
    }
    const guidance: Record<string, string> = {
      pending: 'Still waiting for the human. Poll again in 15-30s, or remind them to open the Review Queue.',
      executed: 'Approved and executed — the resultSummary describes what changed. Verify with read tools if needed.',
      // `failed` now means NOTHING was applied, which is what makes it safe to
      // act on. A run that applied some of its plan and then stopped reports
      // `partial` instead — treating that as `failed` and replaying is how a
      // half-finished destructive plan gets double-applied.
      failed: 'Approved but execution failed and NOTHING was applied — the backend is unchanged. Read resultSummary and report it to the human.',
      partial: 'Approved, and SOME changes were applied before the run stopped. Do NOT replay the original request. resultSummary lists exactly what landed; verify with get_table_schema / read_backend_state and ask only for what is still missing.',
      rejected: 'The human rejected this operation. Do not retry it; ask what they want instead.',
      expired: 'The request expired unapproved (24h). Ask the human whether to raise it again.',
    }
    return withCors(NextResponse.json({
      ok: true,
      summary: `Approval ${approval.id.slice(0, 8)}… is ${approval.status}. ${guidance[approval.status] ?? ''}`,
      data: approval,
      needsUser: approval.status === 'pending',
      timing: { ms: Date.now() - startedAt, heavy: false },
    }))
  }

  // ── apply_migration — SQL in, governed typed actions out ───────────────────
  // Writes used to be reachable only as typed tools (create_table, add_column,
  // …), a vocabulary no model has ever seen. Agents sent DDL to `run_query`
  // instead and got NOT_READ_ONLY — the largest single error class on the live
  // key. This accepts the grammar the model already knows and translates it into
  // those same typed actions, so the governance kernel is untouched and only the
  // ergonomics move. See lib/mcp/migration-parser.ts.
  //
  // The parse is all-or-nothing so a migration can never half-apply from a
  // statement we could not translate. Execution then runs the actions in order
  // through the SAME dispatchTool path a typed call would take, so approval
  // gates, the intent ledger and rollback all behave identically.
  if (tool === 'apply_migration') {
    const sql = typeof args.sql === 'string' ? args.sql : ''
    if (!sql.trim()) {
      recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool, error: 'EMPTY_MIGRATION' })
      return withCors(NextResponse.json(
        {
          ok: false,
          error: 'apply_migration requires { sql }.',
          code: 'EMPTY_MIGRATION',
          hint: 'e.g. { "sql": "ALTER TABLE posts ADD COLUMN likes integer DEFAULT 0" }',
        },
        { status: 400 },
      ))
    }

    let planned
    try {
      planned = parseMigration(sql)
    } catch (err) {
      if (!(err instanceof MigrationParseError)) throw err
      recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool, error: err.code })
      return withCors(NextResponse.json(
        {
          ok: false,
          error: err.message,
          code: err.code,
          ...(err.hint ? { hint: err.hint } : {}),
          ...(err.statement ? { statement: err.statement } : {}),
          applied: [],
        },
        { status: 400 },
      ))
    }

    const applied: { statement: string; tool: string; summary: string }[] = []
    const notes = planned.flatMap((p) => p.notes ?? [])

    for (let i = 0; i < planned.length; i++) {
      const step = planned[i]
      let result: { ok: boolean; summary: string }
      try {
        result = await dispatchTool(step.tool, step.args, {
          projectId: auth.projectId,
          userId: auth.userId,
          sessionToken: undefined,
          destructiveConfirmed: false,
          mcpOwnerConfirmed: true,
          createdThisTurn: new Set<string>(),
        })
      } catch (err) {
        result = { ok: false, summary: err instanceof Error ? err.message : 'Dispatch failed' }
      }

      if (!result.ok) {
        // Report exactly how far the migration got. An agent that knows three of
        // five statements applied can finish the job; one told only "failed"
        // will usually replay the whole thing and double-apply.
        recordMcpCall(
          { ...auth, endpoint: ENDPOINT, startedAt },
          { statusCode: 400, tool, mutation: true, error: 'MIGRATION_FAILED', summary: result.summary },
        )
        return withCors(NextResponse.json(jsonSafe({
          ok: false,
          error: `Migration stopped at: ${step.source}`,
          code: 'MIGRATION_FAILED',
          detail: result.summary,
          applied,
          remaining: planned.slice(i + 1).map((p) => p.source),
          hint: applied.length
            ? 'The statements in `applied` DID take effect — do not replay them. Fix the failing statement and re-send only what remains.'
            : 'Nothing was applied.',
        }), { status: 400 }))
      }
      applied.push({ statement: step.source, tool: step.tool, summary: result.summary })
    }

    const summary =
      `Applied ${applied.length} statement(s): ` +
      applied.map((a) => a.summary).join(' · ') +
      (notes.length ? ` (${notes.join(' ')})` : '')

    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 200, tool, mutation: true, summary: `migration: ${applied.length} statement(s)` },
    )
    return withCors(NextResponse.json(jsonSafe({
      ok: true,
      summary,
      data: { applied, ...(notes.length ? { notes } : {}) },
      needsUser: false,
      timing: { ms: Date.now() - startedAt, heavy: true },
    })))
  }

  // ── branch — route `action` to the tool that performs it ──────────────────
  // Four branch tools collapsed into one advertised door to stay inside the
  // ~20-tool selection budget. Routing table is shared with the schema the
  // manifest advertises, so an action we offer can never be one dispatch
  // cannot serve.
  if (tool === 'branch') {
    const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : ''
    const target = BRANCH_ACTIONS[action]
    if (!target) {
      recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool, error: 'UNKNOWN_BRANCH_ACTION' })
      return withCors(NextResponse.json(
        {
          ok: false,
          error: action ? `Unknown branch action "${action}".` : 'branch requires { action }.',
          code: 'UNKNOWN_BRANCH_ACTION',
          supported: Object.keys(BRANCH_ACTIONS),
          hint: 'Start with { "action": "list" } to get branch ids. Discarding a branch is destructive — ask via backend_chat.',
        },
        { status: 400 },
      ))
    }
    dispatchName = target
    delete dispatchArgs.action
  }

  // ── read_backend_state — route `section` to the tool that answers it ───────
  // Collapsed from 26 separate list_*/get_* tools into one enum. The routing
  // table is shared with the schema the manifest advertises, so a section we
  // offer can never be one dispatch cannot serve.
  if (tool === 'read_backend_state' && typeof args.section === 'string' && args.section.trim()) {
    const section = args.section.trim().toLowerCase()
    const target = STATE_SECTIONS[section]
    if (!target) {
      recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool, error: 'UNKNOWN_SECTION' })
      return withCors(NextResponse.json(
        {
          ok: false,
          error: `Unknown section "${section}".`,
          code: 'UNKNOWN_SECTION',
          supported: Object.keys(STATE_SECTIONS),
          hint: 'Omit `section` for the grounding overview.',
        },
        { status: 400 },
      ))
    }
    dispatchName = target
    delete dispatchArgs.section
  }

  // Runtime data tools (db_query/insert/update/delete) live in the catalog but
  // are served by dedicated helpers, not the brain dispatch. Handle them here so
  // an agent can call them through the SAME /api/mcp/tool surface as every other
  // tool (previously they 404'd with "Unknown tool" unless the host knew to hit
  // /api/mcp/db/*). The dedicated /api/mcp/db/* routes remain for lower latency.
  // run_query needs no special arm here: it is a brain tool, so the generic
  // dispatchTool path above already serves it from its single definition.

  const DB_TOOLS: Record<string, (projectId: string, input: any) => Promise<any>> = {
    db_query: dbQuery, db_insert: dbInsert, db_update: dbUpdate, db_delete: dbDelete,
  }
  if (tool in DB_TOOLS) {
    try {
      const result = await DB_TOOLS[tool](auth.projectId, args as any)
      const mutation = tool !== 'db_query'
      const summary =
        tool === 'db_query' ? `Read ${result.count ?? 0} row(s) from ${(args as any).table}`
        : tool === 'db_insert' ? `Inserted 1 row into ${(args as any).table}`
        : tool === 'db_update' ? `Updated ${result.updated ?? 0} row(s) in ${(args as any).table}`
        : `Deleted ${result.deleted ?? 0} row(s) from ${(args as any).table}`
      recordMcpCall(
        { ...auth, endpoint: ENDPOINT, startedAt },
        { statusCode: 200, tool, mutation, summary },
      )
      return withCors(NextResponse.json(jsonSafe({
        ok: true, summary, data: result, needsUser: false,
        timing: { ms: Date.now() - startedAt, heavy: false },
      })))
    } catch (err) {
      // Same structured contract as the dedicated /api/mcp/db/* routes, so an
      // agent gets identical, self-correctable errors on either surface.
      const body = dbErrorBody(err, 'DB_OP_FAILED')
      recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool, error: body.error })
      return withCors(NextResponse.json(body, { status: 400 }))
    }
  }

  if (isDestructiveTool(tool)) {
    const res = NextResponse.json(
      {
        ok: false,
        error:
          `Tool "${tool}" is destructive and cannot be executed directly over MCP. ` +
          `Instead, describe the operation via backend_chat — it will be parked in the project's ` +
          `Review Queue for human approval, and you'll get an approval id to poll with check_approval.`,
        code: 'DESTRUCTIVE_NEEDS_APPROVAL',
      },
      { status: 403 },
    )
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 403, tool, error: 'DESTRUCTIVE_NOT_ALLOWED' },
    )
    return withCors(res)
  }

  const catalog = catalogByName()
  if (tool === 'backend_chat') {
    return withCors(NextResponse.json(
      {
        ok: false,
        error: 'Use POST /api/mcp/chat for backend_chat — that endpoint runs the brain.',
        code: 'WRONG_ENDPOINT',
      },
      { status: 400 },
    ))
  }
  // Checked against the DISPATCHABLE set, which is wider than the advertised
  // catalog — a client pinned to an older manifest still calls `list_tables`,
  // and 404-ing it would break a working setup for no reliability gain.
  if (!catalog.has(dispatchName)) {
    const res = NextResponse.json(
      {
        ok: false,
        error: `Unknown MCP tool "${tool}". GET /api/mcp/manifest for the list.`,
        code: 'UNKNOWN_TOOL',
      },
      { status: 404 },
    )
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 404, tool, error: 'UNKNOWN_TOOL' },
    )
    return withCors(res)
  }

  const heavy = HEAVY_TOOLS.has(dispatchName)
  const isMutation = !READ_ONLY_TOOLS.has(dispatchName as any)

  // ── Charge half of the credit contract ────────────────────────────────────
  //
  // Opened only for the model-backed tools, and only around dispatch. Every
  // completion issued underneath — the generator's write pass, its repair pass,
  // any model call a future model-backed tool makes — lands in `scope.tokens`
  // without that code knowing billing exists (lib/ai/token-meter.ts).
  //
  // Billed in `finally` because a dispatch that threw still burned the tokens
  // it burned. Fire-and-forget, mirroring the chat route: a billing write must
  // never turn a completed backend change into an error response.
  const metered = MODEL_BACKED_TOOLS.has(tool)
  const tokenScope = createTokenScope()

  try {
    const result = await runInTokenScope(tokenScope, () => dispatchTool(dispatchName, dispatchArgs, {
      projectId: auth.projectId,
      userId: auth.userId,
      sessionToken: undefined,
      destructiveConfirmed: false,
      // Owner-held MCP key on the direct tool surface: destructive tools are
      // already refused above, so pre-confirm the remaining non-destructive
      // medium-risk build actions (set_env_var, connect_frontend) instead of
      // dead-ending them on an opaque APPROVAL_REQUIRED.
      mcpOwnerConfirmed: true,
      createdThisTurn: new Set<string>(),
    }))

    // Structured failure code so an MCP agent can branch without parsing prose
    // (agent-native ergonomics). Explicit code from the tool wins; otherwise a
    // generic TOOL_ERROR marks the failure. Success carries none.
    const code = result.ok ? undefined : (result.code ?? 'TOOL_ERROR')
    const body = {
      ok: result.ok,
      summary: result.summary,
      data: result.data ?? null,
      needsUser: !!result.needsUser,
      ...(code ? { code } : {}),
      // ── `error` must be SET on failure, not just `summary` ─────────────────
      //
      // A failure used to carry its reason in `summary` and leave `error`
      // undefined. That reads fine here and is destroyed one hop away: the
      // client's HTTP layer builds its message from `parsed.error ||
      // parsed.message`, neither of which existed, so it fell through to
      //
      //     "HTTP 400 from /api/mcp/tool (TOOL_ERROR)"
      //
      // — which is verbatim the opaque failure reported from a real build
      // ("identical payload returned HTTP 400 TOOL_ERROR once, succeeded on
      // retry"). The retry looked like flakiness because the message carried
      // nothing that could distinguish a transient fault from a real one.
      //
      // The reason existed the whole time. It was written to a field nobody
      // downstream read.
      ...(result.ok ? {} : { error: result.summary || 'The tool reported failure without a reason.' }),
      timing: { ms: Date.now() - startedAt, heavy },
    }

    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      {
        statusCode: result.ok ? 200 : 400,
        tool,
        mutation: isMutation,
        summary: result.summary,
        error: code,
      },
    )

    return withCors(NextResponse.json(jsonSafe(body), { status: result.ok ? 200 : 400 }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Tool dispatch failed'
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 500, tool, error: msg },
    )
    return withCors(NextResponse.json(
      { ok: false, error: msg, code: 'DISPATCH_FAILED' },
      { status: 500 },
    ))
  } finally {
    if (metered && tokenScope.tokens > 0) {
      import('@/lib/billing')
        .then(({ chargeAiCredits }) => chargeAiCredits(auth.userId, tokenScope.tokens))
        .catch(() => {})
    }
  }
}

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v)
  return res
}

/**
 * Deep-convert BigInt → Number so a tool result can never crash NextResponse.json
 * ("Do not know how to serialize a BigInt"). A single tool returning a Prisma
 * BigInt column used to 500 the whole endpoint; this makes the surface robust
 * to any tool, present or future.
 */
function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)),
  )
}

// ── fetch_docs support ────────────────────────────────────────────────────────

const DOCS_MAX_CHARS = 24_000

/**
 * Load the agent-facing docs (public/llms.txt) and, when a topic is given,
 * return just the matching section. Fetched from the request origin so it works
 * identically in dev, standalone, and behind nginx — no fs path assumptions.
 * Falls back to a terse pointer if the file can't be reached.
 */
async function loadDocs(
  request: NextRequest,
  topic: string,
): Promise<{ markdown: string; matchedTopic: string | null }> {
  let full = await readLlmsTxt(request)

  if (!full) {
    return {
      markdown:
        '# Backenly docs\n\nFull docs: https://backenly.com/llms.txt\n\n' +
        'Use the MCP tools listed in GET /api/mcp/manifest, or call `backend_chat` with a plain-English request.',
      matchedTopic: null,
    }
  }

  if (topic) {
    const section = extractSection(full, topic)
    if (section) return { markdown: clamp(section), matchedTopic: topic }
  }

  return { markdown: clamp(full), matchedTopic: null }
}

/**
 * Load public/llms.txt reliably. The previous implementation self-fetched
 * `request.nextUrl.origin/llms.txt`, which in the Next standalone server behind
 * nginx resolves to an internal origin that does NOT serve the static file — so
 * fetch_docs always returned the tiny fallback pointer instead of the real docs.
 * Try, in order: the file on disk (works in standalone + dev), the absolute app
 * URL, then the request origin. First hit wins.
 */
async function readLlmsTxt(request: NextRequest): Promise<string> {
  // 1. Filesystem — public/ is copied next to the standalone server at build.
  try {
    const fs = await import('fs/promises')
    const path = await import('path')
    for (const p of [
      path.join(process.cwd(), 'public', 'llms.txt'),
      path.join(process.cwd(), '.next', 'standalone', 'public', 'llms.txt'),
    ]) {
      try {
        const txt = await fs.readFile(p, 'utf8')
        if (txt && txt.trim()) return txt
      } catch { /* try next path */ }
    }
  } catch { /* fs unavailable — fall through to HTTP */ }

  // 2. Absolute app URL (nginx serves the static file here), then 3. origin.
  const origins = [
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, ''),
    request.nextUrl.origin,
  ].filter(Boolean) as string[]
  for (const origin of origins) {
    try {
      const res = await fetch(`${origin}/llms.txt`, { cache: 'no-store' })
      if (res.ok) {
        const txt = await res.text()
        if (txt && txt.trim()) return txt
      }
    } catch { /* try next origin */ }
  }
  return ''
}

/** Pull the Markdown section whose heading best matches `topic`. */
function extractSection(markdown: string, topic: string): string | null {
  const lines = markdown.split('\n')
  const needle = topic.toLowerCase()
  let start = -1
  let headingLevel = 0
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{2,4})\s+(.*)$/.exec(lines[i])
    if (m && m[2].toLowerCase().includes(needle)) {
      start = i
      headingLevel = m[1].length
      break
    }
  }
  if (start === -1) return null
  // Capture until the next heading at the same or higher level.
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,4})\s+/.exec(lines[i])
    if (m && m[1].length <= headingLevel) { end = i; break }
  }
  return lines.slice(start, end).join('\n').trim()
}

function clamp(s: string): string {
  return s.length <= DOCS_MAX_CHARS ? s : s.slice(0, DOCS_MAX_CHARS) + '\n\n…(truncated — see https://backenly.com/llms.txt)'
}
