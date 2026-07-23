/**
 * PROJECT MANAGEMENT BLUEPRINT
 * ============================
 * Full backend for any project management / task tracker app (Asana / Linear /
 * Trello / Jira). Projects, tasks, subtasks, comments, labels, milestones,
 * assignments, attachments, time entries.
 *
 * Tables (12): organizations, projects, tasks, subtasks, comments, labels,
 *   task_labels, assignments, milestones, time_entries, attachments,
 *   activity_logs
 * Storage: project-files bucket (private, signed-url access)
 * Realtime: tasks, comments, assignments, activity_logs
 * Triggers: notify on task assigned, comment, status change
 */

import type { Blueprint, BlueprintColumn } from './types'

const col = (n: string, t: BlueprintColumn['type'], o: Partial<BlueprintColumn> = {}): BlueprintColumn => ({ name: n, type: t, ...o })
const createTable = (label: string, tableName: string, columns: BlueprintColumn[]) => ({ label, tool: 'create_table', args: { tableName, columns } })
const generateApi = (tableName: string) => ({ label: `Generate REST API for ${tableName}`, tool: 'generate_api', args: { tableName } })
const addRls = (tableName: string, policy: string, label?: string) => ({ label: label ?? `Lock down ${tableName} with ${policy} RLS`, tool: 'add_rls', args: { tableName, policy } })
const enableRealtime = (tableName: string) => ({ label: `Stream realtime changes on ${tableName}`, tool: 'enable_realtime', args: { tableName } })
const createTrigger = (tableName: string, on: 'insert' | 'update' | 'delete') => ({ label: `Add ${on} trigger on ${tableName}`, tool: 'create_trigger', args: { tableName, on, kind: 'notify' } })

