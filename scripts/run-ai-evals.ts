/**
 * AI EVALUATION HARNESS
 * 
 * Runs 280 prompts against Backenly AI
 * Generates pass/fail report + error analysis
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

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
  error_id: string
  prompt: string
  category: string
  status: string
  actual_response: string
  root_cause: string
  solution_needed: {
    priority: 'HIGH' | 'MEDIUM' | 'LOW'
    effort: string
    implementation: string
  }
}

const PROJECT_ID = process.env.PROJECT_ID || ''
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'

async function runEval(prompt: string, projectId: string, conversationId?: string): Promise<any> {
  try {
    const response = await fetch(`${BASE_URL}/api/ai/chat?projectId=${projectId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': getCookieFromBrowser(),
      },
      body: JSON.stringify({
        message: prompt,
        intelligent: true,
        conversationId: conversationId, // Keep conversation context
      }),
    })

    return await response.json()
  } catch (error: any) {
    return { error: error.message, type: 'network_error' }
  }
}

/**
 * Read the session cookie from the environment, never from a literal.
 *
 * A committed JWT is worse than the account it belongs to. It is a known
 * plaintext paired with a valid signature, so it can be used offline to
 * brute-force JWT_SECRET — and that secret signs every session, not just this
 * one. Expiry is no protection: the signature stays verifiable forever.
 */
function getCookieFromBrowser(): string {
  const cookie = process.env.AUTH_COOKIE
  if (!cookie) {
    console.error(
      '\n  AUTH_COOKIE is not set.\n\n' +
      `  Log in to ${BASE_URL}, copy the auth-token cookie from DevTools →\n` +
      '  Application → Cookies, and export it for this run only:\n\n' +
      "    AUTH_COOKIE='auth-token=<value>' PROJECT_ID=<uuid> npm run evals\n",
    )
    process.exit(1)
  }
  return cookie
}

function judgeResult(prompt: string, response: any): EvalResult['status'] {
  // PASS: AI understood and executed successfully
  if (response.type === 'execution_complete' && response.success) {
    return 'PASS'
  }

  // PARTIAL: AI understood but execution failed (feature exists but broken)
  if (response.type === 'execution_failed' || 
      (response.type === 'plan' && response.needsConfirmation)) {
    return 'PARTIAL'
  }

  // FAIL: AI didn't understand or feature doesn't exist
  if (response.type === 'response' || 
      response.type === 'error' ||
      response.action === 'UNKNOWN') {
    return 'FAIL'
  }

  return 'FAIL'
}

function analyzeError(result: EvalResult): ErrorAnalysis | null {
  if (result.status === 'PASS') return null

  const analysis: ErrorAnalysis = {
    error_id: result.id,
    prompt: result.prompt,
    category: result.category,
    status: result.status,
    actual_response: result.response?.message || 'No response',
    root_cause: '',
    solution_needed: {
      priority: 'MEDIUM',
      effort: 'Unknown',
      implementation: '',
    },
  }

  // Analyze based on category and response
  if (result.category === 'DATABASE') {
    if (result.extractedAction === 'UNKNOWN') {
      analysis.root_cause = 'AI failed to extract CREATE_TABLE or ADD_COLUMN action'
      analysis.solution_needed = {
        priority: 'HIGH',
        effort: '1 day',
        implementation: 'Update extractAction() prompt in minimal-executor.ts to handle more database operations',
      }
    } else if (!result.executed) {
      analysis.root_cause = 'Database action not implemented in executor'
      analysis.solution_needed = {
        priority: 'HIGH',
        effort: '2-3 days',
        implementation: 'Implement missing database operations in executeAction()',
      }
    }
  }

  if (result.category === 'AUTHENTICATION') {
    analysis.root_cause = 'OAuth/Auth features not implemented'
    analysis.solution_needed = {
      priority: 'HIGH',
      effort: '1 week',
      implementation: 'Build OAuth integration system with provider management',
    }
  }

  if (result.category === 'STORAGE') {
    analysis.root_cause = 'File storage features not implemented'
    analysis.solution_needed = {
      priority: 'MEDIUM',
      effort: '1 week',
      implementation: 'Integrate S3/Cloudinary storage service with bucket management',
    }
  }

  if (result.category === 'DEPLOY') {
    analysis.root_cause = 'Deployment features not implemented'
    analysis.solution_needed = {
      priority: 'HIGH',
      effort: '2 weeks',
      implementation: 'Build deployment pipeline with Vercel/Railway integration',
    }
  }

  if (result.category === 'MONITORING') {
    analysis.root_cause = 'Monitoring/observability features not implemented'
    analysis.solution_needed = {
      priority: 'MEDIUM',
      effort: '1 week',
      implementation: 'Integrate monitoring service (DataDog/Sentry) with metrics collection',
    }
  }

  if (result.category === 'API_KEYS') {
    analysis.root_cause = 'API key management features not implemented'
    analysis.solution_needed = {
      priority: 'HIGH',
      effort: '3 days',
      implementation: 'Build API key CRUD endpoints with usage tracking',
    }
  }

  return analysis
}

