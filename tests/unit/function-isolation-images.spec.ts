/**
 * BOTH IMAGES RUN FUNCTION CODE OUTSIDE THE APP, UNDER A UID OF ITS OWN
 * =====================================================================
 *
 * Function code needs a root supervisor beside the app
 * (lib/services/ai-functions/isolation/), so the web and runtime images start
 * as root, start it from docker/function-isolation/entrypoint.sh, and run the
 * app as `node`. These pin each piece in both images, and that every piece is
 * asserted at build time rather than assumed: a USER line, a missing tini, a
 * runner a pool uid cannot read, or an /app it can, would each leave function
 * code next to the app's secrets (or functions refusing to run) without
 * failing anything else.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8')

/** The lines of a Dockerfile stage: the last one, or the one named. */
function stage(file: string, name?: string): string[] {
  const lines = read(join('docker', file)).split(/\r?\n/)
  const starts = lines.map((l, i) => (/^FROM\s/.test(l) ? i : -1)).filter((i) => i >= 0)
  const at = name ? starts.find((i) => new RegExp(`\\sAS\\s+${name}\\s*$`, 'i').test(lines[i])) : starts[starts.length - 1]
  if (at === undefined) throw new Error(`${file} has no stage ${name ?? '(final)'}`)
  const next = starts.find((i) => i > at)
  return lines.slice(at, next ?? lines.length)
}

