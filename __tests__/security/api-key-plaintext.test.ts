/**
 * API key plaintext must never be persisted.
 *
 * `ApiKey` carries `keyHash` (SHA-256, what authentication looks up) and `key`
 * (nullable plaintext). Issuance wrote `key` unconditionally under a comment
 * claiming "Development only", with no environment gate anywhere, so a database
 * dump handed over working credentials instead of useless hashes. An
 * mcp-scoped key can create, alter and drop customer tables.
 *
 * These are static-source assertions rather than route invocations. That is
 * deliberate: the routes require an authenticated session, a project, and a
 * live database, and the invariant being protected is a property of the code
 * itself — "no issuance path writes this column". A source assertion cannot be
 * satisfied by a passing mock, which is the failure mode a route-level test
 * would have here.
 *
 * The behavioural half is covered by the unit tests on the shared helper below.
 */

import fs from 'fs'
import path from 'path'
import {
  hasPersistedPlaintext,
  maskFromPrefix,
  plaintextForStorage,
} from '@/lib/auth/api-key-plaintext'

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

/** Every file that creates or updates an ApiKey row. */
const ISSUANCE_PATHS = [
  'app/api/api-keys/route.ts',
  'app/api/api-keys/[id]/rotate/route.ts',
  'app/api/projects/route.ts',
  'app/api/projects/[id]/anon-key/route.ts',
]

/** Strip comments so prose about the old behaviour cannot fail these. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/**
 * The argument objects passed to every `prisma.apiKey.create/update` call.
 *
 * Needed because `key: fullKey` is legitimate in a RESPONSE body — the caller
 * must receive the credential once — and forbidden in a Prisma `data` object.
 * A line-shaped regex cannot tell those apart, and a first attempt at one
 * failed exactly there, matching the response in the rotate route. Brace
 * matching from the call site distinguishes them structurally.
 */
function prismaApiKeyMutations(src: string): string[] {
  const blocks: string[] = []
  const call = /prisma\.apiKey\.(?:create|update|updateMany)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = call.exec(src)) !== null) {
    let depth = 0
    let i = m.index + m[0].length - 1
    const start = i
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    blocks.push(src.slice(start, i + 1))
  }
  return blocks
}

describe('the shared rule', () => {
  it('never returns a value to persist', () => {
    expect(plaintextForStorage()).toBeNull()
  })

  it('masks from keyPrefix without needing the secret', () => {
    expect(maskFromPrefix('sk_live_')).toBe('sk_live_' + '•'.repeat(8))
    expect(maskFromPrefix(null)).toBe('')
    expect(maskFromPrefix('')).toBe('')
  })

  it('identifies rows that still carry plaintext', () => {
    expect(hasPersistedPlaintext({ key: 'sk_live_abc' })).toBe(true)
    expect(hasPersistedPlaintext({ key: null })).toBe(false)
    expect(hasPersistedPlaintext({ key: '' })).toBe(false)
    expect(hasPersistedPlaintext({})).toBe(false)
  })
})

describe('no issuance path persists plaintext', () => {
  it.each(ISSUANCE_PATHS)('%s does not assign a raw key to the key column', (rel) => {
    // Scoped to the Prisma mutation arguments, never the whole file: returning
    // the key in a response is required, persisting it is the defect.
    for (const block of prismaApiKeyMutations(code(read(rel)))) {
      // Every value the old code assigned: `key: fullKey`, `key: generatedApiKey`,
      // `key: hashedKey`, and any other bare identifier or template literal.
      const assignment = block.match(/(?<![A-Za-z])key:\s*([^,\n}]+)/)
      if (!assignment) continue
      expect(assignment[1].trim()).toBe('plaintextForStorage()')
    }
  })

  it('creating a key stores null in the key column', () => {
    const src = code(read('app/api/api-keys/route.ts'))
    expect(src).toMatch(/key:\s*plaintextForStorage\(\)/)
  })

  it('rotating a key stores null in the key column', () => {
    const src = code(read('app/api/api-keys/[id]/rotate/route.ts'))
    expect(src).toMatch(/key:\s*plaintextForStorage\(\)/)
  })

  it('project creation stores null in the key column', () => {
    const src = code(read('app/api/projects/route.ts'))
    expect(src).toMatch(/key:\s*plaintextForStorage\(\)/)
  })

  it('still returns the full key to the caller exactly once', () => {
    // The point is that the credential stops being RECOVERABLE, not that the
    // user never receives it. If these break, key issuance is unusable.
    expect(code(read('app/api/api-keys/route.ts'))).toMatch(/key:\s*fullKey/)
    expect(code(read('app/api/api-keys/[id]/rotate/route.ts'))).toMatch(/key:\s*fullKey/)
  })
})

