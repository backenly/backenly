/**
 * The parsed-statement check for governed read-only SQL (run_query, the
 * console's SQL tab, the CLI console).
 *
 * ── What this decides, and why a parser decides it ──────────────────────────
 *
 * lib/mcp/read-query.ts runs every statement as the project's `bkn_ro_` role,
 * and for table DATA that role's grants are the tenant boundary: PostgreSQL
 * refuses `workspace_other.orders` without any check having to recognise it.
 *
 * Catalog METADATA is the one thing those grants cannot hide. `pg_catalog` and
 * `information_schema` are readable by PUBLIC and describe the whole database,
 * every project in it: read-query.ts records the session on 2026-07-22 that read
 * ~10 other tenants' function source from `pg_proc`. Revoking the catalogs would
 * break `pg_dump` and `\d` for the read-only credentials this platform hands
 * out. So for metadata the statement itself is the boundary, and it has to be
 * read exactly the way PostgreSQL will read it.
 *
 * A pattern over the text cannot do that. The text check this module now sits
 * in front of blanked double-quoted identifiers as if they were string
 * literals, so `SELECT proname, prosrc FROM "pg_proc"` read every project's
 * function source again. Nor can text see `U&"\0070g_proc"`, an object id
 * turned into another project's name by `16400::regnamespace`, or a query
 * handed to `query_to_xml` as a string. This module parses the statement with
 * PostgreSQL's own parser (libpg-query: pganalyze's libpg_query built as
 * WebAssembly, the PostgreSQL 16 grammar the server runs), walks the whole
 * tree, and refuses anything that:
 *
 *   - names a catalog relation, schema, type or function (`pg_*`,
 *     `information_schema`), however it is quoted or escaped;
 *   - names any schema but the project's own;
 *   - casts to an OID alias type (`regclass`, `regnamespace`, `regproc`, ...),
 *     whose output turns any object id into that object's name;
 *   - calls a function that runs SQL given as text (`query_to_xml`, `ts_stat`,
 *     `dblink`, ...), reads catalog comments, probes the catalog by name or id
 *     (`to_regclass`, `has_table_privilege`, `format_type`, ...), changes the
 *     settings this check assumed (`set_config`), or reads large objects.
 *
 * The text checks in read-query.ts stay as a second, independent layer.
 *
 * It fails closed. A statement that does not parse is refused, never run on the
 * strength of the text checks alone, and when the parser cannot be loaded no
 * statement runs.
 *
 * What it does not decide: whether a project may read a table's DATA. That is
 * still PostgreSQL's grants, and a schema-qualified read of another project is
 * refused here only so the agent gets a clear answer first.
 */

export type StatementRefusalCode =
  | 'EMPTY_QUERY'
  | 'MULTI_STATEMENT'
  | 'NOT_READ_ONLY'
  | 'CATALOG_NOT_READABLE'
  | 'OUTSIDE_PROJECT_SCHEMA'
  | 'SYNTAX_ERROR'
  | 'SQL_PARSER_UNAVAILABLE'

export interface StatementRefusal {
  code: StatementRefusalCode
  message: string
  /** Which of read-query.ts's hints the caller is given. */
  hint?: 'verb' | 'write' | 'multi' | 'catalog' | 'schema'
  /** 503 when Backenly could not check the statement at all; otherwise it is the caller's statement (400). */
  status?: number
}

export const PARSER_UNAVAILABLE =
  "Backenly couldn't load its SQL parser, so the query didn't run. Try again in a minute. " +
  'If it keeps failing, contact support.'

// ── The parser ───────────────────────────────────────────────────────────────

interface Parser {
  loadModule(): Promise<void>
  parse(sql: string): Promise<unknown>
}

let parser: Promise<Parser> | null = null

/**
 * libpg-query, loaded on first use.
 *
 * Imported lazily. The runtime server bundles this module (lib/mcp/runtime-db.ts
 * imports read-query.ts) and never runs a read query, so it should not compile
 * a megabyte of WebAssembly at boot.
 *
 * And kept EXTERNAL to both bundles (`serverExternalPackages` in next.config.js,
 * `external` in scripts/build-runtime-bundle.mjs): its loader reads
 * libpg-query.wasm from beside its own file, so it must be required from
 * node_modules, where both images put it and assert that it parses, rather than
 * inlined into a chunk with no .wasm beside it.
 *
 * A failed load is not remembered, so one transient failure does not refuse
 * every read query until the process restarts.
 */
