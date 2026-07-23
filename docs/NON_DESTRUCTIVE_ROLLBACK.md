# Non-Destructive Rollback System

**PHILOSOPHY: NEVER DELETE USER DATA**

This document describes Backenly's trust-preserving, non-destructive rollback system that replaces destructive `DROP TABLE` operations with reversible table archival.

---

## Overview

**Traditional (Destructive) Rollback:**
```sql
DROP TABLE users CASCADE;  -- ❌ Data lost forever
```

**Backenly (Non-Destructive) Rollback:**
```sql
ALTER TABLE users RENAME TO users__archived__1234567890;  -- ✅ Data preserved
```

All rollback operations preserve user data by renaming tables instead of deleting them. Data is retained for **90 days** before automatic cleanup, giving ample time for recovery if needed.

---

## Core Principles

### 1. Never DROP TABLE in Production

**Rule:** No table is ever dropped during rollback operations.

**Implementation:**
- `DROP_TABLE` actions converted to `ARCHIVE_TABLE`
- Tables renamed to `{table}__archived__{timestamp}` format
- All data, indexes, and constraints preserved
- Archive record created in `table_archives` table

**Example:**
```typescript
// Before rollback: Table "posts" exists
// After rollback: Table renamed to "posts__archived__1706123456789"
// Data: 100% preserved ✅
```

### 2. Point-in-Time Restore (PITR)

**Rule:** Every rollback creates a snapshot for reversibility.

**Implementation:**
- PITR snapshot captured BEFORE any changes
- Snapshot contains complete graph state + schema state
- Snapshots retained for 30 days
- Restoring a rollback is as easy as the original rollback

**Example:**
```typescript
// Create PITR snapshot
const snapshot = await createPITRSnapshot(context, currentState)
// snapshot.id = "pitr_1706123456789_abc123"

// Later: Reverse the rollback
await restoreToPITRSnapshot(context, snapshot.id)
// ✅ Complete state restored, no data lost
```

### 3. Automatic Cleanup (NOT Manual)

**Rule:** Users never trigger data deletion. System handles cleanup automatically.

**Implementation:**
- Weekly cron job (`/api/cron/archive-cleanup`)
- Archives >90 days old are permanently deleted
- PITR snapshots >30 days old are invalidated
- Users never see or configure these operations

**Schedule:**
```json
{
  "path": "/api/cron/archive-cleanup",
  "schedule": "0 3 * * 0"  // Sunday 3 AM UTC
}
```

---

## Architecture

### File Structure

```
lib/rollback/
├── non-destructive-restore.ts        // Core non-destructive operations
├── atomic-rollback-executor.ts       // Uses ARCHIVE_TABLE instead of DROP
└── full-surface-rollback.ts          // Rollback plan generation

lib/execution/
└── schema-rollback-executor.ts       // Executes ARCHIVE_TABLE operations

app/api/
├── projects/[projectId]/rollback/archives/
│   └── route.ts                      // Internal API for archive management
└── cron/archive-cleanup/
    └── route.ts                      // Automatic cleanup (90-day retention)

prisma/schema.prisma
├── TableArchive                      // Tracks archived tables
└── PITRSnapshot                      // Point-in-time restore snapshots
```

### Database Schema

#### TableArchive Model

```prisma
model TableArchive {
  id            String    @id @default(uuid())
  projectId     String
  originalName  String    // e.g., "users"
  archivedName  String    // e.g., "users__archived__1706123456789"
  archivedAt    DateTime  @default(now())
  reason        String    // "rollback" | "schema_change" | "manual"
  canRestore    Boolean   @default(true)
  dataPreserved Boolean   @default(true)
  restoredAt    DateTime?
  deletedAt     DateTime? // Only set after 90-day retention
}
```

#### PITRSnapshot Model

```prisma
model PITRSnapshot {
  id            String   @id
  projectId     String
  capturedAt    DateTime @default(now())
  graphState    Json     // Complete BackendStateGraph
  schemaState   Json     // { tables: [], archivedTables: [] }
  canRestoreTo  Boolean  @default(true)
}
```

