// lib/ai/agents/security-agent.ts
/** Security specialist agent: detects RLS gaps, auth gaps, and LLM-identified vulnerabilities in workspace schemas. */

import { Pool } from 'pg'
import OpenAI from 'openai'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import type { AgentInput, AgentResult, AgentFinding } from './types'

function makeId(): string {
  return `finding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

const SENSITIVE_TABLE_PATTERNS = [
  'users', 'payments', 'orders', 'sessions', 'tokens',
  'credentials', 'secrets',
]

function isSensitiveTable(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE_TABLE_PATTERNS.some(p => lower === p || lower.endsWith(`_${p}`) || lower.startsWith(`${p}_`))
}

export async function runSecurityAgent(input: AgentInput): Promise<AgentResult> {
  const start = Date.now()
  const findings: AgentFinding[] = []
  const autoFixed: string[] = []

  const { projectId, tables, schemaContext } = input

  if (tables.length === 0) {
    return { agentType: 'security', durationMs: Date.now() - start, findings, autoFixed, skipped: true }
  }

  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    // ── 1. Discover tables via information_schema ──────────────────────────
    let liveTables: string[] = []
    try {
      const res = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        [postgresSchema],
      )
      liveTables = res.rows.map(r => r.table_name)
    } catch {
      liveTables = tables
    }

    // ── 2. Find RLS-enabled tables via pg_policies ─────────────────────────
    let rlsTables = new Set<string>()
    try {
      const res = await pool.query<{ tablename: string }>(
        `SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = $1`,
        [postgresSchema],
      )
      rlsTables = new Set(res.rows.map(r => r.tablename))
    } catch {
      // pg_policies may not be accessible — continue without RLS info
    }

    // ── 3. Flag sensitive tables missing RLS ──────────────────────────────
    for (const tbl of liveTables) {
      if (isSensitiveTable(tbl) && !rlsTables.has(tbl)) {
        findings.push({
          id: makeId(),
          agentType: 'security',
          category: 'missing_rls',
          severity: 'critical',
          title: `No RLS policy on sensitive table "${tbl}"`,
          description: `Table "${tbl}" contains sensitive data but has no Row-Level Security policies. Any authenticated user can read all rows.`,
          location: tbl,
          fix: {
            description: `Enable RLS and add a policy restricting access to the row owner on "${tbl}".`,
            executorAction: 'SET_PERMISSION',
            executorParams: { tableName: tbl, policy: 'owner_only' },
            reversible: true,
            requiresApproval: true,
          },
        })
      }
    }

    // ── 4. Auth gap: many tables, no auth-related table ───────────────────
    if (tables.length > 3) {
      const authTableNames = ['users', 'sessions', 'tokens']
      const hasAuthTable = liveTables.some(t =>
        authTableNames.some(a => t.toLowerCase() === a || t.toLowerCase().startsWith(`${a}_`)),
      )
      if (!hasAuthTable) {
        findings.push({
          id: makeId(),
          agentType: 'security',
          category: 'auth_gap',
          severity: 'high',
          title: 'No authentication table detected',
          description: `Your project has ${tables.length} tables but no users/sessions/tokens table. End-users have no way to authenticate.`,
          location: 'auth',
          fix: {
            description: 'Create a users table with email + password_hash and enable the auth system.',
            executorAction: 'CREATE_TABLE',
            executorParams: { tableName: 'users', withAuth: true },
            reversible: false,
            requiresApproval: true,
          },
        })
      }
    }

    // ── 5. LLM deep-dive for injection risk, weak FK constraints, etc. ────
    if (liveTables.length > 0) {
      try {
        const openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY,
          timeout: 25_000,
          maxRetries: 1,
        })
        const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'

        const contextBlock = schemaContext
          ? `\nSchema DDL:\n${schemaContext}\n`
          : `\nTables: ${liveTables.join(', ')}\n`

        const completion = await openai.chat.completions.create({
          model,
          max_tokens: 800,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content:
                'You are a PostgreSQL security auditor for a Backend-as-a-Service platform. ' +
                'Identify concrete security risks: SQL injection vectors, missing input validation, ' +
                'weak FK constraints that allow orphan data, predictable ID patterns, or sensitive ' +
                'columns stored in plaintext. Return a JSON array of findings, each with: ' +
                '{ title, description, location, severity ("critical"|"high"|"medium"|"low"), category }. ' +
                'Return ONLY the JSON array, no prose.',
            },
            {
              role: 'user',
              content: `Audit this workspace schema for security issues.${contextBlock}`,
            },
          ],
        })

        const raw = completion.choices[0]?.message?.content?.trim() ?? '[]'
        // Strip markdown fences if present
        const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        let llmFindings: Array<{
          title: string
          description: string
          location: string
          severity: string
          category: string
        }> = []
        try {
          llmFindings = JSON.parse(jsonText)
          if (!Array.isArray(llmFindings)) llmFindings = []
        } catch {
          llmFindings = []
        }

        const validSeverities = new Set(['critical', 'high', 'medium', 'low'])
        for (const lf of llmFindings) {
          const severity = validSeverities.has(lf.severity)
            ? (lf.severity as AgentFinding['severity'])
            : 'medium'
          findings.push({
            id: makeId(),
            agentType: 'security',
            category: lf.category ?? 'llm_finding',
            severity,
            title: String(lf.title ?? 'Security finding'),
            description: String(lf.description ?? ''),
            location: String(lf.location ?? 'schema'),
          })
        }
      } catch {
        // LLM step is non-fatal
      }
    }
  } catch {
    // Top-level guard — never throw
  } finally {
    try { await pool.end() } catch { /* ignore */ }
  }

  // Sort by severity
  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))

  return {
    agentType: 'security',
    durationMs: Date.now() - start,
    findings,
    autoFixed,
    skipped: false,
  }
}
