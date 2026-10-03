/**
 * DEPLOYMENT RECOVERY, FROM THE COMMAND LINE
 * ==========================================
 *
 *   npm run recovery -- export  [--out DIR]
 *   npm run recovery -- verify  --bundle DIR
 *   npm run recovery -- restore --bundle DIR [--yes]
 *
 * WHY RESTORE IS A CLI AND NOT A BUTTON
 * -------------------------------------
 * This is the part worth being clear about, because a dashboard button would
 * look more finished and would be useless.
 *
 * A deployment recovery bundle exists for the day the deployment is gone. The
 * dashboard IS part of the deployment. On the morning you need to restore, there
 * is no web app to click a button in - there is a new machine, a checkout, a
 * bundle and a credential. A restore that can only be started from the thing
 * you have lost is not a recovery product.
 *
 * So the command line is the primary surface, not a fallback. Export is
 * available from the admin dashboard as well, because export happens while the
 * deployment is healthy and that is exactly when a person is looking at it.
 *
 * VERIFY IS SEPARATE, AND IT IS THE ONE TO RUN OFTEN
 * --------------------------------------------------
 * `verify` runs the full validation pass - manifest, checksums, version, and
 * opening every encrypted component with the credential - and touches nothing.
 * An untested backup is a rumour. This is how it stops being one, and it is
 * safe to run against production on any Tuesday.
 */

import * as path from 'path'
import * as readline from 'readline'
import { exportDeploymentBundle } from '../lib/recovery/export'
import { restoreDeployment, validateBundle, RestoreAbortedError } from '../lib/recovery/restore'
import { missingComponents } from '../lib/recovery/contract'

type Command = 'export' | 'verify' | 'restore'

interface Args {
  command: Command | null
  bundle?: string
  out?: string
  credential?: string
  yes: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: null, yes: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === 'export' || arg === 'verify' || arg === 'restore') args.command = arg
    else if (arg === '--bundle') args.bundle = argv[++i]
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--credential') args.credential = argv[++i]
    else if (arg === '--yes' || arg === '-y') args.yes = true
  }
  return args
}

function usage(): never {
  console.error(`
Deployment recovery

  npm run recovery -- export  [--out DIR]
  npm run recovery -- verify  --bundle DIR
  npm run recovery -- restore --bundle DIR [--yes]

The recovery credential is read from BACKENLY_RECOVERY_CREDENTIAL, or prompted
for. It is never passed on the command line by default, because a command line
ends up in shell history and in the process table.
`.trim())
  process.exit(2)
}

/**
 * Ask for the credential without echoing it.
 *
 * --credential exists for automation, and is deliberately not the documented
 * path: an argument is visible in `ps` to every user on the machine and lands
 * in shell history.
 */