function loadParser(): Promise<Parser> {
  if (!parser) {
    const loading = (async () => {
      const mod: any = await import('libpg-query')
      const lib = mod && typeof mod.parse === 'function' ? mod : mod?.default
      if (!lib || typeof lib.parse !== 'function' || typeof lib.loadModule !== 'function') {
        throw new Error('libpg-query exports no parse()')
      }
      await lib.loadModule()
      return lib as Parser
    })()
    parser = loading
    loading.catch(() => {
      if (parser === loading) parser = null
    })
  }
  return parser
}

/** The raw parse tree, as libpg-query returns it. Throws what the parser throws. */
export async function parseSql(sql: string): Promise<unknown> {
  return (await loadParser()).parse(sql)
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const position = (err as { sqlDetails?: { cursorPosition?: unknown } })?.sqlDetails?.cursorPosition
  // 0-based from libpg-query; PostgreSQL reports positions from 1.
  return typeof position === 'number' && position >= 0 ? `${message} (at character ${position + 1})` : message
}

/**
 * Parse `sql` and inspect it. Null when the statement may run; otherwise why
 * not. `ownSchema` is the project's workspace schema, the only one a statement
 * may name.
 */
export async function inspectReadQuery(sql: string, ownSchema: string): Promise<StatementRefusal | null> {
  // libpg_query reads a C string, and so does the server: a NUL would end the
  // statement early, so whatever followed it would never be checked.
  if (sql.indexOf('\u0000') !== -1) {
    return { code: 'SYNTAX_ERROR', message: 'The statement contains a NUL character (U+0000), which PostgreSQL does not accept.' }
  }

  let lib: Parser
  try {
    lib = await loadParser()
  } catch (err) {
    console.error(`[read-query] the SQL parser could not be loaded, so no read query can run: ${errorText(err)}`)
    return { code: 'SQL_PARSER_UNAVAILABLE', message: PARSER_UNAVAILABLE, status: 503 }
  }

  let tree: unknown
  try {
    tree = await lib.parse(sql)
  } catch (err) {
    // Never fall back to running a statement that did not parse: whatever the
    // parser could not read, this check cannot vouch for.
    return { code: 'SYNTAX_ERROR', message: `The statement could not be parsed: ${errorText(err)}` }
  }
  return inspectParseTree(tree, ownSchema)
}

// ── The tree ─────────────────────────────────────────────────────────────────

type JsonObject = { [key: string]: unknown }

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const MULTI_STATEMENT: StatementRefusal = {
  code: 'MULTI_STATEMENT',
  message: 'Only a single statement is allowed. Remove the ";" and send one query per call.',
  hint: 'multi',
}

const NOT_A_READ: StatementRefusal = {
  code: 'NOT_READ_ONLY',
  message: 'run_query executes read-only SQL. A statement must begin with SELECT, WITH, EXPLAIN, SHOW, TABLE or VALUES.',
  hint: 'verb',
}

const EXPLAIN_ANALYZE: StatementRefusal = {
  code: 'NOT_READ_ONLY',
  message: 'EXPLAIN ANALYZE executes the statement. Use plain EXPLAIN for the plan.',
}

/**
 * Inspect a parse tree. Pure: no parser, no database. Null when the statement
 * may run.
 */
export function inspectParseTree(tree: unknown, ownSchema: string): StatementRefusal | null {
  if (!isObject(tree)) return { code: 'SYNTAX_ERROR', message: 'The statement could not be parsed.' }
  // libpg_query leaves an empty list out of its JSON entirely.
  const stmts = Array.isArray(tree.stmts) ? tree.stmts : []
  if (stmts.length === 0) {
    return { code: 'EMPTY_QUERY', message: 'Empty query: the statement holds only comments or semicolons.' }
  }
  if (stmts.length > 1) return MULTI_STATEMENT

  const raw = stmts[0]
  const stmt = isObject(raw) && isObject(raw.stmt) ? (raw.stmt as JsonObject) : null
  const kind = stmt ? Object.keys(stmt)[0] : undefined
  const body = stmt && kind ? stmt[kind] : undefined
  if (!stmt || !kind || !isObject(body)) return { code: 'SYNTAX_ERROR', message: 'The statement could not be parsed.' }

  // The statements the text check has always admitted: SELECT (WITH, TABLE and
  // VALUES parse as one), EXPLAIN of a SELECT without ANALYZE, and SHOW.
  if (kind === 'ExplainStmt') {
    const options = Array.isArray(body.options) ? body.options : []
    // ANALYZE and ANALYSE both parse to the option "analyze", in either form
    // (EXPLAIN ANALYZE ..., EXPLAIN (ANALYSE) ...). It executes the statement.
    const analyzes = options.some((option) => {
      const def = isObject(option) ? option.DefElem : undefined
      return isObject(def) && String(def.defname).toLowerCase() === 'analyze'
    })
    if (analyzes) return EXPLAIN_ANALYZE
    const explained = body.query
    const query = isObject(explained) ? Object.keys(explained)[0] : undefined
    if (query !== 'SelectStmt') {
      return { code: 'NOT_READ_ONLY', message: 'run_query explains only a SELECT.', hint: 'write' }
    }
  } else if (kind !== 'SelectStmt' && kind !== 'VariableShowStmt') {
    return NOT_A_READ
  }

  return walk(body, ownSchema)
}

