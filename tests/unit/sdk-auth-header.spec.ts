import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * The project key goes in `x-api-key`. Never in `Authorization`.
 *
 * The server treats the two as different credentials: `x-api-key` is looked up
 * as a hashed project key, while `Authorization: Bearer` is parsed as a JWT and
 * verified against the project's signing secret. A `proj_live_…` key is not a
 * JWT, so sending it as a Bearer token fails at `token.split('.')[1]` and comes
 * back 401 INVALID_TOKEN.
 *
 * The published SDK sent every data-plane call the second way, so it could not
 * read or write anything — and because it is what people reverse-engineer the
 * contract from, it taught the wrong scheme to everyone who read it.
 */
const SRC = join(process.cwd(), 'packages/sdk/src')
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'))

describe('the SDK sends the project key in x-api-key (P0)', () => {
  it('scans the whole SDK source', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(files)('%s never puts an apiKey into an Authorization header', (file) => {
    const text = readFileSync(join(SRC, file), 'utf8')
    const offenders = text
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) =>
        /Authorization/i.test(line) &&
        /\bapiKey\b/.test(line) &&
        !line.trimStart().startsWith('*') &&
        !line.trimStart().startsWith('//'),
      )
      .map(({ line, n }) => `${file}:${n}  ${line.slice(0, 100)}`)
    expect(offenders).toEqual([])
  })

  it('the client actually sets x-api-key', () => {
    const client = readFileSync(join(SRC, 'client.ts'), 'utf8')
    expect(client).toMatch(/headers\['x-api-key'\]\s*=\s*this\.apiKey/)
  })

  it('X-User-Token remains the end-user credential, sent alongside', () => {
    const client = readFileSync(join(SRC, 'client.ts'), 'utf8')
    expect(client).toContain("headers['X-User-Token'] = this.userToken")
  })
})
