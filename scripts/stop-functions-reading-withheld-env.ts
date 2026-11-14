/**
 * Release step: stored functions that read the project's signing secret or
 * admin key from process.env (lib/services/ai-functions/withheld-env-migration.ts).
 *
 * Route functions no longer receive JWT_SECRET, ADMIN_API_KEY or
 * AI_EXECUTION_TOKEN. Each now holds a value that matches nothing, so an admin
 * gate comparing a header with it answers 403 to everyone, and signing a
 * session with it is refused. Run this after the release that carries the
 * runner change.
 *
 *   npx tsx scripts/stop-functions-reading-withheld-env.ts                 # report only
 *   npx tsx scripts/stop-functions-reading-withheld-env.ts --apply         # rewrite Backenly's template code
 *   npx tsx scripts/stop-functions-reading-withheld-env.ts --project <id>  # one project
 *
 * --apply rewrites only the exact code Backenly's templates wrote: the admin
 * gate becomes isAdminRequest(req), and the impersonation endpoint answers a
 * refusal. Each rewrite is one governed change, so History keeps the old code.
 * Code an agent deployed, and any other code, is listed for its owner and left
 * as it is.
 */

import { prisma } from '../lib/db'
import {
  applyWithheldEnvRewrites,
  findFunctionsReadingWithheldEnv,
} from '../lib/services/ai-functions/withheld-env-migration'

async function main() {
  const apply = process.argv.includes('--apply')
  const at = process.argv.indexOf('--project')
  const projectId = at >= 0 ? process.argv[at + 1] : undefined

  const found = await findFunctionsReadingWithheldEnv(projectId)
  if (found.length === 0) {
    console.log('No stored function reads JWT_SECRET, ADMIN_API_KEY or AI_EXECUTION_TOKEN.')
    return
  }
  const actions: Record<string, string> = {
    rewrite_admin_gate: 'rewrite the admin gate to isAdminRequest',
    replace_impersonation: 'replace the impersonation endpoint with a refusal',
    owner_must_change: 'its owner must change it (left as it is)',
  }
  for (const f of found) {
    console.log(`${f.projectId}  ${f.name} (${f.functionId}, ${f.codeOrigin})  reads ${f.reads}  -> ${actions[f.action]}`)
  }
  const rewritable = found.filter((f) => f.action !== 'owner_must_change').length
  console.log(`\n${found.length} function(s) read a withheld variable; ${rewritable} are Backenly's template code.`)
  if (!apply) {
    if (rewritable) console.log('Report only. Run with --apply to rewrite them.')
    return
  }
  const results = await applyWithheldEnvRewrites(found)
  for (const r of results) {
    console.log(`${r.functionId}: ${r.changed ? `rewritten (change ${r.changeId})` : 'left as it is: its code changed since the report'}`)
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
