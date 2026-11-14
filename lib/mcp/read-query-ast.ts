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
 *     range, network address and full-text search), called bare or as
 *     pg_catalog.name;
 *   - operators: OPERATORS, PostgreSQL's own, bare or as OPERATOR(pg_catalog.x);
 *   - types, for casts, typed literals and column definitions: TYPES;
 *   - settings, for SHOW: SETTINGS; EXPLAIN options: COSTS, FORMAT TEXT or JSON;
 *   - relations: any in this project's own schema, none named pg_* or in a
 *     catalog schema, none in another schema; no system column.
 *
 * Column notation is a function call too: PostgreSQL reads `g.f` as f(g) when
 * the FROM item g has no column f, and a function in FROM hands that call its
 * scalar value (`SELECT g.regnamespace FROM generate_series(16384, 20000) g`
 * listed every project's schema). checkColumnRef works out a FROM function's
 * columns the way PostgreSQL does (functionItem).
 *
 * The parse tree cannot see code in the project's own schema, which
 * search_path reaches: a function lower(int) there is picked over the
 * built-in for lower(1). So the verdict lists every name the statement leaves
 * to search_path (calls, operators), and read-query.ts refuses the statement
 * when the project's schema defines one of them.
 *
 * ── What one statement may cost ─────────────────────────────────────────────
 *
 * A few listed built-ins are sized by an argument: format('%100000000s', '')
 * built a 100 MB value, ''::char(10485760) a 10 MB one, and generate_series in
 * FROM makes every row before the row cap applies (two billion of them wrote a
 * gigabyte of temporary files in six seconds). Those take literal arguments
 * this check bounds (checkCall, checkTypeModifiers, checkRangeFunction). A
 * value grown by repetition it cannot bound: `s || s` in a recursive CTE
 * doubles a string per row, and no allowlist can refuse ||. PostgreSQL's 1 GB
 * limit on any one value, read-query.ts's statement timeout and the read-only
 * role's three connections bound that, and the server's temp_file_limit bounds
 * temporary files.
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
  | 'OPERATOR_NOT_ALLOWED'
  | 'TYPE_NOT_ALLOWED'
  | 'SETTING_NOT_ALLOWED'
  | 'EXPLAIN_OPTION_NOT_ALLOWED'
  | 'QUERY_TOO_EXPENSIVE'
  | 'SYNTAX_ERROR'
  | 'SQL_PARSER_UNAVAILABLE'

/** Which of read-query.ts's hints a refused caller is given. */
export type RefusalHint =
  | 'verb'
  | 'write'
  | 'multi'
  | 'catalog'
  | 'systemColumn'
  | 'schema'
  | 'function'
  | 'operator'
  | 'type'
  | 'setting'
  | 'explain'
  | 'expensive'

export interface StatementRefusal {
  code: StatementRefusalCode
  message: string
  hint?: RefusalHint
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
  /**
   * The names PostgreSQL looks up through search_path when it runs the
   * statement: the functions it may call unqualified (by name, or by column
   * notation), and the operators it may apply, those written and the
   * comparisons that IN, CASE, JOIN USING and BETWEEN apply. The project's
   * schema is on that path, so read-query.ts refuses the statement when the
   * schema defines one of them. Empty when the statement is refused.
   */
  calls: string[]
  operators: string[]
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
 * format, lpad, rpad, repeat, generate_series and the text search functions
 * are allowed only with the literal arguments checkCall and checkRangeFunction
 * read.
 *
 * Left out on purpose, besides everything that reads the catalog: array_fill
 * and factorial, which allocate whatever size they are asked for; bpchar() and
 * varchar() as calls, which take a length as an argument (bpchar pads to it);
 * get_current_ts_config and every other function that returns an OID alias
 * type, whose value can carry any object id into that type; current_setting,
 * version and inet_server_addr, which describe the server, not the project.
 *
 * It also holds the names the grammar writes itself (EXTRACT, AT TIME ZONE,
 * OVERLAPS, SIMILAR TO, LIKE ... ESCAPE, TRIM, SUBSTRING, POSITION, OVERLAY,
 * NORMALIZE, IS NORMALIZED), and type names of TYPES, which PostgreSQL reads
 * as casts when called like functions (`date(created_at)`).
 */
const FUNCTIONS = new Set([
  // Aggregates.
  'count', 'sum', 'avg', 'min', 'max', 'bool_and', 'bool_or', 'every', 'bit_and', 'bit_or', 'bit_xor',
  'string_agg', 'array_agg', 'json_agg', 'jsonb_agg', 'json_agg_strict', 'jsonb_agg_strict',
  'json_object_agg', 'jsonb_object_agg', 'json_object_agg_strict', 'jsonb_object_agg_strict',
  'json_object_agg_unique', 'jsonb_object_agg_unique', 'json_object_agg_unique_strict', 'jsonb_object_agg_unique_strict',
  'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp', 'corr', 'covar_pop', 'covar_samp',
  'regr_avgx', 'regr_avgy', 'regr_count', 'regr_intercept', 'regr_r2', 'regr_slope', 'regr_sxx', 'regr_sxy',
  'regr_syy', 'percentile_cont', 'percentile_disc', 'mode', 'any_value', 'range_agg', 'range_intersect_agg',
  // Window functions.
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value',
  'last_value', 'nth_value',
  // Math.
  'abs', 'cbrt', 'ceil', 'ceiling', 'degrees', 'div', 'exp', 'floor', 'gcd', 'lcm', 'ln', 'log', 'log10',
  'min_scale', 'mod', 'pi', 'power', 'radians', 'round', 'scale', 'sign', 'sqrt', 'trim_scale', 'trunc',
  'width_bucket', 'random', 'random_normal', 'acos', 'acosd', 'asin', 'asind', 'atan', 'atand', 'atan2',
  'atan2d', 'cos', 'cosd', 'cot', 'cotd', 'sin', 'sind', 'tan', 'tand', 'sinh', 'cosh', 'tanh', 'asinh',
  'acosh', 'atanh',
  // Strings. lpad, rpad and repeat with literal sizes only (checkCall).
  'length', 'char_length', 'character_length', 'octet_length', 'bit_length', 'lower', 'upper', 'initcap',
  'btrim', 'ltrim', 'rtrim', 'substr', 'substring', 'left', 'right', 'position', 'strpos', 'replace',
  'translate', 'reverse', 'split_part', 'concat', 'concat_ws', 'format', 'quote_ident', 'quote_literal',
  'quote_nullable', 'md5', 'sha224', 'sha256', 'sha384', 'sha512', 'encode', 'decode', 'ascii', 'chr',
  'starts_with', 'to_hex', 'regexp_count', 'regexp_instr', 'regexp_like', 'regexp_match', 'regexp_matches',
  'regexp_replace', 'regexp_split_to_array', 'regexp_split_to_table', 'regexp_substr', 'string_to_array',
  'string_to_table', 'array_to_string', 'normalize', 'is_normalized', 'unistr', 'overlay',
  'similar_to_escape', 'like_escape', 'convert_from', 'convert_to', 'to_char', 'to_number', 'to_date',
  'to_timestamp', 'lpad', 'rpad', 'repeat',
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
  // Arrays and set-returning functions. generate_series in FROM with bounds checkRangeFunction can count.
  'array_append', 'array_cat', 'array_dims', 'array_length', 'array_lower', 'array_ndims', 'array_position',
  'array_positions', 'array_prepend', 'array_remove', 'array_replace', 'array_sample', 'array_shuffle',
  'array_upper', 'cardinality', 'trim_array', 'unnest', 'generate_subscripts', 'generate_series',
  // Ranges and multiranges.
  'int4range', 'int8range', 'numrange', 'daterange', 'tsrange', 'tstzrange', 'int4multirange', 'int8multirange',
  'nummultirange', 'datemultirange', 'tsmultirange', 'tstzmultirange', 'multirange', 'isempty', 'lower_inc',
  'upper_inc', 'lower_inf', 'upper_inf', 'range_merge',
  // Network addresses.
  'abbrev', 'broadcast', 'family', 'host', 'hostmask', 'inet_merge', 'inet_same_family', 'masklen', 'netmask',
  'network', 'set_masklen',
  // Full-text search. A configuration is a string literal naming a built-in one
  // ('english'), never anything else (checkCall); ts_stat and ts_rewrite, which
  // run SQL text, are not here.
  'to_tsvector', 'to_tsquery', 'plainto_tsquery', 'phraseto_tsquery', 'websearch_to_tsquery', 'ts_rank',
  'ts_rank_cd', 'ts_headline', 'setweight', 'strip', 'numnode', 'querytree', 'tsvector_to_array',
  'array_to_tsvector', 'ts_delete', 'ts_filter', 'json_to_tsvector', 'jsonb_to_tsvector', 'tsquery_phrase',
  // Other.
  'gen_random_uuid', 'num_nulls', 'num_nonnulls',
  // Casts written as calls.
  'text', 'int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'bool', 'date', 'time', 'timetz', 'timestamp',
  'timestamptz', 'interval', 'json', 'jsonb', 'uuid', 'bytea', 'tsvector', 'tsquery', 'inet', 'cidr',
])

/**
 * The types a cast, a typed literal or a column definition may name, as the
 * parser spells them (`integer` is int4, `double precision` float8, `char(n)`
 * bpchar), and arrays of them. Not the OID alias types (regclass and the rest,
 * whose output names any object), oid, oidvector, pg_* or any type in a schema.
 * regconfig only as a literal naming a built-in configuration
 * (`'english'::regconfig`, see isBuiltinConfiguration).
 *
 * The range types and inet / cidr parse their input and nothing else, like the
 * rest: no catalog lookup by name, no size beyond the literal.
 */
const TYPES = new Set([
  'text', 'varchar', 'bpchar', 'int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'bool', 'date', 'time',
  'timetz', 'timestamp', 'timestamptz', 'interval', 'json', 'jsonb', 'uuid', 'bytea', 'tsvector', 'tsquery',
  'inet', 'cidr', 'int4range', 'int8range', 'numrange', 'daterange', 'tsrange', 'tstzrange', 'int4multirange',
  'int8multirange', 'nummultirange', 'datemultirange', 'tsmultirange', 'tstzmultirange',
])

/** Types whose modifier is a length every value is padded or held to: char(n), varchar(n), bit(n). */
const SIZED_TYPES = new Set(['bpchar', 'varchar', 'bit', 'varbit'])

/**
 * The operators a statement may apply: every operator name in PostgreSQL 16's
 * pg_catalog (`!=` parses as `<>`). Which one runs depends on the operand
 * types, and for built-in types it is always pg_catalog's, unless the
 * project's schema defines one by the same name (read-query.ts checks that).
 */
const OPERATORS = new Set([
  '!!', '!~', '!~*', '!~~', '!~~*', '#', '##', '#-', '#>', '#>>', '%', '&', '&&', '&<', '&<|', '&>', '*', '*<', '*<=',
  '*<>', '*=', '*>', '*>=', '+', '-', '->', '->>', '-|-', '/', '<', '<->', '<<', '<<=', '<<|', '<=', '<>', '<@', '<^',
  '=', '>', '>=', '>>', '>>=', '>^', '?', '?#', '?&', '?-', '?-|', '?|', '?||', '@', '@-@', '@>', '@?', '@@', '@@@',
  '^', '^@', '|', '|&>', '|/', '|>>', '||', '||/', '~', '~*', '~<=~', '~<~', '~=', '~>=~', '~>~', '~~', '~~*',
])

/**
 * The comparisons PostgreSQL applies by name without the statement writing
 * them: IN and NOT IN, a simple CASE, JOIN USING and NATURAL, IS DISTINCT
 * FROM, NULLIF, BETWEEN.
 */
const COMPARISONS = ['=', '<>', '<', '<=', '>', '>=']

/** The keywords A_Expr names BETWEEN by; the comparisons it applies are COMPARISONS. */
const BETWEEN = new Set(['BETWEEN', 'NOT BETWEEN', 'BETWEEN SYMMETRIC', 'NOT BETWEEN SYMMETRIC'])

/**
 * Settings SHOW may read: how values are formatted and what the session is.
 * Not SHOW ALL, which lists settings the platform and its operators set, and
 * not server_version, whose build string version() is refused for.
 */
const SETTINGS = new Set([
  'timezone', 'datestyle', 'intervalstyle', 'server_version_num', 'standard_conforming_strings',
  'client_encoding', 'server_encoding', 'search_path', 'integer_datetimes', 'max_identifier_length',
  'extra_float_digits', 'statement_timeout', 'transaction_isolation', 'transaction_read_only',
  'default_text_search_config', 'bytea_output', 'lc_monetary', 'lc_numeric', 'lc_time',
])

/** TABLESAMPLE methods: the two built in. */
const SAMPLE_METHODS = new Set(['system', 'bernoulli'])

/** PostgreSQL 16's text search configurations, all in pg_catalog. */
const TS_CONFIGS = new Set([
  'arabic', 'armenian', 'basque', 'catalan', 'danish', 'dutch', 'english', 'finnish', 'french', 'german', 'greek',
  'hindi', 'hungarian', 'indonesian', 'irish', 'italian', 'lithuanian', 'nepali', 'norwegian', 'portuguese',
  'romanian', 'russian', 'serbian', 'simple', 'spanish', 'swedish', 'tamil', 'turkish', 'yiddish',
])

/**
 * The text search functions, and how many arguments they take when the first
 * is a configuration. Its name is looked up in whatever schema it names, and
 * the error told another project's schema ("permission denied") from a name
 * that is not there; an integer there is an object id.
 */
const CONFIG_FIRST: { [name: string]: number[] } = {
  to_tsvector: [2],
  to_tsquery: [2],
  plainto_tsquery: [2],
  phraseto_tsquery: [2],
  websearch_to_tsquery: [2],
  ts_headline: [3, 4],
  json_to_tsvector: [3],
  jsonb_to_tsvector: [3],
}

/**
 * Columns that set-returning functions on FUNCTIONS name themselves: json_each's
 * key and value, json_array_elements' value, unnest(tsvector)'s lexeme,
 * positions and weights, and WITH ORDINALITY's ordinality. None is the name of a
 * PostgreSQL function, so reading one can never call a built-in.
 */
const RECORD_FIELDS = new Set(['key', 'value', 'lexeme', 'positions', 'weights', 'ordinality'])

/**
 * The columns of the FUNCTIONS whose OUT parameters name them. PostgreSQL
 * names a function's one column after its single OUT parameter whatever the
 * alias says (chooseScalarFunctionAlias): `FROM json_array_elements_text(x)
 * AS t` has a column `value`, and none called t.
 */
const OUT_COLUMNS: { [name: string]: string[] } = {
  json_each: ['key', 'value'],
  jsonb_each: ['key', 'value'],
  json_each_text: ['key', 'value'],
  jsonb_each_text: ['key', 'value'],
  json_array_elements: ['value'],
  jsonb_array_elements: ['value'],
  json_array_elements_text: ['value'],
  jsonb_array_elements_text: ['value'],
}

/**
 * The built-ins off FUNCTIONS that accept a whole row (record, any,
 * anyelement and the like) as their only argument, from PG16's pg_proc.dat.
 * Column notation on a table, view, subquery or join calls whichever of these
 * it names (`t.hash_record` is hash_record(t)).
 */
const RECORD_CALLABLE = new Set([
  'any_out', 'anycompatible_out', 'anycompatiblenonarray_out', 'anyelement_out', 'anynonarray_out', 'hash_record',
  'record_out', 'record_send', 'pg_collation_for', 'pg_column_compression', 'pg_column_size', 'pg_typeof',
])

/** FUNCTIONS whose arguments checkCall reads. Column notation hands them a value no check can read. */
const ARGUMENTS_READ = new Set([
  'format', 'lpad', 'rpad', 'repeat', 'generate_series', 'to_tsvector', 'to_tsquery', 'plainto_tsquery',
  'phraseto_tsquery', 'websearch_to_tsquery', 'ts_headline', 'json_to_tsvector', 'jsonb_to_tsvector',
])

/** System columns: xmin's age() is the cluster's transaction counter, tableoid an object id. */
const SYSTEM_COLUMNS = new Set(['xmin', 'xmax', 'cmin', 'cmax', 'ctid', 'tableoid'])

/** Rows generate_series may make in FROM, where every one is made before the row cap applies. */
export const MAX_SERIES_ROWS = 100_000

/** The widest field format() may pad to. */
const MAX_FORMAT_WIDTH = 1000

/** The longest value lpad, rpad, repeat or a char(n), varchar(n) or bit(n) may make. */
const MAX_TEXT_LENGTH = 10_000

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
  return { refusal, kind: 'select', calls: [], operators: [] }
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
    const option = checkExplainOptions(options)
    if (option) return refuse(option)
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
    return { refusal: null, kind: 'show', calls: [], operators: [] }
  } else {
    return refuse(NOT_A_READ)
  }

  const uses: Uses = { calls: new Set<string>(), operators: new Set<string>(COMPARISONS) }
  const refusal = walk(body, ownSchema, collectFromItems(body), uses)
  if (refusal) return refuse(refusal)
  return { refusal: null, kind, calls: Array.from(uses.calls), operators: Array.from(uses.operators) }
}

