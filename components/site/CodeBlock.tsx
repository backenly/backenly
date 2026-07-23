'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'

/**
 * Copy-to-clipboard code block for the marketing/docs site.
 *
 * Highlighting is done here rather than pulled in from a syntax-highlighter
 * package for two reasons: the site ships no client-side highlighting runtime
 * (these blocks are static strings known at build time), and every token stays
 * a plain text node inside the <pre>, so `textContent` is still byte-identical
 * to the `code` prop. What an agent or crawler scrapes is exactly what the copy
 * button writes to the clipboard — colour is presentation only.
 *
 * The palette is VS Code Dark+ so a developer reads these blocks with the same
 * token→colour mapping their editor already trained them on.
 */

const C = {
  comment: 'text-[#6a9955]',
  string: 'text-[#ce9178]',
  number: 'text-[#b5cea8]',
  keyword: 'text-[#569cd6]',
  control: 'text-[#c586c0]',
  fn: 'text-[#dcdcaa]',
  variable: 'text-[#9cdcfe]',
  type: 'text-[#4ec9b0]',
  punct: 'text-[#808080]',
} as const

type Rule = {
  /** Regex source, no flags, no capture groups (use non-capturing). */
  re: string
  cls: string
  /** Re-tokenize the match with these rules — e.g. $VARS inside a shell string. */
  sub?: Rule[]
}

/* ── Shell ────────────────────────────────────────────────────────────────
   Rules are ordered: whatever matches EARLIEST in the string wins, and ties at
   the same index go to the rule listed first. The command rule deliberately
   cannot start with "-" so a continuation line like `  -H "x-api-key: …"` is
   read as a flag rather than as the command. */
const SHELL_VAR: Rule[] = [{ re: '\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?', cls: C.variable }]

const SHELL: Rule[] = [
  { re: '^[ \\t]*#[^\\n]*', cls: C.comment },
  { re: '"(?:\\\\.|[^"\\\\])*"', cls: C.string, sub: SHELL_VAR },
  { re: "'(?:\\\\.|[^'\\\\])*'", cls: C.string },
  { re: '\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?', cls: C.variable },
  { re: '(?:^|[ \\t])--?[A-Za-z][\\w-]*', cls: C.keyword },
  { re: '^[ \\t]*[\\w./@][\\w./@-]*', cls: C.fn },
  { re: '\\b\\d+\\b', cls: C.number },
]

/* ── JSON (jsonc — host MCP configs are commonly commented) ────────────── */
const JSON_RULES: Rule[] = [
  { re: '//[^\\n]*', cls: C.comment },
  { re: '"(?:\\\\.|[^"\\\\])*"(?=\\s*:)', cls: C.variable },
  { re: '"(?:\\\\.|[^"\\\\])*"', cls: C.string },
  { re: '\\b(?:true|false|null)\\b', cls: C.keyword },
  { re: '-?\\b\\d+(?:\\.\\d+)?\\b', cls: C.number },
  { re: '[{}\\[\\],:]', cls: C.punct },
]

/* ── TypeScript / JavaScript ──────────────────────────────────────────── */
const TS: Rule[] = [
  { re: '//[^\\n]*|/\\*[\\s\\S]*?\\*/', cls: C.comment },
  { re: '`(?:\\\\.|[^`\\\\])*`', cls: C.string },
  { re: '"(?:\\\\.|[^"\\\\])*"', cls: C.string },
  { re: "'(?:\\\\.|[^'\\\\])*'", cls: C.string },
  {
    re: '\\b(?:import|export|from|const|let|var|function|class|interface|type|enum|new|extends|implements|as|default|async|declare)\\b',
    cls: C.keyword,
  },
  {
    re: '\\b(?:await|return|if|else|for|while|do|try|catch|finally|throw|switch|case|break|continue|yield|in|of)\\b',
    cls: C.control,
  },
  { re: '\\b(?:true|false|null|undefined|this|void)\\b', cls: C.keyword },
  { re: '\\b[A-Za-z_$][\\w$]*(?=\\s*\\()', cls: C.fn },
  // `\b` before the lookahead is load-bearing: without it the engine backtracks
  // to a shorter identifier (`.lis` of `.list(`) just to satisfy `(?!\s*\()`.
  { re: '\\.[A-Za-z_$][\\w$]*\\b(?!\\s*\\()', cls: C.variable },
  { re: '\\b[A-Z][A-Za-z0-9_]*\\b', cls: C.type },
  { re: '\\b\\d+(?:\\.\\d+)?\\b', cls: C.number },
]