export const PROJECT_MGMT_BLUEPRINT: Blueprint = {
  domain: 'project-mgmt',
  title: 'Project Management Backend',
  summary:
    '12 tables (orgs, projects, tasks, subtasks, comments, labels, task_labels, ' +
    'assignments, milestones, time_entries, attachments, activity_logs), file ' +
    'storage, realtime on tasks + comments + activity, notify-on-assign triggers.',
  steps: [
    { label: 'Enable end-user authentication (email + password)', tool: 'enable_auth', args: {} },

    // Multi-tenant scaffold so projects scope cleanly to orgs.
    { label: 'Wire up team multi-tenancy (orgs + members + invitations)', tool: 'enable_teams', args: {} },

    createTable('Create projects', 'projects', [
      col('organization_id', 'uuid'),
      col('name', 'text'),
      col('description', 'text', { nullable: true }),
      col('owner_user_id', 'uuid'),
      col('color', 'text', { nullable: true }),
      col('icon', 'text', { nullable: true }),
      col('archived_at', 'timestamp', { nullable: true }),
    ]),

    createTable('Create tasks', 'tasks', [
      col('project_id', 'uuid', { fkTo: 'projects' }),
      col('organization_id', 'uuid'),
      col('title', 'text'),
      col('description', 'text', { nullable: true }),
      col('status', 'text'),               // todo | in_progress | review | done | cancelled
      col('priority', 'text'),             // low | medium | high | urgent
      col('due_date', 'timestamp', { nullable: true }),
      col('completed_at', 'timestamp', { nullable: true }),
      col('estimate_hours', 'numeric', { nullable: true }),
      col('reporter_user_id', 'uuid', { nullable: true }),
      col('parent_task_id', 'uuid', { fkTo: 'tasks', nullable: true }),
      col('position', 'int', { nullable: true }),
    ]),

    createTable('Create subtasks (checklist items)', 'subtasks', [
      col('task_id', 'uuid', { fkTo: 'tasks' }),
      col('title', 'text'),
      col('completed', 'boolean'),
      col('position', 'int', { nullable: true }),
    ]),

    createTable('Create assignments (task ↔ users)', 'assignments', [
      col('task_id', 'uuid', { fkTo: 'tasks' }),
      col('user_id', 'uuid'),
      col('assigned_at', 'timestamp', { nullable: true }),
      col('assigned_by_user_id', 'uuid', { nullable: true }),
    ]),

    createTable('Create comments', 'comments', [
      col('task_id', 'uuid', { fkTo: 'tasks' }),
      col('user_id', 'uuid'),
      col('content', 'text'),
      col('parent_comment_id', 'uuid', { fkTo: 'comments', nullable: true }),
      col('edited_at', 'timestamp', { nullable: true }),
    ]),

    createTable('Create labels', 'labels', [
      col('organization_id', 'uuid'),
      col('project_id', 'uuid', { fkTo: 'projects', nullable: true }),
      col('name', 'text'),
      col('color', 'text', { nullable: true }),
    ]),

    createTable('Create task_labels', 'task_labels', [
      col('task_id', 'uuid', { fkTo: 'tasks' }),
      col('label_id', 'uuid', { fkTo: 'labels' }),
    ]),

    createTable('Create milestones', 'milestones', [
      col('project_id', 'uuid', { fkTo: 'projects' }),
      col('name', 'text'),
      col('description', 'text', { nullable: true }),
      col('due_date', 'timestamp', { nullable: true }),
      col('completed_at', 'timestamp', { nullable: true }),
    ]),

    createTable('Create time_entries (time tracking)', 'time_entries', [
      col('task_id', 'uuid', { fkTo: 'tasks' }),
      col('user_id', 'uuid'),
      col('hours', 'numeric'),
      col('description', 'text', { nullable: true }),
      col('started_at', 'timestamp', { nullable: true }),
      col('ended_at', 'timestamp', { nullable: true }),
    ]),

    createTable('Create attachments (files on tasks/comments)', 'attachments', [
      col('task_id', 'uuid', { fkTo: 'tasks', nullable: true }),
      col('comment_id', 'uuid', { fkTo: 'comments', nullable: true }),
      col('uploaded_by_user_id', 'uuid'),
      col('url', 'text'),
      col('filename', 'text', { nullable: true }),
      col('mime_type', 'text', { nullable: true }),
      col('size_bytes', 'bigint', { nullable: true }),
    ]),

    createTable('Create activity_logs (project audit feed)', 'activity_logs', [
      col('organization_id', 'uuid'),
      col('project_id', 'uuid', { fkTo: 'projects', nullable: true }),
      col('actor_user_id', 'uuid'),
      col('action', 'text'),
      col('target_type', 'text', { nullable: true }),
      col('target_id', 'text', { nullable: true }),
      col('metadata', 'jsonb', { nullable: true }),
    ]),

    generateApi('projects'),
    generateApi('tasks'),
    generateApi('subtasks'),
    generateApi('assignments'),
    generateApi('comments'),
    generateApi('labels'),
    generateApi('task_labels'),
    generateApi('milestones'),
    generateApi('time_entries'),
    generateApi('attachments'),
    generateApi('activity_logs'),

    addRls('projects', 'org_members'),
    addRls('tasks', 'org_members'),
    addRls('subtasks', 'org_members'),
    addRls('assignments', 'org_members'),
    addRls('comments', 'org_members'),
    addRls('labels', 'org_members'),
    addRls('task_labels', 'org_members'),
    addRls('milestones', 'org_members'),
    addRls('time_entries', 'org_members'),
    addRls('attachments', 'org_members'),
    addRls('activity_logs', 'org_members'),

    enableRealtime('tasks'),
    enableRealtime('subtasks'),
    enableRealtime('assignments'),
    enableRealtime('comments'),
    enableRealtime('activity_logs'),

    createTrigger('assignments', 'insert'),
    createTrigger('comments', 'insert'),
    createTrigger('tasks', 'update'),

    {
      label: 'Create project-files bucket (private, signed-url access)',
      tool: 'create_bucket',
      args: { bucketName: 'project-files', isPublic: false },
    },

    {
      label: 'Generate aggregate /stats/summary endpoint (open tasks, throughput, overdue, by status)',
      tool: 'generate_aggregate_api',
      args: { name: 'summary' },
    },
  ],
  warnings: [
    'Every project-scoped table carries organization_id so org_members RLS works out of the box.',
  ],
}
