/**
 * EVERY ARGUMENT A TOOL'S HANDLER READS IS ONE ITS CALL MAY CARRY
 * ===============================================================
 *
 * /api/mcp/tool refuses an argument a call does not take (lib/mcp/tool-arguments.ts;
 * the route's behaviour is tests/unit/mcp-refuses-undeclared-arguments.spec.ts).
 * That is safe only while what a call may carry covers everything its handler
 * reads: a key the handler reads but the tool does not declare would now be
 * refused, and a call that used to work would break. deploy_function_code read
 * `description` without declaring it, and QA agents sent it in 5 of their 16
 * Nov deploy_code calls.
 *
 * Two checks hold that line:
 *   1. Every call shape QA agents sent on 9 and 16 Nov is accepted.
 *   2. The handlers' source is read with TypeScript's own parser, and every key
 *      read off a call's arguments must be one the call may carry: in the
 *      TOOL_TO_ACTION mappers, in dispatchTool's and preflightValidate's block
 *      for each tool, in the route's own tools, and in the typed parameter of
 *      each service function a handler hands the arguments to. A key that only
 *      Backenly itself sets is listed in INTERNAL with the reason.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'
import { BRANCH_ACTIONS, STATE_SECTIONS, buildDispatchable } from '@/lib/mcp/catalog'
import { DOMAIN_TOOLS } from '@/lib/mcp/domains'
import { isDbTool } from '@/lib/mcp/db-tool-requests'
import { refuseUnknownArguments, toolArguments } from '@/lib/mcp/tool-arguments'

const ROOT = process.cwd()

/**
 * Keys a handler reads that no agent sends: Backenly sets them itself, or the
 * handler reads them only to refuse them. Each is refused over MCP like any
 * other key the call does not take.
 */
const INTERNAL: Record<string, Record<string, string>> = {
  merge_branch: {
    approvedMigrations: 'the statements a person approved, frozen when the merge was parked (lib/branches/merge-request.ts)',
  },
  revert_schema_change: {
    acknowledged: 'what a person approved, measured by Backenly when the restore was parked; the parked call carries nothing the agent sent',
  },
  rollback_deploy: {
    steps: 'the changes a person approved undoing, measured by Backenly when the rollback was parked',
  },
  add_column: {
    columnName: 'an older spelling of column.name that the brain’s own model may send; never offered to MCP callers',
    columnType: 'an older spelling of column.type, as above',
  },
  deploy_function_code: {
    projectId: 'read only to refuse another project: the tool deploys to its connection’s project',
  },
  send_push: {
    '(whole)': 'handed whole to the SEND_PUSH executor, which reads title, message, externalUserIds, playerIds, broadcast and data, all declared',
  },
}

// ── Reading the handlers ──────────────────────────────────────────────────────

const parse = (rel: string) =>
  ts.createSourceFile(rel, readFileSync(join(ROOT, rel), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

type Reads = Map<string, Set<string>>
interface Pass { callee: string; index: number }

/** Names held by `const NAME = new Set([...strings])` at the top of a file. */
function stringSets(sf: ts.SourceFile): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue
    for (const d of s.declarationList.declarations) {
      const init = d.initializer
      if (init && ts.isNewExpression(init) && init.expression.getText() === 'Set' && init.arguments?.[0] && ts.isArrayLiteralExpression(init.arguments[0])) {
        out[d.name.getText()] = init.arguments[0].elements.filter(ts.isStringLiteral).map((e) => e.text)
      }
    }
  }
  return out
}

function findFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const f = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name)
  if (!f?.body) throw new Error(`${sf.fileName} has no function ${name}`)
  return f
}

