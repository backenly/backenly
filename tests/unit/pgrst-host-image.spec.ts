/**
 * The PostgREST binary the PostgREST host runs is the release the rest of the
 * repository runs, and the one CI tests the host against.
 *
 * services/pgrst-host/Dockerfile copies `postgrest` from the upstream image,
 * pinned by digest. The compose files run the same release by tag, and CI's
 * integration job reads the image from the Dockerfile itself, so the suite
 * that runs the real binary (tests/integration/pgrst-host.spec.ts) tests what
 * the image ships.
 */

import fs from 'fs'
import path from 'path'

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')

describe('the PostgREST binary the host runs', () => {
  const arg = /^ARG POSTGREST_IMAGE=(\S+)$/m.exec(read('services/pgrst-host/Dockerfile'))

  it('is pinned by digest', () => {
    expect(arg).not.toBeNull()
    expect(arg![1]).toMatch(/^postgrest\/postgrest:v[\d.]+@sha256:[0-9a-f]{64}$/)
  })

  it('is the release the compose files run', () => {
    const tag = /:(v[\d.]+)@/.exec(arg![1])![1]
    for (const compose of ['docker-compose.dev.yml', 'docker/compose.stack.yml']) {
      expect(read(compose)).toContain(`image: postgrest/postgrest:${tag}\n`)
    }
  })

  it('is the one CI runs the host’s integration suite against', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain(`image="$(sed -n 's/^ARG POSTGREST_IMAGE=//p' services/pgrst-host/Dockerfile)"`)
    expect(ci).toContain('echo "PGRST_HOST_BINARY=$RUNNER_TEMP/postgrest/postgrest" >> "$GITHUB_ENV"')
  })
})