/**
 * Every list of names whose last element is the thing named and whose earlier
 * elements qualify it, keyed by the field that holds it.
 */
const QUALIFIED_NAMES: { [key: string]: 'function' | 'type' | 'operator' | 'collation' } = {
  funcname: 'function', //  FuncCall
  method: 'function', //    RangeTableSample: TABLESAMPLE calls a handler function
  names: 'type', //         TypeName, a field of TypeCast, ColumnDef, RangeTableFuncCol, XmlSerialize, JsonOutput
  name: 'operator', //      A_Expr (a list only there; `name` is a plain string elsewhere)
  operName: 'operator', //  SubLink: x OPERATOR(s.=) ANY (subquery)
  useOp: 'operator', //     SortBy: ORDER BY x USING OPERATOR(s.<)
  collname: 'collation', // CollateClause
}

/** The text of a `{ "String": { "sval": … } }` node: an identifier, never a literal. */
function stringNode(node: unknown): string | null {
  if (!isObject(node)) return null
  const keys = Object.keys(node)
  if (keys.length !== 1 || keys[0] !== 'String') return null
  const inner = node.String
  return isObject(inner) && typeof inner.sval === 'string' ? inner.sval : ''
}

/**
 * Walk every node. Iterative, so a deeply nested statement cannot overflow the
 * stack and end the check early.
 */
function walk(root: JsonObject, ownSchema: string): StatementRefusal | null {
  const stack: Array<{ node: unknown; key: string }> = [{ node: root, key: '' }]
  while (stack.length > 0) {
    const { node, key } = stack.pop() as { node: unknown; key: string }

    if (Array.isArray(node)) {
      const kind = Object.prototype.hasOwnProperty.call(QUALIFIED_NAMES, key) ? QUALIFIED_NAMES[key] : undefined
      if (kind) {
        const parts = node.map(stringNode)
        if (parts.every((p) => p !== null)) {
          const refusal = checkQualifiedName(kind, parts as string[], ownSchema)
          if (refusal) return refusal
          continue
        }
      }
      if (key === 'fields' || key === 'indirection') {
        // ColumnRef.fields (a.b.c) and A_Indirection.indirection ((expr).f).
        for (const element of node) {
          const name = stringNode(element)
          if (name === null) {
            stack.push({ node: element, key: '' }) // subscripts, *
            continue
          }
          const refusal = key === 'fields' ? checkName(name) : checkField(name)
          if (refusal) return refusal
        }
        continue
      }
      for (const element of node) stack.push({ node: element, key })
      continue
    }

    if (!isObject(node)) continue

    const name = stringNode(node)
    if (name !== null) {
      const refusal = checkName(name)
      if (refusal) return refusal
      continue
    }

    // A RangeVar, wrapped as a node or held directly by a field.
    if (typeof node.relname === 'string') {
      const refusal = checkRelation(node, ownSchema)
      if (refusal) return refusal
    }

    for (const field of Object.keys(node)) {
      // A statement inside the statement: a data-modifying CTE, or anything
      // else that is not a SELECT. Node types are capitalised; fields are not.
      if (field !== 'SelectStmt' && /^[A-Z][A-Za-z]*Stmt$/.test(field)) return nestedStatement(field)
      // SELECT ... INTO creates a table.
      if (field === 'intoClause' && node[field]) {
        return { code: 'NOT_READ_ONLY', message: 'run_query is read-only, and SELECT ... INTO creates a table.', hint: 'write' }
      }
      stack.push({ node: node[field], key: field })
    }
  }
  return null
}

const WRITE_VERBS: { [nodeType: string]: string } = {
  InsertStmt: 'INSERT',
  UpdateStmt: 'UPDATE',
  DeleteStmt: 'DELETE',
  MergeStmt: 'MERGE',
}

function nestedStatement(nodeType: string): StatementRefusal {
  const verb = Object.prototype.hasOwnProperty.call(WRITE_VERBS, nodeType) ? WRITE_VERBS[nodeType] : undefined
  return {
    code: 'NOT_READ_ONLY',
    message: `run_query is read-only and refused ${verb ? `a data-modifying ${verb}` : `a ${nodeType}`} inside the statement.`,
    hint: 'write',
  }
}