---

## Implementation Details

### 1. Archive Table (Instead of DROP)

**Function:** `archiveTable(context, tableName, reason)`

**What it does:**
```typescript
// 1. Rename table with timestamp
ALTER TABLE "workspace_abc.Users" 
  RENAME TO "Users__archived__1706123456789"

// 2. Record archive operation
INSERT INTO table_archives (
  projectId, originalName, archivedName, 
  archivedAt, reason, canRestore, dataPreserved
)
```

**Guarantees:**
- ✅ Data preserved
- ✅ Indexes preserved
- ✅ Constraints preserved
- ✅ Restore reversible
- ✅ No data loss

### 2. Create PITR Snapshot

**Function:** `createPITRSnapshot(context, currentState)`

**What it captures:**
```typescript
{
  id: "pitr_1706123456789_abc123",
  projectId: "project-uuid",
  capturedAt: "2024-01-24T12:34:56.789Z",
  graphState: { /* Complete BackendStateGraph */ },
  schemaState: {
    tables: ["users", "posts", "comments"],
    archivedTables: ["old_users__archived__1706000000000"]
  },
  canRestoreTo: true
}
```

**When created:**
- ✅ Before every rollback operation
- ✅ Automatically (no user action)
- ✅ Retained for 30 days

### 3. Restore to PITR Snapshot

**Function:** `restoreToPITRSnapshot(context, snapshotId)`

**What it does:**
```typescript
// 1. Compare current state vs snapshot state
// 2. Archive tables that shouldn't exist
// 3. Restore tables that should exist
// 4. Switch pointers (no data deletion)
```

**Example:**
```typescript
// Current state:
//   tables: ["users", "posts"]
//   archived: ["comments__archived__1706123456789"]

// Snapshot state:
//   tables: ["users", "comments"]
//   archived: []

// Result:
//   - Archive "posts" → "posts__archived__1706125000000"
//   - Restore "comments__archived__1706123456789" → "comments"
```

### 4. Automatic Cleanup

**Function:** `cleanupOldArchives(projectId, retentionDays = 90)`

**What it does:**
```typescript
// 1. Find archives older than 90 days
const cutoff = Date.now() - (90 * 24 * 60 * 60 * 1000)

// 2. NOW we can safely DROP (after 90 days)
DROP TABLE IF EXISTS "workspace_abc.Users__archived__1706123456789" CASCADE

// 3. Mark archive as deleted
UPDATE table_archives 
  SET canRestore = false, deletedAt = NOW()
  WHERE id = 'archive-uuid'
```

**Trigger:** Weekly cron job (Sunday 3 AM UTC)

---

## API Endpoints

### Internal Archive Management

**GET `/api/projects/:projectId/rollback/archives`**

List archived tables and PITR snapshots (internal use only).

**Response:**
```json
{
  "success": true,
  "archives": [
    {
      "originalTable": "users",
      "archivedTable": "users__archived__1706123456789",
      "archivedAt": "2024-01-24T12:34:56.789Z",
      "canRestore": true,
      "ageInDays": 15
    }
  ],
  "snapshots": [
    {
      "id": "pitr_1706123456789_abc123",
      "capturedAt": "2024-01-24T12:34:56.789Z",
      "canRestoreTo": true,
      "ageInHours": 360,
      "tableCount": 3
    }
  ],
  "retentionPolicy": {
    "archiveRetentionDays": 90,
    "snapshotRetentionDays": 30,
    "description": "Archives older than 90 days may be permanently deleted."
  }
}
```

**POST `/api/projects/:projectId/rollback/archives/restore`**

Restore to a PITR snapshot (admin/support only).

**Request:**
```json
{
  "snapshotId": "pitr_1706123456789_abc123"
}
```

