/**
 * PHASE 20 — FINAL TRUST CHECK (THE LITMUS TEST)
 * 
 * Automated validation that ensures:
 * - Zero backend terminology in user-facing text
 * - No technical jargon anywhere visible
 * - Product feels obvious, safe, and boring
 * 
 * If a non-technical user asks "What is an API?" — WE FAILED.
 * If they ask "Where is the database?" — WE FAILED.
 * If they ask "How does auth work?" — WE FAILED.
 */

import { detectForbiddenTerms, LANGUAGE_DICTIONARY } from '@/lib/language/dictionary'
import { glob } from 'glob'
import * as fs from 'fs/promises'
import * as path from 'path'

export interface TrustViolation {
  file: string
  line: number
  column: number
  term: string
  category: string
  context: string
  severity: 'critical' | 'warning'
}

export interface TrustAuditReport {
  passed: boolean
  totalFiles: number
  filesScanned: number
  violations: TrustViolation[]
  violationsByCategory: Record<string, number>
  violationsByFile: Record<string, number>
  criticalViolations: number
  summary: string
}

/**
 * Scan all user-facing files for forbidden terms
 */
export async function runTrustAudit(workspaceRoot: string): Promise<TrustAuditReport> {
  console.log('[Trust Audit] Starting comprehensive trust validation...')

  const violations: TrustViolation[] = []

  // Files to scan (only user-facing code)
  const patterns = [
    'app/**/page.tsx',
    'app/**/layout.tsx', 
    'app/api/**/route.ts', // API responses
    'components/**/*.tsx',
    'lib/errors/**/*.ts', // Error messages
    'lib/language/**/*.ts', // Language system itself
  ]

  let totalFiles = 0
  let filesScanned = 0

  for (const pattern of patterns) {
    const files = await glob(pattern, {
      cwd: workspaceRoot,
      ignore: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.next/**',
        '**/test/**',
        '**/*.test.ts',
        '**/*.test.tsx',
      ],
    })

    totalFiles += files.length

    for (const file of files) {
      try {
        const content = await fs.readFile(path.join(workspaceRoot, file), 'utf-8')
        const fileViolations = scanFileContent(file, content)
        violations.push(...fileViolations)
        filesScanned++
      } catch (error) {
        console.error(`[Trust Audit] Failed to scan ${file}:`, error)
      }
    }
  }

  // Group violations
  const violationsByCategory: Record<string, number> = {}
  const violationsByFile: Record<string, number> = {}
  let criticalViolations = 0

  for (const violation of violations) {
    violationsByCategory[violation.category] = 
      (violationsByCategory[violation.category] || 0) + 1
    violationsByFile[violation.file] = 
      (violationsByFile[violation.file] || 0) + 1
    if (violation.severity === 'critical') {
      criticalViolations++
    }
  }

  const passed = criticalViolations === 0 && violations.length === 0

  const summary = passed
    ? `✅ PASSED: No forbidden terms found in ${filesScanned} user-facing files`
    : `❌ FAILED: Found ${violations.length} violations (${criticalViolations} critical) in ${Object.keys(violationsByFile).length} files`

  console.log(`[Trust Audit] ${summary}`)

  return {
    passed,
    totalFiles,
    filesScanned,
    violations,
    violationsByCategory,
    violationsByFile,
    criticalViolations,
    summary,
  }
}

/**
 * Scan a single file for forbidden terms
 */
function scanFileContent(filePath: string, content: string): TrustViolation[] {
  const violations: TrustViolation[] = []
  const lines = content.split('\n')

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum]

    // Skip comments (they're for developers, not users)
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
      continue
    }

    // Skip imports
    if (line.trim().startsWith('import ')) {
      continue
    }

    // Check for forbidden terms in user-facing strings
    const stringMatches = Array.from(
      line.matchAll(/("[^"]*"|'[^']*'|`[^`]*`)/g)
    )

    for (const match of stringMatches) {
      const stringContent = match[0].slice(1, -1) // Remove quotes
      const { found, violations: termViolations } = detectForbiddenTerms(stringContent)

      if (found.length > 0) {
        for (const violation of termViolations) {
          // Determine severity
          const severity = isUserFacingFile(filePath) ? 'critical' : 'warning'

          violations.push({
            file: filePath,
            line: lineNum + 1,
            column: match.index || 0,
            term: violation.term,
            category: violation.category,
            context: line.trim(),
            severity,
          })
        }
      }
    }
  }

  return violations
}

