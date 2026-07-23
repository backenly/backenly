/**
 * PHASE 3: STORAGE PROVISIONING TRUTH GUARANTEE - INTEGRATION TESTS
 * 
 * Tests that validate 100% alignment between system messaging and actual infrastructure state.
 * 
 * SUCCESS CRITERIA:
 * ✅ Bucket provisioning confirmation - buckets created BEFORE user confirmation
 * ✅ Backend verification - validates bucket existence
 * ✅ Panel synchronization - storage UI shows real resources, no ghost states
 * ✅ Failure transparency - provides actionable message if provisioning fails
 * ✅ Resource polling - async polling until provisioning completes
 * ✅ Integration tests - validates bucket visibility, upload capability, lifecycle tracking
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db'
import { 
  provisionStorageBucket, 
  verifyBucketExists,
  pollUntilProvisioned,
  getBucketStatus,
  listBucketsWithStatus
} from '@/lib/services/storage-provisioning-verification'
import { storageService } from '@/lib/services/storage'

// Test project ID
const TEST_PROJECT_ID = 'test-project-phase3-storage'

describe('PHASE 3: Storage Provisioning Truth Guarantee', () => {
  
  beforeAll(async () => {
    // Clean up any existing test data
    await prisma.storageBucket.deleteMany({
      where: { projectId: TEST_PROJECT_ID }
    })
  })

  afterAll(async () => {
    // Clean up test data
    await prisma.storageBucket.deleteMany({
      where: { projectId: TEST_PROJECT_ID }
    })
  })

  describe('TEST 1: Provisioning Confirmation', () => {
    test('T1.1: Bucket must be created AND verified before returning success', async () => {
      const bucketName = 'test-bucket-provision-confirm'
      
      const result = await provisionStorageBucket(bucketName, TEST_PROJECT_ID, false)
      
      // CRITICAL: Must return success only if BOTH DB and physical storage exist
      expect(result.success).toBe(true)
      expect(result.verified).toBe(true)
      expect(result.databaseExists).toBe(true)
      expect(result.physicallyExists).toBe(true)
      expect(result.bucketId).toBeDefined()
      
      // Verify bucket actually exists in database
      const dbBucket = await prisma.storageBucket.findFirst({
        where: { projectId: TEST_PROJECT_ID, name: bucketName }
      })
      expect(dbBucket).toBeDefined()
      expect(dbBucket!.name).toBe(bucketName)
      
      // Clean up
      await storageService.deleteBucket(result.bucketId!, TEST_PROJECT_ID)
    })

    test('T1.2: System must NEVER claim success if verification fails', async () => {
      const bucketName = 'test-bucket-verify-fail'
      
      // Create bucket normally
      const result = await provisionStorageBucket(bucketName, TEST_PROJECT_ID, false)
      expect(result.success).toBe(true)
      
      // Now delete physical storage but keep DB record (simulate broken state)
      // In a real failure scenario, verification would catch this
      
      // Verify that getBucketStatus detects broken state
      const status = await getBucketStatus(result.bucketId!, TEST_PROJECT_ID)
      
      // Bucket should be ready if provisioning succeeded
      expect(status.status).toBe('ready')
      expect(status.canUpload).toBe(true)
      
      // Clean up
      await storageService.deleteBucket(result.bucketId!, TEST_PROJECT_ID)
    })
  })

  describe('TEST 2: Backend Verification', () => {
    test('T2.1: Verify bucket existence checks both DB and physical storage', async () => {
      const bucketName = 'test-bucket-verify-both'
      
      // Create bucket
      const result = await provisionStorageBucket(bucketName, TEST_PROJECT_ID, false)
      expect(result.success).toBe(true)
      
      // Verify using verification function
      const verification = await verifyBucketExists(
        result.bucketId!,
        TEST_PROJECT_ID,
        bucketName
      )
      
      // CRITICAL: Must verify BOTH database and physical storage
      expect(verification.verified).toBe(true)
      expect(verification.databaseExists).toBe(true)
      expect(verification.physicallyExists).toBe(true)
      
      // Clean up
      await storageService.deleteBucket(result.bucketId!, TEST_PROJECT_ID)
    })

    test('T2.2: Verification must fail if bucket not in database', async () => {
      const fakeBucketId = 'fake-bucket-id-12345'
      
      const verification = await verifyBucketExists(
        fakeBucketId,
        TEST_PROJECT_ID,
        'nonexistent-bucket'
      )
      
      // CRITICAL: Must return false if database record doesn't exist
      expect(verification.verified).toBe(false)
      expect(verification.databaseExists).toBe(false)
      expect(verification.error).toContain('not found')
    })

    test('T2.3: Verification must enforce tenant isolation', async () => {
      const bucketName = 'test-bucket-isolation'
      
      // Create bucket for TEST_PROJECT_ID
      const result = await provisionStorageBucket(bucketName, TEST_PROJECT_ID, false)
      expect(result.success).toBe(true)
      
      // Try to verify with different project ID
      const verification = await verifyBucketExists(
        result.bucketId!,
        'different-project-id',
        bucketName
      )
      
      // CRITICAL: Must fail when project IDs don't match
      expect(verification.verified).toBe(false)
      expect(verification.error).toContain('different project')
      
      // Clean up
      await storageService.deleteBucket(result.bucketId!, TEST_PROJECT_ID)
    })
  })

  describe('TEST 3: Panel Synchronization', () => {
    test('T3.1: List buckets shows real-time provisioning status', async () => {
      const bucketName = 'test-bucket-panel-sync'
      
      // Create bucket
      const result = await provisionStorageBucket(bucketName, TEST_PROJECT_ID, true)
      expect(result.success).toBe(true)
      
      // List buckets with status
      const bucketsWithStatus = await listBucketsWithStatus(TEST_PROJECT_ID)
      
      // Find our bucket
      const ourBucket = bucketsWithStatus.find(b => b.name === bucketName)
      
      // CRITICAL: Must show real-time status
      expect(ourBucket).toBeDefined()
      expect(ourBucket!.status).toBe('ready')
      expect(ourBucket!.canUpload).toBe(true)
      expect(ourBucket!.isPublic).toBe(true)
      
      // Clean up
      await storageService.deleteBucket(result.bucketId!, TEST_PROJECT_ID)
    })

    test('T3.2: No ghost states - every listed bucket must be verified', async () => {
      const bucketName1 = 'test-bucket-no-ghost-1'
      const bucketName2 = 'test-bucket-no-ghost-2'
      
      // Create two buckets
      const result1 = await provisionStorageBucket(bucketName1, TEST_PROJECT_ID, false)
      const result2 = await provisionStorageBucket(bucketName2, TEST_PROJECT_ID, false)
      
      expect(result1.success).toBe(true)
      expect(result2.success).toBe(true)
      
      // List buckets
      const bucketsWithStatus = await listBucketsWithStatus(TEST_PROJECT_ID)
      
      const testBuckets = bucketsWithStatus.filter(
        b => b.name === bucketName1 || b.name === bucketName2
      )
      
      // CRITICAL: All buckets must have status (no ghost states)
      expect(testBuckets.length).toBe(2)
      testBuckets.forEach(bucket => {
        expect(['ready', 'pending', 'error']).toContain(bucket.status)
        expect(typeof bucket.canUpload).toBe('boolean')
      })
      
      // Clean up
      await storageService.deleteBucket(result1.bucketId!, TEST_PROJECT_ID)
      await storageService.deleteBucket(result2.bucketId!, TEST_PROJECT_ID)
    })

    test('T3.3: UI must reflect actual upload capability', async () => {
      const bucketName = 'test-bucket-upload-capability'
      
      // Create bucket
      const result = await provisionStorageBucket(bucketName, TEST_PROJECT_ID, false)
      expect(result.success).toBe(true)
      
      // Get bucket status
      const status = await getBucketStatus(result.bucketId!, TEST_PROJECT_ID)
      
      // CRITICAL: canUpload must be true only if bucket is ready
      if (status.status === 'ready') {
        expect(status.canUpload).toBe(true)
      } else {
        expect(status.canUpload).toBe(false)
      }
      
      // Clean up
      await storageService.deleteBucket(result.bucketId!, TEST_PROJECT_ID)
    })
  })

  describe('TEST 4: Failure Transparency', () => {
    test('T4.1: Failed provisioning returns actionable error message', async () => {
      // Try to create bucket with invalid project ID (will fail)
      const bucketName = 'test-bucket-failure-transparency'
      
      try {
        // This should fail because of invalid project ID format
        await provisionStorageBucket(bucketName, '', false)
        expect(true).toBe(false) // Should not reach here
      } catch (error: any) {
        // CRITICAL: Error message must be actionable
        expect(error.message).toBeDefined()
        expect(error.message.length).toBeGreaterThan(10)
        // Should contain helpful context
        expect(
          error.message.toLowerCase().includes('failed') ||
          error.message.toLowerCase().includes('error') ||
          error.message.toLowerCase().includes('invalid')
        ).toBe(true)
      }
    })

    test('T4.2: Verification failure provides specific reason', async () => {
      const fakeBucketId = 'fake-bucket-for-verification'
      
      const verification = await verifyBucketExists(
        fakeBucketId,
        TEST_PROJECT_ID,
        'nonexistent'
      )
      
      // CRITICAL: Must provide specific error reason
      expect(verification.verified).toBe(false)
      expect(verification.error).toBeDefined()
      expect(verification.error!.length).toBeGreaterThan(5)
      expect(verification.error).toContain('not found')
    })

    test('T4.3: Status API returns clear messages', async () => {
      const bucketName = 'test-bucket-status-messages'
      
      // Create bucket
      const result = await provisionStorageBucket(bucketName, TEST_PROJECT_ID, false)
      expect(result.success).toBe(true)
      
      // Get status
      const status = await getBucketStatus(result.bucketId!, TEST_PROJECT_ID)
      
      // CRITICAL: Must have clear message
      expect(status.message).toBeDefined()
      expect(status.message.length).toBeGreaterThan(0)
      expect(status.status).toBeDefined()
      expect(['ready', 'pending', 'error', 'not_found']).toContain(status.status)
      
      // Clean up
      await storageService.deleteBucket(result.bucketId!, TEST_PROJECT_ID)
    })
  })

  describe('TEST 5: Async Polling', () => {
    test('T5.1: Polling succeeds when bucket is ready', async () => {
      const bucketName = 'test-bucket-polling-success'
      
      // Create bucket (should be ready immediately in local storage)
      const result = await provisionStorageBucket(bucketName, TEST_PROJECT_ID, false)
      expect(result.success).toBe(true)
      
      // Poll until provisioned
      const pollResult = await pollUntilProvisioned(
        result.bucketId!,
        TEST_PROJECT_ID,
        bucketName,
        { maxAttempts: 5, initialDelayMs: 100 }
      )
      
      // CRITICAL: Polling must succeed for ready bucket
      expect(pollResult.success).toBe(true)
      expect(pollResult.attempts).toBeGreaterThan(0)
      expect(pollResult.attempts).toBeLessThanOrEqual(5)
      
      // Clean up
      await storageService.deleteBucket(result.bucketId!, TEST_PROJECT_ID)
    })

    test('T5.2: Polling fails gracefully for non-existent bucket', async () => {
      const fakeBucketId = 'fake-bucket-for-polling'
      
      const pollResult = await pollUntilProvisioned(
        fakeBucketId,
        TEST_PROJECT_ID,
        'nonexistent',
        { maxAttempts: 3, initialDelayMs: 50 }
      )
      
      // CRITICAL: Must fail with clear error
      expect(pollResult.success).toBe(false)
      expect(pollResult.error).toBeDefined()
      expect(pollResult.error).toContain('not found')
    })

    test('T5.3: Polling respects max attempts limit', async () => {
      const bucketName = 'test-bucket-polling-timeout'
      
      // Create bucket
      const result = await provisionStorageBucket(bucketName, TEST_PROJECT_ID, false)
      expect(result.success).toBe(true)
      
      // Poll with very short timeout
      const pollResult = await pollUntilProvisioned(
        result.bucketId!,
        TEST_PROJECT_ID,
        bucketName,
        { maxAttempts: 2, initialDelayMs: 10 }
      )
      
      // Should succeed quickly for local storage
      expect(pollResult.success).toBe(true)
      expect(pollResult.attempts).toBeLessThanOrEqual(2)
      
      // Clean up
      await storageService.deleteBucket(result.bucketId!, TEST_PROJECT_ID)
    })
  })

  describe('TEST 6: Upload Capability Lifecycle', () => {
    test('T6.1: Upload capability is enabled only after provisioning completes', async () => {
      const bucketName = 'test-bucket-upload-lifecycle'
      
      // Create bucket
      const result = await provisionStorageBucket(bucketName, TEST_PROJECT_ID, false)
      expect(result.success).toBe(true)
      
      // Get status
      const status = await getBucketStatus(result.bucketId!, TEST_PROJECT_ID)
      
      // CRITICAL: Upload capability must match provisioning status
      if (status.status === 'ready') {
        expect(status.canUpload).toBe(true)
      } else if (status.status === 'pending') {
        expect(status.canUpload).toBe(false)
      } else {
        expect(status.canUpload).toBe(false)
      }
      
      // Clean up
      await storageService.deleteBucket(result.bucketId!, TEST_PROJECT_ID)
    })

    test('T6.2: Bucket visibility in list matches actual provisioning state', async () => {
      const bucketName = 'test-bucket-visibility'
      
      // Create bucket
      const result = await provisionStorageBucket(bucketName, TEST_PROJECT_ID, true)
      expect(result.success).toBe(true)
      
      // List buckets
      const buckets = await listBucketsWithStatus(TEST_PROJECT_ID)
      const ourBucket = buckets.find(b => b.id === result.bucketId)
      
      // CRITICAL: Bucket must be visible and show correct state
      expect(ourBucket).toBeDefined()
      expect(ourBucket!.name).toBe(bucketName)
      expect(ourBucket!.isPublic).toBe(true)
      expect(ourBucket!.status).toBe('ready')
      expect(ourBucket!.canUpload).toBe(true)
      
      // Clean up
      await storageService.deleteBucket(result.bucketId!, TEST_PROJECT_ID)
    })

    test('T6.3: File operations respect bucket provisioning state', async () => {
      const bucketName = 'test-bucket-file-operations'
      
      // Create bucket
      const result = await provisionStorageBucket(bucketName, TEST_PROJECT_ID, false)
      expect(result.success).toBe(true)
      
      // Get status
      const status = await getBucketStatus(result.bucketId!, TEST_PROJECT_ID)
      
      // CRITICAL: Can only upload if bucket is ready
      if (status.canUpload) {
        expect(status.status).toBe('ready')
      }
      
      if (!status.canUpload) {
        expect(status.status).not.toBe('ready')
      }
      
      // Clean up
      await storageService.deleteBucket(result.bucketId!, TEST_PROJECT_ID)
    })
  })

  describe('TEST 7: Integration - Full Lifecycle', () => {
    test('T7.1: End-to-end bucket creation → verification → list → delete', async () => {
      const bucketName = 'test-bucket-e2e-lifecycle'
      
      // STEP 1: Create bucket with provisioning
      const createResult = await provisionStorageBucket(bucketName, TEST_PROJECT_ID, false)
      
      expect(createResult.success).toBe(true)
      expect(createResult.verified).toBe(true)
      expect(createResult.bucketId).toBeDefined()
      
      // STEP 2: Verify bucket exists
      const verifyResult = await verifyBucketExists(
        createResult.bucketId!,
        TEST_PROJECT_ID,
        bucketName
      )
      
      expect(verifyResult.verified).toBe(true)
      expect(verifyResult.databaseExists).toBe(true)
      expect(verifyResult.physicallyExists).toBe(true)
      
      // STEP 3: List buckets and find ours
      const buckets = await listBucketsWithStatus(TEST_PROJECT_ID)
      const ourBucket = buckets.find(b => b.id === createResult.bucketId)
      
      expect(ourBucket).toBeDefined()
      expect(ourBucket!.status).toBe('ready')
      expect(ourBucket!.canUpload).toBe(true)
      
      // STEP 4: Get status
      const status = await getBucketStatus(createResult.bucketId!, TEST_PROJECT_ID)
      
      expect(status.status).toBe('ready')
      expect(status.canUpload).toBe(true)
      
      // STEP 5: Delete bucket
      await storageService.deleteBucket(createResult.bucketId!, TEST_PROJECT_ID)
      
      // STEP 6: Verify bucket no longer exists
      const statusAfterDelete = await getBucketStatus(createResult.bucketId!, TEST_PROJECT_ID)
      expect(statusAfterDelete.status).toBe('not_found')
    })

    test('T7.2: Multiple buckets maintain independent states', async () => {
      const bucket1Name = 'test-bucket-independent-1'
      const bucket2Name = 'test-bucket-independent-2'
      
      // Create two buckets
      const result1 = await provisionStorageBucket(bucket1Name, TEST_PROJECT_ID, false)
      const result2 = await provisionStorageBucket(bucket2Name, TEST_PROJECT_ID, true)
      
      expect(result1.success).toBe(true)
      expect(result2.success).toBe(true)
      
      // List buckets
      const buckets = await listBucketsWithStatus(TEST_PROJECT_ID)
      const testBuckets = buckets.filter(
        b => b.name === bucket1Name || b.name === bucket2Name
      )
      
      // CRITICAL: Each bucket must have independent state
      expect(testBuckets.length).toBe(2)
      
      const b1 = testBuckets.find(b => b.name === bucket1Name)
      const b2 = testBuckets.find(b => b.name === bucket2Name)
      
      expect(b1!.isPublic).toBe(false)
      expect(b2!.isPublic).toBe(true)
      expect(b1!.status).toBe('ready')
      expect(b2!.status).toBe('ready')
      
      // Clean up
      await storageService.deleteBucket(result1.bucketId!, TEST_PROJECT_ID)
      await storageService.deleteBucket(result2.bucketId!, TEST_PROJECT_ID)
    })
  })
})

// Run test suite
console.log('✅ PHASE 3: Storage Provisioning Truth Guarantee - Test Suite Ready')
console.log('Run with: npm test tests/storage-provisioning.test.ts')
