/**
 * Firestore security rules, read so a person can see them beside each table.
 *
 * They are never translated or applied. Every imported table starts closed:
 * only the project's server key reads or writes it, until the person approves
 * a rule for it (spec: access rules are never applied automatically). What is
 * read here is the text of the released ruleset (Firebase Rules API), and for
 * each table the `match` block that covers its collection, when one can be
 * found, so the approval is made with the old rule in view. Reading the rules
 * needs the Firebase Rules Viewer role; without it the definition is simply
 * unknown.
 */

import { GoogleApiError, type GoogleClient } from '../google-http'
import type { ImportPreviewRule } from '../contract'

const RULES = 'https://firebaserules.googleapis.com/v1'
const MAX_BLOCK = 2000

/** The released Firestore rules' source, or null when they cannot be read. */
export async function readFirestoreRules(client: GoogleClient, projectId: string): Promise<string | null> {
  try {
    const release = await client.json<{ rulesetName?: string }>(
      'rules', 'firebase', 'GET',
      `${RULES}/projects/${encodeURIComponent(projectId)}/releases/cloud.firestore`,
    )
    const name = release?.rulesetName
    if (typeof name !== 'string' || !/^projects\/[^/]+\/rulesets\/[A-Za-z0-9_-]+$/.test(name)) return null
    const ruleset = await client.json<{ source?: { files?: Array<{ content?: string }> } }>(
      'rules', 'firebase', 'GET',
      `${RULES}/${name.split('/').map(encodeURIComponent).join('/')}`,
    )
    const text = (ruleset?.source?.files ?? []).map((f) => f.content ?? '').join('\n').trim()
    return text || null
  } catch (err) {
    if (err instanceof GoogleApiError) return null
    throw err
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The `{ … }` block that starts at `open` (the index of its brace), braces in strings and comments ignored. */
function blockFrom(source: string, open: number): string | null {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const c = source[i]
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      if (nl === -1) return null
      i = nl
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) return null
      i = end + 1
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1
      i = j
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return null
}

/** The first `match /<path>` in `source` with its block, as written. */
function findMatch(source: string, pathRe: string): { text: string; block: string } | null {
  const m = new RegExp(`match\\s+${pathRe}\\s*\\{`).exec(source)
  if (!m) return null
  const open = m.index + m[0].length - 1
  const block = blockFrom(source, open)
  if (!block) return null
  return { text: `${m[0].slice(0, -1).trimEnd()} ${block}`, block: block.slice(1, -1) }
}

const WILDCARD = '\\{[^}/]+\\}'

/**
 * The rule text that covers one collection pattern (posts, posts/*\/comments),
 * written either nested (`match /posts/{id} { match /comments/{c} … }`) or as
 * one path (`match /posts/{id}/comments/{c}`). Null when none is found.
 */
export function rulesForPattern(source: string | null, pattern: string): string | null {
  if (!source) return null
  const ids = pattern.split('/*/')
  // One path for the whole pattern.
  const full = ids.map((id) => `/${escapeRe(id)}/${WILDCARD}`).join('')
  const direct = findMatch(source, full)
  if (direct) return cap(direct.text)
  // Nested: each level looked for only inside the block of the one before.
  let scope = source
  let found: { text: string; block: string } | null = null
  for (const id of ids) {
    found = findMatch(scope, `/${escapeRe(id)}/${WILDCARD}`)
    if (!found) return null
    scope = found.block
  }
  return found ? cap(found.text) : null
}

function cap(text: string): string {
  const t = text.trim()
  return t.length > MAX_BLOCK ? `${t.slice(0, MAX_BLOCK - 1)}…` : t
}

/** One rule entry per table: what waits for the person's approval. */
export function pendingRules(tables: Array<{ name: string; pattern: string }>, source: string | null): ImportPreviewRule[] {
  return tables.map((t) => ({
    table: t.name,
    summary: `Waits for your approval. Firestore rules aren't translated, so until you approve a rule only your server key can read or write ${t.name}.`,
    definition: rulesForPattern(source, t.pattern),
  }))
}