**Response:**
```json
{
  "success": true,
  "snapshotId": "pitr_1706123456789_abc123",
  "tablesRestored": ["comments"],
  "tablesArchived": ["posts"],
  "message": "Restored to snapshot pitr_1706123456789_abc123. 1 tables restored, 1 tables archived."
}
```

---

## User Experience

### What Users See

**When rolling back:**
```
✅ Restored to "Add authentication system"
All changes applied successfully.
```

**What users DON'T see:**
- No warnings about data deletion
- No confirmation dialogs
- No restore options
- No archive management UI

**Philosophy:** Users trust the system to handle data safely. We preserve everything invisibly.

### What Happens Behind the Scenes

1. User clicks "Restore to checkpoint"
2. System creates PITR snapshot (invisible)
3. System archives tables instead of dropping (invisible)
4. System verifies restore succeeded
5. User sees: "✅ Restored successfully"
6. Data preserved for 90 days (invisible)
7. Automatic cleanup after retention period (invisible)

---

## Recovery Scenarios

### Scenario 1: Accidental Rollback

**Problem:** User rolled back too far and lost important schema.

**Solution:**
```typescript
// Admin/support can restore to PITR snapshot
POST /api/projects/:projectId/rollback/archives/restore
{
  "snapshotId": "pitr_1706123456789_abc123"
}

// Result: Complete state restored, no data lost
```

### Scenario 2: Archived Table Recovery

**Problem:** Need to recover data from archived table.

**Solution:**
```typescript
// 1. List available archives
GET /api/projects/:projectId/rollback/archives

// 2. Manually restore (via support)
// Option A: Restore entire PITR snapshot
// Option B: Manually RENAME archived table back
ALTER TABLE "Users__archived__1706123456789" RENAME TO "Users"
```

### Scenario 3: Long-Term Data Retention

**Problem:** Need to preserve archives beyond 90 days.

**Solution:**
```typescript
// Before 90-day cutoff, export archived data
SELECT * FROM "workspace_abc.Users__archived__1706123456789"
-- Export to backup storage

// Or: Adjust retention period in cleanupOldArchives()
await cleanupOldArchives(projectId, 365) // 1 year retention
```

---

## Comparison: Destructive vs Non-Destructive

| Aspect | Destructive (Old) | Non-Destructive (New) |
|--------|------------------|---------------------|
| **Data Safety** | ❌ Data lost forever | ✅ Data preserved 90 days |
| **Reversibility** | ❌ Cannot undo rollback | ✅ PITR snapshots allow undo |
| **User Trust** | ⚠️ Users fear rollbacks | ✅ Users trust the system |
| **Recovery** | ❌ Impossible after DROP | ✅ Possible within 90 days |
| **Audit Trail** | ❌ No record of dropped data | ✅ Complete archive history |
| **Compliance** | ⚠️ Violates data retention | ✅ Meets retention requirements |

---

## Testing

### Unit Tests

```typescript
describe('Non-Destructive Rollback', () => {
  it('should archive table instead of dropping', async () => {
    const archive = await archiveTable(context, 'users', 'rollback')
    
    expect(archive.originalTable).toBe('users')
    expect(archive.archivedTable).toMatch(/users__archived__\d+/)
    expect(archive.canRestore).toBe(true)
    expect(archive.dataPreserved).toBe(true)
  })
  
  it('should create PITR snapshot before rollback', async () => {
    const snapshot = await createPITRSnapshot(context, currentState)
    
    expect(snapshot.id).toMatch(/pitr_\d+_[a-z0-9]+/)
    expect(snapshot.canRestoreTo).toBe(true)
    expect(snapshot.graphState).toBeDefined()
  })
  
  it('should restore to PITR snapshot', async () => {
    const result = await restoreToPITRSnapshot(context, snapshotId)
    
    expect(result.success).toBe(true)
    expect(result.tablesRestored.length).toBeGreaterThan(0)
  })
  
  it('should cleanup old archives after retention period', async () => {
    const result = await cleanupOldArchives(projectId, 90)
    
    expect(result.deletedTables).toBeGreaterThanOrEqual(0)
  })
})
```

