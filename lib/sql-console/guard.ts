/**
 * Read-only SQL console guard — pure validation, no database.
 *
 * Backenly's line: governed READS are fine, ungoverned WRITES never were.
 * This guard admits a single SELECT / WITH / EXPLAIN statement scoped to the
 * project's workspace schema and refuses everything else with a *useful*
 * refusal — a write attempt is converted into a suggestion to run it as a
 * governed change instead of a bare error.
 *
 * Defense in depth (this file is layer 1 of 3):
 *   1. Statement validation here (shape + schema-qualifier + function deny).
 *   2. The executor runs inside BEGIN READ ONLY — Postgres itself rejects any
 *      write that sneaks past parsing.
 *   3. SET LOCAL search_path pins unqualified names to the workspace schema,
 *      and a row cap bounds result size.
 *
 * The caller is always the authenticated project owner — this protects the
 * platform's shared schema and the governance model, not tenant-vs-tenant.
 */

export type SqlVerdict =
  | { ok: true; kind: 'select' | 'explain'; sql: string }
  | { ok: false; kind: 'write' | 'multi' | 'denied' | 'not_select' | 'empty'; reason: string; suggestion?: string }

const WRITE_STARTERS = /^(insert|update|delete|merge|truncate|alter|drop|create|grant|revoke|vacuum|analyze|reindex|cluster|comment|copy|call|do|set|reset|begin|commit|rollback|savepoint|lock|listen|notify|refresh|security|import)\b/

/** Schema qualifiers + catalog/file/system functions that must never appear. */
const DENY_RE = new RegExp(
  [
    // Cross-schema qualifiers — the console is workspace-scoped.
    String.raw`\bpublic\s*\.`,
    String.raw`\bpg_catalog\s*\.`,
    String.raw`\binformation_schema\s*\.`,
    String.raw`\bpg_temp\w*\s*\.`,
    String.raw`\bworkspace_(?!__SELF__)[0-9a-f-]+\s*\.`, // another project's workspace (self is substituted in)
    // Identity/GUC tampering and reading.
    String.raw`\bset_config\s*\(`,
    String.raw`\bcurrent_setting\s*\(`,
    // File/system/loopback access.
    String.raw`\bpg_read_(binary_)?file\s*\(`,
    String.raw`\bpg_ls_dir\s*\(`,
    String.raw`\blo_(im|ex)port\s*\(`,
    String.raw`\bdblink`,
    String.raw`\bpg_sleep\s*\(`,
  ].join('|'),
  'i',
)

/**
 * Strip comments and string literals so the deny-scan can't be fooled by (or
 * false-positive on) data. Literals are replaced by '', identifiers survive.
 */
export function normalizeSql(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    // line comment
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    // block comment (nested per pg)
    if (ch === '/' && next === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; continue }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; continue }
        i++
      }
      out += ' '
      continue
    }
    // single-quoted literal ('' escapes)
    if (ch === "'") {
      i++
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue }
        if (sql[i] === "'") { i++; break }
        i++
      }
      out += "''"
      continue
    }
    // dollar-quoted literal ($tag$ … $tag$)
    if (ch === '$') {
      const m = sql.slice(i).match(/^\$[a-zA-Z_]*\$/)
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        i = end === -1 ? n : end + tag.length
        out += "''"
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

export function validateConsoleSql(rawSql: string, projectId: string): SqlVerdict {
  const raw = (rawSql ?? '').trim().replace(/;\s*$/, '')
  if (!raw) return { ok: false, kind: 'empty', reason: 'Empty query.' }

  const normalized = normalizeSql(raw)

  // Single statement only.
  if (normalized.includes(';')) {
    return { ok: false, kind: 'multi', reason: 'One statement at a time — remove the extra semicolons.' }
  }

  const head = normalized.trimStart().toLowerCase()

  if (WRITE_STARTERS.test(head)) {
    const verb = head.match(WRITE_STARTERS)?.[1] ?? 'that'
    return {
      ok: false,
      kind: 'write',
      reason: `This console is read-only — ${verb.toUpperCase()} is a backend change, and backend changes go through Backenly's governed path (planned, verified, reversible).`,
      suggestion:
        `Describe the change instead — in the dashboard chat, over MCP backend_chat, or paste this statement there ` +
        `and Backenly will turn it into a governed change with a restore point.`,
    }
  }

  if (!/^(select|with|explain)\b/.test(head)) {
    return {
      ok: false,
      kind: 'not_select',
      reason: 'Only SELECT, WITH … SELECT, and EXPLAIN are supported here.',
    }
  }

  // EXPLAIN must wrap a read, not a write.
  if (head.startsWith('explain')) {
    const rest = head.replace(/^explain\s*(\((?:[^)]*)\))?\s*/, '')
    if (WRITE_STARTERS.test(rest)) {
      return { ok: false, kind: 'write', reason: 'EXPLAIN over a write statement is still a write plan — reads only.' }
    }
  }

  // Deny-list with this project's own workspace schema allowed. Scan runs on
  // quote-stripped text: literals are already gone after normalizeSql, so any
  // remaining double quotes wrap identifiers — `"public" . "api_keys"` must
  // read as `public . api_keys` or the word-boundary match whiffs.
  const unquoted = normalized.replace(/"([^"]*)"/g, '$1')
  const deny = new RegExp(DENY_RE.source.replace('__SELF__', projectId.replace(/-/g, '\\-')), 'i')
  const hit = unquoted.match(deny)
  if (hit) {
    return {
      ok: false,
      kind: 'denied',
      reason:
        `"${hit[0].trim()}" is outside this console's scope — queries run inside your project's workspace schema only. ` +
        `Table and schema metadata is available via \`backenly schema\`.`,
    }
  }

  return { ok: true, kind: head.startsWith('explain') ? 'explain' : 'select', sql: raw }
}

/*
 * `buildConsoleStatements` lived here and produced the pinned + row-capped
 * statements the console executed on the APP's pool. It was removed on
 * 2026-07-20 when execution moved to lib/mcp/read-query.ts, which runs the
 * statement as the project's SELECT-only `bkn_ro_` role — so the tenant
 * boundary is a Postgres grant rather than this file's deny-list.
 *
 * It is deleted rather than deprecated on purpose. It had its own timeout,
 * search_path pin and LIMIT wrap, all now duplicated in read-query.ts; leaving
 * both would be two definitions of "read-only SQL" free to disagree, and the
 * verifier that exercised it would have gone on proving a path the product no
 * longer runs. This file remains the validation layer (shape, qualifiers,
 * function deny-list) and is still very much on the live path.
 */
