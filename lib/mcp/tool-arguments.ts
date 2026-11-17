/**
 * The arguments an MCP tool call may carry, and the refusal for any other.
 *
 * Every tool in tools/list says `additionalProperties: false`, but only the
 * db_* tools enforced it (lib/mcp/request-body.ts). Every other tool took its
 * arguments as sent, so an argument it does not know was dropped without a
 * word and the call ran as if it had not been there: `get_table_schema
 * { tableName, branchId }` described production's table, and the agent read
 * it as its branch's (production QA re-test, 2026-11-16). lib/mcp/request-body.ts
 * says why refusing beats stripping: a call that ran without part of what was
 * sent returns a plausible wrong answer under a success code.
 *
 * MCP asks the same of servers ("Servers MUST validate all tool inputs",
 * specification 2025-11-25, server/tools), and an input the tool cannot take is
 * a tool execution error, so the agent reads why and corrects the call.
 *
 * What a call may carry is what runs it declares:
 *   • a section tool (auth, storage, …): `action` and the arguments of the brain
 *     tool that action runs, not the union tools/list shows for the whole tool;
 *   • branch: `action` and the arguments of the branch tool it runs;
 *   • read_backend_state: `section`, `branchId`, and the arguments of the tool
 *     the section is read with (`files` takes bucketName, `metrics` windowMinutes);
 *   • any other tool: the properties of its catalog schema.
 * A key sent as null carries nothing and is not refused: hosts that fill every
 * property of a schema send null for the ones a call does not use.
 *
 * db_* tools are not checked here: their routes and /api/mcp/tool parse them
 * with their own strict schemas, which also route set-based keys to run_query.
 */

import { BRAIN_TOOLS } from '@/lib/ai/brain/tools'
import { BRANCH_ACTIONS, STATE_SECTIONS, catalogByName } from '@/lib/mcp/catalog'
import { isDbTool } from '@/lib/mcp/db-tool-requests'
import { getDomainTool } from '@/lib/mcp/domains'

/** What a call may carry: its label for messages, and the keys it takes. */
export interface ToolArguments {
  label: string
  supported: string[]
}

/** The keys a brain tool declares. */
function brainArguments(tool: string): string[] {
  const def = BRAIN_TOOLS.find((t) => t.function?.name === tool)?.function as
    | { parameters?: { properties?: Record<string, unknown> } }
    | undefined
  return Object.keys(def?.parameters?.properties ?? {})
}

function routingKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * The arguments this call may carry, or null when this check does not decide
 * it: an unknown tool, action or section (the route refuses those itself, with
 * the list of what exists) and the db_* tools.
 */
export function toolArguments(tool: string, args: Record<string, unknown>): ToolArguments | null {
  if (isDbTool(tool)) return null

  const domain = getDomainTool(tool)
  if (domain) {
    const action = routingKey(args.action)
    const hit = domain.actions[action]
    if (!hit) return null
    return { label: `${tool} action "${action}"`, supported: ['action', ...brainArguments(hit.tool)] }
  }

  if (tool === 'branch') {
    const action = routingKey(args.action)
    const target = BRANCH_ACTIONS[action]
    if (!target) return null
    return { label: `branch action "${action}"`, supported: ['action', ...brainArguments(target)] }
  }

  if (tool === 'read_backend_state') {
    const section = routingKey(args.section)
    if (!section) return { label: 'read_backend_state', supported: ['section', 'branchId'] }
    const target = STATE_SECTIONS[section]
    if (!target) return null
    return {
      label: `read_backend_state section "${section}"`,
      supported: ['section', 'branchId', ...brainArguments(target).filter((k) => k !== 'section' && k !== 'branchId')],
    }
  }

  const descriptor = catalogByName().get(tool)
  if (!descriptor) return null
  return { label: tool, supported: Object.keys(descriptor.inputSchema.properties ?? {}) }
}

/** The keys of `args` that carry a value the call does not take. */
export function unsupportedArguments(args: Record<string, unknown>, supported: string[]): string[] {
  const known = new Set(supported)
  return Object.keys(args).filter((k) => !known.has(k) && args[k] !== null && args[k] !== undefined)
}

export interface UnknownArgumentsRefusal {
  ok: false
  code: 'UNKNOWN_PARAMS'
  error: string
  /** The keys refused, so the agent does not have to diff its own call. */
  unsupported: string[]
  /** Every key this call does take. */
  supported: string[]
  hint: string
}

/**
 * The refusal for a call that carries an argument it does not take, or null
 * when every argument is one it takes (or this check does not decide the call).
 * Nothing has run when this is returned.
 */
export function refuseUnknownArguments(
  tool: string,
  args: Record<string, unknown>,
): UnknownArgumentsRefusal | null {
  const accepted = toolArguments(tool, args)
  if (!accepted) return null
  const unsupported = unsupportedArguments(args, accepted.supported)
  if (unsupported.length === 0) return null
  return {
    ok: false,
    code: 'UNKNOWN_PARAMS',
    error: `${accepted.label} does not take ${unsupported.join(', ')}. Nothing ran.`,
    unsupported,
    supported: accepted.supported,
    // A branch id this tool cannot use is the costly case: sent again without
    // it, the call acts on production.
    hint: unsupported.includes('branchId')
      ? 'This call has no preview-branch form: without branchId it acts on production. Send it without branchId only if production is what you mean.'
      : 'Send it again with only the arguments in `supported`.',
  }
}

export interface ProjectMismatchRefusal {
  ok: false
  code: 'PROJECT_MISMATCH'
  error: string
  hint: string
}

/**
 * A projectId argument. The connection decides the project, and agents often
 * name it as well. Their own project's id is accepted, and the caller drops it
 * before anything reads the arguments. Any other id is refused, as
 * deploy_code's handler always refused it, so a call never runs on one project
 * while naming another.
 */
export function refuseOtherProject(
  args: Record<string, unknown>,
  projectId: string,
): ProjectMismatchRefusal | null {
  const named = args.projectId
  if (named === undefined || named === null) return null
  if (typeof named === 'string' && named.trim() === projectId) return null
  return {
    ok: false,
    code: 'PROJECT_MISMATCH',
    error: 'This connection acts on its own project only, and projectId names another. Nothing ran.',
    hint: 'Leave projectId out, or connect with a key for the other project.',
  }
}
