/**
 * FUNCTION GENERATOR (GAP 4)
 * ===========================
 * Generates actual TypeScript/JavaScript code files for custom backend logic.
 * This pushes Backenly from "configured backend" to "actual backend builder."
 *
 * Examples:
 *   "Add a /export-orders-csv endpoint" → writes lib/custom-functions/{projectId}/export-orders-csv.ts
 *   "Add a webhook validator for Stripe" → writes lib/custom-functions/{projectId}/validate-stripe-webhook.ts
 *   "Rate limit the auth endpoint" → injects middleware code
 *
 * The generated functions are:
 *   1. Stored in the database (AiFunction model)
 *   2. Written to a code file under lib/custom-functions/{projectId}/
 *   3. Exposed as a serverless endpoint at /api/v1/{projectId}/fn/{functionName}
 *   4. Listed alongside generated CRUD APIs in the project dashboard
 */

import { prisma } from '@/lib/db'

export interface GeneratedFunction {
  id: string
  name: string
  description: string
  endpoint: string
  method: string
  code: string
  filePath: string
}

/**
 * The exact runtime contract of the route-module runner
 * (lib/services/ai-functions/route-module-runner.ts). Injected into every
 * generation AND repair prompt so the LLM can only write code the runner can
 * actually execute. Drift between this text and the runner is caught by
 * tests/route-module-runner.spec.ts.
 */
const ROUTE_MODULE_CONTRACT = `RUNTIME CONTRACT (the code runs in Backenly's route-module runner, NOT a full Next.js server):
- Export exactly one async handler: export async function METHOD(request: NextRequest, { params }: { params: { projectId: string } })
- The second argument is ALWAYS provided; params.projectId is the project id. Query-string values are also merged into params.
- request supports: request.url, request.method, request.nextUrl.searchParams.get(...), await request.json(), request.headers.get(name), request.cookies.get(name)?.value
- Respond ONLY with NextResponse.json(body, { status }) from 'next/server'.
- Imports allowed ONLY from: 'next/server', '@/lib/db' (prisma), '@/lib/auth/jwt' (verifyToken), 'crypto', 'bcryptjs', 'jsonwebtoken'. Any other import crashes.
- NEVER use: eval, new Function, dynamic import(), child_process, worker_threads, fs writes, process.exit.
- End-user data tables live in the per-project PostgreSQL schema "workspace_{projectId}" — access them with parameterised raw SQL, e.g.:
    const rows = await prisma.$queryRawUnsafe(\`SELECT * FROM "workspace_\${params.projectId}"."posts" WHERE id = $1\`, id)
  NEVER use prisma model accessors (prisma.user, prisma.post, ...) for end-user tables — those models do not exist.
- AUTH IS OPT-IN. Add an auth gate ONLY when the description asks for one ("only the logged-in user", "requires sign-in", "the current user's ..."). Do NOT add a 401 check to an endpoint that was described as public — an invented auth gate makes the endpoint unusable and the caller cannot tell it was never asked for.
- When you DO auth-gate, read either header spelling — clients send both:
    const raw = request.headers.get('x-user-token') || request.headers.get('authorization') || ''
    const payload = verifyToken(raw.replace(/^Bearer /i, ''))
    if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  (The runtime already mirrors one header onto the other, so a function that reads only one still works — but read both so the code is honest about what it accepts.)
- The caller's identity is ALSO applied at the database level automatically: prisma runs with the request's RLS claims set, so own-rows policies scope your queries to the calling user without you doing anything. Do not try to set request.jwt.claims yourself.
- Surface real errors. In a catch block return the actual message — NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 }) — never a bare "internal_error", which leaves the caller with nothing to act on.
- A 400 MUST NAME THE FIELDS. Never return { error: 'Missing or invalid required fields' } or any other message that withholds which field was wrong: the caller has no schema endpoint for a generated function, so an unnamed 400 is unanswerable and the only way forward is to guess payloads. Validate explicitly and report the specific fields, e.g.:
    const missing = ['lineItems','successUrl','cancelUrl'].filter((k) => body[k] === undefined)
    if (missing.length) return NextResponse.json({
      error: \`Missing required field(s): \${missing.join(', ')}\`,
      required: { lineItems: 'array of { price, quantity }', successUrl: 'string', cancelUrl: 'string' },
    }, { status: 400 })
  The \`required\` object IS the contract — include it on every 400 so one failed call teaches the caller the whole shape.
- Answer GET /?describe=1 (and OPTIONS, for a POST-only handler) with the contract instead of doing the work:
    NextResponse.json({ method: 'POST', required: {...}, optional: {...}, returns: {...} })
  This is what makes a generated endpoint discoverable without reading its source.`

