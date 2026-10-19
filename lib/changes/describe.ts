/**
 * A change in one plain sentence, for people.
 *
 *   Created table refunds
 *   Added column status to orders
 *   Renamed orders.note to internal_note
 *   Created refunds and changed orders
 *
 * Built from the change's footprint, what it actually did, never from its
 * title, which is whatever the caller sent (often a raw statement).
 *
 * Pure and dependency-free: the console renders it in the browser as well.
 */

import type { TableChange } from './types'

const NOUN: Record<string, string> = {
  view: 'view',
  materialized_view: 'materialized view',
  function: 'function',
  type: 'type',
}

/**
 * The functions Backenly installs beside a project's tables: the updatedAt
 * stamp and the end-user claim reader every policy calls. They arrive with a
 * project's first table and are plumbing, not what anyone asked for, so the
 * summary leaves them out; View details lists them with the rest.
 */
const isPlatformHelper = (c: TableChange) => c.object === 'function' && /^(?:backenly_|set_updated_at\()/.test(nameOf(c))

export function describeChange(footprint: TableChange[]): string {
  if (footprint.length === 0) return 'Changed nothing'
  const asked = footprint.some((c) => !isPlatformHelper(c)) ? footprint.filter((c) => !isPlatformHelper(c)) : footprint
  if (asked.length === 1) return describeOne(asked[0])
  const tables = asked.filter((c) => !c.object)
  const objects = asked.filter((c) => !!c.object)
  const groups: Array<[string, string[]]> = [
    ['created', names(tables, 'added')],
    ['changed', names(tables, 'modified')],
    ['dropped', names(tables, 'removed')],
    ['recreated', names(tables, 'replaced')],
  ]
  const parts = groups.filter(([, n]) => n.length > 0).map(([verb, n]) => `${verb} ${list(n)}`)
  if (objects.length > 0) {
    parts.push(objects.length === 1 ? `${verbFor(objects[0])} ${NOUN[objects[0].object!]} ${nameOf(objects[0])}` : `changed ${objects.length} views, functions or types`)
  }
  return capitalize(joinAnd(parts))
}

function describeOne(c: TableChange): string {
  const name = nameOf(c)
  if (c.object) return capitalize(`${verbFor(c)} ${NOUN[c.object]} ${name}`)
  if (c.kind === 'added') return `Created table ${name}`
  if (c.kind === 'removed') return `Dropped table ${name}`
  if (c.kind === 'replaced') return `Recreated table ${name}`
  const facts = factsOf(c)
  if (facts.length === 0) return `Changed ${name}`
  if (facts.length === 1) return facts[0].full
  const shown = facts.slice(0, 2).map((f) => f.short)
  const more = facts.length - shown.length
  return `Changed ${name}: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}

interface Fact {
  /** For a list: "added status". */
  short: string
  /** On its own: "Added column status to orders". */
  full: string
}

function factsOf(c: TableChange): Fact[] {
  const t = nameOf(c)
  const added: string[] = []
  const removed: string[] = []
  const renamed: Array<[string, string]> = []
  const retyped: string[] = []
  const required: string[] = []
  const optional: string[] = []
  const defaults: string[] = []
  const rewritten: string[] = []
  const counts = { index: [0, 0, 0], constraint: [0, 0, 0], policy: 0, trigger: 0 }
  let renamedFrom: string | null = null
  let rls: 'on' | 'off' | 'changed' | null = null
  let other = 0
  const sign = (s: string) => (s === '+' ? 0 : s === '−' ? 1 : 2)

  for (const line of c.details) {
    let m: RegExpExecArray | null
    if ((m = /^table renamed from (.+)$/.exec(line))) renamedFrom = m[1]
    else if ((m = /^\+ column (\S+)/.exec(line))) added.push(m[1])
    else if ((m = /^− column (\S+)/.exec(line))) removed.push(m[1])
    else if ((m = /^column (\S+) renamed to (\S+)$/.exec(line))) renamed.push([m[1], m[2]])
    else if ((m = /^~ column (\S+): now NOT NULL$/.exec(line))) required.push(m[1])
    else if ((m = /^~ column (\S+): now nullable$/.exec(line))) optional.push(m[1])
    else if ((m = /^~ column (\S+): default /.exec(line))) defaults.push(m[1])
    else if ((m = /^~ column (\S+): (?!identity|generation)(.+) → /.exec(line))) retyped.push(m[1])
    else if ((m = /^values rewritten in (.+)$/.exec(line))) rewritten.push(...m[1].split(', '))
    else if ((m = /^([+−~]) index /.exec(line))) counts.index[sign(m[1])]++
    else if ((m = /^([+−~]) (primary key|unique|check|foreign key|exclusion|constraint) /.exec(line))) counts.constraint[sign(m[1])]++
    else if (/^[+−~] policy /.test(line)) counts.policy++
    else if (/^[+−~] trigger /.test(line)) counts.trigger++
    else if ((m = /^row-level security (enabled|disabled)$/.exec(line))) rls = m[1] === 'enabled' ? 'on' : 'off'
    else if (/^row-level security/.test(line)) rls = rls ?? 'changed'
    else other++
  }

  const facts: Fact[] = []
  if (renamedFrom) facts.push({ short: `renamed from ${renamedFrom}`, full: `Renamed table ${renamedFrom} to ${t}` })
  if (added.length) facts.push({ short: `added ${columns(added)}`, full: `Added ${columns(added)} to ${t}` })
  if (removed.length) facts.push({ short: `removed ${columns(removed)}`, full: `Removed ${columns(removed)} from ${t}` })
  if (renamed.length === 1) facts.push({ short: `renamed ${renamed[0][0]} to ${renamed[0][1]}`, full: `Renamed ${t}.${renamed[0][0]} to ${renamed[0][1]}` })
  else if (renamed.length > 1) facts.push({ short: `renamed ${renamed.length} columns`, full: `Renamed ${renamed.length} columns in ${t}` })
  if (retyped.length) facts.push({ short: `changed the type of ${list(retyped)}`, full: `Changed the type of ${t}.${list(retyped)}` })
  if (rewritten.length) facts.push({ short: `rewrote ${list(rewritten)}`, full: `Rewrote the values of ${t}.${list(rewritten)}` })
  if (required.length) facts.push({ short: `made ${list(required)} required`, full: `Made ${t}.${list(required)} required` })
  if (optional.length) facts.push({ short: `made ${list(optional)} optional`, full: `Made ${t}.${list(optional)} optional` })
  if (defaults.length) facts.push({ short: `changed the default of ${list(defaults)}`, full: `Changed the default of ${t}.${list(defaults)}` })
  pushCounted(facts, counts.index, 'an index', 'indexes', t)
  pushCounted(facts, counts.constraint, 'a constraint', 'constraints', t)
  if (counts.policy) facts.push({ short: 'changed its access policies', full: `Changed the access policies on ${t}` })
  if (counts.trigger) facts.push({ short: 'changed its triggers', full: `Changed the triggers on ${t}` })
  if (rls === 'on') facts.push({ short: 'turned on row-level security', full: `Turned on row-level security for ${t}` })
  else if (rls === 'off') facts.push({ short: 'turned off row-level security', full: `Turned off row-level security for ${t}` })
  else if (rls === 'changed') facts.push({ short: 'changed row-level security', full: `Changed row-level security for ${t}` })
  if (facts.length === 0 && other > 0) facts.push({ short: 'changed it', full: `Changed ${t}` })
  return facts
}

function pushCounted(facts: Fact[], [added, removed, changed]: number[], one: string, many: string, t: string) {
  const what = (n: number) => (n === 1 ? one : `${n} ${many}`)
  if (added) facts.push({ short: `added ${what(added)}`, full: `Added ${what(added)} to ${t}` })
  if (removed) facts.push({ short: `removed ${what(removed)}`, full: `Removed ${what(removed)} from ${t}` })
  if (changed) facts.push({ short: `changed ${what(changed)}`, full: `Changed ${what(changed)} on ${t}` })
}

function columns(names: string[]): string {
  if (names.length === 1) return `column ${names[0]}`
  if (names.length <= 3) return `columns ${joinAnd(names)}`
  return `${names.length} columns`
}

function names(entries: TableChange[], kind: TableChange['kind']): string[] {
  return entries.filter((c) => c.kind === kind).map(nameOf)
}

function nameOf(c: TableChange): string {
  return c.after ?? c.before ?? 'a table'
}

function verbFor(c: TableChange): string {
  return c.kind === 'added' ? 'created' : c.kind === 'removed' ? 'removed' : 'changed'
}

function list(items: string[]): string {
  if (items.length <= 2) return joinAnd(items)
  return `${items[0]}, ${items[1]} and ${items.length - 2} more`
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
