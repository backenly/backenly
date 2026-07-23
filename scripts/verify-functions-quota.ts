/**
 * End-to-end verification of the AI Function invocation quota fix.
 * Run: npx tsx scripts/verify-functions-quota.ts [projectId]
 *
 * Needs a live database. Checks:
 *  1. Plan rows carry the v4 quotas (Free 10k / Pro 2M / Enterprise unlimited)
 *  2. A real route-module function executes successfully (quota gate passes)
 *  3. A real sandbox function executes successfully
 *  4. Execution log rows are written and usage is tracked
 *  5. The quota-block path returns a structured PLAN_LIMIT_EXCEEDED (simulated
 *     by temporarily exhausting the owner's monthly usage row) AND writes an
 *     execution log so trigger-fired blocks are never invisible
 */
import { prisma } from '../lib/db'
import { executeAiFunction } from '../lib/services/ai-functions/executor'

// v4 pricing: SANDBOX (Free) 10k · BUILDER (Pro $25) 2M · SCALE (Enterprise) null = unlimited
const EXPECTED: Record<string, number | null> = { SANDBOX: 10_000, BUILDER: 2_000_000, SCALE: null }

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

async function main() {
  console.log('\n1. Plan quotas')
  const plans = await prisma.plan.findMany({
    where: { name: { in: Object.keys(EXPECTED) } },
    select: { name: true, maxAiFunctionInvocationsPerMonth: true },
  })
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const plan = plans.find(p => p.name === name)
    check(
      `${name} = ${expected === null ? 'unlimited' : `${expected.toLocaleString()}/mo`}`,
      plan !== undefined && plan.maxAiFunctionInvocationsPerMonth === expected,
      `got ${plan ? String(plan.maxAiFunctionInvocationsPerMonth) : 'missing plan'}`
    )
  }

  const projectId = process.argv[2] || (await prisma.aiFunction.findFirst({
    where: { status: 'active' },
    select: { projectId: true },
  }))?.projectId
  if (!projectId) {
    check('find a project with active functions', false, 'none found')
    return
  }
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true, name: true } })
  console.log(`\nProject: ${project?.name} (${projectId})`)

  const fns = await prisma.aiFunction.findMany({
    where: { projectId, status: 'active' },
    select: { id: true, name: true, generatedCode: true, triggerType: true },
  })
  const routeFn = fns.find(f => /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)/.test(f.generatedCode))
  const sandboxFn = fns.find(f => !/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)/.test(f.generatedCode))

  console.log('\n2. Route-module function runs')
  if (routeFn) {
    const r = await executeAiFunction(routeFn.id, projectId, { type: 'manual', data: {} })
    check(`${routeFn.name} executes (no quota block)`, r.success === true, r.error)
    check('no PLAN_LIMIT_EXCEEDED code', r.errorCode !== 'PLAN_LIMIT_EXCEEDED', r.error)
  } else {
    console.log('  (no route-module function in this project — skipped)')
  }

  console.log('\n3. Sandbox function runs')
  if (sandboxFn) {
    const r = await executeAiFunction(sandboxFn.id, projectId, { type: 'manual', data: { test: true } })
    check(`${sandboxFn.name} not quota-blocked`, r.errorCode !== 'PLAN_LIMIT_EXCEEDED', r.error)
    console.log(`    → success=${r.success}${r.error ? ` error=${r.error}` : ''} (${r.durationMs}ms)`)
  } else {
    console.log('  (no sandbox function in this project — skipped)')
  }

  console.log('\n4. Logs + usage tracking')
  const logCount = await prisma.aiFunctionLog.count({ where: { projectId } })
  check('execution log rows exist', logCount > 0, `count=${logCount}`)
  if (project?.userId) {
    const usage = await prisma.userAiUsage.findFirst({ where: { userId: project.userId, date: thisMonth() } })
    check('aiFunctionInvocations tracked', (usage?.aiFunctionInvocations ?? 0) > 0, `got ${usage?.aiFunctionInvocations}`)
  }

  console.log('\n5. Quota-block path (simulated exhaustion)')
  if (project?.userId && (routeFn || sandboxFn)) {
    const fn = (routeFn || sandboxFn)!
    const usageRow = await prisma.userAiUsage.findFirst({ where: { userId: project.userId, date: thisMonth() } })
    const original = usageRow?.aiFunctionInvocations ?? 0
    if (usageRow) {
      await prisma.userAiUsage.update({ where: { id: usageRow.id }, data: { aiFunctionInvocations: 99_999_999 } })
      const blocked = await executeAiFunction(fn.id, projectId, { type: 'manual', data: {} })
      check('blocked run returns success:false', blocked.success === false)
      check('blocked run carries PLAN_LIMIT_EXCEEDED', blocked.errorCode === 'PLAN_LIMIT_EXCEEDED', blocked.errorCode)
      check('blocked run names required plan', typeof blocked.requiredPlan === 'string', String(blocked.requiredPlan))
      const trace = await prisma.aiFunctionLog.findFirst({
        where: { functionId: fn.id, success: false, error: { contains: 'invocations' } },
        orderBy: { createdAt: 'desc' },
      })
      check('blocked run left an execution-log trace', !!trace)
      const after = await prisma.aiFunction.findUnique({ where: { id: fn.id }, select: { status: true } })
      check('function NOT flipped to error status by the block', after?.status === 'active', after?.status)
      // restore
      await prisma.userAiUsage.update({ where: { id: usageRow.id }, data: { aiFunctionInvocations: original } })
      console.log(`    (usage restored to ${original})`)
    } else {
      console.log('  (no usage row yet — skipped simulation)')
    }
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main()
  .catch(e => { console.error('❌ Verifier crashed:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
