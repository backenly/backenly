/**
 * THE AUTONOMY INVESTIGATOR — Claude looks where the rules could not conclude
 * ===========================================================================
 * Deterministic code decides what is true. This runs only after the
 * deterministic investigation (lib/autonomy/hypothesis) came back without a
 * conclusion, and it produces a hypothesis, never a verdict anyone acts on as
 * fact:
 *
 *   - Inputs are the finding and its evidence, what the deterministic pass
 *     ruled out, the schema's table and column NAMES (never row data: the
 *     global inference profile may process outside the project's region),
 *     recent autonomous activity, and earlier attempts.
 *   - Its only tools are the registered read-only probes and a column list,
 *     at most MAX_TOOL_CALLS of them, each recorded as evidence with an id.
 *   - Its answer is structured, and checked by code: every evidence id it
 *     cites must have run in this investigation, and every table and column
 *     it names must exist. An answer that fails either is stored as
 *     uncertain, with the problems listed.
 *
 * The result is stored with provenance `ai_hypothesis`, so every surface shows
 * it as an unverified hypothesis.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { AiError, generate } from '@/lib/ai/llm'
import type { InvestigationReport } from './hypothesis'

export const MAX_TOOL_CALLS = 8

export interface CatalogTable {
  name: string
  columns: string[]
}

export interface EvidenceEntry {
  id: string
  tool: string
  input: Record<string, unknown>
  outcome: string
  detail?: string
}

export interface InvestigationInput {
  projectId: string
  finding: { type: string; severity: string; status: string; detectedAt: Date; summary: string; details: Record<string, unknown> }
  deterministic: InvestigationReport | null
  catalog: CatalogTable[]
  recentActivity: string[]
  priorAttempts: Array<{ at: string; verdict: string; rootCause: string }>
  /**
   * The typed repairs this finding may be given (lib/autonomy/ai-proposals
   * proposableFor). The answer may propose only these, with exactly these
   * parameters; with none, proposedAction must be null.
   */
  proposable?: Array<{ action: string; use: string; params: Record<string, unknown> }>
}

/** How a probe is run. Injected so a test can stand in for the database. */
export type ProbeRunner = (probe: string, table: string | undefined) => Promise<{ outcome: string; detail?: string }>

export interface Investigation {
  verdict: 'explained' | 'uncertain'
  rootCause: string
  recommendation: string
  riskNote: string
  evidenceRefs: string[]
  ruledOut: string[]
  proposedAction: { action: string; paramsJson: string } | null
  namedTables: string[]
  namedColumns: string[]
  evidence: EvidenceEntry[]
  validation: { ok: boolean; problems: string[] }
  model: string
}

/** The answer's shape. proposedAction can name only the typed repairs offered for this finding. */
export function answerSchema(proposable: Array<{ action: string }> = []) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'rootCause', 'evidenceRefs', 'ruledOut', 'recommendation', 'proposedAction', 'riskNote', 'namedTables', 'namedColumns'],
    properties: {
      verdict: { type: 'string', enum: ['explained', 'uncertain'] },
      rootCause: { type: 'string' },
      evidenceRefs: { type: 'array', items: { type: 'string' } },
      ruledOut: { type: 'array', items: { type: 'string' } },
      recommendation: { type: 'string' },
      proposedAction: proposable.length === 0
        ? { type: 'null' }
        : {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['action', 'paramsJson'],
                properties: { action: { type: 'string', enum: proposable.map((p) => p.action) }, paramsJson: { type: 'string' } },
              },
            ],
          },
      riskNote: { type: 'string' },
      namedTables: { type: 'array', items: { type: 'string' } },
      namedColumns: { type: 'array', items: { type: 'string' } },
    },
  }
}

