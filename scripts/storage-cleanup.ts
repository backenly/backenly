/**
 * Storage Cleanup Background Job
 * 
 * Permanently deletes soft-deleted files older than X days.
 * Run this as a cron job (daily recommended).
 * Works with both LocalStorageService and S3StorageService.
 * 
 * Usage:
 *   npx ts-node scripts/storage-cleanup.ts [--days=30]
 * 
 * Or add to package.json:
 *   "scripts": {
 *     "storage:cleanup": "ts-node scripts/storage-cleanup.ts"
 *   }
 */

import { storageService } from '@/lib/services/storage'

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2)
  const daysArg = args.find(arg => arg.startsWith('--days='))
  const daysOld = daysArg ? parseInt(daysArg.split('=')[1]) : 30

  console.log('=====================================')
  console.log('Storage Cleanup Job Starting')
  console.log('=====================================')
  console.log(`Driver: ${process.env.STORAGE_DRIVER || 'local'}`)
  console.log(`Config: Delete files soft-deleted more than ${daysOld} days ago`)
  console.log(`Timestamp: ${new Date().toISOString()}`)
  console.log('')

  try {
    // Both LocalStorageService and S3StorageService implement cleanupDeletedFiles
    // @ts-ignore - cleanupDeletedFiles exists on both implementations
    const result = await storageService.cleanupDeletedFiles(daysOld)

    console.log('')
    console.log('=====================================')
    console.log('Cleanup Summary:')
    console.log(`  Total Processed: ${result.totalProcessed}`)
    console.log(`  Successfully Deleted: ${result.successCount}`)
    console.log(`  Errors: ${result.errorCount}`)
    console.log('=====================================')
    
    // Exit with error code if there were errors
    process.exit(result.errorCount > 0 ? 1 : 0)
  } catch (error) {
    console.error('')
    console.error('=====================================')
    console.error('FATAL ERROR during cleanup:')
    console.error(error)
    console.error('=====================================')
    process.exit(1)
  }
}

main()

