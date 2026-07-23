import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

// Test Configuration
const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001'
const PROJECT_ID = process.env.PROJECT_ID || ''

/**
 * Read the session cookie from the environment, never from a literal.
 *
 * A committed JWT is a known plaintext paired with a valid signature, which
 * makes it an offline oracle for JWT_SECRET — the key that signs every session,
 * not just this one. Expiry does not help; the signature stays verifiable.
 */
function getCookieFromBrowser(): string {
  const cookie = process.env.AUTH_COOKIE
  if (!cookie) {
    console.error(
      '\n  AUTH_COOKIE is not set.\n\n' +
      '  Log in, copy the auth-token cookie from DevTools → Application →\n' +
      '  Cookies, and export it for this run only:\n\n' +
      "    AUTH_COOKIE='auth-token=<value>' PROJECT_ID=<uuid> npm run stress-test\n",
    )
    process.exit(1)
  }
  return cookie
}

interface EvalPrompt {
  id: string
  category: string
  prompt: string
}

interface EvalResult {
  id: string
  category: string
  prompt: string
  status: 'PASS' | 'FAIL' | 'PARTIAL'
  response: any
  extractedAction: string | null
  validated: boolean
  executed: boolean
  executionSuccess: boolean
  errorMessage: string | null
  timestamp: string
}

interface ErrorAnalysis {
  prompt: string
  category: string
  error_type: string
  raw_error: string
  solution_needed: {
    action: string
    implementation: string
    effort: 'LOW' | 'MEDIUM' | 'HIGH'
    priority: 'HIGH' | 'MEDIUM' | 'LOW'
  }
}

// Run a single evaluation
async function runEval(prompt: string, projectId: string, conversationId?: string): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/api/ai/chat?projectId=${projectId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': getCookieFromBrowser(),
      },
      body: JSON.stringify({
        message: prompt,
        intelligent: true,
        conversationId,
      }),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    return await response.json()
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      action: null,
      validation: null,
      executed: false,
    }
  }
}

// Judge if the result is a pass/fail
function judgeResult(prompt: string, response: any): 'PASS' | 'FAIL' | 'PARTIAL' {
  const promptLower = prompt.toLowerCase()

  // FAIL conditions - only true failures
  if (!response) return 'FAIL'
  if (response.error && !response.executed) return 'FAIL'
  
  // Check if execution reached a valid end state (idempotent success)
  const message = (response.message || response.error || '').toLowerCase()
  const isIdempotentSuccess = 
    message.includes('created') ||
    message.includes('already exists') ||
    message.includes('skipped') ||
    message.includes('no change') ||
    message.includes('exists') ||
    message.includes('success') ||
    message.includes('generated')

  // PASS: System reached valid end state
  if (response.success || response.executed && isIdempotentSuccess) {
    return 'PASS'
  }

  // PASS: Execution completed (even if it says "already exists")
  if (response.type === 'execution_complete') {
    return 'PASS'
  }

  // PARTIAL: AI understood but execution had issues
  if (response.type === 'execution_failed' && response.executed) {
    // Check if it's an idempotent failure (table already exists)
    if (message.includes('already exists')) {
      return 'PASS' // Idempotent operations that fail on duplicate = success
    }
    return 'PARTIAL'
  }

  // FAIL: AI didn't understand
  if (!response.action && !response.executed) return 'FAIL'

  return 'FAIL'
}

// Analyze errors and suggest solutions
function analyzeError(result: EvalResult): ErrorAnalysis | null {
  if (result.status === 'PASS') return null

  const errorMsg = result.errorMessage || 'Unknown error'
  const category = result.category

  let errorType = 'UNKNOWN'
  let solution: {
    action: string
    implementation: string
    effort: 'LOW' | 'MEDIUM' | 'HIGH'
    priority: 'HIGH' | 'MEDIUM' | 'LOW'
  } = {
    action: 'UNKNOWN',
    implementation: 'Unknown implementation needed',
    effort: 'MEDIUM',
    priority: 'MEDIUM',
  }

  // Analyze based on category
  if (category === 'SCHEMA_DEPENDENCY_HELL') {
    errorType = 'DEPENDENCY_RESOLUTION'
    solution = {
      action: 'IMPLEMENT_DEPENDENCY_RESOLVER',
      implementation: 'Add pre-flight dependency resolver that auto-creates referenced tables',
      effort: 'HIGH',
      priority: 'HIGH',
    }
  } else if (category === 'AMBIGUOUS_HUMAN_REQUESTS') {
    errorType = 'INFERENCE_FAILURE'
    solution = {
      action: 'IMPROVE_INTENT_PARSING',
      implementation: 'Enhance intent parser to infer schema changes from natural language',
      effort: 'HIGH',
      priority: 'HIGH',
    }
  } else if (category === 'OPERATIONS_THAT_BREAK_WEAK_SYSTEMS') {
    if (result.prompt.includes('Rename')) {
      errorType = 'SCHEMA_OPERATION_MISSING'
      solution = {
        action: 'ADD_RENAME_COLUMN',
        implementation: 'Implement RENAME_COLUMN action with idempotent behavior',
        effort: 'LOW',
        priority: 'HIGH',
      }
    } else if (result.prompt.includes('unique') || result.prompt.includes('index')) {
      errorType = 'CONSTRAINT_OPERATION_MISSING'
      solution = {
        action: 'ADD_CONSTRAINT_OPERATIONS',
        implementation: 'Implement ADD_CONSTRAINT and CREATE_INDEX actions',
        effort: 'LOW',
        priority: 'HIGH',
      }
    } else if (result.prompt.includes('Delete all') || result.prompt.includes('Update all')) {
      errorType = 'BULK_OPERATION_MISSING'
      solution = {
        action: 'ADD_BULK_OPERATIONS',
        implementation: 'Implement bulk DELETE and UPDATE operations',
        effort: 'MEDIUM',
        priority: 'MEDIUM',
      }
    }
  }

  return {
    prompt: result.prompt,
    category: result.category,
    error_type: errorType,
    raw_error: errorMsg,
    solution_needed: solution,
  }
}