/** Each instruction, continuation lines joined. */
function instructions(lines: string[]): string[] {
  const out: string[] = []
  let current = ''
  for (const line of lines) {
    if (!current && (/^\s*#/.test(line) || !line.trim())) continue
    current += (current ? ' ' : '') + line.replace(/\\\s*$/, '').trim()
    if (!/\\\s*$/.test(line)) {
      out.push(current)
      current = ''
    }
  }
  return out
}

describe.each(['web.Dockerfile', 'runtime.Dockerfile'])('%s', (file) => {
  const final = instructions(stage(file))
  const build = instructions(stage(file, 'build'))
  const index = (re: RegExp) => final.findIndex((i) => re.test(i))

  it('builds the runner, its supervisor and the sandbox packages in the build stage', () => {
    expect(build.some((i) => /^RUN node scripts\/build-function-runner\.mjs --out \/src\/dist-fn$/.test(i))).toBe(true)
  })

  it('starts as root, with tini as PID 1 running the entrypoint', () => {
    expect(final.filter((i) => /^USER\s/.test(i))).toEqual([])
    expect(final.filter((i) => /^ENTRYPOINT\s/.test(i))).toEqual(['ENTRYPOINT ["/usr/bin/tini", "--", "/opt/backenly-fn/entrypoint.sh"]'])
    expect(index(/apt-get install -y --no-install-recommends tini\b/)).toBeGreaterThan(-1)
  })

  it('puts the runner outside /app, and /app out of a pool uid’s reach', () => {
    const copied = index(/^COPY --from=build \/src\/dist-fn\/ \/opt\/backenly-fn\/$/)
    const entry = index(/^COPY docker\/function-isolation\/entrypoint\.sh \/opt\/backenly-fn\/entrypoint\.sh$/)
    const locked = index(/chown root:node \/app && chmod 0750 \/app/)
    expect(copied).toBeGreaterThan(-1)
    expect(entry).toBeGreaterThan(-1)
    expect(locked).toBeGreaterThan(copied)
    expect(final[locked]).toMatch(/chown -R root:root \/opt\/backenly-fn/)
    expect(final[locked]).toMatch(/find \/ -xdev -type f -perm \/6000 -exec chmod ug-s \{\} \+/)
  })

  it('asserts, after all of that, that a pool uid can run a module and cannot read /app', () => {
    const locked = index(/chmod 0750 \/app/)
    const asserted = index(/"kind":"selftest"/)
    expect(asserted).toBeGreaterThan(locked)
    const check = final[asserted]
    expect(check).toMatch(/setpriv --version && prlimit --version && choom --version && tini --version/)
    expect(check).toMatch(/test "\$\(stat -c '%U:%G %a' \/app\)" = "root:node 750"/)
    expect(check).toMatch(/setpriv --reuid=20000 --regid=20000 --clear-groups --no-new-privs -- node \/opt\/backenly-fn\/function-runner\.cjs \| grep -q '"ok":true'/)
    expect(check).toMatch(/"kind":"probe","mustNotRead":\["\/app"/)
    expect(check).toMatch(/grep -q '"\/app":"EACCES"/)
    expect(check).toMatch(/require\.resolve\(p, \{ paths: \['\/opt\/backenly-fn'\] \}\)/)
  })

  it('points a run at RDS roots it can read, and bounds how many run at once', () => {
    const env = final.filter((i) => /^ENV\s/.test(i)).join(' ')
    expect(env).toContain('BACKENLY_FN_CA_CERTS=/opt/backenly-fn/rds-ca-cloud-regions.pem')
    expect(env).toMatch(/BACKENLY_FN_MAX_CONCURRENCY=\d+/)
    expect(index(/cp \/app\/certs\/rds-ca-cloud-regions\.pem \/opt\/backenly-fn\/rds-ca-cloud-regions\.pem/)).toBeGreaterThan(-1)
  })
})

describe('docker/web.Dockerfile, where the app writes', () => {
  // /app is root:node 0750, so the app (node) can create nothing directly in
  // it: every directory it writes under /app at run time must exist, and be
  // node's, before /app is locked.
  const final = instructions(stage('web.Dockerfile'))
  const made = final.findIndex((i) => /^RUN mkdir -p \/app\/workspace /.test(i))
  const locked = final.findIndex((i) => /chown root:node \/app && chmod 0750 \/app/.test(i))

  it.each(['/app/workspace', '/app/backups', '/app/.next/cache', '/app/logs', '/app/storage', '/app/recovery', '/app/tmp'])(
    'makes %s and gives it to node before /app is locked',
    (dir) => {
      expect(made).toBeGreaterThan(-1)
      expect(made).toBeLessThan(locked)
      const [mkdir, chown] = final[made].split('&&').map((s) => s.trim())
      expect(mkdir.split(/\s+/)).toContain(dir)
      expect(chown).toMatch(/^chown -R node:node /)
      expect(chown.split(/\s+/)).toContain(dir)
    },
  )
})

describe('docker/runtime.Dockerfile, where the app writes', () => {
  it('sends the log files lib/logger writes to /tmp, the only place this image writes', () => {
    const env = instructions(stage('runtime.Dockerfile')).filter((i) => /^ENV\s/.test(i)).join(' ')
    expect(env).toMatch(/\bLOG_FILE_PATH=\/tmp\/\S+/)
  })
})

describe('docker/compose.stack.yml', () => {
  it('sets no user on the services that run functions', () => {
    const compose = read('docker/compose.stack.yml')
    const service = (name: string) => compose.slice(compose.indexOf(`\n  ${name}:\n`), compose.indexOf('\n  # ──', compose.indexOf(`\n  ${name}:\n`) + 1))
    for (const name of ['runtime', 'web']) expect(service(name)).not.toMatch(/^\s+user:/m)
  })
})

describe('docker/function-isolation/entrypoint.sh', () => {
  const script = read('docker/function-isolation/entrypoint.sh')

  it('starts the supervisor with an empty environment, passing it only its own settings and paths', () => {
    const start = script.indexOf('env -i')
    const block = script.slice(start, script.indexOf('function-supervisor.cjs', start))
    const names = [...block.matchAll(/^\s+([A-Z_]+)=/gm)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(5)
    expect(names.filter((n) => n !== 'PATH' && !n.startsWith('BACKENLY_FN_'))).toEqual([])
  })

  it('passes on from the task every capacity setting, and the socket the app reads too', () => {
    const start = script.indexOf('env -i')
    const block = script.slice(start, script.indexOf('function-supervisor.cjs', start))
    for (const name of ['MAX_CONCURRENCY', 'MAX_QUEUE', 'QUEUE_WAIT_MS', 'HEAP_MB', 'RSS_MB', 'NPROC', 'NOFILE', 'FSIZE_MB', 'SOCKET']) {
      expect(block).toMatch(new RegExp(`^\\s+BACKENLY_FN_${name}="\\$\\{BACKENLY_FN_${name}:-\\}" \\\\\\r?$`, 'm'))
    }
  })

  it('runs the app as node with no_new_privs and a umask that keeps its files from other uids', () => {
    expect(script).toMatch(/^umask 077$/m)
    expect(script).toMatch(/^exec setpriv --reuid="\$app_uid" --regid="\$app_gid" --init-groups --no-new-privs -- "\$@"$/m)
  })

  ;(process.platform === 'win32' ? it.skip : it)('started as anyone but root, runs the app as it is and says functions will refuse', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const out = execFileSync('sh', [join(ROOT, 'docker/function-isolation/entrypoint.sh'), 'sh', '-c', 'echo app-ran-as-$(id -u)'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(out.trim()).toBe(`app-ran-as-${process.getuid!()}`)
  })
})
