/**
 * THE INSTALLER WRITES TO THE FILE HOLDING EVERY SECRET
 * ====================================================
 * `npm run selfhost` is documented as safe to rerun, and operators will rerun
 * it — after a failed step, after changing a setting, after an upgrade. So the
 * .env editor has two obligations that pull against each other, and both are
 * asserted here rather than left to the installer's integration test, where a
 * wrong answer costs a whole container stack to observe.
 *
 *   NEVER overwrite a configured secret. Regenerating JWT_SECRET on a rerun
 *   signs out every session; regenerating POSTGREST_AUTHENTICATOR_PASSWORD
 *   breaks a PostgREST that is already authenticating with the old one.
 *
 *   ALWAYS overwrite a template placeholder. `.env.example` ships
 *   `JWT_SECRET=your-super-secret-jwt-key-change-this-in-production`. That
 *   string is in a public repository. Treating it as configured would leave a
 *   deployment signing sessions with a key everybody already has, which is
 *   worse than the file being empty.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { randomBytes } from 'crypto'
import { ensureEnvVar, envValue, isPlaceholder, setEnvVar } from '../../scripts/lib/env-file'

/**
 * A value with the shape of a real generated secret, built at runtime.
 *
 * Deliberately not a literal. A 64-character hex string in a source file is
 * indistinguishable from a leaked key to any scanner worth having, and the OSS
 * preflight correctly refused to publish this file when it was one. The test
 * needs the SHAPE, not a fixed value.
 */
const looksGenerated = () => randomBytes(32).toString('hex')

const COUNTER = () => {
  let n = 0
  return () => `generated-value-${++n}`
}

describe('envValue', () => {
  it('reads a plain assignment', () => {
    expect(envValue(['JWT_SECRET=abc123'], 'JWT_SECRET')).toBe('abc123')
  })

  it('trims, because an operator editing by hand leaves spaces', () => {
    expect(envValue(['  JWT_SECRET =  abc123  '], 'JWT_SECRET')).toBe('abc123')
  })

  it('treats a commented-out line as absent, because it configures nothing', () => {
    expect(envValue(['# JWT_SECRET=abc123'], 'JWT_SECRET')).toBeNull()
  })

  it('does not match a key that merely shares a prefix', () => {
    // POSTGREST_JWT_SECRET must not answer for JWT_SECRET. Getting this wrong
    // would make the installer believe an unset secret was configured.
    expect(envValue(['POSTGREST_JWT_SECRET=abc'], 'JWT_SECRET')).toBeNull()
  })

  it('returns an empty string for a bare key, distinct from absent', () => {
    expect(envValue(['MASTER_ENCRYPTION_KEY='], 'MASTER_ENCRYPTION_KEY')).toBe('')
    expect(envValue([], 'MASTER_ENCRYPTION_KEY')).toBeNull()
  })
})

describe('isPlaceholder', () => {
  it.each([
    '',
    'your-super-secret-jwt-key-change-this-in-production',
    'your-storage-secret-change-this-in-production',
    'your-postgrest-jwt-secret-change-this-in-production',
    '<uuid>',
  ])('treats the template value %p as unconfigured', value => {
    expect(isPlaceholder(value)).toBe(true)
  })

  it.each([
    '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    'hunter2',
    // Contains "your" but is not the template's `your-` prefix.
    'notyour-secret',
  ])('treats the real value %p as configured', value => {
    expect(isPlaceholder(value)).toBe(false)
  })

  it('treats a generated 64-char hex secret as configured', () => {
    expect(isPlaceholder(looksGenerated())).toBe(false)
  })
})

