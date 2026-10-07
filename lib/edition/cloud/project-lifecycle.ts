/**
 * Cloud ProjectLifecycle: multi-project, organization-aware.
 *
 * A thin adapter, not an implementation. The work is done by the provider
 * behind `@cloud/project-lifecycle`, which resolves to the private overlay on a
 * composed Cloud checkout and to lib/edition/oss/project-lifecycle.ts
 * otherwise. This file exists so `getProjectLifecycle()` has one shape to
 * return in either edition, and so the ProjectLifecycle contract is satisfied
 * in the public repository rather than only in the private one.
 */
import { createProject, creationAccount, listAccessibleProjects } from '@cloud/project-lifecycle'
import type {
  Edition,
  ProjectCreateInput,
  ProjectCreateResult,
  ProjectCreationAccount,
  ProjectLifecycle,
  ProjectListEntry,
  ProjectListOptions,
} from '../types'

export const cloudProjectLifecycle: ProjectLifecycle = {
  edition: 'cloud' as Edition,

  async list(userId: string, options?: ProjectListOptions): Promise<ProjectListEntry[]> {
    return listAccessibleProjects(userId, options)
  },

  async creationAccount(userId: string, organizationId?: string | null): Promise<ProjectCreationAccount> {
    return creationAccount(userId, organizationId)
  },

  async create(input: ProjectCreateInput): Promise<ProjectCreateResult> {
    return createProject(input)
  },
}