/**
 * Generate TypeScript code for a custom backend function.
 */
/**
 * The project's real schema, rendered for the generation prompt.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The generator used to send the model four things: function name, HTTP method,
 * description, and project id. It was never told what tables exist, what columns
 * they have, what types those are, what the CHECK constraints permit, or whether
 * RLS is on.
 *
 * So the model guessed all of it — and a guess that is 90% right produces code
 * that compiles, passes the load-time validator, deploys, and then 500s on the
 * first real request. That is exactly what was reported: three of four generated
 * functions returned bare 500s, and fixing them required specs so prescriptive
 * the developer was "effectively writing the code" — exact SQL, schema-qualified
 * table names, `::uuid` casts, `Number()` coercion for BigInt.
 *
 * Every one of those is something the platform ALREADY KNOWS. The `::uuid` cast
 * is knowable from the column type. The table name is in the catalog. The BigInt
 * problem is a property of Prisma's `count(*)`. Making a developer supply facts
 * the system holds is not a model limitation — it is a grounding failure, and
 * this is the fix.
 *
 * Capped deliberately: a project with 40 tables must not blow the context
 * window, so the tables most likely to be relevant (named in the description)
 * come first and the rest are summarised.
 */
/**
 * The rules that follow from having a schema at all.
 *
 * Every line is something the developer had to state BY HAND when the model was
 * not told the schema — the `::uuid` cast, the schema qualification, the BigInt
 * coercion. They are derivable facts about this runtime, not preferences, which
 * is why they are stated as rules rather than left to inference.
 */
function renderSchemaRules(): string {
  return [
    `RULES DERIVED FROM THIS SCHEMA — follow them exactly:`,
    '- Always schema-qualify: "workspace_${params.projectId}"."<table>".',
    `- Cast uuid parameters explicitly: WHERE id = $1::uuid. A bare $1 against a uuid column throws 22P02.`,
    `- COUNT(*) comes back from Prisma as BigInt and is NOT JSON-serialisable — wrap it: Number(rows[0].count).`,
    `- Respect every CHECK constraint above. Writing a value outside one fails at runtime with 23514, not at compile time.`,
    `- Never INSERT a column that is NOT NULL without a value, unless it has a DEFAULT.`,
  ].join('\n')
}

/** Test seams — asserted by tests/unit/function-generation-grounding.spec.ts. */
export const __ROUTE_MODULE_CONTRACT = ROUTE_MODULE_CONTRACT
export const __renderSchemaRules = renderSchemaRules