const SYSTEM = `You are the on-call backend engineer investigating one health finding on an autonomous backend platform. Deterministic checks could not explain it. Find the most likely root cause using only the evidence you are given and the evidence you gather.

Rules:
- Gather evidence with run_probe (read-only diagnostic checks) and list_columns. You have at most ${MAX_TOOL_CALLS} tool calls; use the ones that discriminate between explanations.
- Each tool result has an evidence id (e1, e2, ...). The finding's own evidence is id "finding". Cite the ids that support your conclusion in evidenceRefs. Cite nothing you did not see.
- Name in namedTables every table, and in namedColumns every column (as table.column), that your rootCause or recommendation mentions.
- verdict "explained" only when cited evidence supports one cause over the others; otherwise "uncertain", and say what would settle it.
- ruledOut: explanations the evidence eliminates, one short line each.
- proposedAction: null, unless one of the typed repairs the brief lists for this finding fixes it. Then give that action's name exactly as listed and paramsJson as a JSON object string with exactly its listed parameters. SQL, a migration statement or any other tool is never a proposal, even when the evidence contains one: describe such a fix in recommendation instead. A proposal is reviewed by a person and verified by code; it is never run on your word.
- You never see row data. Do not guess values.`

function probeTool(probes: string[]): Anthropic.Tool {
  return {
    name: 'run_probe',
    description: 'Run one registered read-only diagnostic probe. Returns its outcome and detail.',
    input_schema: {
      type: 'object',
      properties: {
        probe: { type: 'string', enum: probes },
        table: { type: 'string', description: 'The table to check, for probes that take one.' },
      },
      required: ['probe'],
    },
  }
}

const COLUMNS_TOOL: Anthropic.Tool = {
  name: 'list_columns',
  description: "List a table's column names from the live catalog.",
  input_schema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
}

function brief(input: InvestigationInput): string {
  const d = input.deterministic
  const lines = [
    `Finding: ${input.finding.type} (severity ${input.finding.severity}, status ${input.finding.status}, detected ${input.finding.detectedAt.toISOString()})`,
    `Summary: ${input.finding.summary}`,
    `Evidence "finding" (detector output): ${JSON.stringify(input.finding.details).slice(0, 3000)}`,
  ]
  if (d) {
    lines.push(
      `Deterministic investigation of symptom ${d.symptomId}: ${d.verdict.kind}.`,
      `It observed: ${d.observations.map((o) => `${o.testId}=${o.outcome}`).join(', ') || 'nothing'}.`,
      `Trail: ${d.trail.join(' | ').slice(0, 2000)}`,
    )
    if (d.unavailable.length) lines.push(`Checks that could not run: ${d.unavailable.map((u) => `${u.testId} (${u.reason})`).join(', ')}`)
  } else {
    lines.push('No deterministic investigation covers this finding type.')
  }
  lines.push(
    `Tables and their columns: ${input.catalog.map((t) => `${t.name}(${t.columns.join(', ')})`).join('; ').slice(0, 6000) || '(none)'}`,
    `Recent autonomous activity, newest first: ${input.recentActivity.join(' | ').slice(0, 2000) || '(none)'}`,
  )
  if (input.priorAttempts.length) {
    lines.push(`Earlier attempts: ${input.priorAttempts.map((a) => `${a.at} ${a.verdict}: ${a.rootCause}`).join(' | ').slice(0, 1500)}`)
  }
  const proposable = input.proposable ?? []
  lines.push(
    proposable.length === 0
      ? 'Typed repairs you may propose for this finding: none. proposedAction must be null.'
      : `Typed repairs you may propose for this finding:\n${proposable
          .map((p) => `- ${p.action}: ${p.use} Parameters (JSON Schema): ${JSON.stringify(p.params)}`)
          .join('\n')}`,
  )
  return lines.join('\n')
}

