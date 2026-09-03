import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth/middleware'
import { generateFunctionCode } from '@/lib/services/ai-functions/generator'
import { validateAiFunctionData } from '@/lib/ai/function-validation'
import { canAccessProject } from '@/lib/edition/guard'

/**
 * GET /api/projects/[id]/ai-functions
 * List all AI functions for a project
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticateRequest(request)
    if (!auth.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    if (!(await canAccessProject(auth.userId, params.id))) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const raw = await prisma.aiFunction.findMany({
      where: { projectId: params.id },
      orderBy: { createdAt: 'desc' },
    })

    // ── 1. Filter out phantom/placeholder functions ───────────────────────────
    // These were created before creation-time guards were in place. They have
    // template descriptions or template names and should never be shown or executed.
    const { isPlaceholderDescription, isPlaceholderName } = await import('@/lib/ai/function-validation')

    const placeholders: typeof raw = []
    const validFunctions = raw.filter(fn => {
      const isPlaceholder =
        !fn.name ||
        fn.name.trim() === '' ||
        isPlaceholderName(fn.name) ||
        isPlaceholderDescription(fn.description)
      if (isPlaceholder) { placeholders.push(fn); return false }
      return true
    })

    // Any placeholder that has a live non-manual trigger will fire on every DB event
    // and throw errors silently.  Deactivate these in the background so they stop firing.
    const dangerousPlaceholders = placeholders.filter(
      fn => fn.status === 'active' && fn.triggerType !== 'manual',
    )
    if (dangerousPlaceholders.length > 0) {
      Promise.allSettled(
        dangerousPlaceholders.map(fn =>
          prisma.aiFunction.update({
            where: { id: fn.id },
            data: { status: 'inactive' },
          }),
        ),
      ).catch(() => {})
    }

    // ── 2. Deduplicate by name — keep the most recent copy ───────────────────
    const seen = new Set<string>()
    const deduped = validFunctions.filter(fn => {
      if (seen.has(fn.name)) return false
      seen.add(fn.name)
      return true
    })

    // ── 3. Auto-heal false-positive errors ────────────────────────────────────
    // Two historical bugs marked healthy functions status='error' permanently:
    //  (a) The old validateFunctionSyntax wrapped code in a sync Function(),
    //      so any async body got "Syntax error: await is only valid in async".
    //  (b) Platform route-module endpoints (jobs/wallets/*-schema/...) were
    //      forced through the NL sandbox, which rejected its own rewritten
    //      imports with "Blocked: code contains forbidden pattern '\brequire'".
    // Both code paths now execute correctly (async wrapper / route-module
    // runner), so these rows are stale. Heal them in the background so they go
    // active immediately; a genuinely broken function will simply re-error on
    // its next run with a truthful message.
    const FALSE_POSITIVE_RE =
      /await is only valid in async|forbidden pattern '\\brequire|forbidden pattern '\(\?<!|Use ctx\.require\(/i
    const toHeal = deduped.filter(fn =>
      fn.status === 'error' &&
      fn.lastError &&
      FALSE_POSITIVE_RE.test(fn.lastError)
    )
    if (toHeal.length > 0) {
      // Fire-and-forget — never blocks the response
      Promise.allSettled(
        toHeal.map(fn =>
          prisma.aiFunction.update({
            where: { id: fn.id },
            data: { status: 'active', lastError: null },
          })
        )
      ).catch(() => {})

      // Return healed state immediately (don't make caller wait for DB)
      deduped.forEach(fn => {
        if (toHeal.some(h => h.id === fn.id)) {
          fn.status = 'active'
          fn.lastError = null
        }
      })
    }

    return NextResponse.json({ functions: deduped })
  } catch (error: any) {
    console.error('[AI Functions] GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch functions' }, { status: 500 })
  }
}

/**
 * POST /api/projects/[id]/ai-functions
 * Create a new AI function — describe it in natural language, AI generates the code
 * Body: { description, triggerType, triggerTable? }
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticateRequest(request)
    if (!auth.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    if (!(await canAccessProject(auth.userId, params.id))) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const body = await request.json()
    const { description, triggerType, triggerTable } = body

    if (!description?.trim()) {
      return NextResponse.json({ error: 'description is required' }, { status: 400 })
    }

    const validTriggers = ['on_signup', 'on_db_insert', 'on_db_update', 'on_db_delete', 'on_webhook', 'manual', 'cron']
    if (!validTriggers.includes(triggerType)) {
      return NextResponse.json(
        { error: `triggerType must be one of: ${validTriggers.join(', ')}` },
        { status: 400 }
      )
    }

    const needsTable = ['on_db_insert', 'on_db_update', 'on_db_delete'].includes(triggerType)
    if (needsTable && !triggerTable) {
      return NextResponse.json(
        { error: 'triggerTable is required for database triggers' },
        { status: 400 }
      )
    }

    // For cron jobs, triggerTable holds the cron expression — require it
    if (triggerType === 'cron' && !triggerTable) {
      return NextResponse.json(
        { error: 'triggerTable is required for cron triggers (provide a cron expression, e.g. "0 9 * * *")' },
        { status: 400 }
      )
    }

    // Generate the function code using AI
    const { name: rawName, code } = await generateFunctionCode(
      description,
      triggerType,
      triggerType === 'cron' ? null : (triggerTable || null),
      params.id
    )

    const validation = validateAiFunctionData(rawName, description)
    if (!validation.valid) {
      console.warn(`[AI Functions API] Rejecting function creation: ${validation.reason}`)
      return NextResponse.json(
        { error: 'Generated function name is invalid. Please provide a clearer description.' },
        { status: 422 }
      )
    }
    const name = validation.name

    const fn = await prisma.aiFunction.create({
      data: {
        projectId: params.id,
        name,
        description: description.trim(),
        generatedCode: code,
        triggerType,
        triggerTable: triggerTable || null,
        status: 'active',
      },
    })

    return NextResponse.json({ function: fn }, { status: 201 })
  } catch (error: any) {
    console.error('[AI Functions] POST error:', error)
    return NextResponse.json({ error: 'Failed to create function' }, { status: 500 })
  }
}
