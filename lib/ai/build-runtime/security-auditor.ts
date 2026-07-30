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

  const { listExposedTables } = await import('@/lib/mcp/schema-introspection')
  const [exposedTables, aiFunctions, tables] = await Promise.all([
    listExposedTables(projectId).catch(() => []),
    prisma.aiFunction.findMany({
      where: { projectId },
      select: { id: true, name: true, generatedCode: true },
    }).catch(() => []),
    prisma.table.findMany({
      where: { projectId },
      select: { name: true },
    }).catch(() => []),
  ])

  // RETIRED 2026-07-30 - this branch audited a projection that is both empty
  // and incapable of holding what it searched for.
  //
  // It read each ApiDefinition's `authRequired` flag and grepped the
  // operations/endpoints JSON for insecure code patterns. Under PostgREST there
  // is no per-API auth flag: every /db/* request is authenticated and RLS
  // decides which rows come back. And the JSON never contained code - the
  // comment this replaces said so itself, after that check produced 48 HIGH
  // findings against correct APIs.
  //
  // The table also has no create path since the cutover, so on every modern
  // project the loop iterated zero rows and `endpointsAudited` stayed 0 while
  // the audit reported a clean pass.
  //
  // Real API-surface security is enforced structurally now: the cutover blocker
  // refuses any schema containing a client-reachable table with RLS disabled,
  // and detectMissingRls / detectRlsDeniesEverything cover the rest. AI function
  // code is still audited below, where there is genuine code to read.

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
  findings.push(...auditTableAuthCoverage(tables, exposedTables))

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

/**
 * Sensitive tables must not be reachable without row-level security.
 *
 * REWRITTEN 2026-07-30. This matched each sensitive table against an
 * ApiDefinition row and reported "Missing API Definition — access control
 * cannot be verified" when it found none, recommending that one be generated.
 * With no create path since the cutover there is never one to find, so every
 * sensitive table on every modern project drew that finding, and the
 * recommendation pointed at an executor that cannot produce the row.
 *
 * The question it was reaching for is answerable, just from somewhere else. A
 * sensitive table is dangerous when it is REACHABLE and NOT RLS-protected —
 * `authRequired` never decided that, because every /db/* request is
 * authenticated and RLS is what chooses the rows. The catalog carries both
 * facts, so this now asks them directly:
 *
 *   not exposed                 → no finding; unreachable data is not exposed data
 *   exposed with RLS            → no finding; the policy decides the rows
 *   exposed without RLS         → HIGH; every authenticated caller reads every row
 */
function auditTableAuthCoverage(
  tables: Array<{ name: string }>,
  exposed: Array<{ name: string; rlsEnabled: boolean }>,
): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  const SENSITIVE_TABLE_PATTERNS = [
    /^users?$/, /^accounts?$/, /^payments?$/, /^orders?$/,
    /^wallets?$/, /^credits?$/, /^subscriptions?$/, /^invoices?$/,
    /^secrets?$/, /^tokens?$/, /^sessions?$/, /^api_keys?$/,
  ]

  const exposedByName = new Map(exposed.map(t => [t.name.toLowerCase(), t]))

  for (const table of tables) {
    if (!SENSITIVE_TABLE_PATTERNS.some(p => p.test(table.name))) continue

    const live = exposedByName.get(table.name.toLowerCase())
    if (!live) continue // not reachable over REST — nothing to protect here

    if (!live.rlsEnabled) {
      findings.push({
        severity: 'high',
        category: 'Sensitive Table Without RLS',
        location: `REST /db/${table.name}`,
        description:
          `Sensitive table "${table.name}" is reachable over the REST API with row-level ` +
          `security disabled. Every authenticated caller can read and write every row, ` +
          `including rows belonging to other users.`,
        recommendation:
          `Enable RLS on "${table.name}" and install an ownership policy. Under PostgREST ` +
          `RLS is the only thing standing between one caller and another caller's rows.`,
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