/**
 * EXPLAIN's options: COSTS, and FORMAT TEXT or JSON, which print the same
 * plan. SETTINGS printed the server's work_mem and planner costs, VERBOSE and
 * the rest print more than the plan, and ANALYZE is refused before this.
 */
function checkExplainOptions(options: unknown[]): StatementRefusal | null {
  for (const option of options) {
    const def = wrapped(option, 'DefElem')
    const name = def ? text(def.defname).toLowerCase() : ''
    if (name === 'costs') continue
    if (name === 'format' && def) {
      const value = (stringNode(def.arg) ?? '').toLowerCase()
      if (value === 'text' || value === 'json') continue
      return explainOptionRefusal(`FORMAT ${value.toUpperCase()}`)
    }
    return explainOptionRefusal(name ? name.toUpperCase() : 'that option')
  }
  return null
}

/**
 * Every list of names whose last element is the thing named and whose earlier
 * elements qualify it, keyed by the field that holds it.
 */
type NameKind = 'function' | 'type' | 'operator' | 'collation' | 'sample method'

const QUALIFIED_NAMES: { [key: string]: NameKind } = {
  funcname: 'function', //       FuncCall
  method: 'sample method', //    RangeTableSample
  names: 'type', //              TypeName, a field of TypeCast, ColumnDef, JsonOutput
  name: 'operator', //           A_Expr (a list only there; `name` is a plain string elsewhere)
  operName: 'operator', //       SubLink: x OPERATOR(s.=) ANY (subquery)
  useOp: 'operator', //          SortBy: ORDER BY x USING OPERATOR(s.<)
  collname: 'collation', //      CollateClause
}

