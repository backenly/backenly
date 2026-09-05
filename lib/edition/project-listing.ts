/**
 * The one `select` every project listing uses.
 *
 * Shared by both lifecycle implementations so a field added for the dashboard
 * cannot appear on Cloud and be missing on self-host, which is the shape of bug
 * that only ever shows up in the edition nobody is looking at.
 */
export const PROJECT_LIST_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  userId: true,
  publicEnabled: true,
  projectStatus: true,
  deployedAt: true,
  environment: true,
  apiUrlDev: true,
  apiUrlStaging: true,
  apiUrlProd: true,
  apiRequests: true,
  avgLatency: true,
  errorCount: true,
  storageUsed: true,
  storageLimit: true,
  maxFileSize: true,
  maxFilesPerBucket: true,
  activeUsers: true,
  lastMetricsUpdate: true,
  createdAt: true,
  updatedAt: true,
  // Counted, never fetched: a listing needs the number of tables, not the tables.
  _count: { select: { tables: true, workspaces: true } },
} as const
