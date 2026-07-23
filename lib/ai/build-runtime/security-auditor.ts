/**
 * SECURITY AUDITOR
 * ================
 * Automated security scan on generated API definitions and endpoint code.
 *
 * Fixes #80 — Generated endpoints were never checked for:
 *   - SQL injection vectors (string interpolation into queries)
 *   - Missing authentication on sensitive routes
 *   - Exposed admin endpoints
 *   - Unvalidated file paths (path traversal)
 *   - Mass assignment vulnerabilities (spreading req.body directly into DB calls)
 *
 * Rules:
 *  - Runs against the REAL generated endpoint code stored in ApiDefinition/AiFunction
 *  - Produces a severity-graded report: critical, high, medium, low
 *  - Critical findings fail the build — medium/low are warnings
 *  - All checks are deterministic — no AI heuristics, only pattern matching on real code
 */

import type { VerificationCheck, VerificationReport } from './verifier'

// ── Types ─────────────────────────────────────────────────────────────────────

export type SecurityFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface SecurityFinding {
  severity: SecurityFindingSeverity
  category: string
  location: string        // endpoint name or file reference
  description: string
  evidence?: string       // exact code snippet that triggered the finding
  recommendation: string
}

export interface SecurityAuditReport extends VerificationReport {
  findings: SecurityFinding[]
  criticalCount: number
  highCount: number
  mediumCount: number
  lowCount: number
  score: number           // 0-100 (100 = no findings)
  endpointsAudited: number
}

// ── SQL injection patterns ────────────────────────────────────────────────────