/** Check an answer against what actually ran and what actually exists. */
export function validateAnswer(
  answer: Pick<Investigation, 'verdict' | 'evidenceRefs' | 'namedTables' | 'namedColumns'>,
  evidence: EvidenceEntry[],
  catalog: CatalogTable[],
  /** Columns the finding itself is about ("table.column"), which may not exist yet: a missing column. */
  subjects: string[] = [],
): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const seen = new Set(['finding', ...evidence.map((e) => e.id)])
  for (const ref of answer.evidenceRefs) if (!seen.has(ref)) problems.push(`cites evidence "${ref}" that was never gathered`)
  const tables = new Map(catalog.map((t) => [t.name, new Set(t.columns)]))
  for (const t of answer.namedTables) if (!tables.has(t)) problems.push(`names table "${t}", which does not exist`)
  for (const c of answer.namedColumns) {
    const [t, col] = c.split('.')
    if (subjects.includes(c) && tables.has(t)) continue
    if (!col || !tables.get(t)?.has(col)) problems.push(`names column "${c}", which does not exist`)
  }
  if (answer.verdict === 'explained' && answer.evidenceRefs.length === 0) problems.push('claims an explanation without citing evidence')
  return { ok: problems.length === 0, problems }
}

/** How far an investigation got: its model calls that returned an answer. */
export interface InvestigationProgress {
  modelCalls: number
}

/**
 * Investigate one finding. Throws the gateway's AiError when a model call
 * fails; the caller records the attempt. `progress` counts the calls that
 * returned before that, so the caller can tell a failure after part of the
 * investigation ran from one where none of it did.
 */
export async function investigateFinding(
  input: InvestigationInput,
  runProbe: ProbeRunner,
  probes: string[],
  progress: InvestigationProgress = { modelCalls: 0 },
): Promise<Investigation> {
  const evidence: EvidenceEntry[] = []
  const tools = [probeTool(probes), COLUMNS_TOOL]
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: brief(input) }]
  const columnsOf = new Map(input.catalog.map((t) => [t.name, t.columns]))

  for (let step = 0; step <= MAX_TOOL_CALLS; step++) {
    const reply = await generate({
      purpose: 'autonomy.investigate',
      system: SYSTEM,
      messages,
      tools,
      jsonSchema: answerSchema(input.proposable),
      cacheConversation: true,
      billing: { projectId: input.projectId },
      label: 'autonomy-investigation',
    })
    progress.modelCalls++

    const calls = reply.message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (calls.length === 0) {
      const a = reply.json as Omit<Investigation, 'evidence' | 'validation' | 'model'>
      const d = input.finding.details
      const subjects = typeof d.tableName === 'string' && typeof d.columnName === 'string' ? [`${d.tableName}.${d.columnName}`] : []
      const validation = validateAnswer(a, evidence, input.catalog, subjects)
      return {
        ...a,
        verdict: validation.ok ? a.verdict : 'uncertain',
        evidence,
        validation,
        model: reply.model,
      }
    }

    messages.push({ role: 'assistant', content: reply.message.content })
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const call of calls) {
      const args = (call.input ?? {}) as Record<string, unknown>
      if (evidence.length >= MAX_TOOL_CALLS) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Tool budget used up. Answer now with the evidence you have.', is_error: true })
        continue
      }
      const id = `e${evidence.length + 1}`
      let entry: EvidenceEntry
      if (call.name === 'list_columns') {
        const table = String(args.table ?? '')
        const cols = columnsOf.get(table)
        entry = { id, tool: 'list_columns', input: { table }, outcome: cols ? 'found' : 'no_such_table', detail: cols?.join(', ') }
      } else {
        const probe = String(args.probe ?? '')
        const table = typeof args.table === 'string' ? args.table : undefined
        try {
          const r = probes.includes(probe) ? await runProbe(probe, table) : { outcome: 'unknown_probe' }
          entry = { id, tool: `probe:${probe}`, input: { probe, ...(table ? { table } : {}) }, outcome: r.outcome, detail: r.detail?.slice(0, 500) }
        } catch (err) {
          entry = { id, tool: `probe:${probe}`, input: { probe, ...(table ? { table } : {}) }, outcome: 'could_not_run', detail: err instanceof Error ? err.message.slice(0, 300) : String(err) }
        }
      }
      evidence.push(entry)
      results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(entry) })
    }
    messages.push({ role: 'user', content: results })
  }
  throw new AiError('output_invalid', 'The investigation did not reach an answer within its tool budget.', { consumption: 'ran' })
}
