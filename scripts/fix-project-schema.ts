/**
 * fix-project-schema.ts
 *
 * Permanently repairs the Team Project Management workspace schema:
 *   1. Adds ALL missing FK constraints (11 relations, all unset in DB)
 *   2. Creates Task_assignments junction table (multi-assignee support)
 *   3. Installs realtime NOTIFY triggers on every table
 *   4. Creates AppTrigger records for activity-log + notification automation
 *
 * Usage (on the deployment host):
 *   npx tsx scripts/fix-project-schema.ts
 *
 * Override project:
 *   PROJECT_ID=<uuid> npx tsx scripts/fix-project-schema.ts
 */

import { prisma } from '../lib/db'
import { installRealtimeTriggersForAllTables } from '../lib/services/realtimeTriggers'

const PROJECT_ID = process.env.PROJECT_ID ?? '64b8a0d7-41ce-42ed-8b9a-3300833826b0'
const S = `workspace_${PROJECT_ID}` // schema name

// ─── helper: safe ALTER TABLE (skip if constraint already exists) ─────────────

async function addFk(
  fromTable: string,
  fromCol: string,
  toTable: string,
  toCol: string,
  onDelete: string = 'SET NULL'
) {
  const constraintName = `fk_${fromTable.toLowerCase()}_${fromCol}`

  const [existing] = await prisma.$queryRawUnsafe<{ cnt: string }[]>(`
    SELECT COUNT(*) AS cnt
    FROM information_schema.table_constraints
    WHERE table_schema    = '${S}'
      AND table_name      = '${fromTable}'
      AND constraint_name = '${constraintName}'
      AND constraint_type = 'FOREIGN KEY'
  `)

  if (Number(existing.cnt) > 0) {
    console.log(`   ✓ FK ${fromTable}.${fromCol} already exists`)
    return
  }

  // Ensure column is nullable so ON DELETE SET NULL works
  if (onDelete === 'SET NULL') {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${S}"."${fromTable}" ALTER COLUMN "${fromCol}" DROP NOT NULL`
    ).catch(() => {/* already nullable */})
  }

  // Verify both columns actually exist before adding the constraint
  const [colCheck] = await prisma.$queryRawUnsafe<{ cnt: string }[]>(`
    SELECT COUNT(*) AS cnt FROM information_schema.columns
    WHERE table_schema = '${S}' AND table_name = '${fromTable}' AND column_name = '${fromCol}'
  `)
  if (Number(colCheck.cnt) === 0) {
    console.log(`   ⚠ Skipped FK ${fromTable}.${fromCol}: column does not exist in this project`)
    return
  }

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "${S}"."${fromTable}"
    ADD CONSTRAINT "${constraintName}"
    FOREIGN KEY ("${fromCol}") REFERENCES "${S}"."${toTable}"("${toCol}")
    ON DELETE ${onDelete}
    ON UPDATE CASCADE
  `)

  console.log(`   ✓ Added FK: ${fromTable}.${fromCol} → ${toTable}.${toCol}`)
}

// ─── 1. Add all FK constraints ───────────────────────────────────────────────

async function addAllForeignKeys() {
  console.log('\n[1/4] Adding all missing FK constraints …')

  // Tasks
  await addFk('Tasks', 'project_id',      'Projects',     'id', 'CASCADE')
  await addFk('Tasks', 'assigned_user_id', 'Users',        'id', 'SET NULL')

  // Comments
  await addFk('Comments', 'task_id',  'Tasks', 'id', 'CASCADE')
  await addFk('Comments', 'user_id',  'Users', 'id', 'SET NULL')

  // Projects
  await addFk('Projects', 'organization_id', 'Organizations', 'id', 'CASCADE')

  // Organization_members
  await addFk('Organization_members', 'user_id',         'Users',         'id', 'CASCADE')
  await addFk('Organization_members', 'organization_id', 'Organizations', 'id', 'CASCADE')

  // Activity_logs
  await addFk('Activity_logs', 'user_id',         'Users',         'id', 'SET NULL')
  await addFk('Activity_logs', 'organization_id', 'Organizations', 'id', 'SET NULL')

  // Notifications
  await addFk('Notifications', 'user_id',         'Users',         'id', 'CASCADE')
  await addFk('Notifications', 'organization_id', 'Organizations', 'id', 'SET NULL')
}

// ─── 2. Task_assignments junction table ──────────────────────────────────────

async function createTaskAssignmentsTable() {
  console.log('\n[2/4] Creating Task_assignments junction table …')

  const [exists] = await prisma.$queryRawUnsafe<{ cnt: string }[]>(`
    SELECT COUNT(*) AS cnt
    FROM information_schema.tables
    WHERE table_schema = '${S}' AND table_name = 'Task_assignments'
  `)

  if (Number(exists.cnt) > 0) {
    console.log('   ✓ Task_assignments already exists, skipping.')
    return
  }

  // Only create if Tasks and Users tables both exist in this workspace
  const [tablesExist] = await prisma.$queryRawUnsafe<{ cnt: string }[]>(`
    SELECT COUNT(*) AS cnt FROM information_schema.tables
    WHERE table_schema = '${S}' AND table_name IN ('Tasks','Users')
  `)
  if (Number(tablesExist.cnt) < 2) {
    console.log('   ⚠ Skipped Task_assignments: Tasks or Users table not found in this project')
    return
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${S}"."Task_assignments" (
      id           TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      task_id      TEXT        NOT NULL,
      user_id      TEXT        NOT NULL,
      role         TEXT        NOT NULL DEFAULT 'assignee',
      assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT fk_task_assignments_task
        FOREIGN KEY (task_id) REFERENCES "${S}"."Tasks"(id) ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_task_assignments_user
        FOREIGN KEY (user_id) REFERENCES "${S}"."Users"(id) ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT uq_task_assignments_task_user UNIQUE (task_id, user_id)
    )
  `)

  // Migrate existing single-assignee data
  const migrated: any = await prisma.$executeRawUnsafe(`
    INSERT INTO "${S}"."Task_assignments" (task_id, user_id)
    SELECT id, assigned_user_id
    FROM   "${S}"."Tasks"
    WHERE  assigned_user_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `)

  console.log(`   ✓ Task_assignments created. Migrated ${migrated ?? 0} existing assignments.`)
}