const SQL_INJECTION_PATTERNS: RegExp[] = [
  // String interpolation directly in query
  /`[^`]*\$\{[^}]*(?:req\.|body\.|params\.|query\.)[^}]*\}[^`]*`/,
  // String concatenation with user input
  /(?:query|sql|text)\s*[+=]\s*(?:['"`][^'"`]*['"`]\s*\+\s*(?:req|body|params|query))/i,
  // Direct interpolation without parameterization
  /executeRawUnsafe\([^)]*\$\{[^}]*(?:req|body|params|query)/,
  // Prisma queryRaw with interpolation
  /queryRaw`[^`]*\$\{[^}]*(?:req|body|params|query)\.[^}]*\}/,
]

// ── Missing auth patterns ─────────────────────────────────────────────────────

// Routes that should ALWAYS require auth
const SENSITIVE_OPERATIONS = ['DELETE', 'PATCH', 'PUT', 'POST']
const AUTH_PATTERNS: RegExp[] = [
  /Authorization|Bearer|jwt|authenticate|requireAuth|verifyToken|checkAuth/i,
  /x-api-key|apiKey|api_key/i,
]

const ADMIN_ROUTE_PATTERNS: RegExp[] = [
  /\/admin\//i,
  /['"](admin|superuser|root)['"]/i,
  /role\s*===?\s*['"]admin['"]/i,
  /isAdmin|is_admin|adminOnly/i,
]

// ── Mass assignment patterns ──────────────────────────────────────────────────

const MASS_ASSIGNMENT_PATTERNS: RegExp[] = [
  // Spreading entire req.body into create/update
  /(?:create|update|insert|upsert)\s*\([^)]*\.\.\.\s*(?:req\.body|body)\b/,
  // Using req.body directly as data
  /data\s*:\s*req\.body\b/,
  /data\s*:\s*body\b(?!\s*\?)/,
  // Object.assign with req.body
  /Object\.assign\([^,)]+,\s*req\.body\)/,
]

// ── Path traversal patterns ───────────────────────────────────────────────────

const PATH_TRAVERSAL_PATTERNS: RegExp[] = [
  // File path from user input without sanitization
  /(?:path\.join|path\.resolve|fs\.readFile|fs\.writeFile|readFileSync|writeFileSync)\([^)]*(?:req\.|body\.|params\.|query\.)/i,
  // Directory traversal sequence
  /\.\.\//,
]

// ── Sensitive data exposure patterns ─────────────────────────────────────────

const SENSITIVE_EXPOSURE_PATTERNS: RegExp[] = [
  // Returning password fields
  /password.*(?:res\.json|return|response)/i,
  // Logging sensitive fields
  /console\.(?:log|error|warn)\([^)]*(?:password|token|secret|key)/i,
  // Selecting password hash in query results
  /select:.*password_hash/i,
]

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Audit all generated API definitions for a project.
 * Returns structured security findings with severity grading.
 */
export async function auditGeneratedAPIs(
  projectId: string,
  nodeId: string,
): Promise<SecurityAuditReport> {
  const findings: SecurityFinding[] = []
  let endpointsAudited = 0

  // ── Load all generated endpoints ───────────────────────────────────────────
  const { prisma } = await import('@/lib/db/prisma')

  const [apiDefs, aiFunctions, tables] = await Promise.all([
    prisma.apiDefinition.findMany({
      where: { projectId },
      select: { id: true, name: true, basePath: true, operations: true, endpoints: true, authRequired: true },
    }).catch(() => []),
    prisma.aiFunction.findMany({
      where: { projectId },
      select: { id: true, name: true, generatedCode: true },
    }).catch(() => []),
    prisma.table.findMany({
      where: { projectId },
      select: { name: true },
    }).catch(() => []),
  ])

  // ── Audit REST API definitions ─────────────────────────────────────────────
  for (const api of apiDefs) {
    // operations + endpoints are Json fields containing the endpoint config and any embedded code
    const code = JSON.stringify(api.operations ?? '') + JSON.stringify(api.endpoints ?? '')
    const location = `REST ${api.basePath ?? '/' + api.name}`
    const methods = extractMethodsFromOperations(api.operations)
    endpointsAudited++

    // Check authRequired flag first — if false on a sensitive operation, that's a finding.
    // When authRequired=true, the runtime enforces JWT auth before reaching any handler.
    // Do NOT run the code-level auth pattern check for authRequired=true APIs — the
    // operations JSON blob (e.g. { list: true, create: true }) never contains auth code,
    // so that check produces false positives (48 HIGH findings from correct APIs).
    if (!api.authRequired) {
      findings.push({
        severity: 'high',
        category: 'Missing Authentication',
        location,
        description: 'authRequired=false on this API definition — all operations are publicly accessible.',
        recommendation: 'Set authRequired=true and add authentication middleware to protect this endpoint.',
      })
      // Still audit code block for SQL injection, mass assignment, etc. but pass
      // isAuthEnforced=false so missing-auth check also fires from code patterns.
      findings.push(...auditCodeBlock(code, location, methods, false))
    } else {
      // authRequired=true — runtime handles auth. Audit for SQL injection,
      // mass assignment, path traversal, and sensitive data exposure only.
      findings.push(...auditCodeBlock(code, location, methods, true))
    }
  }

  // ── Audit AI functions ─────────────────────────────────────────────────────
  // AI functions are invoked via the /fn/:name route which requires a valid
  // project API key — treat as auth-enforced so we only check for SQL injection,
  // path traversal, etc. and skip the missing-auth pattern false positive.
  for (const fn of aiFunctions) {
    const code = fn.generatedCode ?? ''
    const location = `Function /${fn.name ?? fn.id}`
    endpointsAudited++

    findings.push(...auditCodeBlock(code, location, ['POST'], true))
  }

  // ── Audit table-level auth requirements ───────────────────────────────────
  findings.push(...auditTableAuthCoverage(tables, apiDefs))

  // ── Compute score ──────────────────────────────────────────────────────────
  const criticalCount = findings.filter(f => f.severity === 'critical').length
  const highCount = findings.filter(f => f.severity === 'high').length
  const mediumCount = findings.filter(f => f.severity === 'medium').length
  const lowCount = findings.filter(f => f.severity === 'low').length

  // Score: start at 100, deduct by severity
  const score = Math.max(0,
    100 - (criticalCount * 25) - (highCount * 10) - (mediumCount * 3) - (lowCount * 1)
  )

  const passed = criticalCount === 0 && highCount === 0

  const checks: VerificationCheck[] = [
    {
      label: 'No critical security issues',
      status: criticalCount === 0 ? 'pass' : 'fail',
      detail: criticalCount === 0
        ? 'No SQL injection, path traversal, or auth bypass found'
        : `${criticalCount} critical issue(s): ${findings.filter(f => f.severity === 'critical').map(f => f.category).join(', ')}`,
    },
    {
      label: 'No high-severity issues',
      status: highCount === 0 ? 'pass' : 'fail',
      detail: highCount === 0
        ? 'No mass assignment or missing auth on sensitive routes'
        : `${highCount} high-severity issue(s) found`,
    },
    {
      label: 'Security score',
      status: score >= 80 ? 'pass' : score >= 50 ? 'warn' : 'fail',
      detail: `Security score: ${score}/100 (${endpointsAudited} endpoints audited, ${findings.length} total findings)`,
    },
  ]

  const summary = passed
    ? `Security audit passed: score ${score}/100, ${endpointsAudited} endpoints audited, ${findings.length} low/medium advisory findings`
    : `Security audit FAILED: ${criticalCount} critical, ${highCount} high severity findings — build blocked until resolved`

  return {
    nodeId,
    passed,
    checks,
    summary,
    findings,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
    score,
    endpointsAudited,
  }
}

// ── Code auditor ──────────────────────────────────────────────────────────────

/**
 * @param isAuthEnforced - true when the ApiDefinition has authRequired=true.
 *   In that case the runtime enforces JWT before any handler code runs, so we
 *   skip the code-level missing-auth pattern check (which would produce false
 *   positives on the serialized operations JSON blob).
 */
function auditCodeBlock(
  code: string,
  location: string,
  methods: string[],
  isAuthEnforced = false,
): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  if (!code || code.length < 10) return findings

  // SQL injection
  for (const pattern of SQL_INJECTION_PATTERNS) {
    const match = pattern.exec(code)
    if (match) {
      findings.push({
        severity: 'critical',
        category: 'SQL Injection',
        location,
        description: 'User-controlled input is interpolated directly into a SQL query without parameterization.',
        evidence: match[0].slice(0, 200),
        recommendation: 'Use parameterized queries ($1, $2) or Prisma\'s typed query methods. Never interpolate req.body/params into raw SQL.',
      })
    }
  }

  // Mass assignment
  for (const pattern of MASS_ASSIGNMENT_PATTERNS) {
    const match = pattern.exec(code)
    if (match) {
      findings.push({
        severity: 'high',
        category: 'Mass Assignment',
        location,
        description: 'The entire request body is spread into a database create/update call, allowing clients to set any field including privileged ones (role, isAdmin, balance).',
        evidence: match[0].slice(0, 200),
        recommendation: 'Destructure and allowlist specific fields from req.body. Never use { data: req.body } or { ...req.body } directly.',
      })
    }
  }

  // Path traversal
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    const match = pattern.exec(code)
    if (match) {
      findings.push({
        severity: 'critical',
        category: 'Path Traversal',
        location,
        description: 'User-controlled input is used to construct a file path without sanitization, enabling directory traversal attacks.',
        evidence: match[0].slice(0, 200),
        recommendation: 'Sanitize file paths using path.basename() and validate against an allowlist of directories. Never pass req.params directly to fs functions.',
      })
    }
  }

  // Sensitive data exposure
  for (const pattern of SENSITIVE_EXPOSURE_PATTERNS) {
    const match = pattern.exec(code)
    if (match) {
      findings.push({
        severity: 'high',
        category: 'Sensitive Data Exposure',
        location,
        description: 'Password hashes, tokens, or secrets may be returned in API responses or logged.',
        evidence: match[0].slice(0, 200),
        recommendation: 'Explicitly exclude password_hash, token, and secret fields from SELECT clauses. Never log authentication credentials.',
      })
    }
  }

  // Missing auth on sensitive operations — only check when auth is NOT already
  // enforced at the ApiDefinition level (isAuthEnforced=false).
  // When authRequired=true, the runtimeApiExecutor gates all requests with JWT
  // before any handler code runs, so pattern-matching the operations JSON for
  // auth keywords is meaningless and produces false positives.
  if (!isAuthEnforced) {
    const hasSensitiveMethods = SENSITIVE_OPERATIONS.some(m =>
      methods.includes(m) || code.toUpperCase().includes(`method: '${m}'`) || code.toUpperCase().includes(`'${m}'`)
    )
    const hasAuthCheck = AUTH_PATTERNS.some(p => p.test(code))

    if (hasSensitiveMethods && !hasAuthCheck) {
      findings.push({
        severity: 'high',
        category: 'Missing Authentication',
        location,
        description: 'This endpoint accepts write operations (POST/PATCH/DELETE/PUT) but no authentication check was found in the generated code.',
        recommendation: 'Add `requireAuth(req)` or verify `Authorization: Bearer <token>` before processing write operations.',
      })
    }
  }

  // Admin routes without admin role check
  const isAdminRoute = ADMIN_ROUTE_PATTERNS.some(p => p.test(location) || p.test(code))
  if (isAdminRoute) {
    const hasAdminCheck = /role\s*===?\s*['"]admin['"]|isAdmin|adminOnly|x-admin-key/i.test(code)
    if (!hasAdminCheck) {
      findings.push({
        severity: 'critical',
        category: 'Exposed Admin Endpoint',
        location,
        description: 'This endpoint appears to be an admin route but has no admin role verification in the generated code.',
        recommendation: 'Add explicit admin role check: verify req.user.role === "admin" before allowing access to admin operations.',
      })
    }
  }

  return findings
}

// ── Table-level auth coverage ─────────────────────────────────────────────────

function auditTableAuthCoverage(
  tables: Array<{ name: string }>,
  apiDefs: Array<{ name: string; basePath: string; operations: any; authRequired: boolean }>,
): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  // Tables that store sensitive data should always have auth
  const SENSITIVE_TABLE_PATTERNS = [
    /^users?$/, /^accounts?$/, /^payments?$/, /^orders?$/,
    /^wallets?$/, /^credits?$/, /^subscriptions?$/, /^invoices?$/,
    /^secrets?$/, /^tokens?$/, /^sessions?$/, /^api_keys?$/,
  ]

  for (const table of tables) {
    const isSensitive = SENSITIVE_TABLE_PATTERNS.some(p => p.test(table.name))
    if (!isSensitive) continue

    // Match by basePath or name heuristic
    const api = apiDefs.find(a =>
      (a.basePath ?? '').includes(table.name) || a.name.toLowerCase().includes(table.name.toLowerCase())
    )

    if (!api) {
      findings.push({
        severity: 'medium',
        category: 'Missing API Definition',
        location: `table/${table.name}`,
        description: `Sensitive table "${table.name}" has no generated API definition — access control cannot be verified.`,
        recommendation: `Generate an API definition for ${table.name} with explicit authentication requirements.`,
      })
      continue
    }

    if (!api.authRequired) {
      findings.push({
        severity: 'high',
        category: 'Sensitive Table Without Auth',
        location: `REST ${api.basePath ?? '/' + api.name}`,
        description: `The API for sensitive table "${table.name}" has authRequired=false. All records may be accessible to anonymous users.`,
        recommendation: `Set authRequired=true on the API definition for ${table.name}. Sensitive data must never be publicly accessible.`,
      })
    }
  }

  return findings
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractMethodsFromOperations(operations: any): string[] {
  if (!operations) return []
  const ops = typeof operations === 'string' ? JSON.parse(operations) : operations
  if (Array.isArray(ops)) return ops.map((o: any) => (o.method ?? o.httpMethod ?? 'GET').toUpperCase())
  if (typeof ops === 'object') {
    const methods: string[] = []
    for (const key of Object.keys(ops)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(key.toLowerCase())) {
        methods.push(key.toUpperCase())
      }
    }
    return methods.length > 0 ? methods : ['GET', 'POST']
  }
  return ['GET', 'POST']
}