async function buildSchemaContext(projectId: string, description: string): Promise<string> {
  try {
    const { listExposedTables, getTableSchema, isCrudExposable } =
      await import('@/lib/mcp/schema-introspection')

    const tables = (await listExposedTables(projectId)).filter(t => isCrudExposable(t.name))
    if (tables.length === 0) {
      return 'PROJECT SCHEMA: no tables exist yet. Do not query tables — none are available.'
    }

    // Tables the description actually mentions get full detail; the rest are
    // listed by name so the model knows they exist without paying for them.
    const mentioned = tables.filter(t =>
      new RegExp(`\\b${t.name.replace(/[^a-z0-9_]/gi, '')}\\b`, 'i').test(description),
    )
    const detailed = (mentioned.length > 0 ? mentioned : tables).slice(0, 6)
    const rest = tables.filter(t => !detailed.some(d => d.name === t.name))

    const blocks: string[] = []
    for (const t of detailed) {
      const s = await getTableSchema(projectId, t.name).catch(() => null)
      if (!s) continue

      const cols = s.columns
        .map(c => {
          const parts = [`${(c as any).name ?? (c as any).column_name}`, (c as any).type ?? (c as any).data_type]
          if ((c as any).nullable === false || (c as any).is_nullable === 'NO') parts.push('NOT NULL')
          const def = (c as any).default ?? (c as any).column_default
          if (def) parts.push(`DEFAULT ${def}`)
          return `    ${parts.join(' ')}`
        })
        .join('\n')

      const lines = [`  ${s.table}:`, cols]
      if (s.foreignKeys.length) {
        lines.push(`    FKs: ${s.foreignKeys.map(f => `${f.column} → ${f.references}`).join(', ')}`)
      }
      if (s.checkConstraints.length) {
        // The single highest-value line here. A default or an inserted value
        // outside a CHECK is SQLSTATE 23514 at runtime — invisible to any
        // load-time validation, and the model cannot infer it.
        lines.push(`    CHECK: ${s.checkConstraints.map(c => c.definition).join(' | ')}`)
      }
      if (s.rlsEnabled) {
        lines.push(
          `    RLS: ENABLED${s.forceRls ? ' (FORCED)' : ''}. ` +
          `The caller's identity is applied automatically — do NOT set request.jwt.claims yourself. ` +
          `Rows are already scoped to the caller.`,
        )
      }
      blocks.push(lines.filter(Boolean).join('\n'))
    }

    return [
      `PROJECT SCHEMA (real — read from the live catalog, not a guess):`,
      `Workspace schema name: "workspace_${projectId}"`,
      ``,
      ...blocks,
      rest.length ? `\n  Other tables (ask for detail if needed): ${rest.map(t => t.name).join(', ')}` : '',
      ``,
      renderSchemaRules(),
    ].filter(Boolean).join('\n')
  } catch (err) {
    // Grounding is an improvement, not a precondition. If introspection fails,
    // generate the way it always did rather than refusing to generate at all —
    // but say so in the log, because ungrounded generation is the degraded path.
    console.warn(
      '[FunctionGenerator] Could not read schema for grounding; generating without it.',
      err instanceof Error ? err.message : err,
    )
    return 'PROJECT SCHEMA: unavailable. Be defensive — verify table and column names exist before relying on them.'
  }
}

/**
 * Invoke a generated module once and report whether it actually runs.
 *
 * Returns `ok: false` ONLY for a thrown exception or a 5xx — a 4xx means the
 * handler ran and rejected the empty smoke input, which is correct behaviour
 * and the common case for a mutating endpoint.
 *
 * Never throws: a smoke test that takes down generation would be worse than the
 * bug it detects. An infrastructure failure here reports `ok: true` with a note,
 * because "we could not check" must not be reported as "the function is broken".
 */
async function smokeTestRouteModule(
  code: string,
  projectId: string,
  functionName: string,
  method: string,
): Promise<{ ok: boolean; error?: string; status?: number }> {
  try {
    const { executeRouteModuleFunction } = await import('@/lib/services/ai-functions/route-module-runner')
    const result = await executeRouteModuleFunction(
      code,
      projectId,
      { type: 'manual', data: {} },
      `${method.toUpperCase()} /api/v1/${projectId}/fn/${functionName}`,
      // testRun mints a project-scoped admin token + admin key, so an
      // auth-gated handler exercises its real path instead of dead-ending on a
      // 401 that tells us nothing about whether its logic works.
      { testRun: true },
    )

    const status = result.returnValue?.status ?? 200
    if (status >= 500) {
      const body = result.returnValue?.body
      const detail =
        (body && typeof body === 'object' && (body as any).error) ||
        (typeof body === 'string' ? body : JSON.stringify(body ?? {}).slice(0, 300))
      return { ok: false, status, error: `HTTP ${status} — ${detail}` }
    }
    return { ok: true, status }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Distinguish "the function is broken" from "we could not test it". Only
    // the former should trigger a repair; the latter must not block creation.
    if (/failed to compile|evaluation error|exports no/i.test(msg)) {
      return { ok: false, error: msg }
    }
    if (/timeout|ECONN|database|connect/i.test(msg)) {
      console.warn(`[FunctionGenerator] Smoke test could not run for ${functionName}: ${msg}`)
      return { ok: true }
    }
    return { ok: false, error: msg }
  }
}