/** The tool names a condition selects: `name === 'x'`, `a || b`, `x && …`, `SET.has(name)`. */
function testedNames(e: ts.Expression, nameVar: string, sets: Record<string, string[]>): string[] | null {
  if (ts.isParenthesizedExpression(e)) return testedNames(e.expression, nameVar, sets)
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      if (e.left.getText() === nameVar && ts.isStringLiteral(e.right)) return [e.right.text]
      if (e.right.getText() === nameVar && ts.isStringLiteral(e.left)) return [e.left.text]
      return null
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      const l = testedNames(e.left, nameVar, sets)
      const r = testedNames(e.right, nameVar, sets)
      return l && r ? [...l, ...r] : null
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return testedNames(e.left, nameVar, sets) ?? testedNames(e.right, nameVar, sets)
    }
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'has' &&
      e.arguments.length === 1 && e.arguments[0].getText() === nameVar) {
    return sets[e.expression.expression.getText()] ?? null
  }
  return null
}

/** Does this statement always leave the function (its block ends in return or throw)? */
function alwaysExits(s: ts.Statement): boolean {
  if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) return true
  if (ts.isBlock(s)) return s.statements.length > 0 && alwaysExits(s.statements[s.statements.length - 1])
  return false
}

/** The strings a `for (const c of ['a', 'b'])` loop binds `id` to, if that is where it comes from. */
function loopLiterals(id: ts.Identifier): string[] | null {
  for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
    if (ts.isForOfStatement(p) && ts.isVariableDeclarationList(p.initializer) &&
        p.initializer.declarations.some((d) => d.name.getText() === id.text)) {
      let list: ts.Expression = p.expression
      while (ts.isAsExpression(list) || ts.isParenthesizedExpression(list)) list = list.expression
      return ts.isArrayLiteralExpression(list) && list.elements.every(ts.isStringLiteral)
        ? list.elements.map((e) => (e as ts.StringLiteral).text)
        : null
    }
  }
  return null
}

/**
 * Walk a dispatcher, recording for each tool the keys its block reads off the
 * argument object and the calls it hands that object to whole. A block selected
 * by `name === 'x'` (or a Set of names) belongs to those tools; a nested one,
 * a `tool: () => …` entry of a map, or one arm of `name === 'x' ? … : …`, to
 * fewer; a tool whose block always returns owns nothing after it.
 */