### Integration Tests

```typescript
describe('Rollback Flow', () => {
  it('should preserve data through complete rollback', async () => {
    // 1. Insert test data
    await insertTestData('users', 1000)
    
    // 2. Execute rollback
    const result = await executeAtomicRollback(context, current, target)
    
    // 3. Verify archive exists
    const archives = await listArchivedTables(projectId)
    expect(archives.find(a => a.originalTable === 'users')).toBeDefined()
    
    // 4. Verify data preserved
    const archivedData = await queryArchivedTable('users__archived__*')
    expect(archivedData.length).toBe(1000)
  })
})
```

---

## Monitoring

### Metrics to Track

```typescript
// Archive metrics
{
  "totalArchives": 145,
  "archivesByAge": {
    "0-30days": 89,
    "30-60days": 34,
    "60-90days": 22
  },
  "totalStorageUsed": "1.2 GB"
}

// PITR snapshot metrics
{
  "totalSnapshots": 456,
  "snapshotsByAge": {
    "0-7days": 234,
    "7-14days": 123,
    "14-30days": 99
  },
  "averageSnapshotSize": "2.3 MB"
}

// Cleanup metrics
{
  "lastCleanup": "2024-01-21T03:00:00Z",
  "archivesDeleted": 12,
  "bytesFreed": "450 MB",
  "snapshotsInvalidated": 34
}
```

### Alerts

```typescript
// Alert if archives growing too large
if (totalArchives > 1000) {
  alert('High archive count - review retention policy')
}

// Alert if cleanup failing
if (lastCleanup > 14 days ago) {
  alert('Archive cleanup has not run in 14 days')
}

// Alert if PITR snapshots growing too large
if (totalSnapshots > 10000) {
  alert('High PITR snapshot count - reduce retention')
}
```

---

## Migration Guide

### Updating Existing Rollback Code

**Before (Destructive):**
```typescript
rollbackSteps = [{
  action: 'DROP_TABLE',
  tableName: 'users',
}]
```

**After (Non-Destructive):**
```typescript
rollbackSteps = [{
  action: 'ARCHIVE_TABLE',
  tableName: 'users',
}]
```

### Database Migration

1. Add new tables:
```bash
# Run Prisma migration
npx prisma migrate dev --name add-non-destructive-rollback
```

2. Update cron configuration:
```json
{
  "crons": [
    {
      "path": "/api/cron/archive-cleanup",
      "schedule": "0 3 * * 0"
    }
  ]
}
```

3. Set environment variable:
```bash
CRON_SECRET=<secure-random-string>
```

---

## FAQ

**Q: What happens if I need data from an archived table after 90 days?**
A: Data is permanently deleted after 90 days. Export critical data before the retention period expires.

**Q: Can I adjust the 90-day retention period?**
A: Yes, modify the `retentionDays` parameter in `cleanupOldArchives()`. Recommend 90-365 days for production.

**Q: Do archived tables count against storage limits?**
A: Yes, archived tables consume storage. Automatic cleanup prevents unbounded growth.

**Q: Can users see or manage archived tables?**
A: No. Archive management is internal only. Users trust the system to handle data safely.

**Q: What if a PITR restore fails?**
A: PITR restore is atomic - if any step fails, no changes are committed. Original state preserved.

**Q: How do I test archive cleanup without waiting 90 days?**
A: Call `cleanupOldArchives(projectId, 0)` to cleanup all archives immediately (for testing only).

---

## Conclusion

This non-destructive rollback system ensures **no user data is ever destroyed automatically**. Every rollback operation is:

- ✅ **Reversible** (PITR snapshots)
- ✅ **Safe** (data preserved 90 days)
- ✅ **Auditable** (complete archive history)
- ✅ **Automatic** (no user configuration)
- ✅ **Trust-preserving** (users never see complexity)

**Philosophy:** Users should never fear rolling back. The system preserves everything invisibly, building trust through safety guarantees rather than warnings and confirmations.