/** XML: libxml2 does not stop for the statement timeout (an XPath ran 24.9 s against 15). */
const XML_NODES = new Set(['XmlExpr', 'XmlSerialize', 'RangeTableFunc'])

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

/** The names a statement leaves to search_path. */
interface Uses {
  calls: Set<string>
  operators: Set<string>
}

/**
 * Walk every node. Iterative, so a deeply nested statement cannot overflow the
 * stack and end the check early.
 */
function walk(root: JsonObject, ownSchema: string, items: FromItems, uses: Uses): StatementRefusal | null {
  const stack: Array<{ node: unknown; key: string }> = [{ node: root, key: '' }]
  while (stack.length > 0) {
    const { node, key } = stack.pop() as { node: unknown; key: string }

    if (Array.isArray(node)) {
      const kind = Object.prototype.hasOwnProperty.call(QUALIFIED_NAMES, key) ? QUALIFIED_NAMES[key] : undefined
      if (kind) {
        const parts = node.map(stringNode)
        if (parts.every((p) => p !== null)) {
          const refusal = checkQualifiedName(kind, parts as string[], ownSchema, uses)
          if (refusal) return refusal
          continue
        }
      }
      if (key === 'fields') {
        // ColumnRef.fields: a, a.b, s.a.b, with * for a whole row.
        const refusal = checkColumnRef(node, items, uses)
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
          const refusal = checkField(name, uses)
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
      const value = node[field]
      // A statement inside the statement: a data-modifying CTE, or anything
      // else that is not a SELECT. Node types are capitalised; fields are not.
      if (field !== 'SelectStmt' && /^[A-Z][A-Za-z]*Stmt$/.test(field)) return nestedStatement(field)
      // SELECT ... INTO creates a table.
      if (field === 'intoClause' && value) {
        return { code: 'NOT_READ_ONLY', message: 'run_query is read-only, and SELECT ... INTO creates a table.', hint: 'write' }
      }
      if (XML_NODES.has(field)) return XML_REFUSAL
      if (isObject(value)) {
        // A cast of a literal naming a built-in text search configuration is
        // the one regconfig there is; nothing else in it needs checking.
        if (field === 'TypeCast' && isBuiltinConfiguration(node)) continue
        let refusal: StatementRefusal | null = null
        if (field === 'FuncCall') refusal = checkCall(value)
        else if (field === 'RangeFunction') refusal = checkRangeFunction(value)
        else if (field === 'typeName' || field === 'TypeName') refusal = checkTypeModifiers(value)
        if (refusal) return refusal
      }
      stack.push({ node: value, key: field })
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

// ── Lists and literals ───────────────────────────────────────────────────────

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

/** The last name of a qualified name (funcname, names), or null. */
function lastName(names: unknown): string | null {
  const parts = listItems(names).map(stringNode)
  const last = parts.length > 0 ? parts[parts.length - 1] : null
  return last || null
}

/** The name of a built-in: bare, or qualified with pg_catalog. Null for any other qualifier. */
function builtinName(names: unknown): string | null {
  const parts = listItems(names).map(stringNode)
  if (parts.length === 1) return parts[0] || null
  if (parts.length === 2 && parts[0] === 'pg_catalog') return parts[1] || null
  return null
}

/** A TypeName's built-in name, when it is not an array type. */
function typeBase(typeName: unknown): string | null {
  if (!isObject(typeName) || listItems(typeName.arrayBounds).length > 0) return null
  return builtinName(typeName.names)
}

/** An integer literal's value. libpg_query leaves a 0 out of its JSON. */
function integerLiteral(node: unknown): number | null {
  const constant = wrapped(node, 'A_Const')
  const ival = constant ? constant.ival : undefined
  if (!isObject(ival)) return null
  return typeof ival.ival === 'number' ? ival.ival : 0
}

/** A string literal's text, bare or cast to text or varchar. */
function stringLiteral(node: unknown): string | null {
  const cast = wrapped(node, 'TypeCast')
  if (cast) {
    const type = typeBase(cast.typeName)
    return type === 'text' || type === 'varchar' ? stringLiteral(cast.arg) : null
  }
  const constant = wrapped(node, 'A_Const')
  const sval = constant ? constant.sval : undefined
  return isObject(sval) ? text(sval.sval) : null
}

/**
 * A literal naming one of PostgreSQL's own text search configurations,
 * bare ('english') or cast to regconfig. regconfig's input reads the name as
 * an identifier, so its case does not matter.
 */
function isBuiltinConfiguration(node: unknown): boolean {
  const cast = wrapped(node, 'TypeCast')
  if (cast && typeBase(cast.typeName) !== 'regconfig') return false
  const literal = wrapped(cast ? cast.arg : node, 'A_Const')
  const sval = literal && isObject(literal.sval) ? text(literal.sval.sval) : ''
  return /^[A-Za-z_]+$/.test(sval) && TS_CONFIGS.has(sval.toLowerCase())
}

// ── Arguments a listed function may take ─────────────────────────────────────

/**
 * The listed functions that are safe only with some arguments: those sized
 * by an argument (format, lpad, rpad, repeat), and the text search functions,
 * whose configuration is looked up by name or object id.
 */
function checkCall(call: JsonObject): StatementRefusal | null {
  const name = builtinName(call.funcname)
  if (!name) return null
  const args = listItems(call.args)

  if (name === 'format') {
    if (args.length === 0) return null // PostgreSQL refuses the call
    const spec = stringLiteral(args[0])
    const problem = spec === null ? 'a format string that is not a literal' : formatProblem(spec)
    if (!problem) return null
    return sizeRefusal(
      `format() takes a literal format string whose fields pad to at most ${MAX_FORMAT_WIDTH} characters, with no ` +
        `width taken from an argument (refused ${problem})`,
      "format('%s: %10s', name, total)",
    )
  }
  if (name === 'lpad' || name === 'rpad') {
    const length = integerLiteral(args[1])
    if (length !== null && length <= MAX_TEXT_LENGTH) return null
    return sizeRefusal(`${name}() takes its length as an integer literal of at most ${MAX_TEXT_LENGTH}`, `${name}(id::text, 6, '0')`)
  }
  if (name === 'repeat') {
    const value = stringLiteral(args[0])
    const count = integerLiteral(args[1])
    if (value !== null && count !== null && value.length * Math.max(count, 0) <= MAX_TEXT_LENGTH) return null
    return sizeRefusal(
      `repeat() takes a string literal and an integer literal, for at most ${MAX_TEXT_LENGTH} characters; for a ` +
        "count from the data use left(repeat('*', 100), n)",
      "repeat('-', 40)",
    )
  }

  const configured = Object.prototype.hasOwnProperty.call(CONFIG_FIRST, name) ? CONFIG_FIRST[name] : null
  if (configured && configured.indexOf(args.length) !== -1 && !isBuiltinConfiguration(args[0])) {
    return configurationRefusal(name)
  }
  return null
}

/**
 * What is wrong with a format() string, or null. Its fields are
 * %[position$][-][width]type, where the width may be `*`, taken from an
 * argument.
 */
function formatProblem(spec: string): string | null {
  for (let i = 0; i < spec.length; i++) {
    if (spec.charAt(i) !== '%') continue
    i++
    if (spec.charAt(i) === '%') continue
    let j = i
    while (j < spec.length && /[0-9]/.test(spec.charAt(j))) j++
    if (spec.charAt(j) === '$') i = j + 1 // an argument's position, not a width
    while (spec.charAt(i) === '-') i++
    if (spec.charAt(i) === '*') return 'a width taken from an argument (*)'
    let digits = ''
    while (i < spec.length && /[0-9]/.test(spec.charAt(i))) digits += spec.charAt(i++)
    if (digits && Number(digits) > MAX_FORMAT_WIDTH) return `a width of ${digits}`
  }
  return null
}

/** char(n), varchar(n) and bit(n): every value is held or padded to n. */
function checkTypeModifiers(typeName: JsonObject): StatementRefusal | null {
  const base = lastName(typeName.names)
  if (!base || !SIZED_TYPES.has(base)) return null
  for (const modifier of listItems(typeName.typmods)) {
    const length = integerLiteral(modifier)
    if (length === null || length > MAX_TEXT_LENGTH) {
      return sizeRefusal(`char(n), varchar(n) and bit(n) take n of at most ${MAX_TEXT_LENGTH}`, "'x'::varchar(255)")
    }
  }
  return null
}

// ── generate_series in FROM ──────────────────────────────────────────────────

/**
 * A function in FROM is run to its end, every row stored, before anything
 * above it reads one: the row cap's LIMIT does not stop it, and
 * `SELECT g FROM generate_series(1, 2000000000) g` wrote a gigabyte of
 * temporary files in six seconds. So generate_series there must have bounds
 * this check can count, for at most MAX_SERIES_ROWS rows. In the select list it
 * produces rows as they are read, and the cap holds.
 */
function checkRangeFunction(rf: JsonObject): StatementRefusal | null {
  for (const entry of listItems(rf.functions)) {
    const call = wrapped(listItems(entry)[0], 'FuncCall')
    if (!call || builtinName(call.funcname) !== 'generate_series') continue
    const rows = seriesRows(listItems(call.args))
    if (rows !== null && rows <= MAX_SERIES_ROWS) continue
    const instead =
      ' Narrow the range or widen the step, or call it in the select list, where rows stream under the row cap: ' +
      'FROM (SELECT generate_series(...) AS d) s.'
    return {
      code: 'QUERY_TOO_EXPENSIVE',
      message:
        rows === null
          ? 'generate_series in FROM makes every row before run_query\'s row cap applies, so its bounds must be ' +
            'literals run_query can count (numbers, dates and timestamps, now() or current_date plus or minus an ' +
            `interval), for at most ${MAX_SERIES_ROWS} rows. For bounds from the data, call it in the select list, ` +
            'where rows stream under the row cap: FROM (SELECT generate_series(...) AS d) s.'
          : `generate_series in FROM would make ${rows} rows, all of them before run_query's row cap applies; it ` +
            `makes at most ${MAX_SERIES_ROWS} there.${instead}`,
      hint: 'expensive',
    }
  }
  return null
}

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Interval units, in milliseconds. A month is counted as 28 days and a year as
 * 365, so a step of months is counted high, and no span is off by a tenth.
 */
const INTERVAL_UNITS: { [unit: string]: number } = {
  microsecond: 0.001, microseconds: 0.001, us: 0.001, usec: 0.001, usecs: 0.001,
  millisecond: 1, milliseconds: 1, ms: 1, msec: 1, msecs: 1,
  second: SECOND_MS, seconds: SECOND_MS, sec: SECOND_MS, secs: SECOND_MS, s: SECOND_MS,
  minute: MINUTE_MS, minutes: MINUTE_MS, min: MINUTE_MS, mins: MINUTE_MS, m: MINUTE_MS,
  hour: HOUR_MS, hours: HOUR_MS, hr: HOUR_MS, hrs: HOUR_MS, h: HOUR_MS,
  day: DAY_MS, days: DAY_MS, d: DAY_MS,
  week: 7 * DAY_MS, weeks: 7 * DAY_MS, w: 7 * DAY_MS,
  month: 28 * DAY_MS, months: 28 * DAY_MS, mon: 28 * DAY_MS, mons: 28 * DAY_MS,
  year: 365 * DAY_MS, years: 365 * DAY_MS, yr: 365 * DAY_MS, yrs: 365 * DAY_MS, y: 365 * DAY_MS,
  decade: 3650 * DAY_MS, decades: 3650 * DAY_MS,
  century: 36500 * DAY_MS, centuries: 36500 * DAY_MS,
  millennium: 365000 * DAY_MS, millennia: 365000 * DAY_MS,
}

/**
 * A constant a series is bounded by: a number, a time (ms since the epoch;
 * now() is the clock when the statement is checked), an interval (ms), or an
 * untyped literal, which takes its type from where it is used.
 */
interface Constant {
  type: 'number' | 'time' | 'interval' | 'text'
  n: number
  s: string
}

const NOW_FUNCTIONS = new Set(['now', 'transaction_timestamp', 'statement_timestamp', 'clock_timestamp'])
const NUMBER_TYPES = new Set(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8'])
const TIME_TYPES = new Set(['date', 'timestamp', 'timestamptz'])

function numberOf(n: number): Constant | null {
  return Number.isFinite(n) ? { type: 'number', n, s: '' } : null
}

function timeOf(ms: number): Constant | null {
  return Number.isFinite(ms) ? { type: 'time', n: ms, s: '' } : null
}

function intervalOf(ms: number): Constant | null {
  return Number.isFinite(ms) ? { type: 'interval', n: ms, s: '' } : null
}

/** How many rows generate_series makes with these arguments, or null when this check cannot count them. */
function seriesRows(args: unknown[]): number | null {
  if (args.length < 2 || args.length > 4) return 0 // no such generate_series: PostgreSQL refuses the call
  const start = constant(args[0])
  const stop = constant(args[1])
  const step = args.length > 2 ? constant(args[2]) : numberOf(1)
  if (!start || !stop || !step) return null
  const times = start.type === 'time' || stop.type === 'time' || step.type === 'interval' || args.length === 4
  const from = as(start, times ? 'timestamptz' : 'numeric')
  const to = as(stop, times ? 'timestamptz' : 'numeric')
  const by = as(step, times ? 'interval' : 'numeric')
  if (!from || !to || !by) return null
  if (by.n === 0) return 0 // PostgreSQL refuses a zero step
  const steps = (to.n - from.n) / by.n
  if (Number.isNaN(steps)) return null
  return steps < 0 ? 0 : Math.floor(steps) + 1
}

/** The value of a constant expression, or null. */
function constant(node: unknown): Constant | null {
  const literal = wrapped(node, 'A_Const')
  if (literal) {
    if (isObject(literal.ival)) return numberOf(typeof literal.ival.ival === 'number' ? literal.ival.ival : 0)
    if (isObject(literal.fval)) return numberOf(Number(text(literal.fval.fval)))
    if (isObject(literal.sval)) return { type: 'text', n: 0, s: text(literal.sval.sval) }
    return null
  }
  const cast = wrapped(node, 'TypeCast')
  if (cast) {
    const type = typeBase(cast.typeName)
    const value = constant(cast.arg)
    return type && value ? as(value, type) : null
  }
  const svf = wrapped(node, 'SQLValueFunction')
  if (svf) {
    const current = /^SVFOP_(CURRENT_DATE|CURRENT_TIMESTAMP|CURRENT_TIMESTAMP_N|LOCALTIMESTAMP|LOCALTIMESTAMP_N)$/
    return current.test(text(svf.op)) ? timeOf(Date.now()) : null
  }
  const call = wrapped(node, 'FuncCall')
  if (call) {
    const name = builtinName(call.funcname)
    const args = listItems(call.args)
    if (name && NOW_FUNCTIONS.has(name) && args.length === 0) return timeOf(Date.now())
    // date_trunc lands within one unit of what it truncates.
    if (name === 'date_trunc' && (args.length === 2 || args.length === 3)) {
      const value = constant(args[1])
      return value ? as(value, 'timestamptz') : null
    }
    if (name && TIME_TYPES.has(name) && args.length === 1) {
      const value = constant(args[0])
      return value ? as(value, name) : null
    }
    return null
  }
  const expr = wrapped(node, 'A_Expr')
  if (expr && text(expr.kind) === 'AEXPR_OP') {
    const op = builtinName(expr.name)
    const right = constant(expr.rexpr)
    if (!op || !right) return null
    if (expr.lexpr === undefined || expr.lexpr === null) {
      if (op === '+') return right
      if (op !== '-') return null
      const n = right.type === 'text' ? as(right, 'numeric') || as(right, 'interval') : right
      if (!n || n.type === 'time') return null
      return n.type === 'number' ? numberOf(-n.n) : intervalOf(-n.n)
    }
    const left = constant(expr.lexpr)
    return left ? arithmetic(op, left, right) : null
  }
  return null
}

/** A constant as the type it is cast or used as, or null. */
function as(value: Constant, type: string): Constant | null {
  if (NUMBER_TYPES.has(type)) {
    if (value.type === 'number') return value
    const numeric = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?\s*$/i
    return value.type === 'text' && numeric.test(value.s) ? numberOf(Number(value.s)) : null
  }
  if (TIME_TYPES.has(type)) {
    if (value.type === 'time') return value
    return value.type === 'text' ? timeOf(parseTime(value.s)) : null
  }
  if (type === 'interval') {
    if (value.type === 'interval') return value
    return value.type === 'text' ? intervalOf(parseInterval(value.s)) : null
  }
  if (type === 'text' || type === 'varchar') return value.type === 'text' ? value : null
  return null
}

/** An untyped literal beside a typed value takes a type that value can combine with. */
function typedBeside(value: Constant, other: Constant): Constant | null {
  if (value.type !== 'text') return value
  if (other.type === 'number') return as(value, 'numeric')
  if (other.type === 'time' || other.type === 'interval') return as(value, 'interval') || as(value, 'timestamptz')
  return null
}

function arithmetic(op: string, left: Constant, right: Constant): Constant | null {
  const l = typedBeside(left, right)
  const r = typedBeside(right, left)
  if (!l || !r) return null
  switch (`${l.type} ${op} ${r.type}`) {
    case 'number + number': return numberOf(l.n + r.n)
    case 'number - number': return numberOf(l.n - r.n)
    case 'number * number': return numberOf(l.n * r.n)
    case 'number / number': return r.n === 0 ? null : numberOf(l.n / r.n)
    case 'time + interval': return timeOf(l.n + r.n)
    case 'interval + time': return timeOf(l.n + r.n)
    case 'time - interval': return timeOf(l.n - r.n)
    case 'time + number': return timeOf(l.n + r.n * DAY_MS) // date + integer: days
    case 'number + time': return timeOf(l.n * DAY_MS + r.n)
    case 'time - number': return timeOf(l.n - r.n * DAY_MS)
    case 'time - time': return intervalOf(l.n - r.n)
    case 'interval + interval': return intervalOf(l.n + r.n)
    case 'interval - interval': return intervalOf(l.n - r.n)
    case 'interval * number': return intervalOf(l.n * r.n)
    case 'number * interval': return intervalOf(l.n * r.n)
    case 'interval / number': return r.n === 0 ? null : intervalOf(l.n / r.n)
    default: return null
  }
}

/** A date or timestamp literal in ISO form, or a special value, in ms; NaN otherwise ('infinity' included). */
function parseTime(input: string): number {
  const s = input.trim().toLowerCase()
  const now = Date.now()
  if (s === 'now' || s === 'today') return now
  if (s === 'tomorrow') return now + DAY_MS
  if (s === 'yesterday') return now - DAY_MS
  if (s === 'epoch') return 0
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(?:z|utc|[+-]\d{1,2}(?::?\d{2})?)?$/.exec(s)
  if (!m) return NaN
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0))
}

/** An interval literal ('1 day', '15 minutes', '1 day 02:00', '3 hours ago'), in ms; NaN otherwise. */
function parseInterval(input: string): number {
  let rest = input.trim().toLowerCase()
  if (rest.charAt(0) === '@') rest = rest.slice(1)
  let total = 0
  let parts = 0
  for (;;) {
    rest = rest.replace(/^\s+/, '')
    if (!rest) break
    const clock = /^([+-])?(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?/.exec(rest)
    if (clock) {
      const ms = (Number(clock[2]) * 3600 + Number(clock[3]) * 60 + Number(clock[4] || 0)) * SECOND_MS
      total += clock[1] === '-' ? -ms : ms
      rest = rest.slice(clock[0].length)
      parts++
      continue
    }
    const part = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([a-z]*)/.exec(rest)
    if (part) {
      const unit = part[2] || 'second'
      if (!Object.prototype.hasOwnProperty.call(INTERVAL_UNITS, unit)) return NaN
      total += Number(part[1]) * INTERVAL_UNITS[unit]
      rest = rest.slice(part[0].length)
      parts++
      continue
    }
    if (parts > 0 && /^ago$/.test(rest)) return -total
    return NaN
  }
  return parts > 0 ? total : NaN
}

// ── FROM items, for column notation ──────────────────────────────────────────

interface FromItem {
  /**
   * 'function', a function in FROM: its whole row can be a scalar, which
   * column notation hands to a call, so its columns are worked out exactly.
   * 'table', anything else (a table, view, CTE, subquery, VALUES, join): its
   * whole row is a composite value, and its columns are not known here.
   */
  kind: 'function' | 'table'
  /** A function item's columns as PostgreSQL names them, or null when this check cannot tell. */
  columns: string[] | null
}

interface FromItems {
  byName: Map<string, FromItem[]>
  /** Function items with no alias and a name this check cannot tell: any qualifier may reach them. */
  unnamed: FromItem[]
}

const TABLE_ITEM: FromItem = { kind: 'table', columns: null }

/** unnest(a, b) in FROM is one unnest per argument (transformRangeFunction). */
const UNNEST_CALL = { FuncCall: { funcname: [{ String: { sval: 'unnest' } }] } }

function aliasName(alias: unknown): string {
  return isObject(alias) ? text(alias.aliasname) : ''
}

function aliasColumns(alias: unknown): string[] {
  const colnames = isObject(alias) ? alias.colnames : undefined
  if (!Array.isArray(colnames)) return []
  return colnames.map(stringNode).filter((n): n is string => n !== null)
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
 * deliberately ignored: a name is checked against every item that answers to
 * it, at every level, so an inner item can never hide behind an outer one.
 */
function collectFromItems(root: JsonObject): FromItems {
  const byName = new Map<string, FromItem[]>()
  const unnamed: FromItem[] = []
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

    const relname = node.relname
    if (typeof relname === 'string') add(aliasName(node.alias) || relname, TABLE_ITEM)
    const subselect = wrapped(node, 'RangeSubselect')
    if (subselect) add(aliasName(subselect.alias), TABLE_ITEM)
    const join = wrapped(node, 'JoinExpr')
    if (join) {
      add(aliasName(join.alias), TABLE_ITEM)
      add(aliasName(join.join_using_alias), TABLE_ITEM)
    }
    const rangeFunction = wrapped(node, 'RangeFunction')
    if (rangeFunction) {
      const { name, item } = functionItem(rangeFunction)
      if (name) add(name, item)
      else unnamed.push(item)
    }

    for (const field of Object.keys(node)) stack.push(node[field])
  }
  return { byName, unnamed }
}

/**
 * A function in FROM as transformRangeFunction and
 * addRangeTableEntryForFunction (src/backend/parser/parse_clause.c,
 * parse_relation.c) make it: the name a qualifier reaches it by, and its
 * columns.
 *
 *   - Its name is its alias, or else its first function's name.
 *   - Each function gives its column definition list; else its OUT parameters
 *     (json_each: key, value; json_array_elements: value, whatever the alias
 *     says); else, returning one value, one column named after the alias when
 *     the function is alone in FROM, or else after the function.
 *     unnest(a, b) is one unnest per argument.
 *   - WITH ORDINALITY adds "ordinality".
 *   - The alias's column names then rename those columns in order.
 *
 * unnest of a tsvector names its columns lexeme, positions and weights, which
 * the tree cannot tell from an array's unnest. Those are RECORD_FIELDS, never
 * a function's name, so reading one is never a call to a built-in either way.
 */
function functionItem(rf: JsonObject): { name: string | null; item: FromItem } {
  const aliasname = aliasName(rf.alias)
  const outerDefs = columnDefNames(rf.coldeflist)
  const functions: Array<{ expr: unknown; defs: string[] }> = []
  for (const entry of listItems(rf.functions)) {
    const parts = listItems(entry)
    const defs = columnDefNames(parts[1])
    const call = wrapped(parts[0], 'FuncCall')
    const args = call ? listItems(call.args) : []
    const bareUnnest = call ? listItems(call.funcname).length === 1 && lastName(call.funcname) === 'unnest' : false
    const plain = call ? !call.agg_order && !call.agg_filter && !call.over && !call.agg_star && !call.agg_distinct && !call.func_variadic : false
    if (bareUnnest && plain && args.length > 1 && defs.length === 0) {
      for (let i = 0; i < args.length; i++) functions.push({ expr: UNNEST_CALL, defs: [] })
      continue
    }
    functions.push({ expr: parts[0], defs })
  }
  if (functions.length === 1 && outerDefs.length > 0) functions[0].defs = outerDefs

  let columns: string[] | null = []
  for (const fn of functions) {
    const own = functionColumns(fn.expr, fn.defs, aliasname, functions.length)
    columns = columns && own ? columns.concat(own) : null
  }
  if (columns && rf.ordinality) columns.push('ordinality')
  const renamed = aliasColumns(rf.alias)
  if (columns && renamed.length > 0) columns = renamed.concat(columns.slice(renamed.length))

  const first = functions.length > 0 ? wrapped(functions[0].expr, 'FuncCall') : undefined
  const name = aliasname || (first ? lastName(first.funcname) : null)
  return { name, item: { kind: 'function', columns } }
}

/** One function's columns in FROM, before the alias renames them, or null when this check cannot tell. */
function functionColumns(expr: unknown, defs: string[], aliasname: string, nfuncs: number): string[] | null {
  if (defs.length > 0) return defs
  const call = wrapped(expr, 'FuncCall')
  const builtin = call ? builtinName(call.funcname) : null
  if (builtin && Object.prototype.hasOwnProperty.call(OUT_COLUMNS, builtin)) return OUT_COLUMNS[builtin]
  if (nfuncs === 1 && aliasname) return [aliasname]
  // Without an alias PostgreSQL names the column after the function; for
  // anything that is not a call (CAST, COALESCE, CURRENT_DATE) this check
  // does not work out the name.
  const name = call ? lastName(call.funcname) : null
  return name ? [name] : null
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

/** What to use instead of a refused function agents reach for. */
const INSTEAD: { [name: string]: string } = {
  pg_typeof: 'get_table_schema {tableName} gives the type of every column.',
  current_setting: 'SHOW reads the settings run_query shows.',
  version: 'SHOW server_version_num gives the PostgreSQL version.',
  array_fill: 'Build the array with ARRAY[...] or array_agg().',
  bpchar: "Cast instead: 'x'::char(10).",
  varchar: "Cast instead: 'x'::varchar(10).",
}

function functionRefusal(name: string, how = ''): StatementRefusal {
  const instead = Object.prototype.hasOwnProperty.call(INSTEAD, name) ? ` ${INSTEAD[name]}` : ''
  return {
    code: 'FUNCTION_NOT_ALLOWED',
    message:
      `run_query does not call ${name}()${how}. It calls only the built-in aggregate, window, math, string, ` +
      `date and time, JSON, array, range, network and full-text search functions on its list.${instead}`,
    hint: 'function',
  }
}

function operatorRefusal(name: string): StatementRefusal {
  return {
    code: 'OPERATOR_NOT_ALLOWED',
    message: `run_query does not apply the operator ${name}. It applies only PostgreSQL's built-in operators.`,
    hint: 'operator',
  }
}

function typeRefusal(name: string): StatementRefusal {
  const regconfig = /regconfig$/.test(name)
    ? ", and to regconfig only a literal naming a built-in configuration ('english'::regconfig)"
    : ''
  return {
    code: 'TYPE_NOT_ALLOWED',
    message:
      `run_query does not cast to ${name}. It casts only to text, varchar, char, smallint, integer, bigint, ` +
      'numeric, real, double precision, boolean, date, time, timestamp, interval, json, jsonb, uuid, bytea, ' +
      `tsvector, tsquery, inet, cidr and the range and multirange types, and arrays of them${regconfig}.`,
    hint: 'type',
  }
}

function configurationRefusal(name: string): StatementRefusal {
  const headline =
    name === 'ts_headline' ? " To pass ts_headline options, name the configuration first: ts_headline('english', body, query, 'MaxWords=10')." : ''
  return {
    code: 'TYPE_NOT_ALLOWED',
    message:
      `run_query takes ${name}()'s text search configuration only as a string literal naming a built-in one ` +
      `(${Array.from(TS_CONFIGS).join(', ')}), for example ${name}('english', ...). A name in a schema, an ` +
      'object id or a value from the data is looked up, and the lookup\'s error tells other projects\' schemas ' +
      `apart.${headline}`,
    hint: 'type',
  }
}

function systemColumnRefusal(name: string): StatementRefusal {
  return {
    code: 'CATALOG_NOT_READABLE',
    message:
      `run_query does not read the system column ${name}. System columns describe the database's transactions ` +
      "and storage (age(xmin) is the cluster's transaction counter), not the project's data.",
    hint: 'systemColumn',
  }
}

function explainOptionRefusal(option: string): StatementRefusal {
  return {
    code: 'EXPLAIN_OPTION_NOT_ALLOWED',
    message:
      `run_query does not run EXPLAIN with ${option}. It explains with COSTS and FORMAT TEXT or JSON only: the ` +
      "other options print the server's settings, buffer and timing figures, or more than the plan.",
    hint: 'explain',
  }
}

function sizeRefusal(rule: string, example: string): StatementRefusal {
  return {
    code: 'QUERY_TOO_EXPENSIVE',
    message: `run_query bounds what one statement allocates: ${rule}. For example: ${example}.`,
    hint: 'expensive',
  }
}

const XML_REFUSAL: StatementRefusal = {
  code: 'FUNCTION_NOT_ALLOWED',
  message:
    'run_query does not evaluate XML (XMLTABLE, XMLPARSE, XMLELEMENT, XMLSERIALIZE, IS DOCUMENT and the rest): ' +
    'libxml2 does not stop for the statement timeout, so one XPath expression can hold the database far past it.',
  hint: 'function',
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
 * A function, type or operator may be qualified only with pg_catalog, which the
 * grammar writes itself (`x::integer` parses as pg_catalog.int4, EXTRACT as
 * pg_catalog.extract) and which PostgreSQL then searches alone; what it names
 * must be on FUNCTIONS, TYPES or OPERATORS. A collation may also name the
 * project's own schema: a collation runs no code. Any other qualifier is
 * refused: `public` holds extensions and platform helpers, and another
 * project's schema holds another project.
 *
 * An unqualified function or operator is resolved through search_path, which
 * holds the project's schema, so its name goes into `uses` for read-query.ts
 * to check against that schema.
 */
function checkQualifiedName(kind: NameKind, parts: string[], ownSchema: string, uses: Uses): StatementRefusal | null {
  if (parts.length === 0) return null
  const base = parts[parts.length - 1]
  const qualifiers = parts.slice(0, -1)
  const shown = `${kind} "${parts.join('.')}"`
  if (qualifiers.length > 0) {
    const schema = qualifiers[qualifiers.length - 1]
    const allowed = qualifiers.length === 1 && (schema === 'pg_catalog' || (kind === 'collation' && schema === ownSchema))
    if (!allowed) {
      if (qualifiers.some(isCatalogName)) return catalogRefusal(shown)
      if (schema === ownSchema) {
        if (kind === 'type') return typeRefusal(parts.join('.'))
        if (kind === 'operator') return operatorRefusal(parts.join('.'))
        return functionRefusal(parts.join('.'))
      }
      return schemaRefusal(shown, qualifiers[0])
    }
  } else if (kind === 'operator') {
    if (BETWEEN.has(base)) return null // a keyword: the comparisons BETWEEN applies are COMPARISONS
    uses.operators.add(base)
  } else if (kind === 'function') {
    uses.calls.add(base)
  }
  if (kind === 'function' && !FUNCTIONS.has(base)) return functionRefusal(base)
  if (kind === 'operator' && !OPERATORS.has(base)) return operatorRefusal(base)
  if (kind === 'type' && !TYPES.has(base)) return typeRefusal(base)
  if (kind === 'sample method' && !SAMPLE_METHODS.has(base)) return functionRefusal(base, ' as a TABLESAMPLE method')
  return null
}

/** A listed function that column notation may call: its argument is a value no check reads. */
function callable(name: string): boolean {
  return FUNCTIONS.has(name) && !ARGUMENTS_READ.has(name)
}

/**
 * Column notation, which is a function call when it names no column.
 *
 * PostgreSQL reads a qualified column reference `q.f` as column f of the FROM
 * item q, and when q has no column f, as the call f(q) on q's whole row
 * (transformColumnRef in src/backend/parser/parse_expr.c; a bare `f` is never a
 * call). The whole row of a table, view, subquery, CTE or join is a composite
 * value, which no built-in off FUNCTIONS accepts but RECORD_CALLABLE's. The
 * whole row of a function in FROM is that function's scalar, which any call
 * accepts: that is how `g.regnamespace` and `t.ts_stat` read other projects.
 *
 * So for every function item the name q reaches, f must be one of its
 * columns, exactly as functionItem works them out (an alias with a column list
 * is not a column itself, and json_array_elements_text's column is `value`
 * whatever the alias), or a function on FUNCTIONS whose arguments need no
 * reading. A table's columns are never restricted, so ordinary column names
 * keep working. System columns are refused wherever they are named.
 */
function checkColumnRef(fields: unknown[], items: FromItems, uses: Uses): StatementRefusal | null {
  const names = fields.map(stringNode)
  for (const name of names) {
    if (name === null) continue
    const refused = checkName(name)
    if (refused) return refused
  }
  const last = names.length > 0 ? names[names.length - 1] : null
  if (last !== null && SYSTEM_COLUMNS.has(last)) return systemColumnRefusal(last)
  if (names.length < 2 || last === null) return null // a bare column, or q.*
  const qualifier = names[names.length - 2]
  if (qualifier === null) return null
  uses.calls.add(last)

  if (RECORD_CALLABLE.has(last)) {
    return functionRefusal(last, ` as ${qualifier}.${last}, which PostgreSQL reads as ${last}() on the whole row`)
  }
  if (RECORD_FIELDS.has(last)) return null
  const named = items.byName.get(qualifier) ?? []
  const reached = named.concat(items.unnamed)
  if (named.length === 0 && !callable(last)) return notationRefusal(qualifier, last, null)
  for (const item of reached) {
    if (item.kind === 'table') continue
    if (item.columns && item.columns.indexOf(last) !== -1) continue
    if (!callable(last)) return notationRefusal(qualifier, last, item.columns)
  }
  return null
}

function notationRefusal(qualifier: string, field: string, columns: string[] | null): StatementRefusal {
  const has = columns && columns.length > 0 ? `${qualifier}'s columns are ${columns.join(', ')}` : `name a column of ${qualifier}`
  return functionRefusal(
    field,
    ` as ${qualifier}.${field}: ${qualifier} has no column ${field}, so PostgreSQL reads that as ${field}(${qualifier}) ` +
      `(${has}; to name a FROM function's column, give its alias a column list: AS ${qualifier}(name))`,
  )
}

/**
 * A field selected from a value, `(expr).name`. PostgreSQL reads that as a
 * call, name(expr), whenever expr has no such field, whatever its type
 * (ParseFuncOrColumn in src/backend/parser/parse_func.c), so
 * `(16400::oid).obj_description` is a call and `(16400).regclass` a cast. The
 * name must be one of RECORD_FIELDS or a function column notation may call; a
 * table's column is read as `alias.column` instead.
 */
function checkField(name: string, uses: Uses): StatementRefusal | null {
  const refused = checkName(name)
  if (refused) return refused
  uses.calls.add(name)
  if (RECORD_FIELDS.has(name) || callable(name)) return null
  return functionRefusal(
    name,
    ` as (...).${name}, which PostgreSQL reads as a call when the value has no field ${name}. To read a column ` +
      `write alias.${name}, not (alias).${name}`,
  )
}
