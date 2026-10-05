/**
 * LEXICON — what a column name says about the concern it belongs to
 * ==================================================================
 *
 * `refund_amount`, `refund_reason` and `refunded_at` are three columns and one
 * idea. This module turns names into that idea's key, and it is the WEAKEST
 * evidence the engine uses — deliberately so.
 *
 * Names are chosen by people and by models, and both name things inconsistently.
 * A shared prefix is a reasonable guess that columns belong together and nothing
 * more, so `concerns.ts` never lets this module's verdict stand alone: lexical
 * agreement can PROPOSE a group, and something measured has to confirm it. The
 * subsystem clusterer reached the same conclusion about `*_id` name matching —
 * it is a guess, and the finding policy does not build claims on guesses.
 *
 * Pure. No database, no model: a deterministic stemmer over snake_case and
 * camelCase, small enough to read in one sitting.
 */

/** Leading words that qualify a concern rather than name one: `is_refunded`. */
const QUALIFIERS = new Set([
  'is', 'has', 'can', 'should', 'was', 'did', 'needs', 'allow', 'allows', 'last', 'first',
  'num', 'number', 'count', 'total', 'max', 'min', 'avg', 'date', 'time',
])

/**
 * Stems that describe the row itself rather than a concern bolted onto it.
 *
 * A column whose concern is `status` or `created` is part of what every row IS.
 * Grouping `status` with `status_changed_at` and proposing an `order_statuses`
 * table would be a textbook over-normalisation, and it would be proposed on
 * almost every backend.
 */
const GENERIC_STEMS = new Set([
  'id', 'uuid', 'creat', 'create', 'updat', 'update', 'delet', 'delete', 'insert', 'modifi', 'modify',
  'user', 'owner', 'tenant', 'org', 'organization', 'organis', 'organiz', 'project', 'account',
  'status', 'state', 'type', 'kind', 'name', 'title', 'description', 'note', 'metadata', 'meta',
  'data', 'extra', 'version', 'slug', 'position', 'order', 'sort', 'rank', 'archiv', 'archive',
  'enabl', 'enable', 'activ', 'active', 'visibl', 'visible', 'public', 'privat', 'private',
])

/** Bookkeeping columns every table may carry. Never a concern member. */
const BOOKKEEPING = new Set([
  'id', 'created_at', 'updated_at', 'deleted_at', 'inserted_at', 'modified_at', 'createdat',
  'updatedat', 'deletedat', 'created_by', 'updated_by', 'user_id', 'owner_id', 'tenant_id',
  'org_id', 'organization_id', 'project_id', 'account_id', 'version',
])

/** Split snake_case / camelCase / digits into lowercase words. */
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Za-z])(\d)/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * A deliberately tiny stemmer.
 *
 * It only has to agree with itself across one table's column names, which
 * share an author and a style. `refunded → refund`, `shipping → ship`,
 * `cancellation → cancel`, `coupons → coupon`. It does not have to be a
 * linguist, and making it smarter would make its mistakes harder to predict.
 */
export function stem(word: string): string {
  let w = word.toLowerCase()
  if (w.length <= 3) return w
  // Porter's rule: `shipp → ship`, but `bill`, `pass` and `buzz` keep their
  // double letter. Applied only after a suffix came off, so `address` survives.
  const undouble = (s: string) => (/([b-df-hj-kmnp-rtv-y])\1$/.test(s) ? s.slice(0, -1) : s)

  if (w.endsWith('ations') || w.endsWith('ation')) w = w.replace(/ations?$/, '')
  else if (w.endsWith('ments')) w = w.slice(0, -1)
  else if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y'
  else if (w.endsWith('ing') && w.length > 5) w = undouble(w.slice(0, -3))
  else if (w.endsWith('ed') && w.length > 4) w = undouble(w.slice(0, -2))
  else if (w.endsWith('ses') || w.endsWith('xes') || w.endsWith('ches') || w.endsWith('shes')) w = w.slice(0, -2)
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && w.length > 3) w = w.slice(0, -1)
  return w
}

export interface NameReading {
  /** The normalised concern key, or null when the name names no concern. */
  stem: string | null
  /** The word as written, for labelling (`refund`, not `refund`'s stem `refund`). */
  word: string | null
  /** Trailing number of a numbered sibling (`coupon_2` → 2). */
  ordinal: number | null
  /** The name with its ordinal removed, for repeating-group detection. */
  ordinalBase: string | null
}

/** Read one column name. */
export function readName(column: string, hostStem: string | null): NameReading {
  const tokens = tokenize(column)
  const ordinalIdx = tokens.findIndex((t, i) => i > 0 && /^\d+$/.test(t))
  const ordinal = ordinalIdx > 0 ? Number(tokens[ordinalIdx]) : null
  const ordinalBase =
    ordinalIdx > 0 ? tokens.filter((_, i) => i !== ordinalIdx).join('_') : null

  if (BOOKKEEPING.has(column.toLowerCase())) return { stem: null, word: null, ordinal, ordinalBase }

  const words = tokens.filter(t => !/^\d+$/.test(t))
  let i = 0
  while (i < words.length - 1 && QUALIFIERS.has(words[i])) i++
  const word = words[i]
  if (!word) return { stem: null, word: null, ordinal, ordinalBase }

  const s = stem(word)
  // A column named for the host itself (`order_number` on `orders`) describes
  // the row, not something attached to it.
  if (GENERIC_STEMS.has(s) || GENERIC_STEMS.has(word) || (hostStem && s === hostStem)) {
    return { stem: null, word: null, ordinal, ordinalBase }
  }
  return { stem: s, word, ordinal, ordinalBase }
}

/** `orders → order`, `categories → category`, `addresses → address`. */
export function singular(table: string): string {
  const t = table.toLowerCase()
  if (t.endsWith('ies') && t.length > 4) return table.slice(0, -3) + 'y'
  if (/(ss|x|ch|sh)es$/.test(t)) return table.slice(0, -2)
  if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us')) return table.slice(0, -1)
  return table
}

/** `refund → refunds`, `shipping → shipping`, `address → addresses`. */
export function plural(word: string): string {
  const w = word.toLowerCase()
  if (w.endsWith('ing') || (w.endsWith('s') && !w.endsWith('ss'))) return word
  if (/(ss|x|ch|sh)$/.test(w)) return `${word}es`
  if (/[^aeiou]y$/.test(w)) return `${word.slice(0, -1)}ies`
  return `${word}s`
}

/**
 * The name a satellite table would get by default: `orders` + `refund` →
 * `order_refunds`.
 *
 * A default and nothing more. The owner may name it anything when consenting,
 * and the name travels with the consent so the executor never re-derives it.
 */
export function defaultSatelliteName(host: string, word: string): string {
  const name = `${singular(host)}_${plural(word)}`.toLowerCase()
  return name.length <= 63 ? name : name.slice(0, 63)
}

/** The host's own stem, so `order_*` columns on `orders` are read as core. */
export function hostStem(host: string): string {
  const words = tokenize(singular(host))
  return stem(words[words.length - 1] ?? host)
}
