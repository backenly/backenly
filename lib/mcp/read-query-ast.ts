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
 * A pattern over the text cannot do that. The text check this module sits in
 * front of blanked double-quoted identifiers as if they were string literals,
 * so `SELECT proname, prosrc FROM "pg_proc"` read every project's function
 * source again. This module parses the statement with PostgreSQL's own parser
 * (libpg-query: pganalyze's libpg_query built as WebAssembly, the PostgreSQL 16
 * grammar the server runs) and walks the whole tree.
 *
 * ── Allowlists, not a deny list ─────────────────────────────────────────────
 *
 * PostgreSQL has thousands of built-in functions, and enough of them reach the
 * catalog by a name or an object id that no list of the dangerous ones stays
 * complete: query_to_xml and ts_stat run a query given as text,
 * `16400::regnamespace` and oidvectortypes turn ids into other projects' names,
 * currval names any relation in its error. A first version refused those by
 * name, and review still found ones it missed. So the statement may use only
 * what is listed here:
 *
 *   - functions: FUNCTIONS, a fixed set of side-effect-free built-ins agents
 *     need (aggregates, window, math, string, date and time, JSON, array,
 *     range and full-text search), called bare or as pg_catalog.name;
 *   - types, for casts, typed literals and column definitions: TYPES;
 *   - settings, for SHOW: SETTINGS;
 *   - relations: any in this project's own schema, none named pg_* or in a
 *     catalog schema, none in another schema.
 *
 * Column notation is a function call too: PostgreSQL reads `g.f` as f(g) when
 * the FROM item g has no column f, and a function in FROM hands that call its
 * scalar value (`SELECT g.regnamespace FROM generate_series(16384, 20000) g`
 * listed every project's schema). See checkColumnRef.
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
  | 'FUNCTION_NOT_ALLOWED'
  | 'TYPE_NOT_ALLOWED'
  | 'SETTING_NOT_ALLOWED'
  | 'SYNTAX_ERROR'
  | 'SQL_PARSER_UNAVAILABLE'

export interface StatementRefusal {
  code: StatementRefusalCode
  message: string
  /** Which of read-query.ts's hints the caller is given. */
  hint?: 'verb' | 'write' | 'multi' | 'catalog' | 'schema' | 'function' | 'type' | 'setting'
  /** 503 when Backenly could not check the statement at all; otherwise it is the caller's statement (400). */
  status?: number
}

/**
 * What the statement is, from its parse tree. read-query.ts wraps a `select` in
 * its row cap and passes `explain` and `show` through, decided from this and
 * never from the text: a nested comment once made a SELECT read as SHOW.
 */
export type StatementKind = 'select' | 'explain' | 'show'

/**
 * A plain record rather than a union: this repository's tsconfig (strict off)
 * does not narrow a union on a boolean discriminant.
 */
export interface StatementVerdict {
  /** Why the statement may not run, or null when it may. */
  refusal: StatementRefusal | null
  /** What the statement is. Meaningful only when refusal is null. */
  kind: StatementKind
}

export const PARSER_UNAVAILABLE =
  "Backenly couldn't load its SQL parser, so the query didn't run. Try again in a minute. " +
  'If it keeps failing, contact support.'

// ── The allowlists ───────────────────────────────────────────────────────────

/**
 * The functions a statement may call, by name, bare or as pg_catalog.name. All
 * are PostgreSQL 16 built-ins (checked against pg_proc.dat) that compute from
 * their arguments alone: none reads a catalog by name or object id, runs SQL
 * given as text, changes a setting, or touches anything outside the statement.
 *
 * Left out on purpose, besides everything that reads the catalog: repeat, lpad,
 * rpad, array_fill and factorial, which allocate whatever size they are asked
 * for; get_current_ts_config and every other function that returns an OID alias
 * type, whose value can carry any object id into that type; current_setting,
 * version and inet_server_addr, which describe the server, not the project.
 *
 * It also holds the names the grammar writes itself (EXTRACT, AT TIME ZONE,
 * OVERLAPS, SIMILAR TO, LIKE ... ESCAPE, TRIM, SUBSTRING, POSITION, OVERLAY,
 * NORMALIZE, IS NORMALIZED), and the type names of TYPES, which PostgreSQL
 * reads as casts when called like functions (`date(created_at)`).
 */
const FUNCTIONS = new Set([
  // Aggregates.
  'count', 'sum', 'avg', 'min', 'max', 'bool_and', 'bool_or', 'every', 'bit_and', 'bit_or', 'bit_xor',
  'string_agg', 'array_agg', 'json_agg', 'jsonb_agg', 'json_agg_strict', 'jsonb_agg_strict',
  'json_object_agg', 'jsonb_object_agg', 'json_object_agg_strict', 'jsonb_object_agg_strict',
  'json_object_agg_unique', 'jsonb_object_agg_unique', 'json_object_agg_unique_strict', 'jsonb_object_agg_unique_strict',
  'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp', 'corr', 'covar_pop', 'covar_samp',
  'regr_avgx', 'regr_avgy', 'regr_count', 'regr_intercept', 'regr_r2', 'regr_slope', 'regr_sxx', 'regr_sxy',
  'regr_syy', 'percentile_cont', 'percentile_disc', 'mode', 'any_value',
  // Window functions.
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value',
  'last_value', 'nth_value',
  // Math.
  'abs', 'cbrt', 'ceil', 'ceiling', 'degrees', 'div', 'exp', 'floor', 'gcd', 'lcm', 'ln', 'log', 'log10',
  'min_scale', 'mod', 'pi', 'power', 'radians', 'round', 'scale', 'sign', 'sqrt', 'trim_scale', 'trunc',
  'width_bucket', 'random', 'random_normal', 'acos', 'acosd', 'asin', 'asind', 'atan', 'atand', 'atan2',
  'atan2d', 'cos', 'cosd', 'cot', 'cotd', 'sin', 'sind', 'tan', 'tand', 'sinh', 'cosh', 'tanh', 'asinh',
  'acosh', 'atanh',
  // Strings.
  'length', 'char_length', 'character_length', 'octet_length', 'bit_length', 'lower', 'upper', 'initcap',
  'btrim', 'ltrim', 'rtrim', 'substr', 'substring', 'left', 'right', 'position', 'strpos', 'replace',
  'translate', 'reverse', 'split_part', 'concat', 'concat_ws', 'format', 'quote_ident', 'quote_literal',
  'quote_nullable', 'md5', 'sha224', 'sha256', 'sha384', 'sha512', 'encode', 'decode', 'ascii', 'chr',
  'starts_with', 'to_hex', 'regexp_count', 'regexp_instr', 'regexp_like', 'regexp_match', 'regexp_matches',
  'regexp_replace', 'regexp_split_to_array', 'regexp_split_to_table', 'regexp_substr', 'string_to_array',
  'string_to_table', 'array_to_string', 'normalize', 'is_normalized', 'unistr', 'overlay',
  'similar_to_escape', 'like_escape', 'convert_from', 'convert_to', 'to_char', 'to_number', 'to_date',
  'to_timestamp',
  // Dates and times.
  'age', 'clock_timestamp', 'date_add', 'date_subtract', 'date_bin', 'date_part', 'date_trunc', 'extract',
  'isfinite', 'justify_days', 'justify_hours', 'justify_interval', 'make_date', 'make_interval', 'make_time',
  'make_timestamp', 'make_timestamptz', 'now', 'statement_timestamp', 'transaction_timestamp', 'timeofday',
  'timezone', 'overlaps',
  // JSON.
  'to_json', 'to_jsonb', 'array_to_json', 'row_to_json', 'json_build_array', 'jsonb_build_array',
  'json_build_object', 'jsonb_build_object', 'json_object', 'jsonb_object', 'json_array_elements',
  'jsonb_array_elements', 'json_array_elements_text', 'jsonb_array_elements_text', 'json_array_length',
  'jsonb_array_length', 'json_each', 'jsonb_each', 'json_each_text', 'jsonb_each_text', 'json_extract_path',
  'jsonb_extract_path', 'json_extract_path_text', 'jsonb_extract_path_text', 'json_object_keys',
  'jsonb_object_keys', 'json_to_record', 'jsonb_to_record', 'json_to_recordset', 'jsonb_to_recordset',
  'json_strip_nulls', 'jsonb_strip_nulls', 'json_typeof', 'jsonb_typeof', 'jsonb_set', 'jsonb_set_lax',
  'jsonb_insert', 'jsonb_pretty', 'jsonb_path_exists', 'jsonb_path_match', 'jsonb_path_query',
  'jsonb_path_query_array', 'jsonb_path_query_first', 'jsonb_path_exists_tz', 'jsonb_path_match_tz',
  'jsonb_path_query_tz', 'jsonb_path_query_array_tz', 'jsonb_path_query_first_tz',
  // Arrays and set-returning functions (the row cap holds: read-query.ts wraps every SELECT).
  'array_append', 'array_cat', 'array_dims', 'array_length', 'array_lower', 'array_ndims', 'array_position',
  'array_positions', 'array_prepend', 'array_remove', 'array_replace', 'array_sample', 'array_shuffle',
  'array_upper', 'cardinality', 'trim_array', 'unnest', 'generate_subscripts', 'generate_series',
  // Ranges.
  'int4range', 'int8range', 'numrange', 'daterange', 'tsrange', 'tstzrange', 'isempty', 'lower_inc',
  'upper_inc', 'lower_inf', 'upper_inf', 'range_merge',
  // Full-text search. A configuration is named by a string literal ('english'),
  // never cast; ts_stat and ts_rewrite, which run SQL text, are not here.
  'to_tsvector', 'to_tsquery', 'plainto_tsquery', 'phraseto_tsquery', 'websearch_to_tsquery', 'ts_rank',
  'ts_rank_cd', 'ts_headline', 'setweight', 'strip', 'numnode', 'querytree', 'tsvector_to_array',
  'array_to_tsvector', 'ts_delete', 'ts_filter', 'json_to_tsvector', 'jsonb_to_tsvector', 'tsquery_phrase',
  // Other.
  'gen_random_uuid', 'num_nulls', 'num_nonnulls',
  // Casts written as calls.
  'text', 'varchar', 'bpchar', 'int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'bool', 'date', 'time',
  'timetz', 'timestamp', 'timestamptz', 'interval', 'json', 'jsonb', 'uuid', 'bytea', 'tsvector', 'tsquery',
])

/**
 * The types a cast, a typed literal or a column definition may name, as the
 * parser spells them (`integer` is int4, `double precision` float8, `char(n)`
 * bpchar), and arrays of them. Not the OID alias types (regclass and the rest,
 * whose output names any object), oid, oidvector, pg_* or any type in a schema.
 */
const TYPES = new Set([
  'text', 'varchar', 'bpchar', 'int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'bool', 'date', 'time',
  'timetz', 'timestamp', 'timestamptz', 'interval', 'json', 'jsonb', 'uuid', 'bytea', 'tsvector', 'tsquery',
])

/**
 * Settings SHOW may read: how values are formatted and what the session is.
 * Not SHOW ALL, which lists settings the platform and its operators set.
 */
const SETTINGS = new Set([
  'timezone', 'datestyle', 'intervalstyle', 'server_version', 'server_version_num',
  'standard_conforming_strings', 'client_encoding', 'server_encoding', 'search_path', 'integer_datetimes',
  'max_identifier_length', 'extra_float_digits', 'statement_timeout', 'transaction_isolation',
  'transaction_read_only', 'default_text_search_config', 'bytea_output', 'lc_collate', 'lc_ctype',
  'lc_monetary', 'lc_numeric', 'lc_time',
])

/** TABLESAMPLE methods: the two built in. */
const SAMPLE_METHODS = new Set(['system', 'bernoulli'])

/**
 * Columns that set-returning functions on FUNCTIONS name themselves: json_each's
 * key and value, json_array_elements' value, unnest(tsvector)'s lexeme,
 * positions and weights, and WITH ORDINALITY's ordinality. None is the name of a
 * function, so reading one can never be a call.
 */
const RECORD_FIELDS = new Set(['key', 'value', 'lexeme', 'positions', 'weights', 'ordinality'])

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
 * Parse `sql` and check it. `ownSchema` is the project's workspace schema, the
 * only one a statement may name.
 */
export async function checkReadQuery(sql: string, ownSchema: string): Promise<StatementVerdict> {
  // libpg_query reads a C string, and so does the server: a NUL would end the
  // statement early, so whatever followed it would never be checked.
  if (sql.indexOf('\u0000') !== -1) {
    return refuse({ code: 'SYNTAX_ERROR', message: 'The statement contains a NUL character (U+0000), which PostgreSQL does not accept.' })
  }

  let lib: Parser
  try {
    lib = await loadParser()
  } catch (err) {
    console.error(`[read-query] the SQL parser could not be loaded, so no read query can run: ${errorText(err)}`)
    return refuse({ code: 'SQL_PARSER_UNAVAILABLE', message: PARSER_UNAVAILABLE, status: 503 })
  }

  let tree: unknown
  try {
    tree = await lib.parse(sql)
  } catch (err) {
    // Never fall back to running a statement that did not parse: whatever the
    // parser could not read, this check cannot vouch for.
    return refuse({ code: 'SYNTAX_ERROR', message: `The statement could not be parsed: ${errorText(err)}` })
  }
  return inspectParseTree(tree, ownSchema)
}

/** checkReadQuery, answering only why not: null when the statement may run. */
export async function inspectReadQuery(sql: string, ownSchema: string): Promise<StatementRefusal | null> {
  return (await checkReadQuery(sql, ownSchema)).refusal
}

function refuse(refusal: StatementRefusal): StatementVerdict {
  return { refusal, kind: 'select' }
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

/** Inspect a parse tree. Pure: no parser, no database. */
export function inspectParseTree(tree: unknown, ownSchema: string): StatementVerdict {
  if (!isObject(tree)) return refuse({ code: 'SYNTAX_ERROR', message: 'The statement could not be parsed.' })
  // libpg_query leaves an empty list out of its JSON entirely.
  const stmts = Array.isArray(tree.stmts) ? tree.stmts : []
  if (stmts.length === 0) {
    return refuse({ code: 'EMPTY_QUERY', message: 'Empty query: the statement holds only comments or semicolons.' })
  }
  if (stmts.length > 1) return refuse(MULTI_STATEMENT)

  const raw = stmts[0]
  const stmt = isObject(raw) && isObject(raw.stmt) ? (raw.stmt as JsonObject) : null
  const nodeType = stmt ? Object.keys(stmt)[0] : undefined
  const body = stmt && nodeType ? stmt[nodeType] : undefined
  if (!stmt || !nodeType || !isObject(body)) return refuse({ code: 'SYNTAX_ERROR', message: 'The statement could not be parsed.' })

  // The statements the text check has always admitted: SELECT (WITH, TABLE and
  // VALUES parse as one), EXPLAIN of a SELECT without ANALYZE, and SHOW.
  let kind: StatementKind
  if (nodeType === 'SelectStmt') {
    kind = 'select'
  } else if (nodeType === 'ExplainStmt') {
    const options = Array.isArray(body.options) ? body.options : []
    // ANALYZE and ANALYSE both parse to the option "analyze", in either form
    // (EXPLAIN ANALYZE ..., EXPLAIN (ANALYSE) ...). It executes the statement.
    const analyzes = options.some((option) => {
      const def = isObject(option) ? option.DefElem : undefined
      return isObject(def) && String(def.defname).toLowerCase() === 'analyze'
    })
    if (analyzes) return refuse(EXPLAIN_ANALYZE)
    const explained = body.query
    const query = isObject(explained) ? Object.keys(explained)[0] : undefined
    if (query !== 'SelectStmt') {
      return refuse({ code: 'NOT_READ_ONLY', message: 'run_query explains only a SELECT.', hint: 'write' })
    }
    kind = 'explain'
  } else if (nodeType === 'VariableShowStmt') {
    const setting = text(body.name)
    if (!SETTINGS.has(setting.toLowerCase())) {
      return refuse({
        code: 'SETTING_NOT_ALLOWED',
        message: `run_query does not show "${setting}". It shows only these settings: ${Array.from(SETTINGS).join(', ')}.`,
        hint: 'setting',
      })
    }
    return { refusal: null, kind: 'show' }
  } else {
    return refuse(NOT_A_READ)
  }

  const refusal = walk(body, ownSchema, collectFromItems(body))
  return refusal ? refuse(refusal) : { refusal: null, kind }
}

/**
 * Every list of names whose last element is the thing named and whose earlier
 * elements qualify it, keyed by the field that holds it.
 */
type NameKind = 'function' | 'type' | 'operator' | 'collation' | 'sample method'

const QUALIFIED_NAMES: { [key: string]: NameKind } = {
  funcname: 'function', //       FuncCall
  method: 'sample method', //    RangeTableSample
  names: 'type', //              TypeName, a field of TypeCast, ColumnDef, RangeTableFuncCol, XmlSerialize, JsonOutput
  name: 'operator', //           A_Expr (a list only there; `name` is a plain string elsewhere)
  operName: 'operator', //       SubLink: x OPERATOR(s.=) ANY (subquery)
  useOp: 'operator', //          SortBy: ORDER BY x USING OPERATOR(s.<)
  collname: 'collation', //      CollateClause
}

/** The text of a `{ "String": { "sval": … } }` node: an identifier, never a literal. */
function stringNode(node: unknown): string | null {
  if (!isObject(node)) return null
  const keys = Object.keys(node)
  if (keys.length !== 1 || keys[0] !== 'String') return null
  const inner = node.String
  return isObject(inner) ? text(inner.sval) : ''
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Walk every node. Iterative, so a deeply nested statement cannot overflow the
 * stack and end the check early.
 */
function walk(root: JsonObject, ownSchema: string, items: FromItems): StatementRefusal | null {
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
      if (key === 'fields') {
        // ColumnRef.fields: a, a.b, s.a.b, with * for a whole row.
        const refusal = checkColumnRef(node, items)
        if (refusal) return refusal
        continue
      }
      if (key === 'indirection') {
        // A_Indirection.indirection: (expr).f, (expr)[i], (expr).*
        for (const element of node) {
          const name = stringNode(element)
          if (name === null) {
            stack.push({ node: element, key: '' }) // subscripts, *
            continue
          }
          const refusal = checkField(name)
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

// ── FROM items, for column notation ──────────────────────────────────────────

interface FromItem {
  /** A function in FROM: its whole-row value can be a scalar, which column notation hands to a call. */
  isFunction: boolean
  /** Its column names, as far as the statement says them. */
  columns: string[]
}

interface FromItems {
  byName: Map<string, FromItem[]>
  /** A function in FROM with no alias and a name this check cannot tell: every qualifier is treated as naming it. */
  unnamedFunction: boolean
}

function aliasName(alias: unknown): string {
  return isObject(alias) ? text(alias.aliasname) : ''
}

function aliasColumns(alias: unknown): string[] {
  const colnames = isObject(alias) ? alias.colnames : undefined
  if (!Array.isArray(colnames)) return []
  return colnames.map(stringNode).filter((n): n is string => n !== null)
}

/** The elements of a list as libpg_query writes it: a JSON array, or `{ "List": { "items": [...] } }`. */
function listItems(node: unknown): unknown[] {
  if (Array.isArray(node)) return node
  const list = isObject(node) ? node.List : undefined
  const items = isObject(list) ? list.items : undefined
  return Array.isArray(items) ? items : []
}

/** The node a `{ "Type": { … } }` wrapper holds, or undefined. */
function wrapped(node: unknown, type: string): JsonObject | undefined {
  const inner = isObject(node) ? node[type] : undefined
  return isObject(inner) ? inner : undefined
}

function columnDefNames(node: unknown): string[] {
  return listItems(node)
    .map((def) => text(wrapped(def, 'ColumnDef')?.colname))
    .filter(Boolean)
}

/**
 * Every item of every FROM clause in the statement, by the name a qualifier
 * reaches it with: its alias, a table's own name when it has none, and for a
 * function with none, the function's name (PostgreSQL's own default). Scoping is
 * deliberately ignored: a name any function item answers to is a function's,
 * at every level, so an inner item can never hide behind an outer table.
 */
function collectFromItems(root: JsonObject): FromItems {
  const byName = new Map<string, FromItem[]>()
  let unnamedFunction = false
  const add = (name: string, item: FromItem) => {
    if (!name) return
    const list = byName.get(name)
    if (list) list.push(item)
    else byName.set(name, [item])
  }

  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      for (const element of node) stack.push(element)
      continue
    }
    if (!isObject(node)) continue

    // A table, view or CTE: its whole row is a composite value, which none of
    // the refused functions accepts.
    const relname = node.relname
    if (typeof relname === 'string') add(aliasName(node.alias) || relname, { isFunction: false, columns: [] })
    const subselect = wrapped(node, 'RangeSubselect')
    if (subselect) add(aliasName(subselect.alias), { isFunction: false, columns: [] })
    const tableFunc = wrapped(node, 'RangeTableFunc')
    if (tableFunc) add(aliasName(tableFunc.alias) || 'xmltable', { isFunction: false, columns: [] })
    const join = wrapped(node, 'JoinExpr')
    if (join) {
      add(aliasName(join.alias), { isFunction: false, columns: [] })
      add(aliasName(join.join_using_alias), { isFunction: false, columns: [] })
    }

    const rangeFunction = wrapped(node, 'RangeFunction')
    if (rangeFunction) {
      const names: string[] = []
      const columns: string[] = aliasColumns(rangeFunction.alias).concat(columnDefNames(rangeFunction.coldeflist))
      let unnamed = false
      for (const entry of listItems(rangeFunction.functions)) {
        const parts = listItems(entry)
        const call = wrapped(parts[0], 'FuncCall')
        const funcname = call ? listItems(call.funcname).map(stringNode) : []
        const last = funcname.length > 0 ? funcname[funcname.length - 1] : null
        if (last) names.push(last)
        else unnamed = true
        columns.push(...columnDefNames(parts[1]))
      }
      const alias = aliasName(rangeFunction.alias)
      // A function returning one value names its column after its alias, or
      // after itself when it has none.
      const item: FromItem = { isFunction: true, columns: columns.concat(alias ? [alias] : names) }
      if (alias) add(alias, item)
      else if (unnamed) unnamedFunction = true
      else for (const name of names) add(name, item)
    }

    for (const field of Object.keys(node)) stack.push(node[field])
  }
  return { byName, unnamedFunction }
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

function catalogRefusal(what: string): StatementRefusal {
  return {
    code: 'CATALOG_NOT_READABLE',
    message: `run_query does not read the PostgreSQL system catalogs (refused ${what}: ${SHARED}).`,
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

function functionRefusal(name: string, how = ''): StatementRefusal {
  return {
    code: 'FUNCTION_NOT_ALLOWED',
    message:
      `run_query does not call ${name}()${how}. It calls only the built-in aggregate, window, math, string, ` +
      'date and time, JSON, array, range and full-text search functions on its list.',
    hint: 'function',
  }
}

function typeRefusal(name: string): StatementRefusal {
  return {
    code: 'TYPE_NOT_ALLOWED',
    message:
      `run_query does not cast to ${name}. It casts only to text, varchar, char, smallint, integer, bigint, ` +
      'numeric, real, double precision, boolean, date, time, timestamp, interval, json, jsonb, uuid, bytea, ' +
      'tsvector and tsquery, and arrays of them.',
    hint: 'type',
  }
}

/** The pg_ prefix and information_schema, wherever an identifier appears. */
function checkName(name: string): StatementRefusal | null {
  return isCatalogName(name) ? catalogRefusal(`"${name}"`) : null
}

function checkRelation(rv: JsonObject, ownSchema: string): StatementRefusal | null {
  const relname = text(rv.relname)
  const schemaname = text(rv.schemaname)
  const catalogname = text(rv.catalogname)
  const shown = `relation "${[catalogname, schemaname, relname].filter(Boolean).join('.')}"`
  // Unqualified, a pg_ name resolves in pg_catalog first, before the project's
  // schema, so the prefix alone decides it.
  if (isCatalogName(relname) || isCatalogName(schemaname) || isCatalogName(catalogname)) return catalogRefusal(shown)
  if (catalogname) return schemaRefusal(shown, catalogname)
  if (schemaname && schemaname !== ownSchema) return schemaRefusal(shown, schemaname)
  return null
}

/**
 * A function, type, operator, collation or TABLESAMPLE method, qualified or not.
 *
 * A function or type may be qualified only with pg_catalog, which the grammar
 * writes itself (`x::integer` parses as pg_catalog.int4, EXTRACT as
 * pg_catalog.extract) and which is searched first for every unqualified name
 * anyway; what it names must then be on FUNCTIONS or TYPES. Operators and
 * collations may also name the project's own schema. Any other qualifier is
 * refused: `public` holds extensions and platform helpers, and another
 * project's schema holds another project.
 */
function checkQualifiedName(kind: NameKind, parts: string[], ownSchema: string): StatementRefusal | null {
  if (parts.length === 0) return null
  const base = parts[parts.length - 1]
  const qualifiers = parts.slice(0, -1)
  const shown = `${kind} "${parts.join('.')}"`
  if (qualifiers.length > 0) {
    const schema = qualifiers[qualifiers.length - 1]
    const ownAllowed = kind === 'operator' || kind === 'collation'
    const allowed = qualifiers.length === 1 && (schema === 'pg_catalog' || (ownAllowed && schema === ownSchema))
    if (!allowed) {
      if (qualifiers.some(isCatalogName)) return catalogRefusal(shown)
      if (schema === ownSchema) return kind === 'type' ? typeRefusal(parts.join('.')) : functionRefusal(parts.join('.'))
      return schemaRefusal(shown, qualifiers[0])
    }
  }
  if (kind === 'function' && !FUNCTIONS.has(base)) return functionRefusal(base)
  if (kind === 'type' && !TYPES.has(base)) return typeRefusal(base)
  if (kind === 'sample method' && !SAMPLE_METHODS.has(base)) return functionRefusal(base, ' as a TABLESAMPLE method')
  return null
}

/**
 * Column notation, which is a function call when it names no column.
 *
 * PostgreSQL reads a qualified column reference `q.b` as column b of the FROM
 * item q, and when q has no column b, as the call b(q) on q's whole row
 * (transformColumnRef in src/backend/parser/parse_expr.c; a bare `b` is never a
 * call). The whole row of a table, view, subquery, CTE, join or XMLTABLE is a
 * composite value, and no built-in that is off FUNCTIONS accepts one (PG16's
 * single-argument functions on record, any, anyelement and the like are hashes,
 * output functions, aggregates and JSON builders). The whole row of a function
 * in FROM is that function's scalar, which any call accepts: that is how
 * `g.regnamespace` and `t.ts_stat` read other projects.
 *
 * So when q names a function in FROM anywhere in the statement, or names no
 * FROM item at all, b must be a column that item declares (its alias and alias
 * columns, its column definition list, the RECORD_FIELDS functions name), or a
 * function on FUNCTIONS. A table's columns are never restricted, so ordinary
 * column names keep working.
 */
function checkColumnRef(fields: unknown[], items: FromItems): StatementRefusal | null {
  const names = fields.map(stringNode)
  for (const name of names) {
    if (name === null) continue
    const refused = checkName(name)
    if (refused) return refused
  }
  if (names.length < 2) return null
  const last = names[names.length - 1]
  const qualifier = names[names.length - 2]
  if (last === null || qualifier === null) return null // q.*

  const named = items.byName.get(qualifier) ?? []
  const functions = named.filter((item) => item.isFunction)
  const strict = items.unnamedFunction || named.length === 0 || functions.length > 0
  if (!strict) return null
  // A column only when EVERY function the name could reach declares it: an
  // outer `generate_series(...) AS g(regclass)` declaring the column must not
  // vouch for an inner `generate_series(...) g`, which PostgreSQL resolves
  // first and which has no such column. A function this check cannot name
  // declares nothing.
  const declared =
    !items.unnamedFunction && functions.length > 0 && functions.every((item) => item.columns.indexOf(last) !== -1)
  if (declared) return null
  if (RECORD_FIELDS.has(last) || FUNCTIONS.has(last)) return null
  return functionRefusal(
    last,
    ` as ${qualifier}.${last} (with no such column, PostgreSQL reads that as ${last}(${qualifier}); ` +
      `select a column ${qualifier} declares, or give the function in FROM an alias with column names)`,
  )
}

/**
 * A field selected from a value, `(expr).name`. PostgreSQL reads that as a
 * call, name(expr), whenever expr has no such field, whatever its type
 * (ParseFuncOrColumn in src/backend/parser/parse_func.c), so
 * `(16400::oid).obj_description` is a call and `(16400).regclass` a cast. The
 * name must be a function on FUNCTIONS or one of RECORD_FIELDS; a table's
 * column is read as `alias.column` instead.
 */
function checkField(name: string): StatementRefusal | null {
  const refused = checkName(name)
  if (refused) return refused
  if (RECORD_FIELDS.has(name) || FUNCTIONS.has(name)) return null
  return functionRefusal(name, ` as (...).${name}, which PostgreSQL reads as a call when the value has no such field (select alias.column instead)`)
}