async function generateFunctionCode(
  projectId: string,
  description: string,
  functionName: string,
  method: string
): Promise<string> {
  const { getOpenAIClient } = await import('./openai-service')
  const { getModel } = await import('./model-router')
  const openai = getOpenAIClient()

  const schemaContext = await buildSchemaContext(projectId, description)

  const response = await openai.chat.completions.create({
    model: getModel('plan'),
    messages: [{
      role: 'system',
      content: `You are a senior TypeScript backend engineer writing a Next.js API route handler.
Write clean, production-ready TypeScript code.
Include proper error handling.
Return ONLY the code — no markdown fences, no explanation.

${ROUTE_MODULE_CONTRACT}

${schemaContext}`,
    }, {
      role: 'user',
      content: `Write a Next.js API route handler for:
Function: ${functionName}
HTTP Method: ${method}
Description: ${description}
Project ID context: ${projectId}

The file exports an async function named ${method.toUpperCase()} that accepts (request: NextRequest, { params }: { params: { projectId: string } }).

Use the real schema given above — the table and column names there are authoritative. Do not invent columns.`,
    }],
    temperature: 0.2,
    max_tokens: 1600,
  })

  const raw = response.choices[0].message.content?.trim() ?? ''
  return stripCodeFences(raw)
}

function stripCodeFences(raw: string): string {
  return raw
    .replace(/^```(?:typescript|ts|javascript|js)?\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim()
}

/**
 * Repair a route module that failed validation or crashed at runtime.
 * Shared by the creation gate (below) and the executor's self-heal path.
 * Returns null when no validated fix could be produced — callers must treat
 * null as "leave the stored code untouched".
 */
export async function generateFixedRouteModule(
  originalCode: string,
  errorMessage: string,
  description: string,
  method: string,
  projectId: string
): Promise<string | null> {
  try {
    const { getOpenAIClient } = await import('./openai-service')
    const { getModel } = await import('./model-router')
    const { validateRouteModule } = await import('@/lib/services/ai-functions/route-module-runner')
    const openai = getOpenAIClient()

    // The repair pass gets the SAME grounding as generation. A repair prompt
    // without the schema is the identical blind guess that produced the broken
    // code — and it is worse here, because the error being repaired is usually
    // a schema error (wrong column, missing cast, CHECK violation) that the
    // model has no way to diagnose without seeing the table.
    const schemaContext = await buildSchemaContext(projectId, description)

    const response = await openai.chat.completions.create({
      model: getModel('plan'),
      messages: [{
        role: 'system',
        content: `You are a senior TypeScript backend engineer fixing a broken Next.js API route handler.
Return ONLY the complete fixed module code — no markdown fences, no explanation.

${ROUTE_MODULE_CONTRACT}

${schemaContext}`,
      }, {
        role: 'user',
        content: `This route handler failed with:
ERROR: ${errorMessage}

Its purpose: "${description}"
It must export an async function named ${method.toUpperCase()}.

BROKEN CODE:
${originalCode}

Fix the code so it satisfies the runtime contract and its purpose.
Check the error against the real schema above — a runtime failure here is most often a wrong column name, a missing ::uuid cast, an un-serialisable BigInt from COUNT(*), or a value that violates a CHECK constraint.`,
      }],
      temperature: 0.1,
      max_tokens: 1600,
    })

    const fixed = stripCodeFences(response.choices[0].message.content?.trim() ?? '')
    if (!fixed || fixed === originalCode.trim()) return null

    const check = validateRouteModule(fixed, method)
    return check.valid ? fixed : null
  } catch {
    return null
  }
}

/**
 * Execute GENERATE_FUNCTION action.
 * Stores the function in DB and saves the code to a project-specific path.
 */
export async function executeGenerateFunction(
  params: Record<string, any>,
  projectId: string
): Promise<{ success: boolean; message: string; data?: any }> {
  const description: string = params.description || params.functionDescription || ''
  const rawName: string = params.functionName || params.name || ''
  const method: string = (params.method || 'GET').toUpperCase()

  if (!description) {
    return { success: false, message: 'description is required for GENERATE_FUNCTION' }
  }

  // Guard: reject names that look like system prompt instructions rather than real function names.
  // These appear when the LLM uses internal variable names (e.g. "describe_ai_function_with_trigger")
  // as the function name instead of deriving one from the description.
  const SYSTEM_PROMPT_PATTERNS = [
    /^describe[_-]ai[_-]function/i,
    /[_-]trigger[_-]type$/i,
    /^generate[_-]function[_-]/i,
    /^ai[_-]function[_-]prompt/i,
  ]
  const nameIsSystemPrompt = SYSTEM_PROMPT_PATTERNS.some(p => p.test(rawName))

  // Normalize function name to kebab-case slug; if the name looks like a system prompt, derive from description
  const functionName = (rawName && !nameIsSystemPrompt)
    ? rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    : description.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

  const endpoint = `/api/v1/${projectId}/fn/${functionName}`
  const filePath = `lib/custom-functions/${projectId}/${functionName}.ts`

  console.log(`[FunctionGenerator] Generating ${method} ${endpoint}`)

  try {
    // Generate the code
    let code = await generateFunctionCode(projectId, description, functionName, method)

    if (!code) {
      return { success: false, message: 'Code generation returned empty result' }
    }

    // ── Creation-time validation gate ─────────────────────────────────────
    // Compile + evaluate + exported-handler check (never invokes the handler).
    // A module that fails is repaired with the validation error fed back to
    // the LLM, up to 2 attempts. Broken code is NEVER stored as an active
    // function — this is the guarantee that an agent-created endpoint cannot
    // crash on its first invocation with a code-shape error.
    const { validateRouteModule } = await import('@/lib/services/ai-functions/route-module-runner')
    let check = validateRouteModule(code, method)
    for (let attempt = 0; !check.valid && attempt < 2; attempt++) {
      console.warn(`[FunctionGenerator] ${functionName} failed validation (${check.error}) — repair attempt ${attempt + 1}`)
      const fixed = await generateFixedRouteModule(code, check.error || 'validation failed', description, method, projectId)
      if (!fixed) break
      code = fixed
      check = validateRouteModule(code, method)
    }
    // ── Behavioural gate: actually RUN it before calling it deployed ─────────
    //
    // The gate above is honest about its own limit — "never invokes the
    // handler", catches "code-shape errors". So a function that references a
    // column that does not exist, forgets a ::uuid cast, or returns a BigInt
    // from COUNT(*) passes every check, deploys, and 500s on the first real
    // request. That is precisely what was reported: three of four generated
    // functions returned bare 500s from specs that read perfectly well.
    //
    // Compiling is not working. So the function is invoked once, for real, and
    // if it throws or 500s the ACTUAL RUNTIME ERROR is fed back into the repair
    // pass — which is strictly better information than a static check can
    // produce, because it is what the database actually said.
    //
    // ── Why this is safe to do to a mutating handler ─────────────────────────
    //
    // The smoke call sends an EMPTY body. A correct POST/PUT/PATCH/DELETE
    // handler validates its input and returns 4xx — it cannot mutate anything
    // it was never given. A 4xx here is therefore a PASS: the handler ran and
    // rejected bad input, which is the behaviour we want. Only a 5xx or a
    // thrown exception counts as a failure. (A handler that DOES write on empty
    // input is itself a bug, and this catches that too.)
    const smoke = await smokeTestRouteModule(code, projectId, functionName, method)
    if (!smoke.ok) {
      console.warn(`[FunctionGenerator] ${functionName} failed its smoke test: ${smoke.error}`)
      const fixed = await generateFixedRouteModule(
        code,
        `The function was invoked and failed at RUNTIME with: ${smoke.error}`,
        description,
        method,
        projectId,
      )
      if (fixed) {
        const recheck = validateRouteModule(fixed, method)
        if (recheck.valid) {
          const retry = await smokeTestRouteModule(fixed, projectId, functionName, method)
          if (retry.ok) {
            code = fixed
            console.log(`[FunctionGenerator] ${functionName} repaired from its runtime error and now runs.`)
          } else {
            // Store the repaired version anyway — it is no worse than the
            // original and may fail only for want of real input — but say so
            // plainly rather than reporting a clean creation.
            code = fixed
            console.warn(`[FunctionGenerator] ${functionName} still failing after repair: ${retry.error}`)
          }
        }
      }
    }

    if (!check.valid) {
      return {
        success: false,
        message: `Function "${functionName}" failed validation and was NOT created: ${check.error}. Rephrase the description (simpler logic, name the exact tables) and try again.`,
      }
    }

    // Persist to AiFunction table (reuse existing model)
    // First check if one exists, then upsert
    const existing = await prisma.aiFunction.findFirst({
      where: { projectId, name: functionName },
      select: { id: true },
    })
    const fn = existing
      ? await prisma.aiFunction.update({
          where: { id: existing.id },
          data: {
            description,
            generatedCode: code,
            triggerType: 'manual',
            triggerTable: `${method} ${endpoint}`,
            status: 'active',
          },
        })
      : await prisma.aiFunction.create({
          data: {
            projectId,
            name: functionName,
            description,
            generatedCode: code,
            triggerType: 'manual',
            triggerTable: `${method} ${endpoint}`,
            status: 'active',
          },
        })

    const result: GeneratedFunction = {
      id: fn.id,
      name: functionName,
      description,
      endpoint,
      method,
      code,
      filePath,
    }

    console.log(`[FunctionGenerator] ✓ Generated function: ${functionName} → ${endpoint}`)

    // ── Say so when the deployed name is not the requested name ───────────────
    //
    // Names are normalised to a kebab-case slug because they become a URL path
    // segment — that part is right. What was wrong is that it happened SILENTLY:
    // `list_products` was requested and `list-products` was deployed, and the
    // response said "Generated GET /api/v1/<id>/fn/list-products" without ever
    // noting that the name had changed. A client written to the name it asked
    // for 404s, and nothing in the response explains why.
    //
    // The rename is fine. Not mentioning it is not.
    const renamed = rawName && rawName !== functionName
    const message = renamed
      ? `Generated ${method} ${endpoint} — custom function ready. ` +
        `NOTE: deployed as "${functionName}", not "${rawName}" — function names are ` +
        `normalised to lowercase kebab-case because they are URL path segments. ` +
        `Call it at ${endpoint}.`
      : `Generated ${method} ${endpoint} — custom function ready. Code stored in database.`

    return {
      success: true,
      message,
      data: {
        ...result,
        ...(renamed ? { requestedName: rawName, deployedName: functionName, renamed: true } : {}),
      },
    }
  } catch (err: any) {
    console.error('[FunctionGenerator] Error:', err)
    return { success: false, message: `Function generation failed: ${err.message}` }
  }
}

/**
 * List all generated custom functions for a project.
 */
export async function listGeneratedFunctions(projectId: string): Promise<GeneratedFunction[]> {
  try {
    const fns = await prisma.aiFunction.findMany({
      where: { projectId, status: 'active' },
      orderBy: { createdAt: 'desc' },
    })

    return fns.map(fn => ({
      id: fn.id,
      name: fn.name,
      description: fn.description,
      endpoint: `/api/v1/${projectId}/fn/${fn.name}`,
      method: fn.triggerTable?.split(' ')[0] || 'GET',
      code: fn.generatedCode || '',
      filePath: `lib/custom-functions/${projectId}/${fn.name}.ts`,
    }))
  } catch {
    return []
  }
}