describe('public-key behaviour stays intentional', () => {
  it('anon keys keep their plaintext on Project.anonKey', () => {
    // Anon keys are public by design and must remain readable: the dashboard
    // and the generated frontend snippet both hand them back.
    const src = code(read('app/api/projects/[id]/anon-key/route.ts'))
    expect(src).toMatch(/anonKey/)
  })

  it('the anon-key route registers the ApiKey row without a plaintext key', () => {
    const src = code(read('app/api/projects/[id]/anon-key/route.ts'))
    const create = src.slice(src.indexOf('apiKey.create'), src.indexOf('project.update'))
    expect(create).toMatch(/keyHash/)
    expect(create).not.toMatch(/^\s*key:/m)
  })

  it('keyType "public" is not treated as an exemption', () => {
    // The trap: keyType only takes 'dashboard' | 'public', and every sk_* secret
    // in the system is a keyType 'public' row. An exemption keyed on it would
    // have preserved plaintext for exactly the credentials at risk.
    const src = code(read('app/api/api-keys/route.ts'))
    expect(src).not.toMatch(/keyType\s*===\s*'public'\s*\?\s*fullKey/)
  })
})

describe('rotation actually revokes the old key', () => {
  const src = code(read('app/api/api-keys/[id]/rotate/route.ts'))

  it('writes the new keyHash into the update, not merely computes it', () => {
    // It did not. It wrote a bcrypt hash into the plaintext column and never
    // touched keyHash, so the new key could not authenticate and the old one
    // still could. Rotation is what you reach for when a key has leaked.
    //
    // Asserted against the Prisma update ARGUMENTS, not the file. A first
    // version of this test checked the file for /keyHash/ and passed happily
    // when the field was deleted from the data object, because the `const
    // keyHash = ...` declaration still matched. It proved a variable existed
    // rather than that rotation stored it, which is the same shape of mistake
    // as the bug itself.
    expect(src).toMatch(/createHash\(['"]sha256['"]\)/)
    const mutations = prismaApiKeyMutations(src)
    expect(mutations.length).toBeGreaterThan(0)
    for (const block of mutations) {
      expect(block).toMatch(/(?<![A-Za-z])keyHash\s*[,:]/)
    }
  })

  it('does not use bcrypt for the lookup hash', () => {
    // keyHash is a unique indexed column read by equality on every request.
    // A per-row salted hash cannot be looked up by equality at all.
    expect(src).not.toMatch(/hashPassword/)
  })

  it('refuses to rotate the project anon key', () => {
    // A hazard CREATED by fixing the bug above. The anon key lives in two
    // places — this row's hash and Project.anonKey's plaintext — so a rotation
    // that updates only the hash breaks every embedded frontend. Harmless while
    // rotation was a no-op; not harmless now.
    expect(src).toMatch(/anonKey/)
    expect(src).toMatch(/status:\s*400/)
    // Matched by hash, not by the display name, which anyone can change.
    expect(src).not.toMatch(/name\s*===\s*['"]Public Anon Key['"]/)
  })
})

describe('authentication remains hash-based', () => {
  const AUTH_PATHS = [
    'lib/auth/apiKeyAuth.ts',
    'lib/auth/server.ts',
    'lib/mcp/auth.ts',
    'lib/middleware/apiKeyAuth.ts',
  ]

  it.each(AUTH_PATHS)('%s looks keys up by keyHash', (rel) => {
    expect(code(read(rel))).toMatch(/keyHash/)
  })

  it.each(AUTH_PATHS)('%s never looks a key up by its plaintext', (rel) => {
    // where: { key: ... } would reintroduce the dependency this removes.
    expect(code(read(rel))).not.toMatch(/where:\s*\{[^}]*\bkey:\s*(?!Hash)/)
  })
})

describe('the verifier no longer reads secret plaintext', () => {
  const src = code(read('lib/ai/brain/verifier.ts'))

  it('resolves the project anon key instead of an ApiKey row', () => {
    expect(src).toMatch(/anonKey/)
    expect(src).not.toMatch(/apiKey\.findFirst/)
  })

  it('does not treat an unauthenticated 401 as success', () => {
    // The silent-success failure: with no credential, a 401 is the expected
    // answer to an anonymous request and proves nothing about the endpoint.
    expect(src).toMatch(/failureKind:\s*'unauthenticated'/)
    expect(src).toMatch(/authenticated/)
  })
})

describe('generated frontend uses the anon key', () => {
  const src = code(read('lib/integrations/frontend.executor.ts'))

  it('reads Project.anonKey', () => {
    expect(src).toMatch(/project\.anonKey/)
  })

  it('does not read a persisted ApiKey plaintext', () => {
    expect(src).not.toMatch(/apiKeys\s*:\s*\{[^}]*select/)
    expect(src).not.toMatch(/apiKeys\[0\]\?\.key/)
  })
})

describe('the backfill script is manual and quiet', () => {
  const rel = 'scripts/scrub-plaintext-api-keys.ts'
  const raw = read(rel)
  const src = code(raw)

  it('performs NO write on a dry run', async () => {
    // Behavioural, not textual. This guard is the only thing between a routine
    // "let me see what's there" and an unintended rewrite of every credential
    // row, so it is exercised rather than read.
    const { scrubPlaintextApiKeys } = await import('@/scripts/scrub-plaintext-api-keys')
    const updateMany = jest.fn()
    const client = {
      apiKey: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'a', keyPrefix: 'sk_live_', keyType: 'public', scope: 'runtime', serviceRole: false, createdAt: new Date() },
          { id: 'b', keyPrefix: 'sk_service_', keyType: 'public', scope: 'mcp', serviceRole: true, createdAt: new Date() },
        ]),
        updateMany,
        count: jest.fn().mockResolvedValue(0),
      },
    }
    const lines: string[] = []
    await scrubPlaintextApiKeys({ client, log: (m: string) => lines.push(m) })

    expect(updateMany).not.toHaveBeenCalled()
    expect(lines.join('\n')).toMatch(/DRY RUN/)
    expect(lines.join('\n')).toMatch(/Rows with persisted plaintext: 2/)
    // Shape of the exposure, never the exposure itself.
    expect(lines.join('\n')).toMatch(/service-role rows: 1/)
    expect(lines.join('\n')).toMatch(/non-runtime scope rows: 1/)
  })

  it('writes only when --apply is passed, and only nulls the key column', async () => {
    const { scrubPlaintextApiKeys } = await import('@/scripts/scrub-plaintext-api-keys')
    const updateMany = jest.fn().mockResolvedValue({ count: 2 })
    const client = {
      apiKey: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'a', keyPrefix: 'sk_live_', keyType: 'public', scope: 'runtime', serviceRole: false, createdAt: new Date() },
        ]),
        updateMany,
        count: jest.fn().mockResolvedValue(0),
      },
    }
    await scrubPlaintextApiKeys({ apply: true, client, log: () => {} })

    expect(updateMany).toHaveBeenCalledTimes(1)
    const [args] = updateMany.mock.calls[0]
    expect(args).toEqual({ where: { key: { not: null } }, data: { key: null } })
    // keyHash is what authenticates. Touching it would revoke live keys.
    expect(JSON.stringify(args)).not.toMatch(/keyHash/)
  })

  it('prints no key material', async () => {
    const { scrubPlaintextApiKeys } = await import('@/scripts/scrub-plaintext-api-keys')
    // Deliberately NOT shaped like any real provider's key. An earlier
    // version used an sk_live_ prefix with 32 hex characters, which is
    // Stripe's live-secret format, and GitHub push protection rejected the
    // commit. It was right to: a credential-shaped literal in a public repo
    // is indistinguishable from a leak to every scanner that reads it, and
    // the test does not care what the value looks like.
    const secret = 'PLAINTEXT_FIXTURE_NOT_A_REAL_CREDENTIAL'
    const client = {
      apiKey: {
        // A row that wrongly carried the secret must still never be printed.
        findMany: jest.fn().mockResolvedValue([
          { id: 'a', key: secret, keyPrefix: 'sk_live_', keyType: 'public', scope: 'runtime', serviceRole: false, createdAt: new Date() },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
      },
    }
    const lines: string[] = []
    await scrubPlaintextApiKeys({ apply: true, client, log: (m: string) => lines.push(m) })
    expect(lines.join('\n')).not.toContain(secret)
  })

  it('does not select the secret column from the database', async () => {
    const { scrubPlaintextApiKeys } = await import('@/scripts/scrub-plaintext-api-keys')
    const findMany = jest.fn().mockResolvedValue([])
    await scrubPlaintextApiKeys({
      client: { apiKey: { findMany, updateMany: jest.fn(), count: jest.fn() } },
      log: () => {},
    })
    const [args] = findMany.mock.calls[0]
    expect(args.select.key).toBeUndefined()
    expect(args.where).toEqual({ key: { not: null } })
  })

  it('targets only rows carrying plaintext, and never touches keyHash', () => {
    expect(src).toMatch(/key:\s*\{\s*not:\s*null\s*\}/)
    expect(src).toMatch(/data:\s*\{\s*key:\s*null\s*\}/)
    expect(src).not.toMatch(/keyHash\s*:/)
  })

  it('never selects the secret column', () => {
    const select = src.slice(src.indexOf('select:'), src.indexOf('orderBy'))
    expect(select).not.toMatch(/^\s*key:\s*true/m)
  })

  it('is not wired into build, deploy or any package lifecycle', () => {
    const pkg = JSON.parse(read('package.json'))
    const scripts: Record<string, string> = pkg.scripts ?? {}
    for (const [name, cmd] of Object.entries(scripts)) {
      expect(`${name}:${cmd}`).not.toMatch(/scrub-plaintext-api-keys/)
    }
    expect(read('scripts/deploy.sh')).not.toMatch(/scrub-plaintext-api-keys/)
  })
})
