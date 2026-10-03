/**
 * Bring this deployment's database to the current canonical schema.
 *
 *   npx tsx scripts/selfhost-migrate.ts
 *
 * Invoked by `npm run selfhost`, and runnable on its own by an operator who
 * wants to upgrade the schema without running the whole installer.
 *
 * The decision logic lives in lib/selfhost/, not here, so the installer and the
 * upgrade test suite drive exactly the same code. A script-only implementation
 * would be a second copy of the rules, and the two would disagree eventually —
 * which is the failure mode the derived register exists to catch.
 */

import 'dotenv/config'
import { Client } from 'pg'

import { runSelfHostMigrations, MigrationRefused, MigrationFailed } from '../lib/selfhost/run-migrations'
import { assembleMigrationWorkspace } from '../tools/managed-db/migration-workspace'

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set.')
    process.exit(1)
  }

  const client = new Client({ connectionString: url })
  client.on('error', () => {})
  await client.connect()

  try {
    const report = await runSelfHostMigrations({
      root: process.cwd(),
      client,
      databaseUrl: url,
      assemble: root => assembleMigrationWorkspace(root),
      log: message => console.log(`  ${message}`),
    })

    if (report.adopted.length > 0) {
      console.log(`  adopted ${report.adopted.length} migration(s) this database already satisfied:`)
      for (const id of report.adopted) console.log(`    ${id}`)
    }
    if (report.deployed.length > 0) {
      console.log(`  applied ${report.deployed.length} migration(s):`)
      for (const id of report.deployed) console.log(`    ${id}`)
    } else if (report.adopted.length === 0) {
      console.log('  the schema is already current')
    }
  } catch (err) {
    if (err instanceof MigrationFailed) {
      // A migration RAN and failed. Prisma already explained which one and
      // why; printing the command line instead of that explanation is what
      // this branch exists to stop.
      console.error('')
      console.error('The upgrade did NOT complete.')
      console.error('')
      console.error(err.message)
      console.error('')
      console.error('The deployment is still on its previous schema. Nothing else will')
      console.error('be applied until this migration is resolved.')
      console.error('')
      process.exit(1)
    }
    if (err instanceof MigrationRefused) {
      // A refusal is a message for a human, not a stack trace. Nothing was
      // written, and the text says what to do instead.
      console.error('')
      console.error('The database was NOT changed.')
      console.error('')
      console.error(err.message)
      console.error('')
      process.exit(2)
    }
    throw err
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch(err => {
  console.error(err?.message ?? err)
  process.exit(1)
})