// ─── 3. Realtime NOTIFY triggers ─────────────────────────────────────────────

async function installRealtimeTriggers() {
  console.log('\n[3/4] Installing realtime NOTIFY triggers …')

  const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = '${S}'
      AND table_type   = 'BASE TABLE'
      AND table_name   NOT LIKE '\\_backenly\\_%'
    ORDER BY table_name
  `)

  const tableNames = tables.map(t => t.table_name)
  console.log(`   Tables: ${tableNames.join(', ')}`)

  await installRealtimeTriggersForAllTables(PROJECT_ID, tableNames)

  const triggered = await prisma.$queryRawUnsafe<{ table_name: string }[]>(`
    SELECT DISTINCT event_object_table AS table_name
    FROM   information_schema.triggers
    WHERE  trigger_schema = '${S}'
      AND  trigger_name   = 'backenly_realtime'
    ORDER BY event_object_table
  `)

  console.log(`   ✓ Triggers installed on: ${triggered.map(t => t.table_name).join(', ')}`)
}

// ─── 4. AppTrigger records (event automation) ────────────────────────────────

async function createEventTriggers() {
  console.log('\n[4/4] Creating event automation triggers …')

  const triggers = [
    // Activity log: task events
    {
      name: 'Log task created',
      description: 'Write activity log on task insert',
      sourceTable: 'Tasks', event: 'insert', actionType: 'insert_row',
      targetTable: 'Activity_logs',
      fieldMappings: { user_id: 'assigned_user_id', entity_id: 'id', organization_id: 'organization_id' },
      staticFields: { action: 'task_created', entity_type: 'task' },
    },
    {
      name: 'Log task updated',
      description: 'Write activity log on task update',
      sourceTable: 'Tasks', event: 'update', actionType: 'insert_row',
      targetTable: 'Activity_logs',
      fieldMappings: { user_id: 'assigned_user_id', entity_id: 'id', organization_id: 'organization_id' },
      staticFields: { action: 'task_updated', entity_type: 'task' },
    },
    {
      name: 'Log task deleted',
      description: 'Write activity log on task delete',
      sourceTable: 'Tasks', event: 'delete', actionType: 'insert_row',
      targetTable: 'Activity_logs',
      fieldMappings: { user_id: 'assigned_user_id', entity_id: 'id', organization_id: 'organization_id' },
      staticFields: { action: 'task_deleted', entity_type: 'task' },
    },
    // Activity log: comment events
    {
      name: 'Log comment created',
      description: 'Write activity log on comment insert',
      sourceTable: 'Comments', event: 'insert', actionType: 'insert_row',
      targetTable: 'Activity_logs',
      fieldMappings: { user_id: 'user_id', entity_id: 'id' },
      staticFields: { action: 'comment_created', entity_type: 'comment' },
    },
    // Activity log: member events
    {
      name: 'Log member joined org',
      description: 'Write activity log when a member joins an org',
      sourceTable: 'Organization_members', event: 'insert', actionType: 'insert_row',
      targetTable: 'Activity_logs',
      fieldMappings: { user_id: 'user_id', entity_id: 'id', organization_id: 'organization_id' },
      staticFields: { action: 'member_joined', entity_type: 'organization_member' },
    },
    // Notifications
    {
      name: 'Notify on task assigned',
      description: 'Notify user when assigned a task',
      sourceTable: 'Tasks', event: 'insert', actionType: 'insert_row',
      targetTable: 'Notifications',
      fieldMappings: { user_id: 'assigned_user_id', organization_id: 'organization_id' },
      staticFields: { type: 'task_assigned', message: 'You have been assigned a new task', read: false },
    },
    {
      name: 'Notify on task reassigned',
      description: 'Notify user when a task assignment changes',
      sourceTable: 'Tasks', event: 'update', actionType: 'insert_row',
      targetTable: 'Notifications',
      fieldMappings: { user_id: 'assigned_user_id', organization_id: 'organization_id' },
      staticFields: { type: 'task_reassigned', message: 'A task has been reassigned to you', read: false },
    },
    {
      name: 'Notify on org invite',
      description: 'Notify user when added to an organization',
      sourceTable: 'Organization_members', event: 'insert', actionType: 'insert_row',
      targetTable: 'Notifications',
      fieldMappings: { user_id: 'user_id', organization_id: 'organization_id' },
      staticFields: { type: 'org_invite', message: 'You have been added to an organization', read: false },
    },
  ]

  let created = 0
  for (const t of triggers) {
    const existing = await prisma.appTrigger.findFirst({
      where: { projectId: PROJECT_ID, name: t.name },
    })
    if (existing) {
      console.log(`   ✓ "${t.name}" already exists`)
      continue
    }
    await prisma.appTrigger.create({
      data: {
        projectId: PROJECT_ID,
        name: t.name,
        description: t.description,
        sourceTable: t.sourceTable,
        event: t.event,
        actionType: t.actionType,
        targetTable: t.targetTable ?? null,
        fieldMappings: (t.fieldMappings as any) ?? null,
        staticFields: (t.staticFields as any) ?? null,
        enabled: true,
      },
    })
    console.log(`   ✓ Created: "${t.name}"`)
    created++
  }

  console.log(`   Done — ${created} new trigger(s) created.`)
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔧  Fixing workspace: ${PROJECT_ID}`)
  await addAllForeignKeys()
  await createTaskAssignmentsTable()
  await installRealtimeTriggers()
  await createEventTriggers()
  console.log('\n✅  All fixes applied.\n')
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('\n❌ Fix failed:', err); process.exit(1) })
  .finally(() => prisma.$disconnect())