async function main() {
  console.log('🚀 Starting AI Evaluation Harness...\n')

  // Load prompts - USE ALL SECTIONS
  const promptsData = JSON.parse(
    readFileSync(join(process.cwd(), 'evals', 'prompts.json'), 'utf-8')
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

  console.log(`📊 Total prompts to test: ${allPrompts.length}\n`)

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
      console.log(`   ↳ AI asked for confirmation, auto-confirming...`)
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
  console.log('\n📝 Generating reports...\n')

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
    join(outputDir, `report-${timestamp}.json`),
    JSON.stringify(report, null, 2)
  )

  writeFileSync(
    join(outputDir, `errors-analysis-${timestamp}.json`),
    JSON.stringify(errors, null, 2)
  )

  writeFileSync(
    join(outputDir, `full-results-${timestamp}.json`),
    JSON.stringify(results, null, 2)
  )

  // Generate human-readable recommendations
  const recommendations = generateRecommendations(byCategory, errors)
  writeFileSync(
    join(outputDir, `recommendations-${timestamp}.md`),
    recommendations
  )

  console.log('✅ Reports generated successfully!\n')
  console.log(`📊 RESULTS:`)
  console.log(`   Total: ${allPrompts.length}`)
  console.log(`   Passed: ${passed} (${report.passRate})`)
  console.log(`   Failed: ${failed}`)
  console.log(`   Partial: ${partial}\n`)

  console.log(`📁 Files created in evals/results/`)
  console.log(`   - report-${timestamp}.json`)
  console.log(`   - errors-analysis-${timestamp}.json`)
  console.log(`   - full-results-${timestamp}.json`)
  console.log(`   - recommendations-${timestamp}.md`)
}

function generateRecommendations(
  byCategory: Record<string, any>,
  errors: ErrorAnalysis[]
): string {
  let md = `# AI Evaluation Report - Technical Recommendations\n\n`
  md += `Generated: ${new Date().toISOString()}\n\n`
  md += `## Executive Summary\n\n`

  // Category breakdown
  md += `### Performance by Category\n\n`
  md += `| Category | Total | Passed | Failed | Pass Rate |\n`
  md += `|----------|-------|--------|--------|----------|\n`

  for (const [category, stats] of Object.entries(byCategory)) {
    const passRate = ((stats.passed / stats.total) * 100).toFixed(1)
    md += `| ${category} | ${stats.total} | ${stats.passed} | ${stats.failed} | ${passRate}% |\n`
  }

  md += `\n## Critical Issues Requiring Implementation\n\n`

  // Group errors by priority
  const highPriority = errors.filter(e => e.solution_needed.priority === 'HIGH')
  const mediumPriority = errors.filter(e => e.solution_needed.priority === 'MEDIUM')

  md += `### HIGH PRIORITY (${highPriority.length} issues)\n\n`
  const uniqueHighPriority = Array.from(new Set(highPriority.map(e => e.solution_needed.implementation)))
  uniqueHighPriority.forEach((solution, i) => {
    const examples = highPriority.filter(e => e.solution_needed.implementation === solution)
    md += `${i + 1}. **${solution}**\n`
    md += `   - Affected prompts: ${examples.length}\n`
    md += `   - Example: "${examples[0].prompt}"\n`
    md += `   - Effort: ${examples[0].solution_needed.effort}\n\n`
  })

  md += `### MEDIUM PRIORITY (${mediumPriority.length} issues)\n\n`
  const uniqueMediumPriority = Array.from(new Set(mediumPriority.map(e => e.solution_needed.implementation)))
  uniqueMediumPriority.forEach((solution, i) => {
    const examples = mediumPriority.filter(e => e.solution_needed.implementation === solution)
    md += `${i + 1}. **${solution}**\n`
    md += `   - Affected prompts: ${examples.length}\n`
    md += `   - Example: "${examples[0].prompt}"\n`
    md += `   - Effort: ${examples[0].solution_needed.effort}\n\n`
  })

  md += `## Recommended Development Roadmap\n\n`
  md += `Based on pass rates and user impact:\n\n`
  md += `1. **Phase 1 (Week 1-2)**: Fix high-priority Database issues\n`
  md += `2. **Phase 2 (Week 3-4)**: Implement Authentication features\n`
  md += `3. **Phase 3 (Week 5-6)**: Build Deployment pipeline\n`
  md += `4. **Phase 4 (Week 7-8)**: Add Storage and Monitoring\n\n`

  md += `## Success Metrics\n\n`
  md += `Target after implementation:\n`
  md += `- Database: 95%+ pass rate\n`
  md += `- API Builder: 90%+ pass rate\n`
  md += `- Authentication: 80%+ pass rate\n`
  md += `- Deploy: 70%+ pass rate\n`

  return md
}

main().catch(console.error)