describe('ensureEnvVar', () => {
  it('generates when the key is absent, appending it', () => {
    const lines = ['DATABASE_URL=postgresql://x']
    expect(ensureEnvVar(lines, 'JWT_SECRET', COUNTER())).toBe('generated')
    expect(envValue(lines, 'JWT_SECRET')).toBe('generated-value-1')
  })

  it('generates in place when the key exists but is a placeholder', () => {
    const lines = [
      '# The JWT secret',
      'JWT_SECRET=your-super-secret-jwt-key-change-this-in-production',
      'JWT_EXPIRES_IN=7d',
    ]
    expect(ensureEnvVar(lines, 'JWT_SECRET', COUNTER())).toBe('generated')

    expect(envValue(lines, 'JWT_SECRET')).toBe('generated-value-1')
    // Position and surrounding lines preserved: the comments are the only
    // documentation most of these keys have.
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('# The JWT secret')
    expect(lines[2]).toBe('JWT_EXPIRES_IN=7d')
  })

  it('keeps a configured value, which is what makes a rerun safe', () => {
    const real = looksGenerated()
    const lines = [`JWT_SECRET=${real}`]
    expect(ensureEnvVar(lines, 'JWT_SECRET', COUNTER())).toBe('kept')
    expect(envValue(lines, 'JWT_SECRET')).toBe(real)
  })

  it('is idempotent: the second call changes nothing', () => {
    const lines = ['JWT_SECRET=']
    const gen = COUNTER()

    expect(ensureEnvVar(lines, 'JWT_SECRET', gen)).toBe('generated')
    const afterFirst = envValue(lines, 'JWT_SECRET')

    expect(ensureEnvVar(lines, 'JWT_SECRET', gen)).toBe('kept')
    expect(envValue(lines, 'JWT_SECRET')).toBe(afterFirst)
  })

  it('never calls the generator when the value is kept', () => {
    // Not just "the value is unchanged". The generator having run at all would
    // mean a rerun consumed entropy and could, with a different code path,
    // have written it.
    const generate = jest.fn(() => 'should-not-be-used')
    ensureEnvVar(['JWT_SECRET=real-value-here'], 'JWT_SECRET', generate)
    expect(generate).not.toHaveBeenCalled()
  })
})

describe('setEnvVar', () => {
  it('overwrites unconditionally, which ensureEnvVar will not do', () => {
    const lines = ['POSTGREST_AUTHENTICATOR_PASSWORD=old']
    setEnvVar(lines, 'POSTGREST_AUTHENTICATOR_PASSWORD', 'new')
    expect(envValue(lines, 'POSTGREST_AUTHENTICATOR_PASSWORD')).toBe('new')
  })

  it('appends when absent', () => {
    const lines: string[] = []
    setEnvVar(lines, 'POSTGREST_AUTHENTICATOR_PASSWORD', 'new')
    expect(envValue(lines, 'POSTGREST_AUTHENTICATOR_PASSWORD')).toBe('new')
  })
})

describe('against the real .env.example', () => {
  const lines = readFileSync(resolve(__dirname, '../../.env.example'), 'utf8').split('\n')

  // The list the installer fills. If the template ever ships a real-looking
  // default for one of these, the installer would silently keep it, so this
  // asserts the property on the actual file rather than on a fixture.
  const generatedSecrets = [
    'JWT_SECRET',
    'POSTGREST_JWT_SECRET',
    'STORAGE_SECRET',
    'MASTER_ENCRYPTION_KEY',
  ]

  it.each(generatedSecrets)('%s is present and is a placeholder the installer will replace', key => {
    const value = envValue(lines, key)
    expect(value).not.toBeNull()
    expect(isPlaceholder(value!)).toBe(true)
  })

  it('documents MASTER_ENCRYPTION_KEY, which was a required secret nothing mentioned', () => {
    // It is required whenever NODE_ENV=production and silently falls back to
    // 32 zero bytes otherwise. It was absent from the template entirely, so a
    // self-hoster following the README encrypted every project signing secret
    // and stored credential with a key of zeroes.
    expect(envValue(lines, 'MASTER_ENCRYPTION_KEY')).toBe('')
  })
})