// ── The rules ────────────────────────────────────────────────────────────────

/**
 * A catalog name: the pg_ prefix, or information_schema.
 *
 * PostgreSQL reserves pg_ for schema, tablespace and role names (IsReservedName
 * in src/backend/catalog/catalog.c), and every relation in pg_catalog and
 * pg_toast begins with it, so the prefix covers every catalog there is and any
 * a later release adds. It is NOT reserved for a project's own tables or
 * columns: a table named pg_notes is legal, and is refused here like the
 * catalogs, as the text check has always refused it.
 */
function isCatalogName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.indexOf('pg_') === 0 || lower === 'information_schema'
}

const SHARED = 'the system catalogs are shared by every project in the database'

function catalogRefusal(what: string, why: string): StatementRefusal {
  return {
    code: 'CATALOG_NOT_READABLE',
    message: `run_query does not read the PostgreSQL system catalogs (refused ${what}: ${why}).`,
    hint: 'catalog',
  }
}

function schemaRefusal(what: string, schema: string): StatementRefusal {
  return {
    code: 'OUTSIDE_PROJECT_SCHEMA',
    message: `run_query reads only this project's own schema (refused ${what}, which names "${schema}").`,
    hint: 'schema',
  }
}

/** The pg_ prefix and information_schema, wherever an identifier appears. */
function checkName(name: string): StatementRefusal | null {
  return isCatalogName(name) ? catalogRefusal(`"${name}"`, SHARED) : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function checkRelation(rv: JsonObject, ownSchema: string): StatementRefusal | null {
  const relname = text(rv.relname)
  const schemaname = text(rv.schemaname)
  const catalogname = text(rv.catalogname)
  const shown = `relation "${[catalogname, schemaname, relname].filter(Boolean).join('.')}"`
  // Unqualified, a pg_ name resolves in pg_catalog first, before the project's
  // schema, so the prefix alone decides it.
  if (isCatalogName(relname) || isCatalogName(schemaname) || isCatalogName(catalogname)) return catalogRefusal(shown, SHARED)
  if (catalogname) return schemaRefusal(shown, catalogname)
  if (schemaname && schemaname !== ownSchema) return schemaRefusal(shown, schemaname)
  return null
}

/**
 * A function, type, operator or collation name, qualified or not.
 *
 * Qualified, it may name the project's own schema or pg_catalog. pg_catalog
 * because the grammar writes it itself (`x::integer` parses as
 * `pg_catalog.int4`, EXTRACT as `pg_catalog.extract`), and because pg_catalog
 * is searched first for every unqualified function, type and operator anyway:
 * qualifying with it reaches nothing a bare name does not. What the name itself
 * reaches is judged by the base-name rules either way. Any other qualifier is
 * refused: `public` holds extensions and platform helpers, and another
 * project's schema holds another project.
 */
function checkQualifiedName(
  kind: 'function' | 'type' | 'operator' | 'collation',
  parts: string[],
  ownSchema: string,
): StatementRefusal | null {
  if (parts.length === 0) return null
  const base = parts[parts.length - 1]
  const qualifiers = parts.slice(0, -1)
  const shown = `${kind} "${parts.join('.')}"`
  if (qualifiers.length > 0) {
    const schema = qualifiers[qualifiers.length - 1]
    const allowed = qualifiers.length === 1 && (schema === ownSchema || schema === 'pg_catalog')
    if (!allowed) {
      const outside = qualifiers.find(isCatalogName)
      if (outside) return catalogRefusal(shown, SHARED)
      return schemaRefusal(shown, qualifiers[0])
    }
  }
  if (kind === 'function') {
    const why = refusedRoutine(base, true) ?? refusedType(base)
    if (why) return catalogRefusal(shown, why)
  }
  if (kind === 'type') {
    const why = refusedType(base)
    if (why) return catalogRefusal(shown, why)
  }
  return null
}

/**
 * A field selected from a value, `(expr).name`. PostgreSQL also reads that as
 * a call, name(expr), whatever expr's type (ParseFuncOrColumn in
 * src/backend/parser/parse_func.c), so `(16400::oid).obj_description` and
 * `('pg_proc'::text).to_regclass` are calls, and `(16400).regclass` a cast.
 */
function checkField(name: string): StatementRefusal | null {
  const refused = checkName(name)
  if (refused) return refused
  const why = refusedRoutine(name, false) ?? refusedType(name)
  return why ? catalogRefusal(`"(...).${name}", which calls ${name}()`, why) : null
}

const RUNS_SQL = 'it runs SQL given as text, which this check cannot read'
const BY_NAME = 'it looks objects up in the shared catalog by name or id'
const NAMES_BY_ID = "it turns an object id into that object's name, from the shared catalog"
const OPENS_BY_ID = 'it opens an object by its id, and its errors name the object'

/** The OID alias types (PostgreSQL 16 docs, 8.19 Object Identifier Types) and their array types. */
const OID_ALIAS_TYPE = /^_?reg(class|collation|config|dictionary|namespace|oper|operator|proc|procedure|role|type)$/

const LARGE_OBJECT_FUNCTIONS =
  /^(lo_open|lo_close|lo_creat|lo_create|lo_unlink|lo_import|lo_export|lo_get|lo_put|lo_from_bytea|lo_lseek|lo_lseek64|lo_tell|lo_tell64|lo_truncate|lo_truncate64|loread|lowrite)$/

/**
 * Functions refused by name, unqualified or under pg_catalog. Names verified
 * against PostgreSQL 16's pg_proc.dat; the contrib ones (dblink, tablefunc,
 * pgstattuple, pgrowlocks) only exist where those extensions are installed.
 */
const ROUTINE_RULES: Array<{ test: RegExp; why: string }> = [
  { test: /^_?pg_/, why: 'it is a PostgreSQL system function' },
  // query_to_xml, query_to_xmlschema, query_to_xml_and_xmlschema, cursor_to_xml,
  // cursor_to_xmlschema, table_to_xml*, schema_to_xml*, database_to_xml*.
  { test: /^(query|cursor|table|schema|database)_to_xml/, why: RUNS_SQL },
  { test: /^ts_(stat|rewrite)$/, why: RUNS_SQL },
  { test: /^dblink/, why: RUNS_SQL },
  { test: /^(crosstab|connectby)/, why: RUNS_SQL },
  { test: /^(obj|col|shobj)_description$/, why: 'it reads comments from the shared catalog' },
  { test: /^to_reg(class|collation|namespace|oper|operator|proc|procedure|role|type|typemod)$/, why: BY_NAME },
  { test: /^has_[a-z_]+_privilege$/, why: BY_NAME },
  { test: /^row_security_active$/, why: BY_NAME },
  // regclass(...) as a function-style cast, and the types' own I/O functions.
  { test: /^reg(class|collation|config|dictionary|namespace|oper|operator|proc|procedure|role|type)(in|out|recv|send)?$/, why: NAMES_BY_ID },
  { test: /^(format_type|ts_debug|makeaclitem|acldefault|aclexplode|aclcontains|aclinsert|aclremove|aclitemin|aclitemout)$/, why: NAMES_BY_ID },
  // Input functions that take a type by its id: enum_in('x', 16400) names the
  // type in its error and confirms its labels.
  { test: /^(enum|domain|record|array|range|multirange|anyrange|anymultirange|anycompatiblerange|anycompatiblemultirange)_in$/, why: OPENS_BY_ID },
  // currval(16400) answers '"orders" is not a sequence' for any relation id.
  { test: /^(currval|nextval|setval|satisfies_hash_partition|brin_summarize_new_values|brin_summarize_range|brin_desummarize_range|gin_clean_pending_list)$/, why: OPENS_BY_ID },
  { test: /^fmgr_/, why: OPENS_BY_ID },
  { test: /^(pgstattuple|pgstattuple_approx|pgstatindex|pgstatginindex|pgstathashindex|pgrowlocks)$/, why: OPENS_BY_ID },
  { test: /^set_config$/, why: 'it changes the settings this statement was checked under' },
  { test: LARGE_OBJECT_FUNCTIONS, why: 'large objects belong to the whole database, not this project' },
]

/**
 * Why a function is refused, or null. `call` is a call by name, where any lo_
 * function is refused, including one a later release adds; a field name
 * (`(x).lo_bound`) is refused only for the large-object functions that exist.
 */
function refusedRoutine(name: string, call: boolean): string | null {
  const lower = name.toLowerCase()
  for (const rule of ROUTINE_RULES) if (rule.test.test(lower)) return rule.why
  if (call && lower.indexOf('lo_') === 0) return 'large objects belong to the whole database, not this project'
  return null
}

/** Why a type is refused, or null. A function-style cast (`regclass(x)`) names a type too. */
function refusedType(name: string): string | null {
  const lower = name.toLowerCase()
  if (/^_?pg_/.test(lower)) return 'it is a PostgreSQL system type'
  if (OID_ALIAS_TYPE.test(lower)) return NAMES_BY_ID
  if (/^_?aclitem$/.test(lower)) return 'it names roles from the shared catalog'
  return null
}