/**
 * Check if file is directly user-facing (critical violations)
 */
function isUserFacingFile(filePath: string): boolean {
  const userFacingPatterns = [
    '/page.tsx',
    '/components/',
    '/lib/errors/',
  ]

  return userFacingPatterns.some(pattern => filePath.includes(pattern))
}

/**
 * Generate detailed violation report
 */
export function generateViolationReport(violations: TrustViolation[]): string {
  if (violations.length === 0) {
    return '✅ No violations found!'
  }

  let report = `🚨 Trust Violations Detected: ${violations.length}\n\n`

  // Group by file
  const byFile = violations.reduce((acc, v) => {
    if (!acc[v.file]) acc[v.file] = []
    acc[v.file].push(v)
    return acc
  }, {} as Record<string, TrustViolation[]>)

  for (const [file, fileViolations] of Object.entries(byFile)) {
    report += `📄 ${file} (${fileViolations.length} violations)\n`

    for (const violation of fileViolations) {
      const icon = violation.severity === 'critical' ? '🔴' : '⚠️'
      report += `  ${icon} Line ${violation.line}: "${violation.term}" → use "${LANGUAGE_DICTIONARY[violation.category]?.replacement || 'user-friendly term'}"\n`
      report += `     Context: ${violation.context.slice(0, 80)}...\n`
    }

    report += '\n'
  }

  return report
}

/**
 * Quick check for a single string
 */
export function quickTrustCheck(text: string): {
  safe: boolean
  violations: string[]
  suggestions: string[]
} {
  const { found, violations } = detectForbiddenTerms(text)

  return {
    safe: found.length === 0,
    violations: found,
    suggestions: violations.map(v => 
      `Replace "${v.term}" with "${v.suggestion}"`
    ),
  }
}

/**
 * The Litmus Test Questions
 * If a non-technical user asks these, the product failed.
 */
export const LITMUS_TEST_QUESTIONS = [
  {
    question: 'What is an API?',
    failure: 'User sees "API" terminology',
    fix: 'Replace all "API" with "connect"',
  },
  {
    question: 'Where is the database?',
    failure: 'User sees "database" terminology',
    fix: 'Replace all "database" with "remember" or "data"',
  },
  {
    question: 'How does auth work?',
    failure: 'User sees "auth" terminology',
    fix: 'Replace all "auth" with "users" or "sign in"',
  },
  {
    question: 'What is a deployment?',
    failure: 'User sees "deploy" terminology',
    fix: 'Replace all "deploy" with "make it live" or "works"',
  },
  {
    question: 'Where are the servers?',
    failure: 'User sees infrastructure terminology',
    fix: 'Never mention servers, instances, containers',
  },
]

/**
 * Validate against litmus test
 */
export function validateLitmusTest(violations: TrustViolation[]): {
  passed: boolean
  failedQuestions: typeof LITMUS_TEST_QUESTIONS
  explanation: string
} {
  const failedQuestions = []

  for (const question of LITMUS_TEST_QUESTIONS) {
    // Check if any violations match this question's failure condition
    const relevantViolations = violations.filter(v => {
      if (question.failure.includes('API')) return v.category === 'api'
      if (question.failure.includes('database')) return v.category === 'database'
      if (question.failure.includes('auth')) return v.category === 'authentication'
      if (question.failure.includes('deploy')) return v.category === 'deployment'
      if (question.failure.includes('infrastructure')) return v.category === 'infrastructure'
      return false
    })

    if (relevantViolations.length > 0) {
      failedQuestions.push(question)
    }
  }

  const passed = failedQuestions.length === 0

  const explanation = passed
    ? 'Product passes the litmus test! Non-technical users will understand everything.'
    : `Product fails ${failedQuestions.length}/${LITMUS_TEST_QUESTIONS.length} litmus test questions. Users will ask: ${failedQuestions.map(q => q.question).join(', ')}`

  return {
    passed,
    failedQuestions,
    explanation,
  }
}