function scanDispatcher(body: ts.Node, nameVar: string, argVars: string[], sets: Record<string, string[]>) {
  const reads: Reads = new Map()
  const passes = new Map<string, Pass[]>()
  const odd: string[] = []
  const keysOf = (tool: string) => { if (!reads.has(tool)) reads.set(tool, new Set()); return reads.get(tool)! }

  const record = (id: ts.Identifier, names: string[]) => {
    let top: ts.Node = id
    while (top.parent && (ts.isParenthesizedExpression(top.parent) || ts.isAsExpression(top.parent) || ts.isNonNullExpression(top.parent))) top = top.parent
    const p = top.parent
    const keys: string[] = []
    if (ts.isPropertyAccessExpression(p) && p.expression === top) keys.push(p.name.text)
    else if (ts.isElementAccessExpression(p) && p.expression === top) {
      const a = p.argumentExpression
      const literals = ts.isStringLiteral(a) ? [a.text] : ts.isIdentifier(a) ? loopLiterals(a) : null
      if (literals) keys.push(...literals)
      else odd.push(`${names}: ${p.getText()}`)
    } else if (ts.isVariableDeclaration(p) && p.initializer === top && ts.isObjectBindingPattern(p.name)) {
      for (const el of p.name.elements) keys.push((el.propertyName ?? el.name).getText())
    } else if (ts.isCallExpression(p) && p.arguments.some((a) => a === top)) {
      for (const n of names) {
        if (!passes.has(n)) passes.set(n, [])
        passes.get(n)!.push({ callee: p.expression.getText(), index: p.arguments.indexOf(top as ts.Expression) })
      }
    } else if (ts.isPropertyAssignment(p) || ts.isSpreadAssignment(p) || ts.isSpreadElement(p) || ts.isShorthandPropertyAssignment(p)) {
      for (const n of names) keysOf(n).add('(whole)')
    } else if (!ts.isTypeOfExpression(p) && !ts.isBinaryExpression(p) && !(ts.isPropertyAccessExpression(p) && p.name === id)) {
      odd.push(`${names}: ${p.getText().slice(0, 80)}`)
    }
    for (const n of names) for (const k of keys) keysOf(n).add(k)
  }

  const walkStatements = (statements: readonly ts.Statement[], names: string[] | null) => {
    let current = names
    for (const s of statements) {
      walk(s, current)
      if (current && ts.isIfStatement(s)) {
        const ns = testedNames(s.expression, nameVar, sets)
        if (ns && alwaysExits(s.thenStatement)) current = current.filter((n) => !ns.includes(n))
      }
    }
  }

  const walk = (node: ts.Node, names: string[] | null): void => {
    if (ts.isBlock(node)) return walkStatements(node.statements, names)
    if (ts.isIfStatement(node)) {
      const ns = testedNames(node.expression, nameVar, sets)
      if (ns) {
        const inner = names ? ns.filter((n) => names.includes(n)) : ns
        walk(node.expression, inner)
        walk(node.thenStatement, inner)
        if (node.elseStatement) walk(node.elseStatement, names ? names.filter((n) => !ns.includes(n)) : null)
        return
      }
    }
    if (ts.isSwitchStatement(node) && node.expression.getText() === nameVar) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) {
          const tool = clause.expression.text
          if (!names || names.includes(tool)) walkStatements(clause.statements, [tool])
        }
      }
      return
    }
    if (ts.isConditionalExpression(node)) {
      const ns = testedNames(node.condition, nameVar, sets)
      if (ns && names) {
        walk(node.condition, names)
        walk(node.whenTrue, names.filter((n) => ns.includes(n)))
        walk(node.whenFalse, names.filter((n) => !ns.includes(n)))
        return
      }
    }
    if (ts.isPropertyAssignment(node) && names && names.includes(node.name.getText()) && ts.isArrowFunction(node.initializer)) {
      return walk(node.initializer, [node.name.getText()])
    }
    if (ts.isIdentifier(node) && argVars.includes(node.text) && names && names.length) {
      record(node, names)
      return
    }
    ts.forEachChild(node, (child) => walk(child, names))
  }

  walk(body, null)
  return { reads, passes, odd }
}

/** `const x = await import('spec')` and `const { a } = await import('spec')` inside a function. */
function dynamicImports(fn: ts.Node): Record<string, { spec: string; member?: string }> {
  const out: Record<string, { spec: string; member?: string }> = {}
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = ts.isAwaitExpression(n.initializer) ? n.initializer.expression : n.initializer
      if (ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(init.arguments[0])) {
        const spec = (init.arguments[0] as ts.StringLiteral).text
        if (ts.isIdentifier(n.name)) out[n.name.text] = { spec }
        else if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) out[el.name.getText()] = { spec, member: (el.propertyName ?? el.name).getText() }
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(fn)
  return out
}

/**
 * The keys a function reads off the parameter a handler hands the arguments
 * to: one of dispatchTool's dynamic imports, or a helper in tools.ts itself.
 */
function serviceKeys(pass: Pass, imports: Record<string, { spec: string; member?: string }>): string[] {
  const [obj, member] = pass.callee.includes('.') ? pass.callee.split('.') : [pass.callee, undefined]
  const found = imports[obj]
  const local = !found && !member
    ? toolsFile.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === obj)
    : undefined
  if (!found && !local) throw new Error(`cannot tell what ${pass.callee} reads: it is neither imported by dispatchTool nor in tools.ts`)
  const fn = local ?? findFunction(parse(`${found!.spec.replace(/^@\//, '')}.ts`), member ?? found!.member!)
  const param = fn.parameters[pass.index]
  if (param?.type && ts.isTypeLiteralNode(param.type)) {
    // The function cannot read a key its own parameter type does not name.
    return param.type.members.map((m) => m.name!.getText())
  }
  // Untyped: the keys its body reads off the parameter, each one a plain read.
  const name = param.name.getText()
  const keys: string[] = []
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.text === name && n !== param.name) {
      const read = mapperReads(n)
      if (read.includes('(whole)')) throw new Error(`${pass.callee} hands the arguments on whole; follow it here`)
      keys.push(...read)
    }
    ts.forEachChild(n, visit)
  }
  visit(fn.body!)
  return keys
}

