/**
 * The parts of the agent docs that are facts about code, rendered from it.
 *
 * Which actions a section tool has, what each needs, whether a read-only key
 * may use it and whether it waits for a human: every one of these drifted in
 * hand-written prose at least once. So they are not written by hand. The docs
 * carry them between markers, scripts/generate-agent-docs.ts writes them, and
 * tests/unit/agent-docs-conformance.spec.ts fails when the committed text is
 * not what these functions produce.
 */

import { DOMAIN_TOOLS, actionRequires, needsApproval, readOnlyView, type DomainTool } from './domains'
import { AGENT_DOCS_URL, AGENT_DOC_TOPICS } from './agent-docs'

export const GENERATED_BEGIN = (name: string) =>
  `<!-- generated:${name} by scripts/generate-agent-docs.ts from lib/mcp/domains.ts; do not edit -->`
export const GENERATED_END = '<!-- end generated -->'

const code = (s: string) => `\`${s}\``
const cell = (s: string) => s.replace(/\|/g, '\\|')

/** One row per section tool, for the index: every action, and which wait for a human. */
export function renderSectionToolsTable(): string {
  const rows = DOMAIN_TOOLS.map((d) => {
    const actions = Object.keys(d.actions)
    const open = actions.filter((a) => !needsApproval(d.actions[a].tool))
    const gated = actions.filter((a) => needsApproval(d.actions[a].tool))
    const list = open.map(code).join(', ') +
      (gated.length ? `; ${gated.map(code).join(', ')} ${gated.length === 1 ? 'waits' : 'wait'} for approval` : '')
    const topic = AGENT_DOC_TOPICS.find((t) => t.domain === d.name)
    return `| ${code(d.name)} | ${list} | ${topic ? `${AGENT_DOCS_URL}/${topic.id}.md` : ''} |`
  })
  return ['| Tool | Actions | Docs |', '| --- | --- | --- |', ...rows].join('\n')
}

/** Every action of one section tool: what it does, what it needs, who may run it. */
export function renderDomainActionsTable(domain: DomainTool): string {
  const reads = new Set(Object.keys(readOnlyView(domain)?.actions ?? {}))
  const rows = Object.entries(domain.actions).map(([action, { tool, gloss }]) => {
    const needs = actionRequires(tool)
    return `| ${code(action)} | ${cell(gloss)} | ${needs.length ? needs.map(code).join(', ') : 'nothing'} | ` +
      `${reads.has(action) ? 'yes' : 'no'} | ${needsApproval(tool) ? 'waits for a human' : 'no'} |`
  })
  return [
    `Call as \`${domain.name} { action: "<action>", … }\`.`,
    '',
    '| Action | What it does | Needs | Read-only key | Approval |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}

export interface GeneratedBlock {
  /** public/-relative file. */
  file: string
  name: string
  content: string
}

/** Every generated block in the docs, with the text it must hold. */
export function generatedBlocks(): GeneratedBlock[] {
  const out: GeneratedBlock[] = [{ file: 'llms.txt', name: 'section-tools', content: renderSectionToolsTable() }]
  for (const topic of AGENT_DOC_TOPICS) {
    if (!topic.domain) continue
    const domain = DOMAIN_TOOLS.find((d) => d.name === topic.domain)
    if (!domain) throw new Error(`Docs topic ${topic.id} names domain ${topic.domain}, which does not exist`)
    out.push({ file: `docs/agents/${topic.id}.md`, name: `actions:${domain.name}`, content: renderDomainActionsTable(domain) })
  }
  return out
}

/** `text` with the named block replaced by `content`; throws when the markers are missing. */
export function replaceGeneratedBlock(text: string, name: string, content: string): string {
  const begin = GENERATED_BEGIN(name)
  const start = text.indexOf(begin)
  const end = start === -1 ? -1 : text.indexOf(GENERATED_END, start)
  if (start === -1 || end === -1) throw new Error(`missing generated block "${name}"`)
  return text.slice(0, start) + `${begin}\n${content}\n` + text.slice(end)
}

/** The content currently between a block's markers, or null when they are missing. */
export function readGeneratedBlock(text: string, name: string): string | null {
  const begin = GENERATED_BEGIN(name)
  const start = text.indexOf(begin)
  const end = start === -1 ? -1 : text.indexOf(GENERATED_END, start)
  if (start === -1 || end === -1) return null
  return text.slice(start + begin.length + 1, end).replace(/\n$/, '')
}
