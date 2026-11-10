/**
 * THE SDK README'S EXAMPLES COMPILE AGAINST THE SDK (#616)
 * ========================================================
 * The README that ships with @backenly/sdk is the first thing a developer
 * copies, and its examples did not run: realtime called
 * `realtime.onTableChange()` and read `event.record`, storage called
 * `storage.from()` and `getSignedUrl()`, none of which the SDK has, the
 * quickstart destructured an `error` the query never resolves, sign-up
 * destructured a `data` it never returns, and the typed client refused the
 * `Database` that `npx @backenly/cli types` writes.
 *
 * So every TypeScript block in packages/sdk/README.md is compiled here, as a
 * reader's own strict TypeScript project would compile it, against the SDK's
 * source and the types the CLI generates (lib/typegen/type-generator.ts). The
 * SDK snippet on the landing page (components/landing/ConnectTabs.tsx), which
 * is taken from the README, is compiled the same way. A method the SDK does not
 * have, or a field it does not return, fails here.
 *
 * What the storage examples do against the real routes is pinned in
 * tests/integration/sdk-storage-urls.spec.ts.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'
import { generateTypes } from '@/lib/typegen/type-generator'
import type { ColumnInfo } from '@/lib/typegen/schema-reader'

const ROOT = process.cwd()
const README = readFileSync(join(ROOT, 'packages/sdk/README.md'), 'utf8')
const LANDING = readFileSync(join(ROOT, 'components/landing/ConnectTabs.tsx'), 'utf8')

/** Where the snippets are compiled from: a directory of the reader's project, never written to disk. */
const APP = join(ROOT, '.sdk-readme-examples')

function tsBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1])
}

/** The SDK door's code on the landing page. */
function landingSnippet(): string {
  const match = /id: 'sdk',[\s\S]*?code: `([\s\S]*?)`,/.exec(LANDING)
  if (!match) throw new Error("the landing page's SDK snippet was not found")
  return match[1]
}

const column = (columnName: string, dataType: string, udtName: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  tableName: 'posts',
  columnName,
  dataType,
  udtName,
  isNullable: false,
  columnDefault: null,
  isPrimaryKey: false,
  isForeignKey: false,
  ordinalPosition: 1,
  ...extra,
})

/** What `npx @backenly/cli types > src/backenly.types.ts` writes, for a `posts` table. */
const GENERATED_TYPES = generateTypes({
  projectId: 'p',
  schemaName: 'workspace_p',
  generatedAt: new Date(0).toISOString(),
  tables: [
    {
      tableName: 'posts',
      columns: [
        column('id', 'uuid', 'uuid', { isPrimaryKey: true, columnDefault: 'gen_random_uuid()' }),
        column('title', 'text', 'text'),
        column('published', 'boolean', 'bool', { columnDefault: 'false' }),
        column('created_at', 'timestamp with time zone', 'timestamptz', { columnDefault: 'now()' }),
      ],
    },
  ],
}).source

/**
 * What a reader brings to a snippet that does not define it: the client from
 * the quickstart, their credentials, a signed-in user, a picked file, and an
 * element to show it in. Nothing here stands in for the SDK.
 */
const READER = `
declare const backend: import('@backenly/sdk').BackenlyClient
declare const projectId: string
declare const apiKey: string
declare const email: string
declare const password: string
declare const userId: string
declare const postId: string
declare const file: File
declare const avatar: HTMLImageElement
declare function render(change: unknown): void
`

function compile(snippets: Record<string, string>): Record<string, string[]> {
  const files = new Map<string, string>([
    [join(APP, 'reader.d.ts'), READER],
    [join(APP, 'backenly.types.ts'), GENERATED_TYPES],
  ])
  for (const [name, code] of Object.entries(snippets)) files.set(join(APP, `${name}.ts`), `${code}\nexport {}\n`)

  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: ['node'],
    typeRoots: [join(ROOT, 'node_modules/@types')],
    baseUrl: ROOT,
    paths: {
      '@backenly/sdk': ['packages/sdk/src/index.ts'],
      '@backenly/sdk/supabase': ['packages/sdk/src/supabase-compat.ts'],
    },
  }
  const host = ts.createCompilerHost(options)
  const fileExists = host.fileExists.bind(host)
  const directoryExists = host.directoryExists?.bind(host)
  const readFile = host.readFile.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  host.fileExists = (f) => files.has(f) || fileExists(f)
  host.directoryExists = (d) => d === APP || (directoryExists ? directoryExists(d) : true)
  host.readFile = (f) => files.get(f) ?? readFile(f)
  host.getSourceFile = (f, language, onError, create) =>
    files.has(f) ? ts.createSourceFile(f, files.get(f)!, language, true) : getSourceFile(f, language, onError, create)

  const program = ts.createProgram([...files.keys()], options, host)
  const found: Record<string, string[]> = Object.fromEntries(Object.keys(snippets).map((name) => [name, []]))
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const name = Object.keys(snippets).find((n) => d.file?.fileName === join(APP, `${n}.ts`))
    const text = ts.flattenDiagnosticMessageText(d.messageText, '\n')
    if (!name) {
      // Anything outside the snippets is the harness's own fault, and must not pass quietly.
      found.harness = [...(found.harness ?? []), `${d.file?.fileName ?? 'options'}: ${text}`]
      continue
    }
    const { line } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0)
    found[name].push(`line ${line + 1}: ${text}`)
  }
  return found
}

const blocks = tsBlocks(README)
let diagnostics: Record<string, string[]> = {}

// One program for every snippet: a few seconds, longer on a busy machine.
beforeAll(() => {
  const snippets: Record<string, string> = Object.fromEntries(blocks.map((code, i) => [`readme-${i + 1}`, code]))
  snippets.landing = landingSnippet()
  diagnostics = compile(snippets)
}, 120_000)

describe('the @backenly/sdk README', () => {
  it('has the TypeScript examples this test compiles', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(6)
    expect(diagnostics.harness).toBeUndefined()
  })

  it.each(blocks.map((code, i) => [`readme-${i + 1}`, code.split('\n')[0]]))(
    'example %s (%s) compiles against the SDK',
    (name) => {
      expect(diagnostics[name]).toEqual([])
    },
  )
})

describe("the landing page's SDK snippet", () => {
  it('compiles against the SDK', () => {
    expect(diagnostics.landing).toEqual([])
  })
})