const toolsFile = parse('lib/ai/brain/tools.ts')
const toolSets = stringSets(toolsFile)

/** Uses of the arguments the scan could not read as keys; checked by a test below. */
const UNREADABLE: string[] = []

/** Keys each brain tool's handler reads, mappers included. */
function brainReads(): Reads {
  const reads: Reads = new Map()
  const add = (tool: string, keys: Iterable<string>) => {
    if (!reads.has(tool)) reads.set(tool, new Set())
    for (const k of keys) reads.get(tool)!.add(k)
  }

  for (const s of toolsFile.statements) {
    if (!ts.isVariableStatement(s)) continue
    for (const d of s.declarationList.declarations) {
      if (d.name.getText() !== 'TOOL_TO_ACTION' || !d.initializer || !ts.isObjectLiteralExpression(d.initializer)) continue
      for (const prop of d.initializer.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isArrowFunction(prop.initializer)) continue
        const tool = prop.name.getText()
        add(tool, [])
        const param = prop.initializer.parameters[0]
        if (!param) continue
        // A mapper is one tool's code throughout.
        const visit = (n: ts.Node) => {
          if (ts.isIdentifier(n) && n.text === param.name.getText()) add(tool, mapperReads(n))
          ts.forEachChild(n, visit)
        }
        visit(prop.initializer.body)
      }
    }
  }

  const dispatch = findFunction(toolsFile, 'dispatchTool')
  const imports = dynamicImports(dispatch)
  for (const fnName of ['dispatchTool', 'preflightValidate']) {
    const scan = scanDispatcher(findFunction(toolsFile, fnName).body!, 'name', ['args'], toolSets)
    UNREADABLE.push(...scan.odd.map((o) => `${fnName}: ${o}`))
    for (const [tool, keys] of scan.reads) add(tool, keys)
    for (const [tool, passes] of scan.passes) {
      for (const pass of passes) add(tool, serviceKeys(pass, imports))
    }
  }
  return reads
}

/** The keys one occurrence of a mapper's parameter reads. */
function mapperReads(id: ts.Identifier): string[] {
  let top: ts.Node = id
  while (top.parent && (ts.isParenthesizedExpression(top.parent) || ts.isAsExpression(top.parent))) top = top.parent
  const p = top.parent
  if (ts.isPropertyAccessExpression(p) && p.expression === top) return [p.name.text]
  if (ts.isElementAccessExpression(p) && p.expression === top) {
    const a = p.argumentExpression
    const literals = ts.isStringLiteral(a) ? [a.text] : ts.isIdentifier(a) ? loopLiterals(a) : null
    if (!literals) throw new Error(`a mapper reads ${p.getText()}, which cannot be checked`)
    return literals
  }
  if (ts.isPropertyAssignment(p) || ts.isSpreadAssignment(p)) return ['(whole)']
  return []
}

/** Keys the route reads itself for the tools it serves without the brain. */
function routeReads(): Reads {
  const route = parse('app/api/mcp/tool/route.ts')
  const scan = scanDispatcher(findFunction(route, 'handleCall').body!, 'tool', ['args', 'dispatchArgs'], {})
  UNREADABLE.push(...scan.odd.map((o) => `handleCall: ${o}`))
  return scan.reads
}

// ── The calls an MCP client can make ─────────────────────────────────────────

interface Reachable {
  /** How the call reads in a failure. */
  call: string
  /** The brain tool or route block whose reads are checked. */
  handler: string
  supported: string[]
}