async function readCredential(args: Args): Promise<string> {
  if (args.credential) return args.credential
  const fromEnv = process.env.BACKENLY_RECOVERY_CREDENTIAL
  if (fromEnv) return fromEnv

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>(resolve => {
      const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean }
      if (stdin.isTTY) {
        // Suppress the echo so the credential does not stay on screen or in a
        // scrollback buffer somebody screenshots.
        const output = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput: (s: string) => void }
        output._writeToOutput = function (text: string) {
          if (text.includes('credential')) output.output.write(text)
        }
      }
      rl.question('Recovery credential: ', resolve)
    })
    if (process.stdin.isTTY) process.stdout.write('\n')
    return answer.trim()
  } finally {
    rl.close()
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>(resolve => rl.question(`${question} `, resolve))
    return answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

async function runExport(args: Args): Promise<number> {
  const outDir = path.resolve(
    args.out ?? path.join(process.cwd(), 'recovery', new Date().toISOString().replace(/[:.]/g, '-')),
  )
  console.log(`Writing a deployment recovery bundle to ${outDir}`)

  const result = await exportDeploymentBundle({ outDir })
  const absent = missingComponents(result.manifest)

  console.log('')
  for (const component of result.manifest.components) {
    const size = `${(component.bytes / 1024).toFixed(1)} KiB`.padStart(12)
    const sealed = component.encrypted ? 'sealed' : 'plain '
    console.log(`  ${component.component.padEnd(22)} ${sealed} ${size}  ${component.items} item(s)`)
  }
  if (absent.length > 0) {
    // Stated positively rather than left to be inferred from what is missing.
    console.log(`\n  NOT in this bundle: ${absent.join(', ')}`)
  }

  console.log(`
────────────────────────────────────────────────────────────────────────
  RECOVERY CREDENTIAL

      ${result.credential}

  Store this somewhere other than beside the bundle. It is not written
  into the archive and it is not recoverable from it or from the
  database - without it this bundle cannot be opened by anyone,
  including you.
────────────────────────────────────────────────────────────────────────
`)
  return 0
}

async function runVerify(args: Args): Promise<number> {
  if (!args.bundle) usage()
  const bundleDir = path.resolve(args.bundle)
  const credential = await readCredential(args)

  try {
    const bundle = await validateBundle(bundleDir, credential)
    console.log(`\nThis bundle is intact and openable.\n`)
    console.log(`  written    ${bundle.manifest.createdAt}`)
    console.log(`  backenly   ${bundle.manifest.backenlyVersion}`)
    console.log(`  postgres   ${bundle.manifest.postgresVersion}`)
    console.log(`  components ${bundle.manifest.components.length}`)
    const absent = missingComponents(bundle.manifest)
    if (absent.length > 0) console.log(`  absent     ${absent.join(', ')}`)
    console.log('')
    return 0
  } catch (err) {
    console.error(`\n${(err as Error).message}\n`)
    return 1
  }
}

async function runRestore(args: Args): Promise<number> {
  if (!args.bundle) usage()
  const bundleDir = path.resolve(args.bundle)
  // Two connections, because a restore has two jobs with different privileges.
  //
  //   admin  provisions - drops and recreates schemas, creates the PostgREST
  //          roles, installs extensions. None of it available to the app role.
  //   app    replays the dumps, so the restored objects are OWNED by it.
  //          pg_dump runs with --no-owner, so ownership follows the connection,
  //          and FORCE ROW LEVEL SECURITY keys on the owner.
  //
  // The backup credential is for export only and is refused here by preflight.
  const adminUrl = process.env.BACKENLY_ADMIN_DATABASE_URL ?? ''
  const targetUrl = process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? ''
  if (!adminUrl) {
    console.error(
      '\nBACKENLY_ADMIN_DATABASE_URL is not set.\n\n' +
        '  A restore drops and recreates schemas, creates the PostgREST roles and\n' +
        '  installs extensions. The application role may do none of those, and must\n' +
        '  not be given the right to.\n\n' +
        '  Set it to an elevated connection for the same database as DATABASE_URL.\n' +
        '  `npm run selfhost` records one on its first run.\n',
    )
    return 1
  }
  if (!targetUrl) {
    console.error('DATABASE_URL is not set. Point it at the deployment to restore INTO.')
    return 2
  }

  const targetName = targetUrl.split('/').pop()?.split('?')[0] ?? '(unknown)'
  const credential = await readCredential(args)

  if (!args.yes) {
    console.log(`
This REPLACES the deployment in database "${targetName}".

Rows written since the bundle was taken will be gone. Sessions and one-time
tokens are not restored, so everyone signs in again. Nothing is touched until
the whole archive has been validated.
`)
    if (!(await confirm('Type "yes" to continue:'))) {
      console.log('Nothing was changed.')
      return 1
    }
  }

  try {
    const progress = await restoreDeployment({
      bundleDir,
      credential,
      adminUrl,
      targetUrl,
      onStep: result => {
        const mark = result.status === 'ok' ? 'ok  ' : 'FAIL'
        console.log(`  ${mark} ${result.step}${result.detail ? ` — ${result.detail}` : ''}`)
      },
    })
    console.log(`\nRestored. ${progress.completed.length} steps completed.`)
    console.log('Background systems were held off until verification passed, and may now start.\n')
    return 0
  } catch (err) {
    if (err instanceof RestoreAbortedError) {
      console.error(`\n${err.message}`)
      console.error(
        err.targetUntouched
          ? '\nThe target was NOT modified. Fix the bundle and run this again.\n'
          : '\nThe target MAY have been partially modified. Do not start the ' +
            'application against it until a restore completes.\n',
      )
      return 1
    }
    throw err
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.command) usage()

  const code = args.command === 'export'
    ? await runExport(args)
    : args.command === 'verify'
      ? await runVerify(args)
      : await runRestore(args)

  process.exit(code)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