/* ── SQL ───────────────────────────────────────────────────────────────── */
const SQL: Rule[] = [
  { re: '--[^\\n]*', cls: C.comment },
  { re: "'(?:''|[^'])*'", cls: C.string },
  {
    re: '\\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|ORDER|BY|HAVING|LIMIT|OFFSET|WITH|AS|AND|OR|NOT|NULL|CREATE|TABLE|INDEX|ALTER|ADD|COLUMN|CONSTRAINT|REFERENCES|PRIMARY|KEY|FOREIGN|UNIQUE|DEFAULT|EXPLAIN|RETURNING|INTO|VALUES|SET|DISTINCT|COUNT|SUM|AVG|MIN|MAX)\\b',
    cls: C.keyword,
  },
  {
    re: '\\b(?:text|uuid|integer|int|bigint|boolean|timestamptz|timestamp|jsonb|json|numeric|serial|date|vector|inet)\\b',
    cls: C.type,
  },
  { re: '\\b\\d+\\b', cls: C.number },
]

/* ── Markdown ─────────────────────────────────────────────────────────── */
const MD: Rule[] = [
  { re: '^#{1,6} [^\\n]*', cls: C.keyword },
  { re: '```[\\s\\S]*?```', cls: C.string },
  { re: '`[^`\\n]*`', cls: C.string },
  { re: '\\*\\*[^*\\n]+\\*\\*', cls: C.fn },
  { re: '^[ \\t]*(?:[-*+]|\\d+\\.)[ \\t]', cls: C.punct },
  { re: 'https?://[^\\s)>"]+', cls: C.string },
]

const GRAMMARS: Record<string, Rule[]> = {
  bash: SHELL,
  sh: SHELL,
  shell: SHELL,
  console: SHELL,
  json: JSON_RULES,
  jsonc: JSON_RULES,
  ts: TS,
  tsx: TS,
  typescript: TS,
  js: TS,
  jsx: TS,
  javascript: TS,
  sql: SQL,
  md: MD,
  markdown: MD,
}

/** Compile a rule set once into a single alternation with per-rule groups. */
function compile(rules: Rule[]) {
  return {
    re: new RegExp(rules.map((r, i) => `(?<g${i}>${r.re})`).join('|'), 'gm'),
    rules,
  }
}

const COMPILED = new Map<Rule[], ReturnType<typeof compile>>()
function grammarFor(rules: Rule[]) {
  let c = COMPILED.get(rules)
  if (!c) {
    c = compile(rules)
    COMPILED.set(rules, c)
  }
  return c
}

function tokenize(code: string, rules: Rule[], keyPrefix = 't'): ReactNode[] {
  const { re } = grammarFor(rules)
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  let m: RegExpExecArray | null

  re.lastIndex = 0
  while ((m = re.exec(code)) !== null) {
    // A zero-length match would spin forever; step past it.
    if (m[0] === '') {
      re.lastIndex += 1
      continue
    }
    if (m.index > last) out.push(code.slice(last, m.index))

    let rule: Rule | undefined
    const groups = m.groups ?? {}
    for (let i = 0; i < rules.length; i++) {
      if (groups[`g${i}`] !== undefined) {
        rule = rules[i]
        break
      }
    }

    out.push(
      <span key={`${keyPrefix}-${k++}`} className={rule?.cls}>
        {rule?.sub ? tokenize(m[0], rule.sub, `${keyPrefix}-${k}`) : m[0]}
      </span>,
    )
    last = re.lastIndex
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}

export function CodeBlock({
  code,
  label,
  language = 'bash',
}: {
  code: string
  label?: string
  language?: string
}) {
  const [copied, setCopied] = useState(false)

  const rendered = useMemo(() => {
    const rules = GRAMMARS[language.toLowerCase()]
    return rules ? tokenize(code, rules) : code
  }, [code, language])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard blocked — the code is still selectable */
    }
  }

  return (
    <div className="group relative overflow-hidden rounded-lg border border-white/10 bg-[#0a0a0c]">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2">
        <span className="font-mono text-xs text-zinc-500">{label ?? language}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-zinc-400 transition hover:border-white/25 hover:text-white"
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" /> Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-4 text-[13px] leading-relaxed">
        <code className="font-mono text-[#d4d4d4] [font-variant-ligatures:none]">{rendered}</code>
      </pre>
    </div>
  )
}