function reachableCalls(): Reachable[] {
  const out: Reachable[] = []
  const routed = new Set(['branch', 'read_backend_state', ...DOMAIN_TOOLS.map((d) => d.name)])
  for (const t of buildDispatchable()) {
    if (isDbTool(t.name) || routed.has(t.name)) continue
    out.push({ call: t.name, handler: t.name, supported: toolArguments(t.name, {})!.supported })
  }
  for (const d of DOMAIN_TOOLS) {
    for (const [action, { tool }] of Object.entries(d.actions)) {
      out.push({ call: `${d.name} ${action}`, handler: tool, supported: toolArguments(d.name, { action })!.supported })
    }
  }
  for (const [action, tool] of Object.entries(BRANCH_ACTIONS)) {
    out.push({ call: `branch ${action}`, handler: tool, supported: toolArguments('branch', { action })!.supported })
  }
  for (const [section, tool] of Object.entries(STATE_SECTIONS)) {
    out.push({ call: `read_backend_state ${section}`, handler: tool, supported: toolArguments('read_backend_state', { section })!.supported })
  }
  out.push({ call: 'read_backend_state', handler: 'read_backend_state', supported: toolArguments('read_backend_state', {})!.supported })
  return out
}

const BRAIN = brainReads()
const ROUTE = routeReads()
const CALLS = reachableCalls()

const unexplained = (handler: string, keys: Iterable<string>, supported: string[]) =>
  [...keys].filter((k) => !supported.includes(k) && !(INTERNAL[handler] && k in INTERNAL[handler])).sort()

describe('what a call may carry covers what its handler reads', () => {
  it('reads the handlers it is meant to read', () => {
    // So a silent change in how dispatch is written cannot turn this into a test of nothing.
    expect([...(BRAIN.get('get_table_schema') ?? [])]).toContain('tableName')
    expect([...(BRAIN.get('create_webhook') ?? [])]).toEqual(expect.arrayContaining(['eventType', 'targetUrl', 'tables']))
    expect([...(BRAIN.get('list_request_logs') ?? [])]).toEqual(expect.arrayContaining(['branchId', 'minStatus', 'pathPrefix']))
    expect([...(BRAIN.get('set_rls') ?? [])]).toEqual(expect.arrayContaining(['select', 'insert', 'update', 'delete', 'role']))
    // A tool whose block has returned owns nothing read after it.
    expect([...(BRAIN.get('create_branch') ?? [])].sort()).toEqual(['includeData', 'name'])
    expect([...(ROUTE.get('apply_migration') ?? [])]).toEqual(expect.arrayContaining(['sql', 'branchId']))
    expect(CALLS.length).toBeGreaterThan(150)
    // Every use of the arguments in a tool's block was read as keys or followed.
    expect(UNREADABLE).toEqual([])
  })

  it.each(CALLS.map((c) => [c.call, c] as const))('%s', (_label, c) => {
    expect(unexplained(c.handler, BRAIN.get(c.handler) ?? [], c.supported)).toEqual([])
  })

  it('covers what the route itself reads, for each tool it serves', () => {
    const missing: Record<string, string[]> = {}
    for (const [tool, keys] of ROUTE) {
      // A routed tool's own keys (action, section, branchId) are read before the
      // action is known, so they are checked against every action's arguments.
      const supported = CALLS.filter((c) => c.call === tool || c.call.startsWith(`${tool} `)).flatMap((c) => c.supported)
      const extra = unexplained(tool, keys, supported)
      if (extra.length) missing[tool] = extra
    }
    expect(missing).toEqual({})
  })

  it('lists in INTERNAL only keys a handler still reads and no call may carry', () => {
    for (const [handler, keys] of Object.entries(INTERNAL)) {
      for (const key of Object.keys(keys)) {
        expect({ handler, key, read: BRAIN.get(handler)?.has(key) ?? false }).toEqual({ handler, key, read: true })
        for (const c of CALLS.filter((x) => x.handler === handler)) expect(c.supported).not.toContain(key)
      }
    }
  })
})

// ── What agents actually send ────────────────────────────────────────────────