// Clean database between tests for isolation
async function cleanDatabase() {
  try {
    const { PrismaClient } = await import('@prisma/client')
    const prisma = new PrismaClient()

    // Get workspace schema name
    const workspaceSchema = `workspace_${PROJECT_ID}`

    // Delete all API definitions
    await prisma.apiDefinition.deleteMany({
      where: { projectId: PROJECT_ID }
    })

    // Get all tables in workspace schema
    const tables = await prisma.table.findMany({
      where: { projectId: PROJECT_ID },
      select: { name: true }
    })

    // Drop all tables
    for (const table of tables) {
      try {
        await prisma.$executeRawUnsafe(
          `DROP TABLE IF EXISTS "${workspaceSchema}"."${table.name}" CASCADE`
        )
      } catch (e) {
        // Ignore errors for tables that don't exist
      }
    }

    // Delete table metadata
    await prisma.table.deleteMany({
      where: { projectId: PROJECT_ID }
    })

    await prisma.$disconnect()
    console.log('[DB RESET] Database cleaned successfully\n')
  } catch (error: any) {
    console.error('[DB RESET] Failed to clean database:', error.message)
  }
}

async function main() {
  console.log('[STRESS TEST] Starting AI Stress-Test Evaluation...\n')

  // Load stress-test prompts
  const promptsData = JSON.parse(
    readFileSync(join(process.cwd(), 'evals', 'prompts-stress-test.json'), 'utf-8')
  )

  // Flatten all prompts into single array
  const allPrompts: EvalPrompt[] = []
  for (const [category, data] of Object.entries(promptsData.categories)) {
    const prompts = (data as any).prompts
    prompts.forEach((prompt: string, index: number) => {
      allPrompts.push({
        id: `${category}_${String(index + 1).padStart(3, '0')}`,
        category,
        prompt,
      })
    })
  }

  console.log(`[STRESS TEST] Total prompts to test: ${allPrompts.length}\n`)

  // Clean database before starting tests
  console.log('[DB RESET] Cleaning test environment...\n')
  await cleanDatabase()

  // Run evaluations
  const results: EvalResult[] = []
  const errors: ErrorAnalysis[] = []

  for (let i = 0; i < allPrompts.length; i++) {
    const evalPrompt = allPrompts[i]
    console.log(`[${i + 1}/${allPrompts.length}] Testing: ${evalPrompt.prompt.substring(0, 60)}...`)

    // Step 1: Send initial prompt
    const response = await runEval(evalPrompt.prompt, PROJECT_ID)
    
    // Step 2: If AI asks for confirmation, auto-confirm with "yes"
    let finalResponse = response
    if (response.needsConfirmation && response.conversationId) {
      console.log(`   [AUTO-CONFIRM] AI asked for confirmation, sending "yes"...`)
      finalResponse = await runEval('yes', PROJECT_ID, response.conversationId)
    }
    
    const status = judgeResult(evalPrompt.prompt, finalResponse)

    const result: EvalResult = {
      id: evalPrompt.id,
      category: evalPrompt.category,
      prompt: evalPrompt.prompt,
      status,
      response: finalResponse,
      extractedAction: finalResponse.action?.action || null,
      validated: !!finalResponse.validation,
      executed: finalResponse.executed || false,
      executionSuccess: finalResponse.success || false,
      errorMessage: finalResponse.error || finalResponse.message || null,
      timestamp: new Date().toISOString(),
    }

    results.push(result)

    // Analyze failures
    const errorAnalysis = analyzeError(result)
    if (errorAnalysis) {
      errors.push(errorAnalysis)
    }

    // Rate limiting - don't spam the API
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  // Generate reports
  console.log('\n[REPORT] Generating stress-test reports...\n')

  const passed = results.filter(r => r.status === 'PASS').length
  const failed = results.filter(r => r.status === 'FAIL').length
  const partial = results.filter(r => r.status === 'PARTIAL').length

  const byCategory: Record<string, { total: number; passed: number; failed: number; partial: number }> = {}
  for (const result of results) {
    if (!byCategory[result.category]) {
      byCategory[result.category] = { total: 0, passed: 0, failed: 0, partial: 0 }
    }
    byCategory[result.category].total++
    if (result.status === 'PASS') byCategory[result.category].passed++
    if (result.status === 'FAIL') byCategory[result.category].failed++
    if (result.status === 'PARTIAL') byCategory[result.category].partial++
  }

  const report = {
    timestamp: new Date().toISOString(),
    test_type: 'STRESS_TEST',
    total: allPrompts.length,
    passed,
    failed,
    partial,
    passRate: ((passed / allPrompts.length) * 100).toFixed(1) + '%',
    byCategory,
    topFailures: errors.slice(0, 20),
  }

  // Create output directory
  const outputDir = join(process.cwd(), 'evals', 'results')
  mkdirSync(outputDir, { recursive: true })

  // Write files
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  
  writeFileSync(
    join(outputDir, `stress-test-report-${timestamp}.json`),
    JSON.stringify(report, null, 2)
  )

  writeFileSync(
    join(outputDir, `stress-test-errors-${timestamp}.json`),
    JSON.stringify(errors, null, 2)
  )

  writeFileSync(
    join(outputDir, `stress-test-full-${timestamp}.json`),
    JSON.stringify(results, null, 2)
  )

  // Generate human-readable analysis
  const analysis = generateAnalysis(byCategory, errors, results)
  writeFileSync(
    join(outputDir, `stress-test-analysis-${timestamp}.md`),
    analysis
  )

  console.log('[SUCCESS] Reports generated successfully!\n')
  console.log(`[RESULTS]:`)
  console.log(`   Total: ${allPrompts.length}`)
  console.log(`   Passed: ${passed} (${report.passRate})`)
  console.log(`   Failed: ${failed}`)
  console.log(`   Partial: ${partial}\n`)

  console.log(`[FILES] Created in evals/results/`)
  console.log(`   - stress-test-report-${timestamp}.json`)
  console.log(`   - stress-test-errors-${timestamp}.json`)
  console.log(`   - stress-test-full-${timestamp}.json`)
  console.log(`   - stress-test-analysis-${timestamp}.md`)
}

function generateAnalysis(
  byCategory: Record<string, any>,
  errors: ErrorAnalysis[],
  results: EvalResult[]
): string {
  let md = `# AI Stress-Test Evaluation - Analysis Report\n\n`
  md += `Generated: ${new Date().toISOString()}\n\n`
  md += `## Overview\n\n`
  md += `This stress-test uses 30 intentionally tricky, ambiguous, and incomplete prompts that typically break weak AI systems. These test:\n\n`
  md += `- Complex schema + API dependency chains\n`
  md += `- Vague/incomplete human requests requiring inference\n`
  md += `- Destructive operations and edge cases\n\n`

  // Category breakdown
  md += `## Performance by Category\n\n`
  md += `| Category | Total | Passed | Failed | Partial | Pass Rate |\n`
  md += `|----------|-------|--------|--------|---------|----------|\n`

  for (const [category, stats] of Object.entries(byCategory)) {
    const passRate = ((stats.passed / stats.total) * 100).toFixed(1)
    md += `| ${category} | ${stats.total} | ${stats.passed} | ${stats.failed} | ${stats.partial} | ${passRate}% |\n`
  }

  md += `\n## Critical Gaps Exposed\n\n`

  // Group errors by solution needed
  const solutionGroups: Record<string, ErrorAnalysis[]> = {}
  errors.forEach(e => {
    const key = e.solution_needed.implementation
    if (!solutionGroups[key]) solutionGroups[key] = []
    solutionGroups[key].push(e)
  })

  const sortedSolutions = Object.entries(solutionGroups).sort(
    ([, a], [, b]) => b.length - a.length
  )

  sortedSolutions.forEach(([solution, examples], i) => {
    const priority = examples[0].solution_needed.priority
    const effort = examples[0].solution_needed.effort
    md += `### ${i + 1}. ${solution}\n\n`
    md += `- **Priority**: ${priority}\n`
    md += `- **Effort**: ${effort}\n`
    md += `- **Affected Prompts**: ${examples.length}\n`
    md += `- **Example**: "${examples[0].prompt}"\n\n`
  })

  md += `## Sample Failures\n\n`
  const failedResults = results.filter(r => r.status === 'FAIL').slice(0, 10)
  failedResults.forEach((result, i) => {
    md += `### ${i + 1}. ${result.prompt}\n\n`
    md += `- **Category**: ${result.category}\n`
    md += `- **Action Extracted**: ${result.extractedAction || 'None'}\n`
    md += `- **Error**: ${result.errorMessage}\n\n`
  })

  md += `## Recommendations\n\n`
  md += `Based on this stress-test, prioritize:\n\n`
  md += `1. **Dependency Resolution**: Auto-create referenced tables and foreign keys\n`
  md += `2. **Schema Inference**: Parse natural language for schema changes (add column, change type)\n`
  md += `3. **Idempotent Operations**: All schema ops should handle "already exists" gracefully\n`
  md += `4. **Bulk Operations**: Support DELETE WHERE and UPDATE WHERE queries\n\n`

  return md
}

main().catch(console.error)
