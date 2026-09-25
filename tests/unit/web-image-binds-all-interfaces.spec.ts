/**
 * THE WEB IMAGE LISTENS ON EVERY INTERFACE, WHATEVER THE PLATFORM SETS
 * ===================================================================
 *
 * Next's standalone server binds to process.env.HOSTNAME. The Dockerfile sets
 * HOSTNAME=0.0.0.0 in ENV, and ECS Fargate replaces it with the task's own
 * hostname. Measured on AWS staging 2026-09-25: Next logged
 * "Local: http://ip-10-20-10-179.ap-south-1.compute.internal:3000", so nothing
 * listened on loopback. The ALB still reached it, so every health check was
 * green, while the contract sweep's ingress probe (127.0.0.1:3000) failed every
 * minute and never verified one project.
 *
 * So the bind address is set at exec, in CMD, where no platform environment can
 * replace it. This runs that exact CMD string through a real `sh`, with HOSTNAME
 * already set the way Fargate sets it and a stand-in `node` that reports what
 * it was given. An assertion about the file's TEXT would pass just as happily
 * against a CMD whose quoting never sets the variable.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const DOCKERFILE = join(__dirname, '..', '..', 'docker', 'web.Dockerfile')

/** The final stage's CMD, in exec form. */
function finalCmd(): string[] {
  const lines = readFileSync(DOCKERFILE, 'utf8').split(/\r?\n/)
  const cmd = lines.filter(l => /^CMD\s/.test(l)).pop()
  if (!cmd) throw new Error('web.Dockerfile has no CMD')
  return JSON.parse(cmd.replace(/^CMD\s+/, ''))
}

describe('web.Dockerfile CMD', () => {
  it('is exec form running a shell that sets the bind address and execs node', () => {
    const cmd = finalCmd()
    expect(cmd.slice(0, 2)).toEqual(['sh', '-c'])
    expect(cmd[2]).toMatch(/\bHOSTNAME=0\.0\.0\.0\b/)
    expect(cmd[2]).toMatch(/\bexec node server\.js$/)
  })

  it('overrides a platform-set HOSTNAME, and hands node the process', () => {
    const script = finalCmd()[2]
    const dir = mkdtempSync(join(tmpdir(), 'web-cmd-'))
    try {
      // A stand-in for node: reports the bind address it was started with, its
      // arguments, and whether it replaced the shell (exec) or ran beneath it.
      writeFileSync(
        join(dir, 'node'),
        '#!/bin/sh\necho "HOSTNAME=$HOSTNAME args=$* parent_is_sh=$( [ "$PPID" = "$SHELL_PID" ] && echo yes || echo no)"\n',
        { mode: 0o755 },
      )
      const out = execFileSync('sh', ['-c', `export SHELL_PID=$$; ${script}`], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
          // What Fargate puts there.
          HOSTNAME: 'ip-10-20-10-179.ap-south-1.compute.internal',
        },
      }).trim()
      expect(out).toContain('HOSTNAME=0.0.0.0')
      expect(out).toContain('args=server.js')
      // exec: node IS the process sh was, not a child of it, so SIGTERM from the
      // orchestrator reaches node directly.
      expect(out).toContain('parent_is_sh=no')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