/**
 * Every distinct call shape the QA agents sent through Backenly's MCP tools in
 * the production QA runs of 9 Nov (155 calls) and 16 Nov (80 calls): the tool,
 * its action or section, and the keys. Values do not matter to the check.
 */
const QA_CALLS: Array<[string, Record<string, string>, string[]]> = [
  ['apply_migration', {}, ['branchId', 'sql']],
  ['apply_migration', {}, ['sql']],
  ['auth', { action: 'enable' }, []],
  ['auth', { action: 'list_users' }, ['limit']],
  ['backend_chat', {}, ['message']],
  ['branch', { action: 'create' }, ['name']],
  ['branch', { action: 'diff' }, ['branchId']],
  ['branch', { action: 'list' }, []],
  ['branch', { action: 'merge' }, ['branchId']],
  ['check_approval', {}, ['id']],
  ['connect', { action: 'connect_frontend' }, ['url']],
  ['connect', { action: 'create_api_key' }, ['description']],
  ['connect', { action: 'create_api_key' }, ['description', 'expiresInDays', 'permissions']],
  ['connect', { action: 'list_api_keys' }, []],
  ['connect', { action: 'revoke_api_key' }, ['keyId']],
  ['connect', { action: 'set_env' }, ['description', 'key', 'value']],
  ['connect', { action: 'whoami' }, []],
  ['db_insert', {}, ['branchId', 'row', 'table']],
  ['db_insert', {}, ['row', 'table']],
  ['db_update', {}, ['filter', 'patch', 'table']],
  ['deploy', { action: 'changes' }, ['limit']],
  ['deploy', { action: 'revert_change' }, ['changeId']],
  ['fetch_docs', {}, []],
  ['fetch_docs', {}, ['topic']],
  ['functions', { action: 'delete' }, ['name']],
  ['functions', { action: 'deploy_code' }, ['code', 'columns', 'description', 'name', 'table', 'trigger']],
  ['functions', { action: 'deploy_code' }, ['code', 'description', 'method', 'name', 'trigger']],
  ['functions', { action: 'deploy_code' }, ['code', 'method', 'name', 'trigger']],
  ['functions', { action: 'deploy_code' }, ['code', 'name', 'table', 'trigger']],
  ['functions', { action: 'invoke' }, ['event', 'name']],
  ['functions', { action: 'list' }, []],
  ['functions', { action: 'logs' }, ['limit']],
  ['functions', { action: 'logs' }, ['limit', 'name']],
  ['functions', { action: 'set_active' }, ['active', 'name']],
  ['get_table_schema', {}, ['tableName']],
  ['integrations', { action: 'list' }, []],
  ['monitoring', { action: 'request_logs' }, ['limit', 'method', 'pathPrefix', 'sinceMinutes']],
  ['read_backend_state', {}, []],
  ['read_backend_state', { section: 'evolution' }, []],
  ['read_backend_state', { section: 'findings' }, []],
  ['read_backend_state', { section: 'incidents' }, []],
  ['read_backend_state', { section: 'schema' }, []],
  ['read_backend_state', { section: 'schema' }, ['branchId']],
  ['realtime', { action: 'enable' }, ['tableName']],
  ['run_query', {}, ['sql']],
  ['set_rls', {}, ['delete', 'insert', 'role', 'select', 'tableName', 'update']],
  ['storage', { action: 'create_bucket' }, ['bucketName', 'isPublic']],
  ['storage', { action: 'list_files' }, ['bucketName', 'limit']],
  ['storage', { action: 'set_policy' }, ['bucketName', 'policy']],
]

describe('the calls QA agents made', () => {
  it.each(QA_CALLS.map(([tool, routing, keys]) => [`${tool} ${Object.values(routing).join(' ')} {${keys.join(', ')}}`, tool, routing, keys] as const))(
    'accepts %s',
    (_label, tool, routing, keys) => {
      const args: Record<string, unknown> = { ...routing, ...Object.fromEntries(keys.map((k) => [k, 'x'])) }
      expect(refuseUnknownArguments(tool, args)).toBeNull()
    },
  )
})
